# Discord Workflow Builder — Spec (WB-1)

Build onboarding and interaction workflows in the dashboard — steps, questions,
buttons, dropdowns, role grants, private threads — and run them live on the
server through the connected bot. This replaces the "Roles & Onboarding" stub
with the real thing, and its first acceptance test is rebuilding the existing
`#start` → "Start — meet Otto" flow, built in the builder instead of hardcoded.

Companions: the Setup tab (bot token + guild, shipped `0485291`) and the Server
tab (guild REST management, shipped `e8afa8b`). This spec adds the interaction
runtime + the builder that compiles to it.

---

## 0. THE DECISION — where interactions land (pick before building)

One Discord application has ONE interactions path: either an HTTP endpoint URL
(set in the portal → Ed25519-signed POSTs) or, when that field is EMPTY, the
gateway (`InteractionCreate` on the bot's websocket). Today the endpoint URL
points at `airlock-discord-gate` (Vercel edge, 224 lines, 4 handlers: `/poll`,
`/otto`, `/link`, `beam_start`).

| Option | Shape | Cost | Benefit |
|---|---|---|---|
| **A — Relay** | Gate keeps the endpoint; forwards `wf:*` custom_ids to hivesync; defers + follow-up via webhook token | Two services per click, 3s deadline across a hop, token plumbing | Zero migration; interactions stay on Vercel edge uptime |
| **B — Move the HTTP endpoint** | Point the portal URL at hivesync `/api/discord/interactions`; port the gate's handlers; keep Ed25519 | Migration AND the raw-HTTP interaction dance | No gateway dependency for interactions |
| **C — Gateway (RECOMMENDED)** | Clear the portal's endpoint URL; ALL interactions arrive on hivesync's already-connected discord.js client; port the gate's 4 handlers | Port ~150 lines (all four are portable: `/poll` is pure, `/otto` is a fetch to the relay, `/link`+`beam_start` are Supabase REST inserts — add `SUPABASE_URL`/key to Render env); interactions blink during hivesync deploys | No Ed25519, no 3s HTTP plumbing — discord.js gives `reply/deferReply/showModal/threads` natively; one brain: the engine reads the same DB the builder writes; **rollback = re-paste the endpoint URL in the portal, gate reactivates instantly (keep it deployed, dormant)** |

**Recommendation: C** (conviction: 80%, flips if interaction downtime during
Render deploys proves unacceptable in practice — then A, gate as thin relay).
The workflow engine wants rich interaction objects — private threads, modals,
ephemeral follow-ups — and discord.js hands those over for free on the gateway.

---

## 1. Data model (Neon, migrations/)

```sql
create table if not exists discord_workflows (
  id          uuid primary key default gen_random_uuid(),
  guild_id    text not null,
  name        text not null,
  status      text not null default 'draft',     -- draft | published | paused
  trigger     jsonb not null,                    -- v1: {type:'button_post', channel_id, message:{content?, embed?}, button_label}
  definition  jsonb not null,                    -- the step graph (shape §2)
  version     int  not null default 1,           -- bumped every publish
  trigger_message_id text,                       -- the posted trigger message (edit/refresh on republish)
  role_allowlist text[] not null default '{}',   -- ONLY roles grantable by this workflow (checked again at execution)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists discord_workflow_runs (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references discord_workflows(id) on delete cascade,
  wf_version  int  not null,                     -- pinned at start; stale-version clicks are rejected cleanly
  guild_id    text not null,
  discord_id  text not null,                     -- the member walking the flow
  step_id     text not null,
  answers     jsonb not null default '{}',       -- {step_id: value|value[]}
  thread_id   text,                              -- private thread hosting the run (v1 default)
  status      text not null default 'active',    -- active | completed | abandoned
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- one ACTIVE run per member per workflow; completed history is kept
create unique index if not exists wf_runs_one_active
  on discord_workflow_runs (workflow_id, discord_id) where status = 'active';
```

## 2. Definition shape (the step graph)

```json
{ "entry": "s1",
  "steps": [
    { "id": "s1", "type": "message",          "content": "welcome — quick questions", "next": "s2" },
    { "id": "s2", "type": "question_buttons", "prompt": "how do you bet?",
      "options": [ { "label": "casual",  "next": "s3" },
                   { "label": "serious", "next": "s3" } ] },
    { "id": "s3", "type": "question_select",  "prompt": "pick your teams",
      "multi": true, "max": 5,
      "options": [ { "label": "Yankees", "value": "nyy" }, { "label": "Reds", "value": "cin" } ],
      "next": "s4" },
    { "id": "s4", "type": "grant_role",       "role_id": "<snowflake>", "next": "s5" },
    { "id": "s5", "type": "finish",           "content": "you're in 🦦",
      "summary_channel_id": "<staff channel, optional>" } ]
}
```

Step types (v1, all deterministic): `message`, `question_buttons` (≤5, optional
per-option branch), `question_select` (≤25 options, single or multi),
`grant_role`, `finish` (closing message + optional answers-summary post to a
staff channel). v2 adds: `modal_text` (free-text via modal), `member_join`
trigger (auto-DM flows), delays.

## 3. Runtime (the engine)

1. **Publish** — dashboard POST compiles + validates the graph (entry exists,
   every `next` resolves, no orphan steps, option/label caps, role_ids ⊆
   allowlist), bumps `version`, posts (or edits) the trigger message with the
   button. Publish is a human click — same floor as everything else.
2. **Start** — member clicks the trigger button → engine opens a **private
   thread** in the trigger channel (`Run: <name> — <username>`), inserts a run
   (pinned `wf_version`), renders the entry step in-thread. Duplicate active
   run → ephemeral "you're already mid-flow, continuing in <thread link>".
3. **Advance** — every component carries `custom_id = wf:<run_id>:<step_id>:<opt_idx>`
   (ids only, ≤100 chars, nothing trusted from it — everything re-fetched
   server-side). Engine: verify run exists + active + version matches + step
   matches + **`interaction.user.id === run.discord_id`** (anyone else:
   ephemeral "start your own — hit the button in #start"). Record answer,
   disable the answered row (edit message), render next step. Non-interactive
   steps (`message`, `grant_role`) auto-advance in sequence.
4. **Finish** — closing message, run → `completed`, optional summary embed to
   the staff channel (answers, member, duration). Thread auto-archives (1h).
5. **Failure posture** — unknown/stale custom_id → ephemeral "this flow moved
   on — tap the start button to begin fresh", never a crash, never a write.
   Engine errors → run stays `active`, member sees "hiccup — tap again".

## 4. Builder UI (dashboard — "Workflows" tab replaces the Roles & Onboarding stub)

- **List**: name, status chip, version, runs started/completed (from runs
  table — this is the first real Analytics data), publish/pause, edit.
- **Editor**: steps as a vertical card stack (same idiom as Setup). Add-step
  picker (5 types). Per-card: prompt/content fields (reusing the Composer's
  embed sub-editor for message steps), options list with per-option branch
  select, role picker (from live guild roles — filtered, see floor), channel
  pickers from the live structure (Server tab's source). Live Discord-style
  preview pane (Composer preview idiom).
- **Trigger card**: channel picker + button label + the trigger message
  (content or embed).
- **Test mode**: "Run as me" — executes the flow against the admin's own user
  in a private thread before publish. No test = no publish button.
- Everything escaped; no innerHTML of member/guild strings (house rule).

## 5. Safety floor (auditors verify — same lineage as §9 / the global floor)

1. **Identity from the interaction only** — `discord_id` comes from the signed
   gateway/HTTP interaction, never from custom_id or any client field.
   custom_id carries opaque ids; every fact is re-fetched server-side.
2. **Author-gate on runs** — only the member who started a run can advance it
   (the gate repo's `isOwner` pattern, generalized).
3. **Role grants are triple-fenced** — role must be (a) in the workflow's
   `role_allowlist` snapshot, (b) below the bot's highest role, and (c) carry
   NO privileged permission bits (ADMINISTRATOR, MANAGE_*, KICK, BAN,
   MENTION_EVERYONE) — checked at EXECUTION time, not just in the builder, so
   a tampered definition still can't escalate. The builder's role picker never
   even offers privileged roles.
4. **Mentions locked** — `allowed_mentions: {parse: []}` on every engine post,
   as everywhere else.
5. **Deterministic engine** — no LLM in the interaction path. Otto drafts
   content through the existing Command Otto lane (human approves), and flow
   COPY can be agent-drafted, but flow EXECUTION is pure state machine.
6. **Admin surface gated by ADMIN_KEY**; runs data (members' answers) is
   admin-only, never exposed unauthenticated.

## 6. Acceptance (WB-1 — what the audit checks)

- The existing "meet Otto" onboarding is rebuilt IN the builder and runs
  end-to-end on The Brain Brigade: `#start` trigger button → private thread →
  a buttons question + a multi-select question → role grant → finish message +
  staff summary. The hardcoded original is retired.
- Member B clicking member A's run components → ephemeral rejection, no state
  change. Stale-version and unknown custom_ids → clean ephemeral, no crash.
- A definition hand-edited to grant an admin role fails AT EXECUTION with the
  fence error; the run continues past the step with a logged skip.
- Publish edits the existing trigger message (no duplicate posts); pause stops
  new runs but lets active runs finish.
- Ported gate commands (`/poll`, `/otto`, `/link`, `beam_start`) answer
  identically to today, from hivesync's gateway path (Option C), with the gate
  left deployed as the documented rollback.
- Every engine-posted message passes the mention lock; run answers render
  escaped in the dashboard.

## 7. Phasing

- **WB-1** (this spec): Option C port + engine + 5 step types + button_post
  trigger + builder UI + test mode + the `#start` rebuild.
- **WB-2**: `member_join` trigger (auto-DM onboarding), `modal_text` free-text
  steps, reusable self-role menus, answers export, per-step drop-off analytics
  on the Workflows list.
- **WB-3**: rules/automod + server-settings panels (separate spec — different
  risk surface, wants its own bright lines).

---

*Runtime lives in hivesync (always-on Render, gateway already connected).
The gate stays deployed and dormant as the one-field rollback. Build → audit
(author excluded) → ship, per the house loop.*

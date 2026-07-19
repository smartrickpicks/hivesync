# Fixer Community Dashboard — Endpoint Contract (for Fable)

**Operation Gold Rush · the "shovels" surface.** This is the build contract for the
community-management dashboard. The backend (`connectors.js` on hivesync) is live,
guild-aware, and independently audited. Fable builds the dashboard **HTML/JS against
the endpoints below** — nothing here calls an LLM; it's a deterministic control plane.

Build only against endpoints marked **WIRED**. Anything under "Not backed yet" is a
panel you may lay out but must leave stubbed (disabled / "coming soon"), not point at
an invented route.

---

## 0. Base, auth, conventions

- **Base URL:** the hivesync service (Render). Same origin the dashboard is served
  from — use relative paths (`/connectors/...`). Do not hardcode the host.
- **Auth (every route below):** the master key, sent as either header:
  - `Authorization: Bearer <ADMIN_KEY>`  — or —  `x-admin-key: <ADMIN_KEY>`
  - Missing/wrong key → **401** `{ "error": "unauthorized" }`. The dashboard should
    treat 401 as "not signed in" and gate the whole UI behind key entry.
- **Guild (multi-tenant ready):** optional header `x-guild-id: <id>`. Omit it and
  everything resolves to guild `default` — which is correct for now (one guild).
  Build the dashboard to send **no guild header** in v1; the plumbing is there for
  later without a UI change.
- **Format:** JSON in, JSON out. `Content-Type: application/json` on writes.
- **Errors:** `400` validation (`{error}` names the missing field), `404` not found,
  `502` Discord rejected the send (`{error:"discord <status>"}` or `discord fetch: ...`).
- **Webhook masking:** every read returns `webhook_url` **masked** (`https://disc…abc123`).
  The real URL is write-only. To change a channel's webhook, POST a new full URL.

---

## 1. Bootstrap — one call to paint the dashboard

**`GET /connectors/state`** → everything the shell needs on load:
```json
{
  "guild_id": "default",
  "channels":  [ { "tier":"top", "label":"Top Plays", "enabled":true, "webhook_url":"https://disc…abc123", "updated_at":"…" } ],
  "sources":   [ { "id":"uuid", "url":"…", "name":"…", "route_tier":"watch", "source_tier":2, "enabled":true, "added_at":"…" } ],
  "scheduled": [ { "id":"uuid", "channel_key":"top", "run_at":"…", "cron":null, "repeat":false, "enabled":true, "last_run":null } ]
}
```
Call this on load and after any mutation (or update local state optimistically).

---

## 2. Channels panel (routing) — WIRED

Channels are named routes keyed by a free-form `tier` string. The Fixer publisher
uses `top` / `qualified` / `watch` / `pass` / `all`, but any string is valid.

| Action | Call | Body | Returns |
|---|---|---|---|
| List | `GET /connectors/channels` | — | `[{tier,label,enabled,webhook_url(masked),updated_at}]` |
| Create/update | `POST /connectors/channels` | `{ tier, webhook_url, label?, enabled? }` | `{ok:true}` (upsert by tier) |
| Delete | `DELETE /connectors/channels/:tier` | — | `{ok:true}` |

UI: a channel = a Discord webhook URL the operator pastes once. Show masked after save.
`enabled:false` keeps the config but stops sends to it.

---

## 3. Embed composer — WIRED

The Discohook-style panel: compose a rich embed (or plain content) and send it now.

**`POST /connectors/embed/send`**
```json
{ "channel_key": "top", "embed": { …Discord embed object… } }
```
or `{ "channel_key":"top", "content":"plain text" }`. One of `embed`/`content` required.
→ `{ok:true}` · `404` if the channel isn't configured/enabled · `502` if Discord rejects.

**Discord embed shape** the composer should build (all optional except you need *something*):
```json
{ "title":"…", "description":"…", "url":"…", "color":2021739,
  "fields":[ {"name":"…","value":"…","inline":true} ],
  "footer":{"text":"…"}, "timestamp":"ISO-8601" }
```
`color` is a **decimal** int (not hex). Cap: 10 fields, title ≤256, description ≤4096.

> **Mentions are locked.** The backend forces `allowed_mentions:{parse:[]}` — the
> composer can NOT ping @everyone/@here/roles. Do not build a "ping everyone" toggle
> in v1; that's a deliberate safety floor, not a missing feature.

---

## 4. RSS / news sources — WIRED

| Action | Call | Body | Returns |
|---|---|---|---|
| List | `GET /connectors/sources` | — | `[rss_source]` |
| Add | `POST /connectors/sources` | `{ url, name?, route_tier?, source_tier? , enabled? }` | the created row |
| Delete | `DELETE /connectors/sources/:id` | — | `{ok:true}` |

`route_tier` = which channel new items post to. `source_tier` (int, default 2) is a
trust/priority hint. **Note:** storage + management is wired; the fetch/poll runner
that actually pulls feeds and posts them is **not built yet** — treat this panel as
"configure sources now, auto-posting soon."

---

## 5. Scheduled posts — WIRED (with a live 60s runner)

| Action | Call | Body | Returns |
|---|---|---|---|
| List | `GET /connectors/scheduled` | — | `[scheduled_post]` |
| Create | `POST /connectors/scheduled` | `{ channel_key, payload, run_at?, cron?, repeat? }` | the created row |
| Delete | `DELETE /connectors/scheduled/:id` | — | `{ok:true}` |

`payload` = `{content?|embed?|embeds?}` (same shape as the composer). Set `run_at` (ISO)
for a one-shot; the always-on runner fires due posts every 60s and disables one-shots
after they fire (`repeat:true` keeps them). `cron` is stored but the recurring runner
isn't wired yet — use `run_at` for now.

---

## 6. Activity log — WIRED

**`GET /connectors/log`** → last 200 sends for this guild, newest first:
`[{ dedup_key, kind, guild_id, posted_at }]`. `kind` is `embed` / `scheduled` /
`dispatch` / a channel tier. Every successful send lands here — use it for the
"recent activity" feed.

---

## 7. Command Otto (dispatch) — WIRED · the human-in-the-loop lane

This is the panel where the operator asks the local Otto agent to draft something
(a recap, a poll, a judgment call), reviews the **draft**, and approves it to publish.
The AI never publishes on its own — approval is a human click.

**Flow the dashboard implements:**
1. **Create a job** — `POST /connectors/dispatch`
   ```json
   { "capability":"content.draft_recap", "payload":{ "prompt":"…", "project":"fixer" } }
   ```
   → `{ id, status:"queued" }`. (`capability` must be allow-listed on the agent side,
   e.g. `content.*`; `payload.project` must be an allow-listed project.)
2. **Poll status** — `GET /connectors/dispatch` → list with `{id,status,capability,…}`.
   Statuses: `queued → claimed → awaiting_approval` (or `failed`). Poll every few sec.
3. **Show the draft** — when a job is `awaiting_approval`,
   `GET /connectors/dispatch/:id` → full row including `result.output` (the drafted
   text). Render that for review.
4. **Approve → publish** — `POST /connectors/dispatch/:id/approve`
   ```json
   { "channel_key":"top" }
   ```
   → `{ok:true}` (published once) or `{ok:true, already:true}` (already published /
   double-click safe). `502` if the send fails — the job stays un-published and
   retriable (the backend releases its guard on failure).

**Do NOT call** these agent-only routes from the dashboard (they use a different
credential, `AGENT_KEY`, and belong to the local watcher): `POST /connectors/dispatch/claim`,
`POST /connectors/dispatch/:id/result`, `POST /connectors/agents/heartbeat`.

---

## 8. Not backed yet — lay out, but stub

These are on the module map (MEE6/YAGPDB parity) but have **no backend endpoint yet**.
Build the panels disabled or behind a "coming soon" state; do not invent routes:

- **Moderation / automod** (rules, cases, actions)
- **Roles & onboarding** (welcome, self-roles, reaction roles)
- **Leveling / XP**
- **Analytics** (growth, funnel, conversion) — beyond the raw activity log
- **RSS auto-posting runner** (config is wired in §4; the poller is not)
- **Recurring `cron` scheduler** (one-shot `run_at` is wired in §5; cron is not)

When one of these gets a backend, it'll be added here as a new WIRED section.

---

## 9. Security floor the UI must honor

1. **Human approves before publish** — the dispatch lane's whole point. Never auto-approve.
2. **No mass-ping controls** — mentions are locked server-side; don't build a UI that
   implies otherwise.
3. **Master key is the whole gate** — treat it like a password: never render it back,
   never log it, store it only in memory/session for the tab.
4. **Webhooks are secrets** — they arrive masked; show masked, never try to un-mask.

---

*Backend source of truth: `hivesync/connectors.js` (audited, guild-aware). Questions
on a shape → read that file; it's the contract's implementation. This doc tracks it.*

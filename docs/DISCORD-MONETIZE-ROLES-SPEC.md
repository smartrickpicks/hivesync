# Monetize + Auto-Roles — Spec (M-1 / M-2)

The Fixer's Stripe payment link becomes a managed thing in the dashboard, and
paying (or completing onboarding) grants Discord roles automatically. Two
repos, one pipe:

```
 Payment Link (Stripe-hosted checkout)
   └─ ?client_reference_id=<discord_id>   ← appended by the picks-chat board (member is /link'd)
        └─ Stripe webhook → picks-chat /api/stripe/webhook
             └─ entitlements.grant(discord_id, {source:'stripe'})   ← the EXISTING grant path
                  └─ hivesync role reconciler (60s) → bot adds/removes the Pro role
```

Companion: `DISCORD-WORKFLOW-BUILDER-SPEC.md` (WB-1) — its `grant_role` step
shares the same role fences defined here. Onboarding-completion roles are
WB-1's job; this spec adds the payment-driven role and the management surface.

---

## M-1 · Stripe (money never touches our servers — Stripe-hosted only)

### Config — shared Supabase table (both apps read it, dashboard writes it)
```sql
create table if not exists fixer_monetize (
  id               int primary key default 1 check (id = 1),
  payment_link_url text,            -- the Stripe Payment Link (https://buy.stripe.com/…)
  price_label      text,            -- display only, e.g. "$39.99/mo"
  pro_role_id      text,            -- the Discord role paying members get
  enabled          boolean not null default false,
  updated_at       timestamptz not null default now()
);
```

### picks-chat deliverables (webhook + board button)
1. **`POST /api/stripe/webhook`** (new): verify `STRIPE_WEBHOOK_SECRET`
   signature on EVERY event — unverified requests are 400, full stop.
   - `checkout.session.completed` → `discord_id = session.client_reference_id`
     → `grant(discord_id, {source:'stripe', expires_at: null})` via the
     existing entitlements lib (unchanged shape — the push worker never learns
     Stripe exists). Store `stripe_customer_id`/`subscription_id` on the
     entitlement row (add columns) so cancels map back.
   - `customer.subscription.deleted` / `invoice.payment_failed` (final) /
     `charge.refunded` → `revoke(discord_id)` by customer/subscription lookup.
   - **Unmatched payment** (no/garbage client_reference_id): write to
     `fixer_stripe_orphans` (event id, email, amount, created_at) — surfaced
     on the dashboard for manual matching. Never guess identity from email.
2. **Board "Go Pro" button**: session-aware — linked member who isn't Pro sees
   it; href = `payment_link_url` + `?client_reference_id=<their discord_id>`
   (+ `prefilled_email` blank — Stripe collects it). Reads `fixer_monetize`;
   hidden when `enabled=false` or no link set.
3. Idempotency: webhook events dedup on Stripe event id (table or the
   entitlement upsert's natural idempotence); replays must not double-grant.

### hivesync deliverables (the Monetize tab + reconciler)
1. **Monetize tab** (admin-key gated, replaces nothing — new tab):
   - Payment link field (URL-validated: `https://buy.stripe.com/…`), price
     label, enabled toggle.
   - **Pro role picker** — live guild roles, filtered by the role fences (§M-2).
   - **Entitlements table** — who's Pro (discord_id, source, status, since,
     expires) read from `fixer_entitlements` via Supabase REST (add
     `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` to Render env — same values the
     gate uses). Manual **Grant / Revoke** buttons writing through the same
     upsert shape as the lib (manual grants marked `source:'manual'`).
   - **Orphans queue** — unmatched payments with a "match to discord_id" field.
   - **"Post the Go Pro embed"** — one click prefills the Composer with a
     styled embed + LINK button to the payment link.
2. **Role reconciler** (the auto-grant engine, 60s interval alongside the
   connectors scheduler): when `pro_role_id` is set —
   - desired = active `fixer_entitlements` (plan=pro, status=active, unexpired)
   - actual = guild members holding `pro_role_id` (client cache; GUILD_MEMBERS
     intent already required)
   - diff → `PUT/DELETE /guilds/:id/members/:uid/roles/:role_id`, throttled
     (≤5 changes/tick), every change logged to an `role_audit` table shown on
     the Activity tab (`kind: role_grant | role_revoke`, who, why).
   - Reconciler > webhook-push design (conviction: 85%, flips if 60s latency
     on role grant is unacceptable): self-heals missed webhooks, handles
     cancels/refunds/expiry with zero cross-service calls, and manual DB
     grants get roles too.

## M-2 · Role fences (shared by ALL role automation)

Invite permissions: **add Manage Roles (268435456)** to `INVITE_PERMISSIONS`
(reversal of `e8afa8b`'s exclusion — two shipped features now require it;
Kick/Ban/Administrator remain excluded). Existing installs re-invite or grant
the bot role Manage Roles.

Every role change — WB-1 `grant_role` steps, the Pro reconciler, manual
dashboard grants — passes the SAME server-side fence at execution time:
1. Role is explicitly configured for that feature (workflow allowlist /
   `pro_role_id`) — never derived.
2. Role sits BELOW the bot's highest role (Discord enforces; we pre-check for
   a clean error instead of a 403).
3. Role carries NO privileged bits (ADMINISTRATOR, MANAGE_*, KICK_MEMBERS,
   BAN_MEMBERS, MENTION_EVERYONE, MODERATE_MEMBERS) — a fenced role picker in
   the UI AND a hard reject at execution, so a tampered config cannot escalate.
4. Every change lands in `role_audit` — no silent role mutations, ever.

## Acceptance (what the audit checks)

- Test-mode Stripe purchase with `client_reference_id` → entitlement row
  appears (source stripe) → within 60s the member holds the Pro role → Pro
  DMs flow (existing push worker, untouched).
- Test-mode cancel → revoke → role removed on the next tick.
- Webhook with a bad signature → 400, nothing written. Replayed event → no
  double-grant. Payment without client_reference_id → orphans queue, no grant.
- Pro role picker refuses a role with Manage Messages; a hand-edited
  `pro_role_id` pointing at an admin role is rejected at reconcile with a
  logged fence error.
- Editing the payment link in the Monetize tab changes the board's Go Pro
  button target without a deploy.
- All four role-change sources appear in `role_audit` with actor + reason.

## Bright lines

Stripe-hosted checkout only — no card data, no Stripe.js on our pages; webhook
signature verified always; identity = `client_reference_id` (session-derived
discord_id) only, email never used to guess; entitlement writes go through the
one existing grant/revoke path; role fences enforced at execution; every role
mutation audited; the model, the picks, and the push worker's decision logic
stay untouched.

## Build order

1. **M-2 first** (hivesync): invite perms + fence module + `role_audit` — WB-1's
   `grant_role` needs the same fences, so this unblocks both.
2. **M-1a** (picks-chat): webhook + entitlement columns + board button.
3. **M-1b** (hivesync): Monetize tab + reconciler.
4. Audit per the house loop (author excluded), then flip `enabled` — the tab's
   toggle is the go-live switch, not a deploy.

*Secrets: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` exist in the vault →
Vercel (picks-chat) env; `SUPABASE_URL`/`SERVICE_ROLE_KEY` → hivesync Render
env. The payment link URL itself is not a secret.*

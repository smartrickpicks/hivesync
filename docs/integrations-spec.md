# Integration API Spec — Otto Partner Brief

This brief lists what Otto needs from each of the four partner integrations (Scout, Forge, Relay, Pulse) so the actual API details can be filled in. Every concrete value the owner would need to annotate — auth values, endpoint paths, header names, payload field names — is wrapped in `<TODO: …>` markers below. We are NOT guessing these; the owner replies inline (or by reply email) and we merge before any wiring work starts.

The dashboard already has placeholder connection cards for Scout, Forge, and Pulse on the Settings tab — see `public/dashboard-user.html` (Scout ~line 624, Forge ~line 666, Pulse ~line 708). Relay has no card yet. The spec below feeds those UI cards; the cards remain inert until this document is signed off.

## Shared conventions (apply to all four integrations)

These apply to every vendor below unless an integration's own section overrides them.

- **Auth pattern.** Every provider exposes a REST API authenticated with a Bearer token in `Authorization: Bearer <key>`. Each vendor issues a key with the shape `<vendor>_live_<…>` — the dashboard input fields already show this placeholder shape (`scout_live_…` ~line 639, `forge_live_…` ~line 681, `pulse_live_…` ~line 723). Concretely, Relay will need `<TODO: confirm prefix — likely `relay_live_…`>`.
- **Transport.** HTTPS only. JSON request and response bodies. `Content-Type: application/json` on every Otto → provider call.
- **Outbound webhook signing** *(to confirm with owner — placeholder convention, do not assume real provider uses this exact shape)*: provider sends `X-<Vendor>-Signature` header containing an HMAC-SHA256 of the raw request body keyed with a shared secret Otto stores alongside the API key. Otto verifies the signature BEFORE persisting any payload. Exact header name and digest algorithm per vendor: `<TODO: confirm per vendor>`.
- **Idempotency.** Otto sends `Idempotency-Key: <uuid>` on every POST/PUT to a provider. The provider echoes the key back in the response and returns the original response on key reuse so retries are safe. Header name + max-TTL: `<TODO: confirm>`.
- **Base URL per vendor.** `<TODO: confirm per vendor — likely `https://api.<vendor>.com/v1/…` or similar — not invented here.>`
- **Rate limits.** Per-integration request budget and 429 backoff contract: `<TODO: confirm per vendor>`.

### Scout

**Purpose:** Connect Scout to surface community signals into Otto. (Per-product copy already shown on the Scout card, `public/dashboard-user.html` line 635.)

#### Auth
- Key format: `scout_live_<…>` — `<TODO: confirm prefix + length>`
- Issued via: `<TODO: confirm — does Scout have an Otto-facing partner console, or is the owner emailed a key directly?>`
- Signing secret for inbound webhooks: shared, distinct from the API key, `<TODO: confirm rotation policy>`
- Stored: append-only row in a new `integration_credentials` table with `vendor`, `api_key_encrypted`, `webhook_secret_encrypted`, `created_at`, `revoked_at` *(left as `<TODO: confirm column shape with owner>`; do not add the migration in this build)*.

#### Required endpoints (Otto → provider)
- `GET <TODO: confirm path>` — connection probe / health probe — request: empty; response: `{ "status": …, "<TODO: confirm field>": … }`.
- `GET <TODO: confirm path>` — list Scout signals (primary read; what Otto pulls on each sync). Response: `{ "items": [ { "id": <TODO>, "community_id": <TODO>, "text": <TODO>, "ts": <TODO>, "metadata": { … } } ] }`.
- `POST <TODO: confirm path>` — push Otto's classified intent/sentiment back to Scout so Scout's UI reflects Otto's read. Request: `{ "signal_id": <TODO>, "intent": <TODO>, "sentiment": <TODO>, "ai_response": <TODO> }`; response: `{ "ok": <TODO> }`.
- `POST <TODO: confirm path>` — disconnect / revoke. Request: empty; response: `{ "revoked_at": <TODO> }`.

#### Inbound webhooks (provider → Otto)
- **Event:** `signal.created` — `<TODO: confirm event name>` — payload: `{ "id": <TODO>, "community_id": <TODO>, "author": <TODO>, "text": <TODO>, "url": <TODO>, "posted_at": <TODO> }`. Otto handler: insert into `messages` table with intent=`unknown` initially, run the classifier on the next sweep.
- **Event:** `signal.updated` — `<TODO: confirm event name>` — payload mirrors `signal.created`. Otto handler: re-classify the row identified by `id`; preserve prior intent if confidence drops below threshold.
- **Event:** `signal.deleted` — `<TODO: confirm event name>` — payload: `{ "id": <TODO> }`. Otto handler: mark the matching `messages` row as deleted (soft delete; do not drop).

#### Open questions for owner
- Does Scout subscribe per-community or per-workspace? (Affects whether the API key maps to one `community_id` or many.)
- What's the message size / payload cap on inbound webhooks?

### Forge

**Purpose:** Connect Forge to ship community-driven automations into Otto. (Per-product copy already shown on the Forge card, `public/dashboard-user.html` line 677.)

#### Auth
- Key format: `forge_live_<…>` — `<TODO: confirm prefix + length>`
- Issued via: `<TODO: confirm — partner console vs. manual mint>`
- Webhook signing secret: `<TODO: confirm>`
- Stored: same `integration_credentials` table as above (column shape `<TODO: confirm with owner>`).

#### Required endpoints (Otto → provider)
- `GET <TODO: confirm path>` — connection probe — response: `{ "status": <TODO> }`.
- `GET <TODO: confirm path>` — list automations Forge will run for this community. Response: `{ "automations": [ { "id": <TODO>, "trigger": <TODO>, "steps": [ … ] } ] }`.
- `POST <TODO: confirm path>` — Otto enqueues an automation run (e.g. "post a digest"). Request: `{ "automation_id": <TODO>, "context": { "community_id": <TODO>, … } }`; response: `{ "run_id": <TODO>, "status": <TODO> }`.
- `GET <TODO: confirm path>` — fetch run status / logs. Response: `{ "run_id": <TODO>, "status": <TODO>, "started_at": <TODO>, "finished_at": <TODO>, "output": <TODO> }`.
- `POST <TODO: confirm path>` — disconnect / revoke. Response: `{ "revoked_at": <TODO> }`.

#### Inbound webhooks (provider → Otto)
- **Event:** `run.started` — `<TODO: confirm event name>` — payload: `{ "run_id": <TODO>, "automation_id": <TODO>, "started_at": <TODO> }`. Otto handler: insert a row into a `forge_runs` table (or whatever the owner's chosen ledger is) with status=running.
- **Event:** `run.completed` — `<TODO: confirm event name>` — payload: `{ "run_id": <TODO>, "status": <TODO>, "result": <TODO>, "finished_at": <TODO> }`. Otto handler: update the run row to its terminal state.
- **Event:** `run.failed` — `<TODO: confirm event name>` — payload: `{ "run_id": <TODO>, "error": <TODO>, "finished_at": <TODO> }`. Otto handler: surface the failure on the dashboard's Pending Reviews panel.

#### Open questions for owner
- Does Forge's run output stream back via webhooks only, or can Otto poll a status endpoint during long-running automations?
- Is there a per-run payload size cap we should chunk around?

### Relay

**Purpose:** Connect Relay to cross-post announcements and threads across Discord, Twitter, and forums — keeping every channel in sync. (Product copy currently lives in `public/index.html` line 1267–1268; the Settings tab does not yet have a Relay card. Owner: confirm the purpose line above or replace it.)

#### Auth
- Key format: `relay_live_<…>` *(assumed shape; consistent with Scout/Forge/Pulse)* — `<TODO: confirm prefix + length>`
- Issued via: `<TODO: confirm — likely partner console>`
- Webhook signing secret: `<TODO: confirm>`
- Stored: same `integration_credentials` table as above (column shape `<TODO: confirm with owner>`).

#### Required endpoints (Otto → provider)
- `GET <TODO: confirm path>` — connection probe — response: `{ "status": <TODO> }`.
- `GET <TODO: confirm path>` — list target channels Relay will fan out to for this community. Response: `{ "channels": [ { "id": <TODO>, "platform": <TODO>, "external_id": <TODO> } ] }`.
- `POST <TODO: confirm path>` — submit a single relay post. Request: `{ "content": <TODO>, "channels": [ <TODO> ], "scheduled_at": <TODO?> }`; response: `{ "relay_id": <TODO>, "status": <TODO> }`.
- `POST <TODO: confirm path>` — submit a thread (linked cross-posts). Request: `{ "thread_id": <TODO>, "posts": [ { "channel": <TODO>, "content": <TODO> } ] }`; response: `{ "thread_id": <TODO>, "relay_ids": [ <TODO> ] }`.
- `POST <TODO: confirm path>` — disconnect / revoke. Response: `{ "revoked_at": <TODO> }`.

#### Inbound webhooks (provider → Otto)
- **Event:** `relay.posted` — `<TODO: confirm event name>` — payload: `{ "relay_id": <TODO>, "channel": <TODO>, "external_url": <TODO>, "posted_at": <TODO> }`. Otto handler: record the cross-post in the configured communities' activity log so the dashboard reflects it.
- **Event:** `relay.failed` — `<TODO: confirm event name>` — payload: `{ "relay_id": <TODO>, "channel": <TODO>, "error": <TODO> }`. Otto handler: surface on the dashboard's Pending Reviews panel.
- **Event:** `relay.thread.completed` — `<TODO: confirm event name>` — payload: `{ "thread_id": <TODO>, "results": [ { "relay_id": <TODO>, "channel": <TODO>, "status": <TODO> } ] }`. Otto handler: upsert the thread's terminal state.

#### Open questions for owner
- Does Relay require us to pre-register each target channel, or does Otto supply channel IDs inline per post?
- Twitter API access requires OAuth user-context tokens — is the Relay API key sufficient, or does Otto need a separate per-vendor OAuth secret? `<TODO: confirm.>`
- The dashboard currently has no Relay card (Scout/Forge/Pulse only). Should we add a Relay card matching the Scout/Forge/Pulse pattern before shipping? `<TODO: confirm.>`

### Pulse

**Purpose:** Connect Pulse to stream community health metrics into Otto. (Per-product copy already shown on the Pulse card, `public/dashboard-user.html` line 719.)

#### Auth
- Key format: `pulse_live_<…>` — `<TODO: confirm prefix + length>`
- Issued via: `<TODO: confirm — partner console vs. manual mint>`
- Webhook signing secret: `<TODO: confirm>`
- Stored: same `integration_credentials` table as above (column shape `<TODO: confirm with owner>`).

#### Required endpoints (Otto → provider)
- `GET <TODO: confirm path>` — connection probe — response: `{ "status": <TODO> }`.
- `GET <TODO: confirm path>` — fetch latest community health snapshot (primary read). Response: `{ "community_id": <TODO>, "score": <TODO>, "components": { <TODO>: <TODO>, … }, "captured_at": <TODO> }`.
- `GET <TODO: confirm path>` — fetch health history for the dashboard's chart. Response: `{ "items": [ { "captured_at": <TODO>, "score": <TODO>, "components": { … } } ] }`.
- `POST <TODO: confirm path>` — push a curated weekly rollup back to Pulse (so Pulse's UI surfaces Otto's take). Request: `{ "community_id": <TODO>, "week_of": <TODO>, "rollup": { <TODO>: <TODO> } }`; response: `{ "ok": <TODO> }`.
- `POST <TODO: confirm path>` — disconnect / revoke. Response: `{ "revoked_at": <TODO> }`.

#### Inbound webhooks (provider → Otto)
- **Event:** `metric.updated` — `<TODO: confirm event name>` — payload: `{ "community_id": <TODO>, "metric": <TODO>, "value": <TODO>, "captured_at": <TODO> }`. Otto handler: append to a `pulse_metrics` table; consumed by the weekly rollup job.
- **Event:** `alert.raised` — `<TODO: confirm event name>` — payload: `{ "community_id": <TODO>, "metric": <TODO>, "threshold": <TODO>, "severity": <TODO>, "raised_at": <TODO> }`. Otto handler: surface on the dashboard's Pending Reviews panel.

#### Open questions for owner
- Cadence of `metric.updated`: real-time, every N minutes, or daily batch? Affects whether we accumulate rows or keep only the latest.
- Are component scores disclosed in real-time, or only in the daily snapshot endpoint?

## How to reply

Owner can either annotate inline in this markdown (the `<TODO: …>` markers are grep-friendly for that) or reply by email and we'll merge. Either way we want concrete values for every `<TODO>` before any of this gets built — the placeholder UI on the dashboard stays inert until then.

For the UI context this spec feeds, see the Settings tab in `public/dashboard-user.html` (Scout ~line 624, Forge ~line 666, Pulse ~line 708). Relay has no card yet — see its open question.

# Distribution V1 — social proof on owned channels (LEAN, reuses what's built)

**Goal:** strangers discover the Fixer via a public, honest track record. Reddit blocks
self-promo → owned channels are the play: **X (discovery), Discord (community), Substack
(depth).** Convert followers → members.

**Positioning (the edge):** post the HONEST record — wins AND losses, each graded and
sealed. Every betting account screams "🔒 LOCK." The Fixer's differentiator is calibration
+ refusal. The honest record IS the marketing.

## The one principle
One canonical feed (`picks_data.json`), many DUMB publishers. This is NOT the Content
Relay platform (object storage / outbox bus / MCP facade / approval queue as infra). The
feed is the asset; each surface is a small subscriber that reads it and dedups.

## Deterministic vs LLM split
- **Deterministic (no LLM):**
  - Picks → **Discord**: `picks-chat/api/cron/publish.js` — BUILT. Config only (webhook env
    + Pi curls it after each grade).
  - Picks → **X**: a small poster on the same feed, dedup like `publish.js`. Net-new, gated
    by X free-tier write limits (verify; else generate-for-manual).
- **LLM (via the hivesync dispatch bridge → Claude, APPROVE-gated):** reuses
  `/connectors/dispatch/*` + `dispatch_jobs` (BUILT) + the arcade `claude -p` watcher.
  Job types: `daily_recap` (settled results → record), `matchup_preview` (tomorrow's slate),
  `tweet_copy`. Claude drafts → **you approve** → `sendToChannel`/X posts. Nothing
  auto-posts unreviewed.
- **Substack:** generate via dispatch, **you one-click publish.** No stable write API —
  `substack-api` is read-only + deprecated; do NOT build auto-publish on it.

## Honest caveats
- The dispatch worker must be RUNNING to claim jobs → "automatic when the Mac + watcher are
  on." Fine for once-daily content; not 24/7 unless the watcher is hosted always-on.
- X free tier caps writes; confirm the daily volume fits before assuming full auto.
- Dispatch spends Claude usage (cheap for daily content on a Max plan).

## Sequence
1. **Discord picks** — `publish.js` config, tonight. (No build.)
2. **Daily recap generator** — dispatch job, the social-proof core. Small.
3. **X poster** — deterministic picks + the recap; auto if free tier holds, else draft-for-post.
4. **Substack** — dispatch generates preview+recap; you publish.
5. **Pick cards (images)** — revive/replace the Railway renderer later; text ships first.

## NON-goals (parked north-stars — build only at a 2nd consumer + revenue)
- Content Relay platform (ChatGPT spec) — the feed + dumb publishers replace it for V1.
- Full Member Context Protocol (16 tables + MCP facade) — the shipped `fixer_book_prefs` /
  `fixer_entitlements` / `fixer_session` already cover Phase 1; extend that one table pattern
  as onboarding needs, no facade.
- Any read-only MCP facade over content/members — premature at one consumer.

**Rule: generate once, publish everywhere through small governed subscribers — no platform
until paying members fund it.**

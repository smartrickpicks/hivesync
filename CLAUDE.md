# Hivesync — AI Community Management

## What this app does
Hivesync is an AI-powered community management agent that monitors Slack/Discord messages, classifies intent/sentiment, and responds helpfully to community members in real-time.

## Stack
Express.js + PostgreSQL (Neon) + Render + OpenAI API

## Directory map
- `server.js` — main entry (Express app, all routes + logic inline — refactor pending)
- `migrate.js` — database migration runner
- `migrations/` — SQL migration files
- `bot.js` — Slack bot / webhook handler
- `public/` — static assets (HTML pages)
- `test-fixtures/` — test data

## Database
- `messages` — community messages, intent/sentiment classification, AI responses
- `waitlist` — early access signups
- `communities` — community configurations

## External integrations
- **OpenAI** — message classification and AI response generation
- **Stripe** — payment processing
- **Polsia R2** — image uploads
- **Slack/Discord webhooks** — inbound community messages

## Recent changes
- 2026-07-06 — Add HTTP→HTTPS + www→non-www redirect for orbitwithotto.com
- 2026-07-06 — Otto landing page with SEO meta tags and /otto route
- 2026-05-20 — Initial migration setup for messages, waitlist, communities tables
# Server Setup — morning checklist (Zac's hands; Otto is walled off from deploys)

Two INDEPENDENT tracks. Track A (picks flowing) needs nothing deployed new. Track B
(dashboard) is the hivesync deploy so you can build community features in it.

---

## TRACK A — picks flowing to Discord (picks-chat is ALREADY on Vercel; config only)

The auto-poster (`api/cron/publish.js`) is live and gated (verified: `/api/cron/publish`
→ 401). It reads `picks_data.json`, routes by tier, posts webhook embeds, dedups. It just
has no webhook + no trigger yet.

1. **Discord:** make a webhook on your picks channel → copy the URL.
2. **Vercel (picks-chat project) → Settings → Env:** set
   - `DISCORD_WEBHOOK_ALL` = that webhook URL  (or per-tier: `DISCORD_WEBHOOK_TOP` /
     `_QUALIFIED` / `_WATCH` / `_PASS`)
   - `CRON_SECRET` = a random string (if not already set)
   - redeploy picks-chat so the env takes.
3. **Pi:** after each `make_snapshot`, add one line to the cron script:
   `curl -s -H "Authorization: Bearer $CRON_SECRET" https://picks-chat.vercel.app/api/cron/publish`
   (Pi is always-on → dodges Vercel's daily-cron limit; posts every grade cycle.)
4. **Test now:** `curl -s -H "Authorization: Bearer <CRON_SECRET>" https://picks-chat.vercel.app/api/cron/publish`
   → expect `{"ok":true,"posted":N,...}` and embeds land in the channel.
→ Picks flow. Ping Otto the webhook's set and he'll hit the endpoint to watch the first batch.

**Also push the receipts settlement (separate, ready):** `picks-chat` commit `8300eda`
(unpushed) makes receipts show WON/LOST live. `cd ~/Desktop/Airlock/picks-chat && vercel --prod`
after `git`-committing — verify the board still loads, revert `8300eda` if it blanks.

---

## TRACK B — deploy the hivesync dashboard (so you can build in it)

Needs a Postgres DB. Config is free-tier-safe already (`render.yaml`: `plan: free`,
migrations on build, `DATABASE_URL` env).

1. **Push the config:** `cd /Volumes/OttoVault/repos/hivesync && git push` (carries the
   render.yaml fixes to GitHub).
2. **Neon:** neon.tech → free project → copy the connection string (`DATABASE_URL`).
   (Reuse an existing hivesync Neon DB if you have one.)
3. **Render:** New → Web Service → connect `smartrickpicks/hivesync` → **Free** instance.
   Env: `DATABASE_URL` (Neon) + `DISCORD_BOT_TOKEN` (community bot). Build runs migrations.
4. **Open the dashboard** (the Render URL) → **Setup** tab → paste bot token + guild ID →
   bot connects, guild picker fills.
5. Now build in the dashboard: Channels / Composer / Sources / Scheduled are live.
→ Ping Otto the Render URL and he'll hit `/health` to confirm it's up.

**Cost note:** free tier sleeps on idle — fine for the dashboard + manual Composer sends;
the `plan: starter` (~$7/mo) upgrade is only needed later for unattended scheduling + the
WB-1a interaction bot. Deferred until revenue.

---

## What Otto CAN do once these are live (reads, not deploys)
- Hit `/api/cron/publish` with the secret to trigger + watch the first picks batch.
- Hit the Render `/health` to confirm the dashboard is up.
- Build/spec the next dashboard features (WB-1a runtime, recap generator) on request.

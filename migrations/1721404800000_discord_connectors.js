module.exports = {
  name: 'discord_connectors',
  up: async (client) => {
    // Channel routing (editable live from the dashboard, replaces env webhooks).
    await client.query(`
      create table if not exists discord_channels (
        tier text primary key, webhook_url text not null, label text,
        enabled boolean default true, updated_at timestamptz default now()
      )`);
    // Idempotent publish log — a (game/item, tier) posts at most once per day.
    await client.query(`
      create table if not exists discord_publish_log (
        dedup_key text primary key, kind text, posted_at timestamptz default now()
      )`);
    // Operator-managed RSS / news sources.
    await client.query(`
      create table if not exists rss_sources (
        id uuid primary key default gen_random_uuid(),
        url text not null, name text, route_tier text,
        source_tier int default 2, enabled boolean default true,
        added_at timestamptz default now()
      )`);
    // Scheduled + recurring posts (fired by the always-on runner in connectors.js).
    await client.query(`
      create table if not exists scheduled_posts (
        id uuid primary key default gen_random_uuid(),
        channel_key text not null, payload jsonb not null,
        run_at timestamptz, cron text, repeat boolean default false,
        last_run timestamptz, enabled boolean default true,
        created_at timestamptz default now()
      )`);
  },
};

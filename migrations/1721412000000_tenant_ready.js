module.exports = {
  name: 'tenant_ready',
  up: async (client) => {
    // Make the connector tables multi-guild ready WITHOUT changing single-guild
    // behavior. Every scoped table gains guild_id defaulting to 'default', so
    // existing rows and today's one-guild code keep working; a second guild just
    // writes a different guild_id. Enforcement (per-query filtering) is additive
    // in connectors.js — this migration only makes the data model ready.

    // Tenant registry.
    await client.query(`
      create table if not exists guilds (
        guild_id text primary key,
        name text,
        plan text default 'free',        -- free | pro | ...
        created_at timestamptz default now()
      )`);
    await client.query(
      `insert into guilds (guild_id, name) values ('default', 'Default workspace')
       on conflict (guild_id) do nothing`
    );

    // Tag every scoped table. add-column-if-not-exists keeps this idempotent.
    for (const t of ['discord_channels', 'discord_publish_log', 'rss_sources', 'scheduled_posts', 'dispatch_jobs', 'agent_devices']) {
      await client.query(`alter table ${t} add column if not exists guild_id text not null default 'default'`);
    }

    // discord_channels keyed on tier alone can't hold two guilds' 'top' channel.
    // Move the primary key to (guild_id, tier). Safe on near-empty data.
    await client.query(`alter table discord_channels drop constraint if exists discord_channels_pkey`);
    await client.query(`alter table discord_channels add primary key (guild_id, tier)`);

    // Guild-scoped read indexes.
    await client.query(`create index if not exists discord_channels_guild_idx    on discord_channels (guild_id)`);
    await client.query(`create index if not exists rss_sources_guild_idx         on rss_sources (guild_id)`);
    await client.query(`create index if not exists scheduled_posts_guild_idx     on scheduled_posts (guild_id)`);
    await client.query(`create index if not exists dispatch_jobs_guild_idx       on dispatch_jobs (guild_id, status, created_at)`);
    await client.query(`create index if not exists discord_publish_log_guild_idx on discord_publish_log (guild_id, posted_at)`);
  },
};

module.exports = {
  name: 'discord_setup',
  up: async (client) => {
    // Single-row config for the gateway bot — lets the dashboard's Setup tab
    // hold the bot token + guild instead of Render env vars. The token is a
    // secret: write-only through the API, masked in every read, never logged.
    await client.query(`
      create table if not exists discord_config (
        id             int primary key default 1 check (id = 1),
        bot_token      text,
        application_id text,
        guild_id       text,
        updated_at     timestamptz not null default now()
      )`);
  },
};

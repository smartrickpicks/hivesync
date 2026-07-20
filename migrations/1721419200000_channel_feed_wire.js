module.exports = {
  name: 'channel_feed_wire',
  up: async (client) => {
    // Map a feed row (tier → webhook) back to the Discord channel it posts
    // into, so the dashboard's Server tab can show which channels are wired
    // and one-click provision the rest. Tenant guild_id stays 'default' —
    // that's what the publisher and connectors read today.
    await client.query(`alter table discord_channels add column if not exists channel_id text`);
  },
};

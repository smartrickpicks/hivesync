const { Client, GatewayIntentBits, Events } = require('discord.js');

// Env-var path kept for backwards compatibility; the primary path is now the
// dashboard Setup tab → discord_config row → server calls connect(token).
const WEBHOOK_URL   = process.env.DISCORD_WEBHOOK_URL;
const ENV_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// Live wiring state — surfaced by /api/discord/status and /api/discord/setup so
// the dashboard can say exactly WHY it's empty instead of rendering blanks.
// No secrets: env/config names and booleans only, never values.
const state = {
  status: 'disabled',        // disabled | connecting | connected | error
  source: null,              // 'setup' (dashboard/db) | 'env' | null
  missing: [],               // what's missing when disabled (names only)
  bot_tag: null,
  guilds: 0,
  guild_list: [],            // [{ id, name }] — feeds the Setup tab's guild picker
  messages_seen: 0,          // gateway events this process lifetime
  joins_seen: 0,
  last_event_at: null,
  last_error: null,
};

let client = null;
let ingestFn = null;         // in-process ingest injected by server.js

function configure({ ingest } = {}) {
  if (typeof ingest === 'function') ingestFn = ingest;
}

function status() {
  return { ...state, guild_list: [...state.guild_list] };
}

function refreshGuilds() {
  if (!client) return;
  state.guilds = client.guilds.cache.size;
  state.guild_list = [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
}

async function disconnect() {
  if (client) {
    try { await client.destroy(); } catch (_) { /* already gone */ }
    client = null;
  }
  state.status = 'disabled';
  state.bot_tag = null;
  state.guilds = 0;
  state.guild_list = [];
}

// Hand an event to the server's in-process ingest (community resolution +
// classification + storage). Legacy HTTP webhook path only if no ingest was
// injected AND the old env var is set.
async function deliver(payload) {
  state.last_event_at = new Date().toISOString();
  try {
    if (ingestFn) { await ingestFn(payload); return; }
    if (!WEBHOOK_URL) return;
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      state.last_error = `ingest ${res.status}: ${text.slice(0, 120)}`;
      console.error(`[Discord Bot] Webhook rejected (${res.status}):`, text);
    }
  } catch (err) {
    state.last_error = `ingest failed: ${err.message}`;
    console.error('[Discord Bot] Ingest failed:', err.message);
  }
}

// Boot (or reboot) the gateway client with a token. `source` records where the
// token came from ('setup' = dashboard-stored config, 'env' = Render env var).
async function connect(token, source = 'setup') {
  if (!token) return;
  await disconnect();

  state.status = 'connecting';
  state.source = source;
  state.missing = [];
  state.last_error = null;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,   // privileged — must be enabled in the dev portal
      GatewayIntentBits.GuildMembers,     // privileged — must be enabled in the dev portal
    ],
  });

  client.once(Events.ClientReady, (c) => {
    state.status = 'connected';
    state.bot_tag = c.user.tag;
    state.last_error = null;
    refreshGuilds();
    console.log(`[Discord Bot] Connected as ${c.user.tag} (${state.guilds} guild(s), source: ${source})`);
  });

  client.on(Events.Error, (err) => {
    state.last_error = err.message;
    console.error('[Discord Bot] Client error:', err.message);
  });

  client.on(Events.GuildCreate, refreshGuilds);
  client.on(Events.GuildDelete, refreshGuilds);

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.content?.trim()) return;

    state.messages_seen++;
    await deliver({
      id:           message.id,
      content:      message.content,
      author:       { username: message.author.username, id: message.author.id },
      channel_name: message.channel.name || message.channelId,
      guild_id:     message.guildId || null,
      guild_name:   message.guild?.name || null,
      timestamp:    message.createdAt.toISOString(),
    });
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    state.joins_seen++;
    await deliver({
      content:      `New member joined: ${member.user.username}`,
      author:       { username: member.user.username, id: member.user.id },
      channel_name: 'members',
      guild_id:     member.guild.id,
      guild_name:   member.guild.name,
      timestamp:    new Date().toISOString(),
    });
  });

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    const oldRoles = [...oldMember.roles.cache.values()].map(r => r.name).filter(n => n !== '@everyone').sort();
    const newRoles = [...newMember.roles.cache.values()].map(r => r.name).filter(n => n !== '@everyone').sort();
    const added   = newRoles.filter(r => !oldRoles.includes(r));
    const removed = oldRoles.filter(r => !newRoles.includes(r));
    if (!added.length && !removed.length) return;

    const parts = [];
    if (added.length)   parts.push(`gained: ${added.join(', ')}`);
    if (removed.length) parts.push(`lost: ${removed.join(', ')}`);

    await deliver({
      content:      `Member ${newMember.user.username} role change — ${parts.join('; ')}`,
      author:       { username: newMember.user.username, id: newMember.user.id },
      channel_name: 'roles',
      guild_id:     newMember.guild.id,
      guild_name:   newMember.guild.name,
      timestamp:    new Date().toISOString(),
    });
  });

  await client.login(token).catch((err) => {
    // "Used disallowed intents" here = Message Content / Server Members not
    // toggled on under Developer Portal → Bot → Privileged Gateway Intents.
    state.status = 'error';
    state.last_error = err.message;
    console.error('[Discord Bot] Login failed:', err.message);
  });
}

// Env-var fallback boot (legacy). The server prefers the stored Setup config
// and only calls this when no config row carries a token.
function start() {
  if (!ENV_BOT_TOKEN) {
    state.status = 'disabled';
    state.missing = ['bot token — paste it in the dashboard: Community Ops → Setup'];
    console.log('[Discord Bot] No stored or env bot token — bot disabled (set it in the dashboard Setup tab)');
    return;
  }
  connect(ENV_BOT_TOKEN, 'env');
}

module.exports = { start, connect, disconnect, configure, status };

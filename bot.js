const { Client, GatewayIntentBits, Events } = require('discord.js');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;

// Live wiring state — surfaced by GET /api/discord/status so the dashboard can
// say exactly WHY it's empty instead of rendering blank panels. No secrets.
const state = {
  status: 'disabled',        // disabled | connecting | connected | error
  missing: [],               // env var NAMES missing when disabled (names only, never values)
  bot_tag: null,
  guilds: 0,
  messages_seen: 0,          // gateway events this process lifetime
  joins_seen: 0,
  last_event_at: null,
  last_error: null,
};

function status() {
  return { ...state };
}

function start() {
  const missing = [];
  if (!BOT_TOKEN) missing.push('DISCORD_BOT_TOKEN');
  if (!WEBHOOK_URL) missing.push('DISCORD_WEBHOOK_URL');
  if (missing.length) {
    state.status = 'disabled';
    state.missing = missing;
    console.log(`[Discord Bot] ${missing.join(' + ')} not set — bot disabled`);
    return;
  }

  state.status = 'connecting';
  const client = new Client({
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
    state.guilds = c.guilds.cache.size;
    state.last_error = null;
    console.log(`[Discord Bot] Connected as ${c.user.tag} (${state.guilds} guild(s))`);
  });

  client.on(Events.Error, (err) => {
    state.last_error = err.message;
    console.error('[Discord Bot] Client error:', err.message);
  });

  client.on(Events.GuildCreate, () => { state.guilds = client.guilds.cache.size; });
  client.on(Events.GuildDelete, () => { state.guilds = client.guilds.cache.size; });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.content?.trim()) return;

    state.messages_seen++;
    state.last_event_at = new Date().toISOString();
    await postToWebhook({
      id:           message.id,
      content:      message.content,
      author:       { username: message.author.username, id: message.author.id },
      channel_name: message.channel.name || message.channelId,
      timestamp:    message.createdAt.toISOString(),
    });
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    state.joins_seen++;
    state.last_event_at = new Date().toISOString();
    await postToWebhook({
      content:      `New member joined: ${member.user.username}`,
      author:       { username: member.user.username, id: member.user.id },
      channel_name: 'members',
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

    state.last_event_at = new Date().toISOString();
    await postToWebhook({
      content:      `Member ${newMember.user.username} role change — ${parts.join('; ')}`,
      author:       { username: newMember.user.username, id: newMember.user.id },
      channel_name: 'roles',
      timestamp:    new Date().toISOString(),
    });
  });

  client.login(BOT_TOKEN).catch((err) => {
    // "Used disallowed intents" here = the privileged intents (Message Content,
    // Server Members) are not toggled on in the Discord developer portal.
    state.status = 'error';
    state.last_error = err.message;
    console.error('[Discord Bot] Login failed:', err.message);
  });
}

async function postToWebhook(payload) {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      state.last_error = `ingest ${res.status}: ${text.slice(0, 120)}`;
      console.error(`[Discord Bot] Webhook rejected (${res.status}):`, text);
    }
  } catch (err) {
    state.last_error = `ingest failed: ${err.message}`;
    console.error('[Discord Bot] Failed to post to webhook:', err.message);
  }
}

module.exports = { start, status };

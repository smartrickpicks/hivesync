const { Client, GatewayIntentBits, Events } = require('discord.js');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;

function start() {
  if (!BOT_TOKEN || !WEBHOOK_URL) {
    console.log('[Discord Bot] DISCORD_BOT_TOKEN or DISCORD_WEBHOOK_URL not set — bot disabled');
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[Discord Bot] Connected as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.content?.trim()) return;

    await postToWebhook({
      id:           message.id,
      content:      message.content,
      author:       { username: message.author.username, id: message.author.id },
      channel_name: message.channel.name || message.channelId,
      timestamp:    message.createdAt.toISOString(),
    });
  });

  client.on(Events.GuildMemberAdd, async (member) => {
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

    await postToWebhook({
      content:      `Member ${newMember.user.username} role change — ${parts.join('; ')}`,
      author:       { username: newMember.user.username, id: newMember.user.id },
      channel_name: 'roles',
      timestamp:    new Date().toISOString(),
    });
  });

  client.login(BOT_TOKEN).catch((err) => {
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
      console.error(`[Discord Bot] Webhook rejected (${res.status}):`, text);
    }
  } catch (err) {
    console.error('[Discord Bot] Failed to post to webhook:', err.message);
  }
}

module.exports = { start };

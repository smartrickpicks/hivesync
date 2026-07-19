'use strict';
// connectors.js — the DETERMINISTIC Discord connector backend.
// Wired from server.js: require('./connectors')(app, pool).
// The dashboard (config panels) and the arcade dispatch lane BOTH call these —
// agent output and deterministic output share one path. No LLM in this file.
//
// Fail-closed: every route requires ADMIN_KEY. Webhook URLs are masked in reads.
// Multi-guild ready: every scoped query carries a guild_id (default 'default').

const crypto = require('crypto');
const ADMIN_KEY = process.env.ADMIN_KEY;

// Constant-time key compare (audit #6) — avoids timing side-channel on the key.
function safeEq(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function admin(req, res, next) {
  const k = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-admin-key'];
  if (!safeEq(k, ADMIN_KEY)) return res.status(401).json({ error: 'unauthorized' });
  next();
}
const mask = (u) => (u ? u.slice(0, 34) + '…' + u.slice(-6) : null);

// Which guild a request targets. Default 'default' keeps single-guild callers
// (today's dashboard + publisher, which send no guild) working unchanged.
function guildOf(req) {
  const g = req.headers['x-guild-id']
    || (req.body && req.body.guild_id)
    || (req.query && req.query.guild_id)
    || 'default';
  return String(g).slice(0, 64) || 'default';
}

// Shared send primitive — the Discohook core everything reuses. Logs EVERY send
// (audit #2): the deterministic embed/send, the scheduler, and approved drafts all
// land a discord_publish_log row so the dashboard log reflects real activity, not
// just approvals. Logging never blocks or fails a send.
async function sendToChannel(pool, guild_id, channel_key, payload, opts = {}) {
  const { rows } = await pool.query(
    'select webhook_url, enabled from discord_channels where guild_id=$1 and tier=$2', [guild_id, channel_key]
  );
  if (!rows[0] || !rows[0].enabled) return { ok: false, error: 'channel not configured/enabled' };
  const body = {};
  if (payload.content) body.content = String(payload.content).slice(0, 2000);
  if (payload.embed) body.embeds = [payload.embed];
  if (payload.embeds) body.embeds = payload.embeds;
  // Security: never ping by default. Operator must opt in explicitly (e.g. {parse:['roles']}).
  // Stops composed/agent-drafted content from injecting @everyone / mass mentions.
  body.allowed_mentions = payload.allowed_mentions || { parse: [] };
  const r = await fetch(rows[0].webhook_url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: `discord ${r.status}` };
  // Audit trail — one row per successful send. logKey lets a caller reuse its
  // pre-send dedup key (on-conflict no-op); otherwise generate a unique one.
  try {
    const logKey = opts.logKey || `send:${guild_id}:${channel_key}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
    await pool.query(
      `insert into discord_publish_log (dedup_key, kind, guild_id) values ($1,$2,$3) on conflict (dedup_key) do nothing`,
      [logKey, opts.kind || channel_key, guild_id]
    );
  } catch (e) { console.error('[connectors] send-log write failed', e.message); }
  return { ok: true };
}

module.exports = (app, pool) => {
  // ---- state (dashboard bootstrap) ----
  app.get('/connectors/state', admin, async (req, res) => {
    const g = guildOf(req);
    const [ch, src, sch] = await Promise.all([
      pool.query('select tier,label,enabled,webhook_url,updated_at from discord_channels where guild_id=$1 order by tier', [g]),
      pool.query('select id,url,name,route_tier,source_tier,enabled,added_at from rss_sources where guild_id=$1 order by added_at desc', [g]),
      pool.query('select id,channel_key,run_at,cron,repeat,enabled,last_run from scheduled_posts where guild_id=$1 order by run_at nulls last', [g]),
    ]);
    res.json({
      guild_id: g,
      channels: ch.rows.map((r) => ({ ...r, webhook_url: mask(r.webhook_url) })),
      sources: src.rows,
      scheduled: sch.rows,
    });
  });

  // ---- channels ----
  app.get('/connectors/channels', admin, async (req, res) => {
    const { rows } = await pool.query('select tier,label,enabled,webhook_url,updated_at from discord_channels where guild_id=$1 order by tier', [guildOf(req)]);
    res.json(rows.map((r) => ({ ...r, webhook_url: mask(r.webhook_url) })));
  });
  app.post('/connectors/channels', admin, async (req, res) => {
    const g = guildOf(req);
    const { tier, webhook_url, label, enabled = true } = req.body || {};
    if (!tier || !webhook_url) return res.status(400).json({ error: 'tier + webhook_url required' });
    await pool.query(
      `insert into discord_channels (guild_id,tier,webhook_url,label,enabled,updated_at) values ($1,$2,$3,$4,$5,now())
       on conflict (guild_id,tier) do update set webhook_url=$3,label=$4,enabled=$5,updated_at=now()`,
      [g, tier, webhook_url, label || tier, enabled]
    );
    res.json({ ok: true });
  });
  app.delete('/connectors/channels/:tier', admin, async (req, res) => {
    await pool.query('delete from discord_channels where guild_id=$1 and tier=$2', [guildOf(req), req.params.tier]);
    res.json({ ok: true });
  });

  // ---- embed / send (the Discohook primitive) ----
  app.post('/connectors/embed/send', admin, async (req, res) => {
    const g = guildOf(req);
    const { channel_key, embed, content } = req.body || {};
    if (!channel_key || (!embed && !content)) return res.status(400).json({ error: 'channel_key + embed|content required' });
    const out = await sendToChannel(pool, g, channel_key, { embed, content }, { kind: 'embed' });
    if (!out.ok) return res.status(out.error && out.error.startsWith('channel') ? 404 : 502).json(out);
    res.json({ ok: true });
  });

  // ---- rss sources ----
  app.get('/connectors/sources', admin, async (req, res) => {
    const { rows } = await pool.query('select * from rss_sources where guild_id=$1 order by added_at desc', [guildOf(req)]);
    res.json(rows);
  });
  app.post('/connectors/sources', admin, async (req, res) => {
    const g = guildOf(req);
    const { url, name, route_tier, source_tier = 2, enabled = true } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const { rows } = await pool.query(
      `insert into rss_sources (guild_id,url,name,route_tier,source_tier,enabled) values ($1,$2,$3,$4,$5,$6) returning *`,
      [g, url, name || url, route_tier || null, source_tier, enabled]
    );
    res.json(rows[0]);
  });
  app.delete('/connectors/sources/:id', admin, async (req, res) => {
    await pool.query('delete from rss_sources where id=$1 and guild_id=$2', [req.params.id, guildOf(req)]);
    res.json({ ok: true });
  });

  // ---- scheduled posts ----
  app.get('/connectors/scheduled', admin, async (req, res) => {
    const { rows } = await pool.query('select * from scheduled_posts where guild_id=$1 order by run_at nulls last', [guildOf(req)]);
    res.json(rows);
  });
  app.post('/connectors/scheduled', admin, async (req, res) => {
    const g = guildOf(req);
    const { channel_key, payload, run_at, cron, repeat = false } = req.body || {};
    if (!channel_key || !payload) return res.status(400).json({ error: 'channel_key + payload required' });
    const { rows } = await pool.query(
      `insert into scheduled_posts (guild_id,channel_key,payload,run_at,cron,repeat) values ($1,$2,$3,$4,$5,$6) returning *`,
      [g, channel_key, payload, run_at || null, cron || null, repeat]
    );
    res.json(rows[0]);
  });
  app.delete('/connectors/scheduled/:id', admin, async (req, res) => {
    await pool.query('delete from scheduled_posts where id=$1 and guild_id=$2', [req.params.id, guildOf(req)]);
    res.json({ ok: true });
  });

  // ---- publish log (dashboard "see scheduled/posted") ----
  app.get('/connectors/log', admin, async (req, res) => {
    const { rows } = await pool.query('select * from discord_publish_log where guild_id=$1 order by posted_at desc limit 200', [guildOf(req)]);
    res.json(rows);
  });

  // ---- dispatch bridge (Command Otto → outbound local agent) ----
  // Agent auth = AGENT_KEY (separate credential, NOT the master ADMIN_KEY).
  function agentAuth(req, res, next) {
    const k = req.headers['x-agent-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!safeEq(k, process.env.AGENT_KEY)) return res.status(401).json({ error: 'unauthorized agent' });
    next();
  }
  // dashboard creates a job
  app.post('/connectors/dispatch', admin, async (req, res) => {
    const g = guildOf(req);
    const { capability, payload, allowed_projects, created_by } = req.body || {};
    if (!capability) return res.status(400).json({ error: 'capability required' });
    const { rows } = await pool.query(
      `insert into dispatch_jobs (guild_id,capability,payload,allowed_projects,created_by) values ($1,$2,$3,$4,$5) returning id,status`,
      [g, capability, payload || {}, allowed_projects || [], created_by || 'dashboard']
    );
    res.json(rows[0]);
  });
  app.get('/connectors/dispatch', admin, async (req, res) => {
    const { rows } = await pool.query('select id,guild_id,capability,status,error,created_by,created_at,updated_at from dispatch_jobs where guild_id=$1 order by created_at desc limit 100', [guildOf(req)]);
    res.json(rows);
  });
  // agent leases ONE queued job atomically (skip-locked). The operator's agent is
  // guild-agnostic; the job carries its own guild_id downstream.
  app.post('/connectors/dispatch/claim', agentAuth, async (req, res) => {
    const owner = String((req.body && req.body.device) || 'agent').slice(0, 64);
    const { rows } = await pool.query(
      `update dispatch_jobs set status='claimed', lease_owner=$1, lease_expires_at=now()+interval '5 minutes', updated_at=now()
       where id=(select id from dispatch_jobs where status='queued' order by created_at limit 1 for update skip locked)
       returning id,guild_id,capability,payload,allowed_projects`, [owner]
    );
    res.json(rows[0] || {});
  });
  app.post('/connectors/dispatch/:id/result', agentAuth, async (req, res) => {
    const { status, output, error } = req.body || {};
    const st = ['succeeded', 'failed', 'awaiting_approval', 'running'].includes(status) ? status : 'succeeded';
    await pool.query(
      `update dispatch_jobs set status=$2, result=$3, error=$4, lease_owner=null, lease_expires_at=null, updated_at=now() where id=$1`,
      [req.params.id, st, output != null ? { output } : null, error || null]
    );
    res.json({ ok: true });
  });
  app.post('/connectors/agents/heartbeat', agentAuth, async (req, res) => {
    const id = String((req.body && req.body.device) || 'agent').slice(0, 64);
    await pool.query(
      `insert into agent_devices (device_id,name,last_seen) values ($1,$1,now())
       on conflict (device_id) do update set last_seen=now()`, [id]
    );
    res.json({ ok: true });
  });
  // human approves a drafted result → publish through the SAME delivery path
  app.post('/connectors/dispatch/:id/approve', admin, async (req, res) => {
    const { channel_key } = req.body || {};
    const { rows } = await pool.query('select guild_id, result, status from dispatch_jobs where id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    if (rows[0].status === 'succeeded') return res.json({ ok: true, already: true }); // already published — no double-post
    const g = rows[0].guild_id || 'default';
    const draft = rows[0].result && rows[0].result.output;
    if (!channel_key || !draft) return res.status(400).json({ error: 'channel_key + a drafted result required' });
    // atomic dedup: one publish per job id (audit #1/#2)
    const dedupKey = `dispatch:${req.params.id}`;
    const dedup = await pool.query(
      `insert into discord_publish_log (dedup_key, kind, guild_id) values ($1,'dispatch',$2) on conflict (dedup_key) do nothing returning dedup_key`,
      [dedupKey, g]
    );
    if (!dedup.rows.length) {
      await pool.query(`update dispatch_jobs set status='succeeded', updated_at=now() where id=$1`, [req.params.id]);
      return res.json({ ok: true, already: true });
    }
    // reuse the dedup key as the send logKey so sendToChannel's audit insert is a no-op, not a second row
    const out = await sendToChannel(pool, g, channel_key, typeof draft === 'string' ? { content: draft } : draft, { logKey: dedupKey, kind: 'dispatch' });
    if (!out.ok) return res.status(502).json(out);
    await pool.query(`update dispatch_jobs set status='succeeded', updated_at=now() where id=$1`, [req.params.id]);
    res.json({ ok: true });
  });

  // ---- always-on scheduler: fire due one-shot scheduled_posts every 60s ----
  async function tick() {
    try {
      // requeue jobs whose agent lease expired (agent died mid-run)
      await pool.query(
        `update dispatch_jobs set status='queued', lease_owner=null, lease_expires_at=null, updated_at=now()
         where status in ('claimed','running') and lease_expires_at is not null and lease_expires_at < now()`
      );
      const { rows } = await pool.query(
        `select * from scheduled_posts where enabled and run_at is not null and run_at <= now() and last_run is null limit 25`
      );
      for (const p of rows) {
        const out = await sendToChannel(pool, p.guild_id || 'default', p.channel_key, p.payload, { kind: 'scheduled' });
        if (!out.ok) console.error('[connectors] scheduled post failed', p.id, out.error); // not silent (audit #3)
        await pool.query('update scheduled_posts set last_run=now() where id=$1', [p.id]);
        if (out.ok && !p.repeat) await pool.query('update scheduled_posts set enabled=false where id=$1', [p.id]);
      }
    } catch (e) {
      console.error('[connectors scheduler]', e.message);
    }
  }
  if (ADMIN_KEY) setInterval(tick, 60000);

  console.log('[connectors] Discord connector routes mounted' + (ADMIN_KEY ? '' : ' (ADMIN_KEY unset — routes 401 until set)'));
};

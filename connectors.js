'use strict';
// connectors.js — the DETERMINISTIC Discord connector backend.
// Wired from server.js: require('./connectors')(app, pool).
// The dashboard (config panels) and the arcade dispatch lane BOTH call these —
// agent output and deterministic output share one path. No LLM in this file.
//
// Fail-closed: every route requires ADMIN_KEY. Webhook URLs are masked in reads.

const ADMIN_KEY = process.env.ADMIN_KEY;

function admin(req, res, next) {
  const k = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-admin-key'];
  if (!ADMIN_KEY || k !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}
const mask = (u) => (u ? u.slice(0, 34) + '…' + u.slice(-6) : null);

// Shared send primitive — the Discohook core everything reuses.
async function sendToChannel(pool, channel_key, payload) {
  const { rows } = await pool.query(
    'select webhook_url, enabled from discord_channels where tier=$1', [channel_key]
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
  return r.ok ? { ok: true } : { ok: false, error: `discord ${r.status}` };
}

module.exports = (app, pool) => {
  // ---- state (dashboard bootstrap) ----
  app.get('/connectors/state', admin, async (req, res) => {
    const [ch, src, sch] = await Promise.all([
      pool.query('select tier,label,enabled,webhook_url,updated_at from discord_channels order by tier'),
      pool.query('select id,url,name,route_tier,source_tier,enabled,added_at from rss_sources order by added_at desc'),
      pool.query('select id,channel_key,run_at,cron,repeat,enabled,last_run from scheduled_posts order by run_at nulls last'),
    ]);
    res.json({
      channels: ch.rows.map((r) => ({ ...r, webhook_url: mask(r.webhook_url) })),
      sources: src.rows,
      scheduled: sch.rows,
    });
  });

  // ---- channels ----
  app.get('/connectors/channels', admin, async (req, res) => {
    const { rows } = await pool.query('select tier,label,enabled,webhook_url,updated_at from discord_channels order by tier');
    res.json(rows.map((r) => ({ ...r, webhook_url: mask(r.webhook_url) })));
  });
  app.post('/connectors/channels', admin, async (req, res) => {
    const { tier, webhook_url, label, enabled = true } = req.body || {};
    if (!tier || !webhook_url) return res.status(400).json({ error: 'tier + webhook_url required' });
    await pool.query(
      `insert into discord_channels (tier,webhook_url,label,enabled,updated_at) values ($1,$2,$3,$4,now())
       on conflict (tier) do update set webhook_url=$2,label=$3,enabled=$4,updated_at=now()`,
      [tier, webhook_url, label || tier, enabled]
    );
    res.json({ ok: true });
  });
  app.delete('/connectors/channels/:tier', admin, async (req, res) => {
    await pool.query('delete from discord_channels where tier=$1', [req.params.tier]);
    res.json({ ok: true });
  });

  // ---- embed / send (the Discohook primitive) ----
  app.post('/connectors/embed/send', admin, async (req, res) => {
    const { channel_key, embed, content } = req.body || {};
    if (!channel_key || (!embed && !content)) return res.status(400).json({ error: 'channel_key + embed|content required' });
    const out = await sendToChannel(pool, channel_key, { embed, content });
    if (!out.ok) return res.status(out.error && out.error.startsWith('channel') ? 404 : 502).json(out);
    res.json({ ok: true });
  });

  // ---- rss sources ----
  app.get('/connectors/sources', admin, async (req, res) => {
    const { rows } = await pool.query('select * from rss_sources order by added_at desc');
    res.json(rows);
  });
  app.post('/connectors/sources', admin, async (req, res) => {
    const { url, name, route_tier, source_tier = 2, enabled = true } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const { rows } = await pool.query(
      `insert into rss_sources (url,name,route_tier,source_tier,enabled) values ($1,$2,$3,$4,$5) returning *`,
      [url, name || url, route_tier || null, source_tier, enabled]
    );
    res.json(rows[0]);
  });
  app.delete('/connectors/sources/:id', admin, async (req, res) => {
    await pool.query('delete from rss_sources where id=$1', [req.params.id]);
    res.json({ ok: true });
  });

  // ---- scheduled posts ----
  app.get('/connectors/scheduled', admin, async (req, res) => {
    const { rows } = await pool.query('select * from scheduled_posts order by run_at nulls last');
    res.json(rows);
  });
  app.post('/connectors/scheduled', admin, async (req, res) => {
    const { channel_key, payload, run_at, cron, repeat = false } = req.body || {};
    if (!channel_key || !payload) return res.status(400).json({ error: 'channel_key + payload required' });
    const { rows } = await pool.query(
      `insert into scheduled_posts (channel_key,payload,run_at,cron,repeat) values ($1,$2,$3,$4,$5) returning *`,
      [channel_key, payload, run_at || null, cron || null, repeat]
    );
    res.json(rows[0]);
  });
  app.delete('/connectors/scheduled/:id', admin, async (req, res) => {
    await pool.query('delete from scheduled_posts where id=$1', [req.params.id]);
    res.json({ ok: true });
  });

  // ---- publish log (dashboard "see scheduled/posted") ----
  app.get('/connectors/log', admin, async (req, res) => {
    const { rows } = await pool.query('select * from discord_publish_log order by posted_at desc limit 200');
    res.json(rows);
  });

  // ---- dispatch bridge (Command Otto → outbound local agent) ----
  // Agent auth = AGENT_KEY (separate credential, NOT the master ADMIN_KEY).
  function agentAuth(req, res, next) {
    const k = req.headers['x-agent-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!process.env.AGENT_KEY || k !== process.env.AGENT_KEY) return res.status(401).json({ error: 'unauthorized agent' });
    next();
  }
  // dashboard creates a job
  app.post('/connectors/dispatch', admin, async (req, res) => {
    const { capability, payload, allowed_projects, created_by } = req.body || {};
    if (!capability) return res.status(400).json({ error: 'capability required' });
    const { rows } = await pool.query(
      `insert into dispatch_jobs (capability,payload,allowed_projects,created_by) values ($1,$2,$3,$4) returning id,status`,
      [capability, payload || {}, allowed_projects || [], created_by || 'dashboard']
    );
    res.json(rows[0]);
  });
  app.get('/connectors/dispatch', admin, async (req, res) => {
    const { rows } = await pool.query('select id,capability,status,error,created_by,created_at,updated_at from dispatch_jobs order by created_at desc limit 100');
    res.json(rows);
  });
  // agent leases ONE queued job atomically (skip-locked)
  app.post('/connectors/dispatch/claim', agentAuth, async (req, res) => {
    const owner = String((req.body && req.body.device) || 'agent').slice(0, 64);
    const { rows } = await pool.query(
      `update dispatch_jobs set status='claimed', lease_owner=$1, lease_expires_at=now()+interval '5 minutes', updated_at=now()
       where id=(select id from dispatch_jobs where status='queued' order by created_at limit 1 for update skip locked)
       returning id,capability,payload,allowed_projects`, [owner]
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
    const { rows } = await pool.query('select result from dispatch_jobs where id=$1', [req.params.id]);
    const draft = rows[0] && rows[0].result && rows[0].result.output;
    if (!channel_key || !draft) return res.status(400).json({ error: 'channel_key + a drafted result required' });
    const out = await sendToChannel(pool, channel_key, typeof draft === 'string' ? { content: draft } : draft);
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
        const out = await sendToChannel(pool, p.channel_key, p.payload);
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

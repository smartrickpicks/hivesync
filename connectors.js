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

  // ---- always-on scheduler: fire due one-shot scheduled_posts every 60s ----
  async function tick() {
    try {
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

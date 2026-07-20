const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// OpenAI client — uses OPENAI_API_KEY or Polsia AI proxy
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'unused',
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

app.use(express.json({ limit: '1mb' }));

// ──────────────────────────────────────────────
// HTTP → HTTPS + www → non-www redirect
// ──────────────────────────────────────────────

const CUSTOM_DOMAINS = ['orbitwithotto.com', 'www.orbitwithotto.com'];

function getCanonicalHost(req) {
  const raw =
    req.headers['x-original-host'] ||
    req.headers['x-forwarded-host']?.split(',')[0]?.trim() ||
    req.headers.host ||
    '';
  return raw.split(':')[0].toLowerCase();
}

app.use((req, res, next) => {
  const host = getCanonicalHost(req);
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const isCustomDomain = CUSTOM_DOMAINS.includes(host);

  if (isCustomDomain && proto !== 'https') {
    return res.redirect(301, `https://orbitwithotto.com${req.url}`);
  }
  if (host === 'www.orbitwithotto.com') {
    return res.redirect(301, `https://orbitwithotto.com${req.url}`);
  }
  next();
});

// Health check endpoint (required for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'hivesync', version: '1.0.0' });
});

// Serve static files from public folder (extension-less URLs like /privacy resolve to /privacy.html)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));


// ──────────────────────────────────────────────
// AI Classification Engine
// ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Hivesync, an AI community management agent. You analyze community messages and respond helpfully.

For each message, you must return a JSON object with:
- intent: one of "question", "feedback", "introduction", "support_request", "discussion", "spam"
- sentiment: one of "positive", "neutral", "negative"
- confidence: a number between 0 and 1 indicating classification confidence
- response: a helpful, on-brand response to the message (2-4 sentences, warm but professional)
- reasoning: one sentence explaining why you classified the message this way

Rules for responses:
- Questions: provide a direct answer or acknowledge and promise follow-up
- Feedback: thank them sincerely, acknowledge the specific point
- Introductions: welcome them warmly, ask what they're working on
- Support requests: acknowledge the issue, provide next steps or escalation
- Discussion: contribute meaningfully, ask a follow-up question
- Spam: respond with "SPAM_DETECTED" as the response

Always respond in valid JSON only. No markdown, no wrapping.`;

async function classifyMessage(content, authorName, channel) {
  try {
    const userPrompt = `Analyze this community message and respond with JSON:

Author: ${authorName || 'Anonymous'}
Channel: ${channel || 'general'}
Message: "${content}"`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      // Polsia AI proxy routing
      ...(process.env.POLSIA_AI_PROXY && { task: 'community-message-classification' }),
    });

    const result = JSON.parse(completion.choices[0].message.content);

    return {
      intent: result.intent || 'discussion',
      sentiment: result.sentiment || 'neutral',
      confidence: Math.min(1, Math.max(0, parseFloat(result.confidence) || 0.5)),
      response: result.response || '',
      reasoning: result.reasoning || '',
    };
  } catch (err) {
    console.error('[AI Classification Error]', err.message);
    // Fallback: return basic classification without AI
    return {
      intent: 'discussion',
      sentiment: 'neutral',
      confidence: 0,
      response: '',
      reasoning: 'AI classification unavailable — fallback to default',
    };
  }
}


// ──────────────────────────────────────────────
// POST /api/messages — Ingest + classify a message
// ──────────────────────────────────────────────

app.post('/api/messages', async (req, res) => {
  try {
    const {
      content,
      platform = 'api',
      channel,
      author_name,
      author_id,
      external_id,
      metadata = {}
    } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'content is required and must be a non-empty string'
      });
    }

    if (content.length > 10000) {
      return res.status(400).json({
        success: false,
        message: 'content must be under 10,000 characters'
      });
    }

    // Classify with AI
    const classification = await classifyMessage(content, author_name, channel);

    // Store in database
    const result = await pool.query(
      `INSERT INTO messages
        (external_id, platform, channel, author_name, author_id, content,
         intent, sentiment, confidence, ai_response, response_status, metadata,
         processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       RETURNING *`,
      [
        external_id || null,
        platform,
        channel || null,
        author_name || null,
        author_id || null,
        content.trim(),
        classification.intent,
        classification.sentiment,
        classification.confidence,
        classification.response,
        classification.intent === 'spam' ? 'rejected' : 'suggested',
        JSON.stringify({ ...metadata, reasoning: classification.reasoning })
      ]
    );

    const message = result.rows[0];

    console.log(`[Message] ${message.id} | ${classification.intent} (${classification.confidence}) | ${platform}/${channel || 'general'}`);

    res.status(201).json({
      success: true,
      message: {
        id: message.id,
        content: message.content,
        platform: message.platform,
        channel: message.channel,
        author_name: message.author_name,
        created_at: message.created_at,
      },
      classification: {
        intent: classification.intent,
        sentiment: classification.sentiment,
        confidence: classification.confidence,
      },
      suggested_response: classification.intent !== 'spam' ? classification.response : null,
      response_status: message.response_status,
    });
  } catch (err) {
    console.error('[POST /api/messages]', err.message);
    res.status(500).json({ success: false, message: 'Failed to process message' });
  }
});


// ──────────────────────────────────────────────
// GET /api/messages — List messages with filters
// ──────────────────────────────────────────────

app.get('/api/messages', async (req, res) => {
  try {
    const {
      intent,
      sentiment,
      platform,
      status,
      limit = 50,
      offset = 0,
      sort = 'newest'
    } = req.query;

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (intent) {
      conditions.push(`intent = $${paramIdx++}`);
      params.push(intent);
    }
    if (sentiment) {
      conditions.push(`sentiment = $${paramIdx++}`);
      params.push(sentiment);
    }
    if (platform) {
      conditions.push(`platform = $${paramIdx++}`);
      params.push(platform);
    }
    if (status) {
      conditions.push(`response_status = $${paramIdx++}`);
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderDir = sort === 'oldest' ? 'ASC' : 'DESC';
    const safeLimit = Math.min(parseInt(limit) || 50, 200);
    const safeOffset = parseInt(offset) || 0;

    const query = `
      SELECT id, external_id, platform, channel, author_name, author_id,
             content, intent, sentiment, confidence, ai_response,
             response_status, metadata, created_at, processed_at
      FROM messages
      ${where}
      ORDER BY created_at ${orderDir}
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(safeLimit, safeOffset);

    const countQuery = `SELECT COUNT(*) as total FROM messages ${where}`;
    const countParams = params.slice(0, params.length - 2);

    const [messagesResult, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams)
    ]);

    res.json({
      success: true,
      messages: messagesResult.rows,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit: safeLimit,
        offset: safeOffset,
      }
    });
  } catch (err) {
    console.error('[GET /api/messages]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch messages' });
  }
});


// ──────────────────────────────────────────────
// GET /api/messages/:id — Get single message
// ──────────────────────────────────────────────

app.get('/api/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }

    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error('[GET /api/messages/:id]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch message' });
  }
});


// ──────────────────────────────────────────────
// PATCH /api/messages/:id/respond — Approve/edit response
// ──────────────────────────────────────────────

app.patch('/api/messages/:id/respond', async (req, res) => {
  try {
    const { id } = req.params;
    const { action, edited_response } = req.body;

    if (!['approve', 'reject', 'edit'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'action must be one of: approve, reject, edit'
      });
    }

    if (action === 'edit' && (!edited_response || edited_response.trim().length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'edited_response is required when action is "edit"'
      });
    }

    let query, params;

    if (action === 'approve') {
      query = `UPDATE messages SET response_status = 'approved', responded_at = NOW() WHERE id = $1 RETURNING *`;
      params = [id];
    } else if (action === 'reject') {
      query = `UPDATE messages SET response_status = 'rejected', responded_at = NOW() WHERE id = $1 RETURNING *`;
      params = [id];
    } else {
      query = `UPDATE messages SET ai_response = $1, response_status = 'approved', responded_at = NOW() WHERE id = $2 RETURNING *`;
      params = [edited_response.trim(), id];
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }

    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error('[PATCH /api/messages/:id/respond]', err.message);
    res.status(500).json({ success: false, message: 'Failed to update response' });
  }
});


// ──────────────────────────────────────────────
// GET /api/analytics — Message analytics dashboard
// ──────────────────────────────────────────────

app.get('/api/analytics', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const safeDays = Math.min(parseInt(days) || 30, 365);
    const since = `NOW() - INTERVAL '${safeDays} days'`;

    const [
      totalResult,
      intentResult,
      sentimentResult,
      platformResult,
      dailyResult,
      responseResult,
      recentResult
    ] = await Promise.all([
      // Total messages
      pool.query(`SELECT COUNT(*) as total FROM messages WHERE created_at >= ${since}`),

      // By intent
      pool.query(`
        SELECT intent, COUNT(*) as count
        FROM messages WHERE created_at >= ${since}
        GROUP BY intent ORDER BY count DESC
      `),

      // By sentiment
      pool.query(`
        SELECT sentiment, COUNT(*) as count
        FROM messages WHERE created_at >= ${since}
        GROUP BY sentiment ORDER BY count DESC
      `),

      // By platform
      pool.query(`
        SELECT platform, COUNT(*) as count
        FROM messages WHERE created_at >= ${since}
        GROUP BY platform ORDER BY count DESC
      `),

      // Daily volume (last N days)
      pool.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM messages WHERE created_at >= ${since}
        GROUP BY DATE(created_at) ORDER BY date DESC
        LIMIT ${safeDays}
      `),

      // Response status breakdown
      pool.query(`
        SELECT response_status, COUNT(*) as count
        FROM messages WHERE created_at >= ${since}
        GROUP BY response_status ORDER BY count DESC
      `),

      // Most recent messages
      pool.query(`
        SELECT id, content, intent, sentiment, platform, channel,
               author_name, ai_response, response_status, created_at
        FROM messages
        ORDER BY created_at DESC LIMIT 10
      `)
    ]);

    // Avg confidence
    const avgConfResult = await pool.query(`
      SELECT ROUND(AVG(confidence)::numeric, 3) as avg_confidence
      FROM messages WHERE created_at >= ${since} AND confidence > 0
    `);

    res.json({
      success: true,
      analytics: {
        period_days: safeDays,
        total_messages: parseInt(totalResult.rows[0].total),
        avg_confidence: parseFloat(avgConfResult.rows[0]?.avg_confidence || 0),
        by_intent: intentResult.rows.map(r => ({ intent: r.intent, count: parseInt(r.count) })),
        by_sentiment: sentimentResult.rows.map(r => ({ sentiment: r.sentiment, count: parseInt(r.count) })),
        by_platform: platformResult.rows.map(r => ({ platform: r.platform, count: parseInt(r.count) })),
        by_response_status: responseResult.rows.map(r => ({ status: r.response_status, count: parseInt(r.count) })),
        daily_volume: dailyResult.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
      },
      recent_messages: recentResult.rows,
    });
  } catch (err) {
    console.error('[GET /api/analytics]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
  }
});


// ──────────────────────────────────────────────
// POST /api/messages/batch — Bulk ingest (no AI)
// ──────────────────────────────────────────────

app.post('/api/messages/batch', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'messages must be a non-empty array'
      });
    }

    if (messages.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 100 messages per batch'
      });
    }

    const inserted = [];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const msg of messages) {
        if (!msg.content || typeof msg.content !== 'string') continue;

        const result = await client.query(
          `INSERT INTO messages
            (external_id, platform, channel, author_name, author_id, content,
             response_status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
           RETURNING id, content, platform`,
          [
            msg.external_id || null,
            msg.platform || 'api',
            msg.channel || null,
            msg.author_name || null,
            msg.author_id || null,
            msg.content.trim().slice(0, 10000),
            JSON.stringify(msg.metadata || {})
          ]
        );
        inserted.push(result.rows[0]);
      }

      await client.query('COMMIT');
    } catch (batchErr) {
      await client.query('ROLLBACK');
      throw batchErr;
    } finally {
      client.release();
    }

    res.status(201).json({
      success: true,
      inserted: inserted.length,
      messages: inserted,
      note: 'Batch messages ingested without AI classification. Use POST /api/messages for real-time classification.'
    });
  } catch (err) {
    console.error('[POST /api/messages/batch]', err.message);
    res.status(500).json({ success: false, message: 'Failed to batch ingest messages' });
  }
});


// ──────────────────────────────────────────────
// POST /api/waitlist — Join the waitlist
// ──────────────────────────────────────────────

app.post('/api/waitlist', async (req, res) => {
  try {
    const { email, name, platform, community_size, referral_source } = req.body;

    // Email validation
    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address'
      });
    }

    // Validate platform if provided
    const validPlatforms = ['discord', 'slack', 'forums', 'other'];
    const safePlatform = platform && validPlatforms.includes(platform.toLowerCase())
      ? platform.toLowerCase()
      : null;

    // Validate community size if provided
    const validSizes = ['1-100', '100-1000', '1000-10000', '10000+'];
    const safeSize = community_size && validSizes.includes(community_size)
      ? community_size
      : null;

    // Insert (or return existing if duplicate email)
    const result = await pool.query(
      `INSERT INTO waitlist (email, name, platform, community_size, referral_source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ((LOWER(email))) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, created_at`,
      [
        trimmedEmail,
        name ? name.trim().slice(0, 255) : null,
        safePlatform,
        safeSize,
        referral_source ? referral_source.trim().slice(0, 255) : null
      ]
    );

    const entry = result.rows[0];

    // Get position on waitlist
    const posResult = await pool.query(
      `SELECT COUNT(*) as position FROM waitlist WHERE id <= $1`,
      [entry.id]
    );
    const position = parseInt(posResult.rows[0].position);

    // Get total count
    const totalResult = await pool.query('SELECT COUNT(*) as total FROM waitlist');
    const total = parseInt(totalResult.rows[0].total);

    console.log(`[Waitlist] #${position} — ${trimmedEmail} (${safePlatform || 'no platform'})`);

    // Send email notifications (best-effort — never block the 201 response)
    try {
      const emailBase = `${process.env.POLSIA_API_BASE_URL}/api/proxy/email/send`;
      const authHeader = `Bearer ${process.env.POLSIA_API_TOKEN || process.env.POLSIA_API_KEY}`;

      const ownerBody = [
        `New Otto waitlist signup`,
        ``,
        `Email: ${trimmedEmail}`,
        name ? `Name: ${name.trim().slice(0, 255)}` : null,
        safePlatform ? `Platform: ${safePlatform}` : null,
        safeSize ? `Community size: ${safeSize}` : null,
        ``,
        `Waitlist position: #${position} of ${total}`,
      ].filter(line => line !== null).join('\n');

      const confirmBody = [
        `You're on the Otto waitlist.`,
        ``,
        `Position: #${position}`,
        ``,
        `Otto is an autonomous community intelligence agent — built to operate in the dark, classify intent, and surface what matters before anyone asks.`,
        ``,
        `We'll reach out when your access is ready. Until then, keep an eye on your inbox.`,
        ``,
        `— Otto`,
      ].join('\n');

      const results = await Promise.allSettled([
        fetch(emailBase, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify({
            to: process.env.POLSIA_OWNER_EMAIL,
            subject: 'New Otto waitlist signup',
            body: ownerBody,
          }),
        }).then(r => { if (!r.ok) throw new Error(`owner email status ${r.status}`); }),

        fetch(emailBase, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify({
            to: trimmedEmail,
            subject: "You're on the Otto waitlist",
            body: confirmBody,
          }),
        }).then(r => { if (!r.ok) throw new Error(`submitter email status ${r.status}`); }),
      ]);

      results.forEach(r => {
        if (r.status === 'rejected') console.error('[Waitlist] email send failed:', r.reason?.message);
      });
    } catch (emailErr) {
      console.error('[Waitlist] unexpected email error:', emailErr.message);
    }

    res.status(201).json({
      success: true,
      position,
      total,
      message: `You're #${position} on the waitlist!`
    });
  } catch (err) {
    console.error('[POST /api/waitlist]', err.message);
    res.status(500).json({ success: false, message: 'Failed to join waitlist' });
  }
});


// ──────────────────────────────────────────────
// GET /api/waitlist — Admin: list all signups
// ──────────────────────────────────────────────

app.get('/api/waitlist', async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 100, 500);
    const safeOffset = parseInt(offset) || 0;

    const [signupsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT id, email, name, platform, community_size, referral_source, created_at
         FROM waitlist
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [safeLimit, safeOffset]
      ),
      pool.query('SELECT COUNT(*) as total FROM waitlist')
    ]);

    // Platform breakdown
    const platformResult = await pool.query(
      `SELECT platform, COUNT(*) as count
       FROM waitlist
       WHERE platform IS NOT NULL
       GROUP BY platform ORDER BY count DESC`
    );

    // Size breakdown
    const sizeResult = await pool.query(
      `SELECT community_size, COUNT(*) as count
       FROM waitlist
       WHERE community_size IS NOT NULL
       GROUP BY community_size ORDER BY count DESC`
    );

    res.json({
      success: true,
      signups: signupsResult.rows,
      total: parseInt(countResult.rows[0].total),
      by_platform: platformResult.rows.map(r => ({ platform: r.platform, count: parseInt(r.count) })),
      by_size: sizeResult.rows.map(r => ({ size: r.community_size, count: parseInt(r.count) })),
      pagination: {
        limit: safeLimit,
        offset: safeOffset,
        total: parseInt(countResult.rows[0].total)
      }
    });
  } catch (err) {
    console.error('[GET /api/waitlist]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch waitlist' });
  }
});


// ──────────────────────────────────────────────
// POST /api/communities — Register a Discord server
// ──────────────────────────────────────────────

app.post('/api/communities', async (req, res) => {
  try {
    const { name, guild_id } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'name is required and must be a non-empty string'
      });
    }

    if (!guild_id || typeof guild_id !== 'string' || guild_id.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'guild_id is required and must be a non-empty string'
      });
    }

    // Generate a random 64-char hex API key
    const apiKey = crypto.randomBytes(32).toString('hex');

    const result = await pool.query(
      `INSERT INTO communities (guild_id, name, api_key)
       VALUES ($1, $2, $3)
       RETURNING id, guild_id, name, api_key, message_count, created_at`,
      [guild_id.trim(), name.trim().slice(0, 255), apiKey]
    );

    const community = result.rows[0];

    console.log(`[Community] Registered "${community.name}" (guild: ${community.guild_id})`);

    res.status(201).json({
      success: true,
      community: {
        id: community.id,
        guild_id: community.guild_id,
        name: community.name,
        api_key: community.api_key,
        message_count: community.message_count,
        created_at: community.created_at,
      },
      webhook_url: `/api/discord/webhook/${community.api_key}`,
    });
  } catch (err) {
    // Handle unique constraint violation on guild_id
    if (err.code === '23505' && err.constraint?.includes('guild_id')) {
      return res.status(409).json({
        success: false,
        message: 'A community with this guild_id is already registered'
      });
    }
    console.error('[POST /api/communities]', err.message);
    res.status(500).json({ success: false, message: 'Failed to register community' });
  }
});


// ──────────────────────────────────────────────
// GET /api/communities — List registered communities
// ──────────────────────────────────────────────

app.get('/api/communities', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 50, 200);
    const safeOffset = parseInt(offset) || 0;

    const [communitiesResult, countResult] = await Promise.all([
      pool.query(
        `SELECT
           id, guild_id, name, message_count, created_at,
           (
             SELECT json_agg(m_sub ORDER BY m_sub.created_at DESC)
             FROM (
               SELECT id, intent, sentiment, confidence, channel, author_name, created_at
               FROM messages
               WHERE community_id = communities.id
               ORDER BY created_at DESC
               LIMIT 5
             ) m_sub
           ) AS recent_messages
         FROM communities
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [safeLimit, safeOffset]
      ),
      pool.query('SELECT COUNT(*) as total FROM communities')
    ]);

    res.json({
      success: true,
      communities: communitiesResult.rows.map(c => ({
        id:              c.id,
        guild_id:        c.guild_id,
        name:            c.name,
        message_count:   c.message_count,
        created_at:      c.created_at,
        recent_messages: c.recent_messages || [],
      })),
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit: safeLimit,
        offset: safeOffset,
      }
    });
  } catch (err) {
    console.error('[GET /api/communities]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch communities' });
  }
});


// ──────────────────────────────────────────────
// GET /api/dashboard — Authenticated user dashboard data
// ──────────────────────────────────────────────

app.get('/api/dashboard', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const apiKey = req.query.api_key || (authHeader ? authHeader.replace('Bearer ', '') : null);

    if (!apiKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const communityResult = await pool.query(
      'SELECT id, guild_id, name, message_count, created_at FROM communities WHERE api_key = $1',
      [apiKey]
    );

    if (communityResult.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid API key' });
    }

    const community = communityResult.rows[0];

    const alertsResult = await pool.query(
      `SELECT id, content, intent, sentiment, ai_response, response_status, created_at
       FROM messages
       WHERE community_id = $1 AND response_status = 'suggested'
       ORDER BY created_at DESC
       LIMIT 10`,
      [community.id]
    );

    const recentResult = await pool.query(
      `SELECT id, content, intent, sentiment, channel, author_name, response_status, created_at
       FROM messages
       WHERE community_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [community.id]
    );

    const statsResult = await pool.query(
      `SELECT
         COUNT(*) as total_messages,
         COUNT(*) FILTER (WHERE response_status = 'approved') as approved_count,
         COUNT(*) FILTER (WHERE response_status = 'suggested') as pending_count,
         ROUND(AVG(confidence)::numeric, 3) FILTER (WHERE confidence > 0) as avg_confidence
       FROM messages
       WHERE community_id = $1`,
      [community.id]
    );

    const stats = statsResult.rows[0];

    const volumeResult = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM messages
       WHERE community_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [community.id]
    );

    res.json({
      success: true,
      community: {
        id: community.id,
        guild_id: community.guild_id,
        name: community.name,
        message_count: community.message_count,
        created_at: community.created_at,
      },
      stats: {
        total_messages: parseInt(stats.total_messages || 0),
        approved_count: parseInt(stats.approved_count || 0),
        pending_count: parseInt(stats.pending_count || 0),
        avg_confidence: parseFloat(stats.avg_confidence || 0),
      },
      alerts: alertsResult.rows,
      recent_messages: recentResult.rows,
      volume_trend: volumeResult.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
    });
  } catch (err) {
    console.error('[GET /api/dashboard]', err.message);
    res.status(500).json({ success: false, message: 'Failed to load dashboard data' });
  }
});


// ──────────────────────────────────────────────
// GET /api/dashboard/owner-metrics — Aggregate product metrics
// ──────────────────────────────────────────────

app.get('/api/dashboard/owner-metrics', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const apiKey = req.query.api_key || (authHeader ? authHeader.replace('Bearer ', '') : null);

    if (!apiKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const keyCheck = await pool.query('SELECT 1 FROM communities WHERE api_key = $1', [apiKey]);
    if (keyCheck.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid API key' });
    }

    const [waitlistResult, communitiesResult, messagesResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM waitlist'),
      pool.query('SELECT COUNT(*) as total FROM communities'),
      pool.query("SELECT COUNT(*) as total FROM messages WHERE platform = 'discord'"),
    ]);

    res.json({
      success: true,
      metrics: {
        waitlist_signups: parseInt(waitlistResult.rows[0].total),
        communities_connected: parseInt(communitiesResult.rows[0].total),
        discord_messages: parseInt(messagesResult.rows[0].total),
      },
    });
  } catch (err) {
    console.error('[GET /api/dashboard/owner-metrics]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch owner metrics' });
  }
});


// ──────────────────────────────────────────────
// GET /api/communities/me — Get current user's community
// ──────────────────────────────────────────────

app.get('/api/communities/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const apiKey = req.query.api_key || (authHeader ? authHeader.replace('Bearer ', '') : null);

    if (!apiKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const result = await pool.query(
      `SELECT id, guild_id, name, api_key, message_count, created_at
       FROM communities WHERE api_key = $1`,
      [apiKey]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Community not found' });
    }

    const community = result.rows[0];

    res.json({
      success: true,
      community: {
        id: community.id,
        guild_id: community.guild_id,
        name: community.name,
        api_key: community.api_key,
        message_count: community.message_count,
        created_at: community.created_at,
      },
      webhook_url: `/api/discord/webhook/${community.api_key}`,
    });
  } catch (err) {
    console.error('[GET /api/communities/me]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch community' });
  }
});


// ──────────────────────────────────────────────
// GET /api/discord/status — live wiring diagnostics
// Why the dashboard is (or isn't) showing data: bot connection state, env
// presence (names/booleans only — never values), community registration, and
// ingest freshness. The dashboard renders this as the Live banner.
// ──────────────────────────────────────────────

app.get('/api/discord/status', async (req, res) => {
  try {
    const bot = require('./bot').status();
    const [commResult, msgResult] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM communities'),
      pool.query(`SELECT COUNT(*)::int AS n, MAX(created_at) AS last FROM messages WHERE platform = 'discord'`),
    ]);
    res.json({
      success: true,
      bot,
      env: {
        bot_token_set: Boolean(process.env.DISCORD_BOT_TOKEN),
        webhook_url_set: Boolean(process.env.DISCORD_WEBHOOK_URL),
      },
      communities: commResult.rows[0].n,
      discord_messages: msgResult.rows[0].n,
      last_discord_message_at: msgResult.rows[0].last,
    });
  } catch (err) {
    console.error('[GET /api/discord/status]', err.message);
    res.status(500).json({ success: false, message: 'status failed' });
  }
});


// ──────────────────────────────────────────────
// POST /api/discord/webhook/:api_key — Discord webhook receiver
// ──────────────────────────────────────────────

app.post('/api/discord/webhook/:api_key', async (req, res) => {
  try {
    const { api_key } = req.params;

    // Validate API key and look up community
    const communityResult = await pool.query(
      'SELECT id, guild_id, name FROM communities WHERE api_key = $1',
      [api_key]
    );

    if (communityResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid API key'
      });
    }

    const community = communityResult.rows[0];

    // Parse Discord webhook payload
    // Discord sends: author (username, id, discriminator), content, channel_id, timestamp, etc.
    const payload = req.body;

    // Extract fields from Discord message format
    const content = payload.content;
    const authorName = payload.author?.username || payload.author?.global_name || payload.author_name || 'Unknown';
    const authorId = payload.author?.id || payload.author_id || null;
    const channelName = payload.channel_name || payload.channel_id || null;
    const externalId = payload.id || payload.message_id || null;
    const timestamp = payload.timestamp || null;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'content is required and must be a non-empty string'
      });
    }

    if (content.length > 10000) {
      return res.status(400).json({
        success: false,
        message: 'content must be under 10,000 characters'
      });
    }

    // Run through existing AI classification pipeline
    const classification = await classifyMessage(content, authorName, channelName);

    // Store in messages table linked to community
    const msgResult = await pool.query(
      `INSERT INTO messages
        (external_id, platform, channel, author_name, author_id, content,
         intent, sentiment, confidence, ai_response, response_status, metadata,
         community_id, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       RETURNING *`,
      [
        externalId,
        'discord',
        channelName,
        authorName,
        authorId,
        content.trim(),
        classification.intent,
        classification.sentiment,
        classification.confidence,
        classification.response,
        classification.intent === 'spam' ? 'rejected' : 'suggested',
        JSON.stringify({
          reasoning: classification.reasoning,
          guild_id: community.guild_id,
          discord_timestamp: timestamp,
        }),
        community.id,
      ]
    );

    const message = msgResult.rows[0];

    // Increment community message_count
    await pool.query(
      'UPDATE communities SET message_count = message_count + 1 WHERE id = $1',
      [community.id]
    );

    console.log(`[Discord] ${community.name} | msg ${message.id} | ${classification.intent} (${classification.confidence}) | #${channelName || 'unknown'}`);

    res.status(201).json({
      success: true,
      message: {
        id: message.id,
        content: message.content,
        platform: message.platform,
        channel: message.channel,
        author_name: message.author_name,
        created_at: message.created_at,
      },
      classification: {
        intent: classification.intent,
        sentiment: classification.sentiment,
        confidence: classification.confidence,
      },
      suggested_response: classification.intent !== 'spam' ? classification.response : null,
      response_status: message.response_status,
      community: {
        id: community.id,
        name: community.name,
      },
    });
  } catch (err) {
    console.error('[POST /api/discord/webhook]', err.message);
    res.status(500).json({ success: false, message: 'Failed to process Discord message' });
  }
});


// ──────────────────────────────────────────────
// Helper: serve HTML with __POLSIA_SLUG__ and __GA4_MEASUREMENT_ID__ injected
// ──────────────────────────────────────────────

function serveInjected(res, htmlPath) {
  if (!fs.existsSync(htmlPath)) return false;
  const slug  = process.env.POLSIA_ANALYTICS_SLUG || '';
  const ga4Id = process.env.GA4_MEASUREMENT_ID    || '';
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html
    .replace('__POLSIA_SLUG__', slug)
    .replace(/__GA4_MEASUREMENT_ID__/g, ga4Id);
  res.type('html').send(html);
  return true;
}


// ──────────────────────────────────────────────
// Landing page with analytics beacon
// ──────────────────────────────────────────────

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (!serveInjected(res, htmlPath)) res.json({ message: 'Hivesync API is running.' });
});


// ──────────────────────────────────────────────
// Otto landing page (/otto) — stable path for orbitwithotto.com custom domain
// ──────────────────────────────────────────────

app.get('/otto', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (!serveInjected(res, htmlPath)) res.redirect('/');
});


// ──────────────────────────────────────────────
// Dashboard page
// ──────────────────────────────────────────────

app.get('/dashboard', (req, res) => {
  const apiKey = req.query.api_key || (req.headers.authorization || '').replace('Bearer ', '');
  if (apiKey) {
    const userPath = path.join(__dirname, 'public', 'dashboard-user.html');
    if (serveInjected(res, userPath)) return;
  }
  const dashPath = path.join(__dirname, 'public', 'dashboard.html');
  if (!serveInjected(res, dashPath)) res.redirect('/');
});


// ──────────────────────────────────────────────
// GET /payment/success — Stripe redirect handler
// ──────────────────────────────────────────────

app.get('/payment/success', (req, res) => {
  const sessionId = req.query.session_id || req.query.checkout_session_id;
  if (!sessionId) return res.redirect('/');
  serveInjected(res, path.join(__dirname, 'public', 'payment-success.html'));
});


// ──────────────────────────────────────────────
// GET /payment/poll — Verify Stripe checkout session
// ──────────────────────────────────────────────

app.get('/payment/poll', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.json({ verified: false });

  try {
    const response = await fetch(
      `${process.env.POLSIA_API_BASE_URL}/api/company-payments/verify?session_id=${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${process.env.POLSIA_API_KEY}` } }
    );
    const data = await response.json();
    res.json({ verified: data.verified || false, email: data.payment?.customer_email || null });
  } catch {
    res.json({ verified: false });
  }
});


// Discord connector backend (deterministic; channels, embed send, sources, scheduled).
require('./connectors')(app, pool);

app.listen(port, () => {
  console.log(`[Hivesync] Server running on port ${port}`);
  console.log(`[Hivesync] POST /api/messages — Ingest & classify`);
  console.log(`[Hivesync] GET  /api/messages — List messages`);
  console.log(`[Hivesync] GET  /api/analytics — Analytics dashboard`);
  console.log(`[Hivesync] POST /api/communities — Register Discord server`);
  console.log(`[Hivesync] GET  /api/communities — List communities`);
  console.log(`[Hivesync] POST /api/discord/webhook/:api_key — Discord webhook`);
  require('./bot').start();
});

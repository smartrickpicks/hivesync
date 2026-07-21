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
    const cfg = await getDiscordConfig();
    res.json({
      success: true,
      bot,
      env: {
        bot_token_set: Boolean(process.env.DISCORD_BOT_TOKEN),
        webhook_url_set: Boolean(process.env.DISCORD_WEBHOOK_URL),
      },
      setup: {
        token_set: Boolean(cfg && cfg.bot_token),
        guild_id: (cfg && cfg.guild_id) || null,
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

// Shared ingest: validate → classify → store → count. Used by BOTH the HTTP
// webhook route (legacy/external callers) and the in-process gateway bot path.
// Throws { status: 400 } errors for caller-shaped responses.
async function ingestDiscordMessage(community, payload) {
  const content = payload.content;
  const authorName = payload.author?.username || payload.author?.global_name || payload.author_name || 'Unknown';
  const authorId = payload.author?.id || payload.author_id || null;
  const channelName = payload.channel_name || payload.channel_id || null;
  const externalId = payload.id || payload.message_id || null;
  const timestamp = payload.timestamp || null;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    const err = new Error('content is required and must be a non-empty string');
    err.status = 400; throw err;
  }
  if (content.length > 10000) {
    const err = new Error('content must be under 10,000 characters');
    err.status = 400; throw err;
  }

  const classification = await classifyMessage(content, authorName, channelName);

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
  await pool.query('UPDATE communities SET message_count = message_count + 1 WHERE id = $1', [community.id]);
  console.log(`[Discord] ${community.name} | msg ${message.id} | ${classification.intent} (${classification.confidence}) | #${channelName || 'unknown'}`);
  return { message, classification };
}

// Find-or-create the community row for a guild — this is what makes setup
// "guild ID in, working feed out": no manual registration call required.
async function communityForGuild(guildId, guildName) {
  const found = await pool.query('SELECT id, guild_id, name FROM communities WHERE guild_id = $1 ORDER BY id LIMIT 1', [guildId]);
  if (found.rows.length) return found.rows[0];
  const apiKey = crypto.randomBytes(32).toString('hex');
  try {
    const created = await pool.query(
      `INSERT INTO communities (guild_id, name, api_key) VALUES ($1, $2, $3) RETURNING id, guild_id, name`,
      [guildId, (guildName || `guild ${guildId}`).slice(0, 255), apiKey]
    );
    console.log(`[Community] Auto-registered "${created.rows[0].name}" (guild: ${guildId})`);
    return created.rows[0];
  } catch (_) {
    // unique(guild_id) race — someone else inserted first; use theirs
    const again = await pool.query('SELECT id, guild_id, name FROM communities WHERE guild_id = $1 ORDER BY id LIMIT 1', [guildId]);
    return again.rows[0];
  }
}

// In-process ingest for the gateway bot (no HTTP round-trip, no webhook URL).
// A configured guild_id acts as a filter; unset = ingest every guild the bot
// is in, each auto-registered as its own community.
async function botIngest(payload) {
  try {
    if (!payload || !payload.guild_id) return; // DMs etc. — not community traffic
    const cfg = await getDiscordConfig();
    if (cfg && cfg.guild_id && cfg.guild_id !== payload.guild_id) return;
    const community = await communityForGuild(payload.guild_id, payload.guild_name);
    if (community) await ingestDiscordMessage(community, payload);
  } catch (err) {
    if (err.status !== 400) console.error('[Discord ingest]', err.message);
  }
}

// ──────────────────────────────────────────────
// Discord setup — dashboard-driven wiring (no env vars, no curl)
// The Setup tab stores the bot token + guild here and the server boots the
// gateway itself. Token is WRITE-ONLY: masked hint on reads, never logged.
// All routes gated by ADMIN_KEY (same header contract as /connectors/*).
// ──────────────────────────────────────────────

function adminSafeEq(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function adminAuth(req, res, next) {
  const k = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-admin-key'];
  if (!adminSafeEq(k, process.env.ADMIN_KEY)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

let discordConfigEnsured = false;
async function ensureDiscordConfigTable() {
  if (discordConfigEnsured) return;
  await pool.query(`
    create table if not exists discord_config (
      id             int primary key default 1 check (id = 1),
      bot_token      text,
      application_id text,
      guild_id       text,
      updated_at     timestamptz not null default now()
    )`);
  discordConfigEnsured = true;
}

async function getDiscordConfig() {
  try {
    await ensureDiscordConfigTable();
    const r = await pool.query('SELECT bot_token, application_id, guild_id, updated_at FROM discord_config WHERE id = 1');
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

// View Channels (1024) + Send Messages (2048) + Embed Links (16384) +
// Read Message History (65536) + Manage Channels (16) + Manage Events
// (8589934592) + Manage Threads (17179869184) + Manage Webhooks (536870912)
// = what the Server tab actually uses: tracking, bot-sends, structure
// management, events, threads, one-click feed webhooks. Manage Roles lands
// with the M-2 fence module (spec); Kick / Ban / Admin never requested.
const INVITE_PERMISSIONS = '26306759696';

app.get('/api/discord/setup', adminAuth, async (req, res) => {
  try {
    const cfg = (await getDiscordConfig()) || {};
    const bot = require('./bot').status();
    const appId = cfg.application_id || null;
    res.json({
      success: true,
      config: {
        application_id: appId,
        guild_id: cfg.guild_id || null,
        token_set: Boolean(cfg.bot_token || process.env.DISCORD_BOT_TOKEN),
        token_hint: cfg.bot_token ? '••••' + cfg.bot_token.slice(-4) : (process.env.DISCORD_BOT_TOKEN ? 'from env' : null),
        updated_at: cfg.updated_at || null,
      },
      bot,
      invite_url: appId
        ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot&permissions=${INVITE_PERMISSIONS}`
        : null,
      portal: {
        application: appId ? `https://discord.com/developers/applications/${encodeURIComponent(appId)}` : 'https://discord.com/developers/applications',
        bot_page: appId ? `https://discord.com/developers/applications/${encodeURIComponent(appId)}/bot` : 'https://discord.com/developers/applications',
        required_intents: ['MESSAGE CONTENT INTENT', 'SERVER MEMBERS INTENT'],
      },
    });
  } catch (err) {
    console.error('[GET /api/discord/setup]', err.message);
    res.status(500).json({ success: false, message: 'setup read failed' });
  }
});

app.post('/api/discord/setup', adminAuth, async (req, res) => {
  try {
    await ensureDiscordConfigTable();
    const body = req.body || {};

    // Field semantics: undefined = keep stored value, '' = clear, value = set.
    const parseId = (raw, label) => {
      if (typeof raw !== 'string') return { keep: true };
      const v = raw.trim();
      if (v === '') return { value: null };
      if (!/^\d{15,21}$/.test(v)) return { error: `${label} must be the numeric ID from Discord` };
      return { value: v };
    };
    const appId = parseId(body.application_id, 'application_id');
    const guildId = parseId(body.guild_id, 'guild_id');
    if (appId.error) return res.status(400).json({ success: false, message: appId.error });
    if (guildId.error) return res.status(400).json({ success: false, message: guildId.error });

    const token = typeof body.bot_token === 'string' ? body.bot_token.trim() : '';
    if (token && (token.length < 50 || /\s/.test(token))) {
      return res.status(400).json({ success: false, message: 'that does not look like a bot token — copy it from Bot → Reset Token' });
    }

    const existing = (await getDiscordConfig()) || {};
    const finalToken = token || existing.bot_token || null;          // write-only: empty keeps stored
    const finalApp = appId.keep ? (existing.application_id || null) : appId.value;
    const finalGuild = guildId.keep ? (existing.guild_id || null) : guildId.value;

    await pool.query(
      `INSERT INTO discord_config (id, bot_token, application_id, guild_id, updated_at)
       VALUES (1, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET bot_token = $1, application_id = $2, guild_id = $3, updated_at = now()`,
      [finalToken, finalApp, finalGuild]
    );

    const bot = require('./bot');
    if (finalToken) await bot.connect(finalToken, 'setup');
    res.json({ success: true, bot: bot.status(), token_set: Boolean(finalToken) });
  } catch (err) {
    console.error('[POST /api/discord/setup]', err.message);
    res.status(500).json({ success: false, message: 'setup save failed' });
  }
});

// ──────────────────────────────────────────────
// Guild management — the dashboard drives Discord's REST API with the stored
// bot token: structure, categories/channels, events, threads, bot-sends.
// All admin-gated. Mass mentions stay locked on every send path.
// ──────────────────────────────────────────────

async function discordApi(method, apiPath, body) {
  const cfg = await getDiscordConfig();
  const token = (cfg && cfg.bot_token) || process.env.DISCORD_BOT_TOKEN;
  if (!token) { const e = new Error('no bot token — connect in Setup first'); e.status = 400; throw e; }
  const r = await fetch(`https://discord.com/api/v10${apiPath}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* empty body (e.g. 204) */ }
  if (!r.ok) {
    const e = new Error((data && data.message) || `discord ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

async function resolveGuildId() {
  const cfg = await getDiscordConfig();
  if (cfg && cfg.guild_id) return cfg.guild_id;
  const list = require('./bot').status().guild_list;
  if (list.length === 1) return list[0].id;
  const e = new Error(list.length ? 'bot is in multiple servers — pick the guild in Setup' : 'no guild — connect the bot in Setup');
  e.status = 400;
  throw e;
}

function discordErr(res, err, fallback) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const hint = err.status === 403
    ? ' — the bot lacks this permission; re-invite it with the updated link in Setup (the invite now carries manage permissions) or grant its role Manage Channels/Events/Threads'
    : '';
  res.status(status).json({ success: false, message: (err.message || fallback) + hint });
}

const CHANNEL_TYPE_TO_DISCORD = { text: 0, voice: 2, announcement: 5, category: 4, forum: 15 };
const DISCORD_TYPE_TO_LABEL = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 15: 'forum', 13: 'stage' };

// Live server structure: categories with their channels, plus active threads.
app.get('/api/discord/guild/structure', adminAuth, async (req, res) => {
  try {
    const guildId = await resolveGuildId();
    const channels = await discordApi('GET', `/guilds/${guildId}/channels`);
    const cats = channels.filter((c) => c.type === 4).sort((a, b) => a.position - b.position)
      .map((c) => ({ id: c.id, name: c.name, position: c.position, channels: [] }));
    const byCat = Object.fromEntries(cats.map((c) => [c.id, c]));
    const uncategorized = [];
    for (const c of channels.filter((c) => c.type !== 4).sort((a, b) => a.position - b.position)) {
      const entry = { id: c.id, name: c.name, type: DISCORD_TYPE_TO_LABEL[c.type] || String(c.type), topic: c.topic || null };
      if (c.parent_id && byCat[c.parent_id]) byCat[c.parent_id].channels.push(entry);
      else uncategorized.push(entry);
    }
    let threads = null;
    try {
      const t = await discordApi('GET', `/guilds/${guildId}/threads/active`);
      threads = (t.threads || []).map((th) => ({ id: th.id, name: th.name, parent_id: th.parent_id }));
    } catch (_) { /* missing perms — threads stay null, structure still renders */ }
    // Which channels already have a feed wired (tier → webhook), for the tree.
    let feeds = [];
    try {
      await ensureFeedColumn();
      const fr = await pool.query(
        `select tier, label, enabled, channel_id from discord_channels where guild_id = 'default' and channel_id is not null`
      );
      feeds = fr.rows;
    } catch (_) { /* table may predate the column locally — tree still renders */ }
    res.json({ success: true, guild_id: guildId, categories: cats, uncategorized, threads, feeds });
  } catch (err) {
    discordErr(res, err, 'structure fetch failed');
  }
});

// Create a category or channel (optionally inside a category, with topic).
app.post('/api/discord/guild/channels', adminAuth, async (req, res) => {
  try {
    const guildId = await resolveGuildId();
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ success: false, message: 'name is required (max 100 chars)' });
    const type = CHANNEL_TYPE_TO_DISCORD[body.type];
    if (type === undefined) return res.status(400).json({ success: false, message: 'type must be text | voice | announcement | forum | category' });
    const payload = { name, type };
    if (type !== 4 && typeof body.parent_id === 'string' && /^\d{15,21}$/.test(body.parent_id)) payload.parent_id = body.parent_id;
    if (type !== 4 && typeof body.topic === 'string' && body.topic.trim()) payload.topic = body.topic.trim().slice(0, 1024);
    const created = await discordApi('POST', `/guilds/${guildId}/channels`, payload);
    console.log(`[Discord] created ${body.type} "${name}" (${created.id})`);
    res.json({ success: true, channel: { id: created.id, name: created.name, type: body.type } });
  } catch (err) {
    discordErr(res, err, 'channel create failed');
  }
});

app.delete('/api/discord/guild/channels/:id', adminAuth, async (req, res) => {
  try {
    if (!/^\d{15,21}$/.test(req.params.id)) return res.status(400).json({ success: false, message: 'bad channel id' });
    // Guard: only delete channels belonging to the configured guild.
    const guildId = await resolveGuildId();
    const ch = await discordApi('GET', `/channels/${req.params.id}`);
    if (ch.guild_id !== guildId) return res.status(400).json({ success: false, message: 'channel is not in the configured guild' });
    await discordApi('DELETE', `/channels/${req.params.id}`);
    console.log(`[Discord] deleted channel ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    discordErr(res, err, 'channel delete failed');
  }
});

// Create a scheduled server event — voice-channel or external (location) type.
app.post('/api/discord/guild/events', adminAuth, async (req, res) => {
  try {
    const guildId = await resolveGuildId();
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ success: false, message: 'event name is required (max 100 chars)' });
    const start = new Date(body.start_time || '');
    if (Number.isNaN(start.getTime()) || start <= new Date()) return res.status(400).json({ success: false, message: 'start_time must be a future date/time' });
    const payload = {
      name,
      privacy_level: 2, // GUILD_ONLY — the only valid value
      scheduled_start_time: start.toISOString(),
      description: typeof body.description === 'string' ? body.description.trim().slice(0, 1000) : undefined,
    };
    if (typeof body.channel_id === 'string' && /^\d{15,21}$/.test(body.channel_id)) {
      payload.entity_type = 2; // VOICE
      payload.channel_id = body.channel_id;
    } else if (typeof body.location === 'string' && body.location.trim()) {
      payload.entity_type = 3; // EXTERNAL — requires location + end time
      payload.entity_metadata = { location: body.location.trim().slice(0, 100) };
      const end = new Date(body.end_time || '');
      payload.scheduled_end_time = (!Number.isNaN(end.getTime()) && end > start)
        ? end.toISOString()
        : new Date(start.getTime() + 60 * 60 * 1000).toISOString(); // default: 1h
    } else {
      return res.status(400).json({ success: false, message: 'pick a voice channel or give a location' });
    }
    const ev = await discordApi('POST', `/guilds/${guildId}/scheduled-events`, payload);
    console.log(`[Discord] created event "${name}" (${ev.id})`);
    res.json({ success: true, event: { id: ev.id, name: ev.name } });
  } catch (err) {
    discordErr(res, err, 'event create failed');
  }
});

// ── Channel feeds: one-click webhook provisioning ──
// The picks publisher reads discord_channels (tier → webhook_url). Instead of
// hand-creating webhooks in Discord's UI and pasting URLs, the bot mints (or
// reuses) a "Hivesync Feed" webhook on the channel and writes the row itself.
let feedColumnEnsured = false;
async function ensureFeedColumn() {
  if (feedColumnEnsured) return;
  await pool.query(`alter table discord_channels add column if not exists channel_id text`);
  feedColumnEnsured = true;
}

app.post('/api/discord/guild/webhooks', adminAuth, async (req, res) => {
  try {
    await ensureFeedColumn();
    const guildId = await resolveGuildId();
    const body = req.body || {};
    if (!/^\d{15,21}$/.test(String(body.channel_id || ''))) {
      return res.status(400).json({ success: false, message: 'channel_id required' });
    }
    const tier = typeof body.tier === 'string' ? body.tier.trim().toLowerCase() : '';
    if (!/^[a-z0-9_-]{1,32}$/.test(tier)) {
      return res.status(400).json({ success: false, message: 'tier required (top, qualified, watch, pass, all, …)' });
    }
    const ch = await discordApi('GET', `/channels/${body.channel_id}`);
    if (ch.guild_id !== guildId) return res.status(400).json({ success: false, message: 'channel is not in the configured guild' });
    if (![0, 5].includes(ch.type)) return res.status(400).json({ success: false, message: 'feeds attach to text or announcement channels' });

    // Reuse the bot's existing feed webhook on this channel, else create one —
    // repeated wiring never piles up duplicate webhooks.
    const hooks = await discordApi('GET', `/channels/${body.channel_id}/webhooks`);
    let hook = (hooks || []).find((h) => h.token && h.name === 'Hivesync Feed');
    if (!hook) hook = await discordApi('POST', `/channels/${body.channel_id}/webhooks`, { name: 'Hivesync Feed' });
    if (!hook || !hook.token) return res.status(502).json({ success: false, message: 'Discord did not return a webhook token' });
    const url = `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;

    // Tenant key stays 'default' — that is what the publisher and the
    // /connectors routes resolve to today (no guild header). channel_id is the
    // dashboard's wiring map. Same table, same masked-read rules as always.
    await pool.query(
      `insert into discord_channels (guild_id, tier, webhook_url, label, enabled, channel_id, updated_at)
       values ('default', $1, $2, $3, true, $4, now())
       on conflict (guild_id, tier) do update set webhook_url = $2, label = $3, enabled = true, channel_id = $4, updated_at = now()`,
      [tier, url, `#${ch.name}`.slice(0, 100), body.channel_id]
    );
    console.log(`[Discord] feed wired: tier "${tier}" → #${ch.name}`);
    res.json({ success: true, tier, channel: `#${ch.name}` });
  } catch (err) {
    discordErr(res, err, 'feed wire failed');
  }
});

app.post('/api/discord/guild/feeds/toggle', adminAuth, async (req, res) => {
  try {
    await ensureFeedColumn();
    const body = req.body || {};
    const tier = typeof body.tier === 'string' ? body.tier.trim().toLowerCase() : '';
    if (!tier) return res.status(400).json({ success: false, message: 'tier required' });
    const r = await pool.query(
      `update discord_channels set enabled = $2, updated_at = now() where guild_id = 'default' and tier = $1`,
      [tier, Boolean(body.enabled)]
    );
    if (!r.rowCount) return res.status(404).json({ success: false, message: 'no feed with that tier' });
    res.json({ success: true });
  } catch (err) {
    console.error('[POST /api/discord/guild/feeds/toggle]', err.message);
    res.status(500).json({ success: false, message: 'toggle failed' });
  }
});

// ── Picks Router: every pick → its grade's channel ──
// The Fixer re-grades picks every ~90min, and EVERY pick posts regardless of
// actionability — routing is by grade letter alone (A-/B+ collapse to A/B).
// A pick posts to a grade channel the FIRST time it lands on that grade each
// day, so movement (C→B) surfaces in the new channel without re-spamming the
// old one. Wiring IS the whole config: Feed a channel as tier a/b/c/d/f (or
// all) on the Server tab, the router does the rest. Sports later = tier
// naming (mlb-a, nba-a…) — no code change.
const PICKS_FEED_URL = process.env.PICKS_FEED_URL
  || 'https://raw.githubusercontent.com/smartrickpicks/fixer-data/main/picks_data.json';
const GRADE_TIERS = ['a', 'b', 'c', 'd', 'f'];
const GRADE_COLORS = { A: 0x1fbe6b, B: 0x00d1ff, C: 0xeab308, D: 0xf97316, F: 0xef4444 };

// News feed produced by the Pi pipeline (news_pipeline.py): RSS → mo gate → tags.
// Only mo-relevant items (HOT/WARM) are in it; each carries relevance/factor/
// sentiment tags. Routed to news channels, dedup'd per (item, tier, slate-day).
const NEWS_FEED_URL = process.env.NEWS_FEED_URL
  || 'https://raw.githubusercontent.com/smartrickpicks/fixer-data/main/news_data.json';
const NEWS_TIERS = ['news-hot', 'news-warm', 'news'];
const NEWS_COLORS = { HOT: 0xef4444, WARM: 0xeab308 };

function pickEmbed(g, bucket) {
  const a = g.asmt || {};
  const vs = a.value_side || {};
  const ls = a.likely_side || {};
  const am = (n) => (n == null ? '—' : n > 0 ? `+${n}` : `${n}`);
  const pct = (p) => (p == null ? '—' : `${(p * 100).toFixed(1)}%`);
  const statusLabel = (a.tier && a.tier.label) || a.status || '—';
  return {
    title: `${bucket} — ${g.away} @ ${g.home}`,
    description: ls.label && vs.label && ls.label !== vs.label
      ? `More likely **${ls.label}**, but **${vs.label}**'s price is the value.`
      : (vs.label ? `Model and market agree on **${vs.label}**.` : `No priced value — ${String(statusLabel).toLowerCase()}.`),
    color: GRADE_COLORS[bucket] || 0x7c5cfc,
    fields: [
      { name: 'Value side', value: vs.label ? `${vs.label} ${am(vs.american_odds)}${vs.book ? ` · ${vs.book}` : ''}` : 'no priced value', inline: false },
      { name: 'Valid through', value: a.price_limit_american != null ? am(a.price_limit_american) : '—', inline: true },
      { name: 'Grade', value: `${a.grade || bucket} · ${a.score != null ? a.score : '—'}/100`, inline: true },
      { name: 'Status', value: statusLabel, inline: true },
      { name: 'Most likely', value: ls.label ? `${ls.label} ${pct(ls.probability)}` : '—', inline: true },
      { name: 'Fair vs break-even', value: `${pct(a.fair_probability)} fair · ${pct(a.market_break_even)} BE${vs.value_points != null ? ` · ${vs.value_points > 0 ? '+' : ''}${vs.value_points} pts` : ''}`, inline: false },
    ],
    footer: { text: `The Fixer · sealed ${a.seal || a.assessment_id || ''} · report only · not financial advice · 21+` },
  };
}

let picksRouterBusy = false;
async function pollPicks() {
  if (picksRouterBusy) return { ok: false, busy: true };
  picksRouterBusy = true;
  let posted = 0, skipped = 0;
  const byGrade = {};
  try {
    const { rows: routes } = await pool.query(
      `select tier from discord_channels where guild_id = 'default' and enabled and tier = any($1)`,
      [[...GRADE_TIERS, 'all']]
    );
    if (!routes.length) return { ok: true, idle: 'no channels wired', posted, skipped }; // nothing wired — router idle
    const wired = new Set(routes.map((r) => r.tier));

    let feed;
    try {
      const r = await fetch(`${PICKS_FEED_URL}?t=${Date.now()}`, { cache: 'no-store' });
      feed = await r.json();
    } catch (_) {
      return { ok: false, error: 'feed fetch failed', posted, skipped }; // transient — next tick/trigger retries
    }

    const { sendToChannel } = require('./connectors');
    const games = Array.isArray(feed.games) ? feed.games : [];
    for (const g of games) {
      const a = g.asmt;
      if (!a || !a.grade) continue;
      const bucket = String(a.grade).trim().toUpperCase()[0];
      if (!'ABCDF'.includes(bucket)) continue;
      const day = (a.commence_time || '').slice(0, 10) || feed.date || '';

      for (const tier of [bucket.toLowerCase(), 'all']) {
        if (!wired.has(tier)) continue;
        // once per (game, grade, channel, day) — reserve before send, release
        // on failure so the next tick can retry (never poison the key)
        const dedupKey = `pick:${day}:${g.away}@${g.home}:${bucket}:${tier}`;
        const ins = await pool.query(
          `insert into discord_publish_log (dedup_key, kind, guild_id) values ($1, $2, 'default')
           on conflict (dedup_key) do nothing returning dedup_key`,
          [dedupKey, `pick-${tier}`]
        );
        if (!ins.rows.length) { skipped++; continue; }
        const out = await sendToChannel(pool, 'default', tier, { embed: pickEmbed(g, bucket) }, { logKey: dedupKey, kind: `pick-${tier}` });
        if (!out.ok) {
          await pool.query(`delete from discord_publish_log where dedup_key = $1`, [dedupKey]);
          console.error(`[picks router] ${tier} send failed:`, out.error);
        } else {
          posted++; byGrade[tier] = (byGrade[tier] || 0) + 1;
        }
      }
    }
    return { ok: true, candidates: games.length, posted, skipped, byGrade };
  } catch (e) {
    console.error('[picks router]', e.message);
    return { ok: false, error: e.message, posted, skipped };
  } finally {
    picksRouterBusy = false;
  }
}
setInterval(pollPicks, 5 * 60 * 1000);
setTimeout(pollPicks, 15 * 1000); // first pass shortly after boot

// Pi/cron trigger — the Fixer regrades every ~90min; after each make_snapshot the
// Pi curls this so posting never depends on the free-tier instance staying awake
// (the request itself wakes it). CRON_SECRET-gated, fail-closed. Reuses pollPicks
// so routing/dedup/embed are identical to the background poller; safe to call any
// number of times (dedup makes re-runs no-ops).
app.post('/api/picks/consume', async (req, res) => {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!process.env.CRON_SECRET || auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    const out = await pollPicks();
    res.json(out);
  } catch (e) {
    console.error('[picks/consume]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── News Router: mo-gated slate news → news channels ──
// Mirror of the picks router. The Pi pipeline pre-filters (mo PPMI gate) and
// tags; this only routes + dedups. HOT → news-hot, WARM → news-warm, both → news
// (whichever tiers are wired). News is CONTEXT, never a pick — the embed footer
// says so, and it never touches a grade.
function newsEmbed(item) {
  const s = item.sentiment || {};
  const mo = item.mo || {};
  const facs = Array.isArray(item.factors) ? item.factors.join(' · ') : '';
  const sentLine = s.cue ? `${s.tag}${s.team ? ` · ${s.team}` : ''} (cue: ${s.cue})` : 'neutral';
  return {
    title: `${item.relevance === 'HOT' ? '🔴' : '🟡'} ${String(item.title || '').slice(0, 240)}`,
    url: item.url || undefined,
    description: (item.desc ? String(item.desc).slice(0, 300) : '')
      + (mo.topDoc ? `\n\n**Game:** ${mo.topDoc}` : ''),
    color: NEWS_COLORS[item.relevance] || 0x7c5cfc,
    fields: [
      { name: 'Relevance', value: `${item.relevance} · mo ${item.score != null ? item.score : '—'}`, inline: true },
      { name: 'Factors', value: facs || 'general', inline: true },
      { name: 'Read', value: sentLine, inline: true },
    ],
    footer: { text: `${item.feed || 'rss'} · context only, not a pick · attributed report · 21+` },
  };
}

let newsRouterBusy = false;
async function pollNews() {
  if (newsRouterBusy) return { ok: false, busy: true };
  newsRouterBusy = true;
  let posted = 0, skipped = 0;
  const byTier = {};
  try {
    const { rows: routes } = await pool.query(
      `select tier from discord_channels where guild_id = 'default' and enabled and tier = any($1)`,
      [NEWS_TIERS]
    );
    if (!routes.length) return { ok: true, idle: 'no news channels wired', posted, skipped };
    const wired = new Set(routes.map((r) => r.tier));

    let feed;
    try {
      const r = await fetch(`${NEWS_FEED_URL}?t=${Date.now()}`, { cache: 'no-store' });
      feed = await r.json();
    } catch (_) {
      return { ok: false, error: 'news feed fetch failed', posted, skipped };
    }

    const { sendToChannel } = require('./connectors');
    const day = feed.slate_date || (feed.generated_at || '').slice(0, 10) || '';
    const items = Array.isArray(feed.items) ? feed.items : [];
    for (const item of items) {
      const rel = String(item.relevance || '').toUpperCase();
      if (rel !== 'HOT' && rel !== 'WARM') continue;
      // HOT → news-hot + news ; WARM → news-warm + news
      const targets = [rel === 'HOT' ? 'news-hot' : 'news-warm', 'news'];
      for (const tier of targets) {
        if (!wired.has(tier)) continue;
        const dedupKey = `news:${day}:${item.sha}:${tier}`;
        const ins = await pool.query(
          `insert into discord_publish_log (dedup_key, kind, guild_id) values ($1, $2, 'default')
           on conflict (dedup_key) do nothing returning dedup_key`,
          [dedupKey, `news-${tier}`]
        );
        if (!ins.rows.length) { skipped++; continue; }
        const out = await sendToChannel(pool, 'default', tier, { embed: newsEmbed(item) }, { logKey: dedupKey, kind: `news-${tier}` });
        if (!out.ok) {
          await pool.query(`delete from discord_publish_log where dedup_key = $1`, [dedupKey]);
          console.error(`[news router] ${tier} send failed:`, out.error);
        } else {
          posted++; byTier[tier] = (byTier[tier] || 0) + 1;
        }
      }
    }
    return { ok: true, candidates: items.length, posted, skipped, byTier };
  } catch (e) {
    console.error('[news router]', e.message);
    return { ok: false, error: e.message, posted, skipped };
  } finally {
    newsRouterBusy = false;
  }
}

// Pi/cron trigger for the news router (same contract as /api/picks/consume).
app.post('/api/news/consume', async (req, res) => {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!process.env.CRON_SECRET || auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    const out = await pollNews();
    res.json(out);
  } catch (e) {
    console.error('[news/consume]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Send a message as the bot to any channel in the guild. Same safety floor as
// every other send path: mass mentions are stripped, no override.
app.post('/api/discord/send', adminAuth, async (req, res) => {
  try {
    const guildId = await resolveGuildId();
    const body = req.body || {};
    if (!/^\d{15,21}$/.test(String(body.channel_id || ''))) return res.status(400).json({ success: false, message: 'channel_id required' });
    const content = typeof body.content === 'string' ? body.content.trim().slice(0, 2000) : '';
    const embed = body.embed && typeof body.embed === 'object' ? body.embed : null;
    if (!content && !embed) return res.status(400).json({ success: false, message: 'content or embed required' });
    const ch = await discordApi('GET', `/channels/${body.channel_id}`);
    if (ch.guild_id !== guildId) return res.status(400).json({ success: false, message: 'channel is not in the configured guild' });
    const payload = { allowed_mentions: { parse: [] } };
    if (content) payload.content = content;
    if (embed) payload.embeds = [embed];
    await discordApi('POST', `/channels/${body.channel_id}/messages`, payload);
    res.json({ success: true });
  } catch (err) {
    discordErr(res, err, 'send failed');
  }
});

app.post('/api/discord/setup/disconnect', adminAuth, async (req, res) => {
  try {
    const bot = require('./bot');
    await bot.disconnect();
    if (req.body && req.body.forget_token) {
      await ensureDiscordConfigTable();
      await pool.query('UPDATE discord_config SET bot_token = NULL, updated_at = now() WHERE id = 1');
    }
    res.json({ success: true, bot: bot.status() });
  } catch (err) {
    console.error('[POST /api/discord/setup/disconnect]', err.message);
    res.status(500).json({ success: false, message: 'disconnect failed' });
  }
});

app.post('/api/discord/webhook/:api_key', async (req, res) => {
  try {
    const communityResult = await pool.query(
      'SELECT id, guild_id, name FROM communities WHERE api_key = $1',
      [req.params.api_key]
    );
    if (communityResult.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid API key' });
    }
    const community = communityResult.rows[0];

    const { message, classification } = await ingestDiscordMessage(community, req.body || {});

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
    if (err.status === 400) return res.status(400).json({ success: false, message: err.message });
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
  // Discord gateway: prefer the dashboard-stored Setup config (no env vars,
  // no redeploys); fall back to DISCORD_BOT_TOKEN env for legacy installs.
  const bot = require('./bot');
  bot.configure({ ingest: botIngest });
  getDiscordConfig()
    .then((cfg) => {
      if (cfg && cfg.bot_token) return bot.connect(cfg.bot_token, 'setup');
      bot.start();
    })
    .catch(() => bot.start());
});

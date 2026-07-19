'use strict';
const { createSign } = require('crypto');
const { Pool }       = require('pg');

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const SA_JSON     = process.env.GA4_SERVICE_ACCOUNT_JSON; // raw JSON string

async function main() {
  if (!PROPERTY_ID || !SA_JSON) {
    console.error('[GA4 Report] Missing GA4_PROPERTY_ID or GA4_SERVICE_ACCOUNT_JSON — skipping');
    process.exit(0);
  }

  const sa          = JSON.parse(SA_JSON);
  const accessToken = await getAccessToken(sa);
  const report      = await fetchGA4Report(accessToken);
  const waitlist    = await fetchWaitlistCount();
  await sendReport(report, waitlist);
  process.exit(0);
}

// ── GA4 JWT auth ─────────────────────────────────────────────────

function makeJWT(sa) {
  const now    = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim  = b64url(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  }));
  const sig = createSign('RSA-SHA256')
    .update(`${header}.${claim}`)
    .sign(sa.private_key, 'base64url');
  return `${header}.${claim}.${sig}`;
}

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

async function getAccessToken(sa) {
  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  makeJWT(sa),
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── GA4 Data API ─────────────────────────────────────────────────

async function fetchGA4Report(token) {
  const url  = `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`;
  const body = {
    dateRanges:  [{ startDate: '7daysAgo', endDate: 'today' }],
    dimensions:  [{ name: 'eventName' }],
    metrics:     [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'screenPageViews' },
      { name: 'eventCount' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: ['session_start', 'generate_lead', 'cta_click', 'page_view'] },
      },
    },
  };

  const res  = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return res.json();
}

// ── Database waitlist count ───────────────────────────────────────

async function fetchWaitlistCount() {
  const pool   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const result = await pool.query(
    `SELECT COUNT(*) AS total FROM waitlist WHERE created_at >= NOW() - INTERVAL '7 days'`
  );
  await pool.end();
  return parseInt(result.rows[0].total, 10);
}

// ── Email report ─────────────────────────────────────────────────

async function sendReport(ga4Data, newSignups) {
  const rows = ga4Data.rows || [];

  function metric(eventName, metricIdx) {
    const row = rows.find(r => r.dimensionValues[0].value === eventName);
    return row ? parseInt(row.metricValues[metricIdx].value, 10) : 0;
  }

  const sessions   = metric('session_start', 0);
  const pageViews  = metric('page_view',     2);
  const leads      = metric('generate_lead', 3);
  const ctaClicks  = metric('cta_click',     3);
  const convRate   = sessions > 0 ? ((leads / sessions) * 100).toFixed(1) : '0.0';

  const body = [
    `Otto Landing Page — Weekly GA4 Report`,
    `Period: last 7 days`,
    ``,
    `Traffic`,
    `  Sessions:   ${sessions}`,
    `  Page views: ${pageViews}`,
    ``,
    `Conversions`,
    `  Waitlist signups (DB):   ${newSignups}`,
    `  generate_lead events:    ${leads}`,
    `  CTA button clicks:       ${ctaClicks}`,
    `  Conversion rate:         ${convRate}%  (leads / sessions)`,
    ``,
    `GA4 dashboard: https://analytics.google.com/analytics/web/#/p${PROPERTY_ID}/reports/dashboard`,
    ``,
    `— Otto`,
  ].join('\n');

  const emailBase  = `${process.env.POLSIA_API_BASE_URL}/api/proxy/email/send`;
  const authHeader = `Bearer ${process.env.POLSIA_API_TOKEN || process.env.POLSIA_API_KEY}`;

  const res = await fetch(emailBase, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body:    JSON.stringify({
      to:      process.env.POLSIA_OWNER_EMAIL,
      subject: `Otto weekly report — ${leads} leads, ${convRate}% conv rate`,
      body,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[GA4 Report] Email send failed:', text);
  } else {
    console.log('[GA4 Report] Weekly report sent to', process.env.POLSIA_OWNER_EMAIL);
  }
}

main().catch(err => {
  console.error('[GA4 Report] Fatal:', err.message);
  process.exit(1);
});

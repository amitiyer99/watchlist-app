'use strict';

// Fetch daily FII/DII cash-market buy/sell/net figures from the NSE India API
// and maintain a rolling history in docs/fii-dii.json.
//
// Output schema (docs/fii-dii.json):
//   {
//     updatedAt: ISO,
//     rows: [ { date: 'YYYY-MM-DD', category: 'FII'|'DII',
//               buyValue, sellValue, netValue },   // all in ₹ Cr
//             ... chronological, last 250 trading days ]
//   }
//
// NSE blocks bare API hits: a warm-up request to www.nseindia.com with
// browser-like headers is needed first to obtain cookies (same approach as
// fetch-nse-delivery.js). Idempotent — rows are deduped by date+category.
// On any failure it warns and exits 0, leaving the existing file untouched.

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const OUT_PATH  = path.join(__dirname, 'docs', 'fii-dii.json');
const MAX_DATES = 250;               // rolling window of trading days kept

const WARMUP_URL = 'https://www.nseindia.com';
const API_URL    = 'https://www.nseindia.com/api/fiidiiTradeReact';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Connection': 'close',
};

function tryFetch(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      timeout: 15000,
      headers: Object.assign({}, BROWSER_HEADERS, headers || {}),
    };
    const req = https.request(opts, res => {
      if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end',  () => resolve({ body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Warm-up hit to collect the session cookies NSE requires for /api/ routes.
async function getCookies() {
  const res = await tryFetch(WARMUP_URL, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });
  const setCookies = res.headers['set-cookie'] || [];
  const jar = setCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  if (!jar) throw new Error('warm-up returned no cookies');
  return jar;
}

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// NSE dates look like '18-Jul-2025' — normalise to ISO 'YYYY-MM-DD'.
function toIsoDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const mon = MONTHS[m[2].toUpperCase()];
  if (mon == null) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

// Rows come back like { category: 'FII/FPI *', date: '18-Jul-2025',
// buyValue: '12345.67', sellValue: '...', netValue: '...' } (₹ Cr).
function parseApiRows(body) {
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('API returned non-JSON (likely blocked)'); }
  if (!Array.isArray(json)) throw new Error('unexpected API shape');
  const rows = [];
  for (const r of json) {
    const cat = String(r.category || '').toUpperCase();
    const category = /FII|FPI/.test(cat) ? 'FII' : /DII/.test(cat) ? 'DII' : null;
    const date = toIsoDate(r.date);
    const buyValue = toNum(r.buyValue);
    const sellValue = toNum(r.sellValue);
    const netValue = toNum(r.netValue);
    if (!category || !date || netValue == null) continue;
    rows.push({ date, category, buyValue, sellValue, netValue });
  }
  return rows;
}

function loadCurrent() {
  try {
    if (!fs.existsSync(OUT_PATH)) return { updatedAt: null, rows: [] };
    const raw = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return { updatedAt: raw.updatedAt || null, rows: Array.isArray(raw.rows) ? raw.rows : [] };
  } catch { return { updatedAt: null, rows: [] }; }
}

function mergeRows(existing, fresh) {
  const byKey = new Map();
  for (const r of existing) byKey.set(`${r.date}|${r.category}`, r);
  for (const r of fresh)    byKey.set(`${r.date}|${r.category}`, r);   // fresh wins
  let rows = [...byKey.values()];
  // Keep only the last MAX_DATES distinct trading days.
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const keep = new Set(dates.slice(-MAX_DATES));
  rows = rows.filter(r => keep.has(r.date));
  rows.sort((a, b) => a.date === b.date ? a.category.localeCompare(b.category) : (a.date < b.date ? -1 : 1));
  return rows;
}

async function main() {
  console.log('Fetching FII/DII cash-market flows...');
  let fresh;
  try {
    const cookies = await getCookies();
    const res = await tryFetch(API_URL, {
      'Accept': 'application/json,*/*',
      'Referer': 'https://www.nseindia.com/reports/fii-dii',
      'Cookie': cookies,
    });
    fresh = parseApiRows(res.body);
    if (!fresh.length) throw new Error('no parseable rows in API response');
  } catch (e) {
    console.warn(`  WARNING: FII/DII fetch failed (${e.message}). Keeping existing ${OUT_PATH} unchanged.`);
    return;   // exit 0, old file untouched
  }

  const data = loadCurrent();
  const before = data.rows.length;
  const rows = mergeRows(data.rows, fresh);
  const payload = { updatedAt: new Date().toISOString(), rows };
  if (!fs.existsSync(path.dirname(OUT_PATH))) fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));

  const latest = rows.length ? rows[rows.length - 1].date : 'n/a';
  console.log(`  Fetched ${fresh.length} fresh rows; history ${before} -> ${rows.length} rows, latest ${latest}`);
  console.log(`  Wrote ${OUT_PATH}`);
}

if (require.main === module) {
  main().catch(e => { console.warn(`  WARNING: FII/DII fetch failed (${e.message}). Keeping old file.`); process.exit(0); });
}
module.exports = { main, parseApiRows, mergeRows };

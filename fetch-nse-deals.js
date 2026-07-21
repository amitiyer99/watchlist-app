'use strict';

// Fetch NSE bulk-deal and block-deal disclosures (last 30 days) and maintain
// a rolling 90-day history in docs/deals.json — the "smart money" feed.
//
// Output schema (docs/deals.json):
//   {
//     updatedAt: ISO,
//     rows: [ { date: 'YYYY-MM-DD', symbol, clientName, buySell: 'BUY'|'SELL',
//               quantity, avgPrice, type: 'bulk'|'block' }, ... chronological ]
//   }
//
// NSE blocks bare API hits: a warm-up request to www.nseindia.com with
// browser-like headers is needed first to obtain cookies (same approach as
// fetch-fii-dii.js). Idempotent — rows are deduped by
// date|symbol|clientName|buySell|type. On any failure it warns and exits 0,
// leaving the existing file untouched.

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const OUT_PATH   = path.join(__dirname, 'docs', 'deals.json');
const FETCH_DAYS = 30;   // window requested from NSE each run
const KEEP_DAYS  = 90;   // rolling history kept on disk

const WARMUP_URL = 'https://www.nseindia.com';
const BULK_URL   = 'https://www.nseindia.com/api/historical/bulk-deals';
const BLOCK_URL  = 'https://www.nseindia.com/api/historical/block-deals';

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
      timeout: 20000,
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

function ddmmyyyyDash(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

// Pick the first key matching any of the regexes that yields a usable value.
function pick(row, regexes, convert) {
  for (const re of regexes) {
    for (const k of Object.keys(row)) {
      if (!re.test(k)) continue;
      const v = convert(row[k]);
      if (v != null && v !== '') return v;
    }
  }
  return null;
}

// Rows come back like { BD_DT_DATE: '18-Jul-2025', BD_SYMBOL: 'XYZ',
// BD_CLIENT_NAME: '…', BD_BUY_SELL: 'BUY', BD_QTY_TRD: '123', BD_TP_WATP: '45.6' }
// — field names drift between bulk/block, so match keys defensively.
function parseDealRows(body, type) {
  let json;
  try { json = JSON.parse(body); } catch { throw new Error(`${type}-deals API returned non-JSON (likely blocked)`); }
  const raw = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : null);
  if (!raw) throw new Error(`unexpected ${type}-deals API shape`);
  const rows = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const date       = pick(r, [/dt.*date/i, /^date$/i, /date/i, /timestamp/i], v => toIsoDate(v));
    const symbol     = pick(r, [/symbol/i], v => typeof v === 'string' ? v.trim().toUpperCase() : null);
    const clientName = pick(r, [/client/i], v => typeof v === 'string' ? v.trim() : null);
    const bsRaw      = pick(r, [/buy.?sell/i], v => typeof v === 'string' ? v.trim().toUpperCase() : null);
    const buySell    = bsRaw ? (bsRaw.startsWith('B') ? 'BUY' : bsRaw.startsWith('S') ? 'SELL' : null) : null;
    const quantity   = pick(r, [/qty|quantity/i], toNum);
    const avgPrice   = pick(r, [/watp/i, /price/i], toNum);
    if (!date || !symbol || !buySell) continue;
    rows.push({ date, symbol, clientName: clientName || '', buySell, quantity, avgPrice, type });
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

const dealKey = r => `${r.date}|${r.symbol}|${r.clientName}|${r.buySell}|${r.type}`;

function mergeRows(existing, fresh) {
  const byKey = new Map();
  for (const r of existing) byKey.set(dealKey(r), r);
  for (const r of fresh)    byKey.set(dealKey(r), r);   // fresh wins
  const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  let rows = [...byKey.values()].filter(r => r.date >= cutoff);
  rows.sort((a, b) => a.date === b.date ? a.symbol.localeCompare(b.symbol) : (a.date < b.date ? -1 : 1));
  return rows;
}

async function main() {
  console.log('Fetching NSE bulk/block deals...');
  const to = new Date();
  const from = new Date(to.getTime() - FETCH_DAYS * 864e5);
  const qs = `?from=${ddmmyyyyDash(from)}&to=${ddmmyyyyDash(to)}`;

  let cookies;
  try { cookies = await getCookies(); }
  catch (e) {
    console.warn(`  WARNING: NSE warm-up failed (${e.message}). Keeping existing ${OUT_PATH} unchanged.`);
    return;   // exit 0, old file untouched
  }

  const fresh = [];
  let fetched = 0;
  for (const [type, base] of [['bulk', BULK_URL], ['block', BLOCK_URL]]) {
    try {
      const res = await tryFetch(base + qs, {
        'Accept': 'application/json,*/*',
        'Referer': 'https://www.nseindia.com/report-detail/display-bulk-and-block-deals',
        'Cookie': cookies,
      });
      const rows = parseDealRows(res.body, type);
      console.log(`  ${type} deals: ${rows.length} rows`);
      fresh.push(...rows);
      fetched++;
    } catch (e) {
      console.warn(`  WARNING: ${type}-deals fetch failed (${e.message}).`);
    }
  }
  if (!fetched) {
    console.warn(`  WARNING: all deal fetches failed. Keeping existing ${OUT_PATH} unchanged.`);
    return;   // exit 0, old file untouched
  }

  const data = loadCurrent();
  const before = data.rows.length;
  const rows = mergeRows(data.rows, fresh);
  const payload = { updatedAt: new Date().toISOString(), rows };
  if (!fs.existsSync(path.dirname(OUT_PATH))) fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`  Fetched ${fresh.length} fresh rows; history ${before} -> ${rows.length} rows (last ${KEEP_DAYS} days)`);
  console.log(`  Wrote ${OUT_PATH}`);
}

if (require.main === module) {
  main().catch(e => { console.warn(`  WARNING: deals fetch failed (${e.message}). Keeping old file.`); process.exit(0); });
}
module.exports = { main, parseDealRows, mergeRows };

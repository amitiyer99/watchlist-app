'use strict';

// Fetch NSE bulk-deal and block-deal disclosures (last 30 days) into
// docs/deals.json — the "smart money" feed behind the FII/DII page.
//
// WHY PLAYWRIGHT: NSE sits behind Akamai bot protection that 403s plain Node
// https requests (and GitHub-runner IPs). A real Chromium session passes it, so
// this drives the same persisted browser profile fetch.js uses, warms up on the
// NSE site to collect Akamai cookies, then issues the API calls FROM INSIDE the
// page (same-origin fetch with real cookies + fingerprint). Run it locally where
// Chromium is installed:  npm run deals   (opens a short-lived browser window).
//
// Output schema (unchanged):
//   { updatedAt: ISO, rows: [ { date, symbol, clientName, buySell, quantity,
//     avgPrice, type } ] }  — deduped by date|symbol|clientName|buySell|type,
//   rolling KEEP_DAYS window. On any failure it warns and leaves the file as-is.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { chromium } = require('playwright');

const OUT_PATH   = path.join(__dirname, 'docs', 'deals.json');
const FETCH_DAYS = 90;    // pull a full quarter each run (page window is 90d)
const KEEP_DAYS  = 120;   // keep a buffer beyond the window so it's always fully populated
const CHUNK_DAYS = 15;    // NSE API caps ~70 records/call → fetch in 15-day chunks & merge
// Reuse the same persisted profile as fetch.js — real cookies + fingerprint.
const SESSION_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'watchlist-app-session');
const HEADLESS = process.env.HEADLESS === '1'; // default: visible window (best Akamai pass-through)

const HOME_URL   = 'https://www.nseindia.com/';
const REPORT_URL = 'https://www.nseindia.com/report-detail/display-bulk-and-block-deals';
// Real endpoint the report page uses: /api/historicalOR/bulk-block-short-deals
// with optionType=bulk_deals|block_deals & from/to (DD-MM-YYYY). Returns {data:[…]}
// with BD_* fields, which parseDealRows already understands.
const DEALS_API  = 'https://www.nseindia.com/api/historicalOR/bulk-block-short-deals';
const dealsUrl = (type, from, to) => `${DEALS_API}?optionType=${type}_deals&from=${ddmmyyyyDash(from)}&to=${ddmmyyyyDash(to)}`;

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function toIsoDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) { const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
  const mon = MONTHS[m[2].toUpperCase()];
  if (mon == null) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}
function toNum(v) { if (v == null) return null; const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; }
function ddmmyyyyDash(d) { return `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`; }

// NSE serves some client names with cp1252 punctuation (en-dashes in fund names) that
// arrive as U+FFFD replacement chars — "FIDELITY FUNDS \uFFFD\uFFFD EMERGING MARKETS".
// Normalise on ingest so every consumer (page chips, 🧠 panels, emails) shows clean
// names, and so dedup keys stay stable.
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const out = v.replace(/\uFFFD+/g, '-').replace(/\s*-\s*-\s*/g, ' - ').replace(/\s{2,}/g, ' ').trim();
  return out || null;
}

function pick(row, regexes, convert) {
  for (const re of regexes) for (const k of Object.keys(row)) {
    if (!re.test(k)) continue;
    const v = convert(row[k]);
    if (v != null && v !== '') return v;
  }
  return null;
}

function parseDealRows(body, type) {
  let json;
  try { json = typeof body === 'string' ? JSON.parse(body) : body; }
  catch { throw new Error(`${type}-deals API returned non-JSON (likely blocked)`); }
  const raw = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : null);
  if (!raw) throw new Error(`unexpected ${type}-deals API shape`);
  const rows = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const date       = pick(r, [/dt.*date/i, /^date$/i, /date/i, /timestamp/i], v => toIsoDate(v));
    const symbol     = pick(r, [/symbol/i], v => typeof v === 'string' ? v.trim().toUpperCase() : null);
    const clientName = pick(r, [/client/i], cleanName);
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
  for (const r of fresh)    byKey.set(dealKey(r), r);
  const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  const rows = [...byKey.values()].filter(r => r.date >= cutoff);
  rows.sort((a, b) => a.date === b.date ? a.symbol.localeCompare(b.symbol) : (a.date < b.date ? -1 : 1));
  return rows;
}

// In-page same-origin fetch — runs in the real browser, so Akamai sees genuine
// cookies + fingerprint. NSE's /api/historical/* often 503s until the session is
// fully warm, so retry a few times. Sends the same headers the site's own XHRs do.
async function apiFetch(page, url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const { ok, status, text } = await page.evaluate(async (u) => {
        const r = await fetch(u, {
          headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'include',
        });
        return { ok: r.ok, status: r.status, text: await r.text() };
      }, url);
      if (ok) return text;
      lastErr = new Error('HTTP ' + status);
    } catch (e) { lastErr = e; }
    await page.waitForTimeout(2500); // let cookies/session settle, then retry
  }
  throw lastErr || new Error('failed');
}

async function main() {
  console.log('Fetching NSE bulk/block deals via Playwright...');
  const to = new Date();
  const from = new Date(to.getTime() - FETCH_DAYS * 864e5);

  let context;
  try {
    context = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: HEADLESS,
      viewport: { width: 1300, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    console.warn(`  WARNING: could not launch Chromium (${e.message}). Is it installed? Try: npx playwright install chromium. Keeping existing file.`);
    return;
  }

  const fresh = [];
  let fetched = 0;
  try {
    const page = context.pages()[0] || await context.newPage();
    // Warm up: establishes Akamai cookies + a valid same-origin Referer.
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // NSE's JSON API caps at ~70 records per call, so one wide request only returns
    // the most recent ~2-3 weeks. Fetch in CHUNK_DAYS sub-windows and merge (dedup
    // handles the 1-day overlaps) to cover the full FETCH_DAYS span.
    for (const type of ['bulk', 'block']) {
      let typeRows = 0, chunks = 0, chunkFails = 0;
      for (let endMs = to.getTime(); endMs > from.getTime(); endMs -= CHUNK_DAYS * 864e5) {
        const cTo = new Date(endMs);
        const cFrom = new Date(Math.max(from.getTime(), endMs - CHUNK_DAYS * 864e5));
        chunks++;
        try {
          const body = await apiFetch(page, dealsUrl(type, cFrom, cTo));
          const rows = parseDealRows(body, type);
          fresh.push(...rows);
          typeRows += rows.length;
        } catch (e) { chunkFails++; }
      }
      console.log(`  ${type} deals: ${typeRows} rows across ${chunks} chunk(s)${chunkFails ? ` (${chunkFails} failed)` : ''}`);
      if (typeRows > 0) fetched++;
    }
  } finally {
    await context.close().catch(() => {});
  }

  if (!fetched) {
    console.warn(`  WARNING: all deal fetches failed. Keeping existing ${OUT_PATH} unchanged.`);
    return;
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

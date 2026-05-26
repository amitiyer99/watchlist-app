'use strict';

// Fetch NSE delivery percentages from sec_bhavdata_full daily CSV and persist them.
//
// Output schema (docs/delivery.json):
//   {
//     updatedAt: ISO,
//     latestDate: 'DD-MMM-YYYY',
//     stocks: {
//       <SYMBOL>: {
//         latest: { date, deliveryPct, deliveryQty, totalQty, close },
//         history: [ {date, deliveryPct, deliveryQty}, ... up to 30 entries chronologically ],
//         avg20d: number|null,
//         deliverySurge: boolean,
//         deliverySurgeMult: number|null  // today / 20D average
//       }
//     }
//   }
//
// Idempotent — re-runs on the same day overwrite that day's row in history (no double-counting).

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const OUT_PATH = path.join(__dirname, 'docs', 'delivery.json');
const MAX_HISTORY = 30;
const SURGE_MULT = 1.5;          // today / 20D avg threshold for "surge"

function todayIST() {
  const d = new Date();
  const offsetMs = (5.5 * 60 - d.getTimezoneOffset()) * 60 * 1000;
  return new Date(d.getTime() + offsetMs);
}

function ddmmyyyy(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}${mm}${d.getFullYear()}`;
}

function ddMonYYYY(d) {
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const dd = String(d.getDate()).padStart(2, '0');
  return `${dd}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function isWeekday(d) { const day = d.getDay(); return day >= 1 && day <= 5; }

async function tryFetch(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      timeout: 15000,
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/csv,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.nseindia.com/',
        'Connection': 'close',
      }, headers || {}),
    };
    const req = https.request(opts, res => {
      if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end',  () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function parseSecBhavdata(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',').map(h => h.trim().toUpperCase());
  const idx = {
    SYMBOL:     header.indexOf('SYMBOL'),
    SERIES:     header.indexOf('SERIES'),
    CLOSE:      header.indexOf('CLOSE_PRICE'),
    TTQ:        header.indexOf('TTL_TRD_QNTY'),
    DELIV_QTY:  header.indexOf('DELIV_QTY'),
    DELIV_PER:  header.indexOf('DELIV_PER'),
  };
  if (idx.SYMBOL < 0 || idx.DELIV_PER < 0) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(s => s.trim());
    if (cols.length < header.length) continue;
    const series = (cols[idx.SERIES] || '').toUpperCase();
    if (series !== 'EQ' && series !== 'BE') continue;        // equity series only
    const symbol = cols[idx.SYMBOL];
    const dp = parseFloat(cols[idx.DELIV_PER]);
    const dq = parseFloat(cols[idx.DELIV_QTY]);
    const tq = parseFloat(cols[idx.TTQ]);
    const cl = parseFloat(cols[idx.CLOSE]);
    if (!symbol || isNaN(dp)) continue;
    rows.push({ symbol, deliveryPct: dp, deliveryQty: isNaN(dq) ? null : dq, totalQty: isNaN(tq) ? null : tq, close: isNaN(cl) ? null : cl });
  }
  return rows;
}

async function fetchForDate(d) {
  // sec_bhavdata_full is on archives.nseindia.com (newer) and nsearchives.nseindia.com (older).
  const fname = `sec_bhavdata_full_${ddmmyyyy(d)}.csv`;
  const urls = [
    `https://nsearchives.nseindia.com/products/content/${fname}`,
    `https://archives.nseindia.com/products/content/${fname}`,
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const csv = await tryFetch(url);
      const rows = parseSecBhavdata(csv);
      if (rows.length) return { date: ddMonYYYY(d), rows };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all URLs failed');
}

function loadCurrent() {
  try {
    if (!fs.existsSync(OUT_PATH)) return { updatedAt: null, latestDate: null, stocks: {} };
    return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  } catch { return { updatedAt: null, latestDate: null, stocks: {} }; }
}

function medianVal(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

async function main() {
  console.log('Fetching NSE delivery data...');
  const data = loadCurrent();

  // Look back up to 5 business days (today + last 4) so we catch the latest tradeable bhavcopy
  const today = todayIST();
  let fetched = null;
  for (let i = 0; i < 6; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    if (!isWeekday(d)) continue;
    try {
      const result = await fetchForDate(d);
      console.log(`  Fetched ${result.rows.length} rows for ${result.date}`);
      fetched = result;
      break;
    } catch (e) {
      console.warn(`  ${ddMonYYYY(d)} failed: ${e.message}`);
    }
  }
  if (!fetched) {
    console.error('No delivery data fetched. Writing existing snapshot unchanged.');
    fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
    return;
  }

  for (const row of fetched.rows) {
    const sym = row.symbol;
    if (!data.stocks[sym]) data.stocks[sym] = { history: [], latest: null, avg20d: null, deliverySurge: false, deliverySurgeMult: null };
    const h = data.stocks[sym].history;
    // Replace any existing row for the same date
    const ix = h.findIndex(r => r.date === fetched.date);
    const entry = { date: fetched.date, deliveryPct: row.deliveryPct, deliveryQty: row.deliveryQty };
    if (ix >= 0) h[ix] = entry; else h.push(entry);
    // Keep newest first by trimming oldest
    while (h.length > MAX_HISTORY) h.shift();
    // Compute 20D median + surge multiplier (exclude today)
    const recent = h.slice(0, -1).slice(-20).map(r => r.deliveryPct).filter(v => v != null);
    const med = medianVal(recent);
    const surgeMult = med ? +(row.deliveryPct / med).toFixed(2) : null;
    data.stocks[sym].latest = { date: fetched.date, deliveryPct: row.deliveryPct, deliveryQty: row.deliveryQty, totalQty: row.totalQty, close: row.close };
    data.stocks[sym].avg20d = med != null ? +med.toFixed(2) : null;
    data.stocks[sym].deliverySurge = surgeMult != null && surgeMult >= SURGE_MULT;
    data.stocks[sym].deliverySurgeMult = surgeMult;
  }
  data.latestDate = fetched.date;
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));

  const surgeCt = Object.values(data.stocks).filter(s => s.deliverySurge).length;
  console.log(`  Wrote ${OUT_PATH}: ${Object.keys(data.stocks).length} symbols tracked, ${surgeCt} delivery surges today`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main };

'use strict';

// Fetch NSE surveillance lists — ASM (Additional Surveillance Measure), GSM
// (Graded Surveillance Measure) and the daily F&O securities-ban list — and
// persist them for the trigger layer's tradeability gate.
//
// Output schema (docs/surveillance.json):
//   {
//     updatedAt: ISO,
//     asm:    { <SYMBOL>: { stage: number|null, type: 'longterm'|'shortterm' } },
//     gsm:    { <SYMBOL>: { stage: number|null } },
//     fnoBan: [ <SYMBOL>, ... ]
//   }
//
// NSE blocks bare API hits: a warm-up request to www.nseindia.com with
// browser-like headers is needed first to obtain cookies (same approach as
// fetch-fii-dii.js / fetch-nse-delivery.js). The three datasets are fetched
// independently — one failing keeps that section from the previous file and
// must not kill the others. If everything fails the old file is left
// untouched and the script exits 0.

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const OUT_PATH = path.join(__dirname, 'docs', 'surveillance.json');

const WARMUP_URL  = 'https://www.nseindia.com';
const ASM_URL     = 'https://www.nseindia.com/api/reportASM';
const GSM_URL     = 'https://www.nseindia.com/api/reportGSM';
const FNO_BAN_URL = 'https://www.nseindia.com/api/foSecuritiesBan';
const FNO_BAN_CSV = 'https://nsearchives.nseindia.com/content/fo/fo_secban.csv';

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

async function fetchApi(url, cookies, referer) {
  const res = await tryFetch(url, {
    'Accept': 'application/json,*/*',
    'Referer': referer || 'https://www.nseindia.com/reports/surveillance-actions',
    'Cookie': cookies,
  });
  return res.body;
}

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };

// NSE stage fields come in many flavours: 'Stage I', 'LTASM Stage II', '1', 2, 'IV'.
function parseStage(v) {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  const s = String(v).toUpperCase().trim();
  let m = s.match(/(\d+)/);
  if (m) return parseInt(m[1], 10);
  m = s.match(/\b(VI|IV|III|II|V|I)\b/);
  if (m) return ROMAN[m[1]];
  return null;
}

function symbolFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  for (const k of Object.keys(row)) {
    if (/symbol/i.test(k) && typeof row[k] === 'string' && row[k].trim()) return row[k].trim().toUpperCase();
  }
  return null;
}

function stageFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  // Prefer explicitly stage-ish fields, then any surveillance-indicator field.
  const keys = Object.keys(row);
  const ordered = [
    ...keys.filter(k => /stage/i.test(k)),
    ...keys.filter(k => /surv|indicator/i.test(k) && !/stage/i.test(k)),
  ];
  for (const k of ordered) {
    const st = parseStage(row[k]);
    if (st != null) return st;
  }
  return null;
}

function rowsOf(section) {
  if (Array.isArray(section)) return section;
  if (section && Array.isArray(section.data)) return section.data;
  return [];
}

// reportASM → { longterm: {data:[{symbol, asmSurvIndicator…}]}, shortterm: {data:[…]} }
// (parsed defensively — shapes drift). Long-term wins when a symbol is in both.
function parseAsm(body) {
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('ASM API returned non-JSON (likely blocked)'); }
  const out = {};
  for (const type of ['shortterm', 'longterm']) {
    for (const row of rowsOf(json[type])) {
      const symbol = symbolFromRow(row);
      if (!symbol) continue;
      out[symbol] = { stage: stageFromRow(row), type };
    }
  }
  if (!Object.keys(out).length) throw new Error('no parseable ASM rows');
  return out;
}

// reportGSM → array or {data:[{symbol, gsmSurvIndicator/stage…}]}.
function parseGsm(body) {
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('GSM API returned non-JSON (likely blocked)'); }
  const rows = rowsOf(json).length ? rowsOf(json) : rowsOf(json.gsm);
  const out = {};
  for (const row of rows) {
    const symbol = symbolFromRow(row);
    if (!symbol) continue;
    out[symbol] = { stage: stageFromRow(row) };
  }
  if (!Object.keys(out).length) throw new Error('no parseable GSM rows');
  return out;
}

const SYMBOL_RE = /^[A-Z0-9&-]{1,20}$/;

// foSecuritiesBan → JSON with a list of banned symbols somewhere inside
// (seen as {bans:[…]} / {data:[…]} / plain array, items strings or {symbol}).
function parseFnoBanJson(body) {
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('F&O ban API returned non-JSON (likely blocked)'); }
  const lists = [];
  if (Array.isArray(json)) lists.push(json);
  else if (json && typeof json === 'object') {
    for (const v of Object.values(json)) if (Array.isArray(v)) lists.push(v);
  }
  const out = new Set();
  for (const list of lists) {
    for (const item of list) {
      const sym = typeof item === 'string' ? item.trim().toUpperCase() : symbolFromRow(item);
      if (sym && SYMBOL_RE.test(sym)) out.add(sym);
    }
  }
  // An empty ban list is a legitimate result only if the payload clearly parsed;
  // treat "found no arrays at all" as a shape failure so the CSV fallback runs.
  if (!lists.length) throw new Error('unexpected F&O ban API shape');
  return [...out];
}

// fo_secban.csv — plain text, one symbol per line after a header row,
// each line typically 'N,SYMBOL'.
function parseFnoBanCsv(body) {
  const lines = String(body).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 1; i < lines.length; i++) {           // skip header line
    const parts = lines[i].split(',').map(s => s.trim()).filter(Boolean);
    const sym = (parts[parts.length - 1] || '').toUpperCase();
    if (SYMBOL_RE.test(sym) && !/^\d+$/.test(sym)) out.push(sym);
  }
  return out;
}

function loadCurrent() {
  try {
    if (!fs.existsSync(OUT_PATH)) return { updatedAt: null, asm: {}, gsm: {}, fnoBan: [] };
    const raw = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return {
      updatedAt: raw.updatedAt || null,
      asm: raw.asm && typeof raw.asm === 'object' ? raw.asm : {},
      gsm: raw.gsm && typeof raw.gsm === 'object' ? raw.gsm : {},
      fnoBan: Array.isArray(raw.fnoBan) ? raw.fnoBan : [],
    };
  } catch { return { updatedAt: null, asm: {}, gsm: {}, fnoBan: [] }; }
}

async function main() {
  console.log('Fetching NSE surveillance lists (ASM / GSM / F&O ban)...');
  const data = loadCurrent();

  let cookies = null;
  try { cookies = await getCookies(); }
  catch (e) { console.warn(`  WARNING: NSE warm-up failed (${e.message}) — API fetches will likely fail too.`); }

  let fetched = 0;

  try {
    if (cookies == null) throw new Error('no session cookies');
    data.asm = parseAsm(await fetchApi(ASM_URL, cookies));
    fetched++;
    console.log(`  ASM: ${Object.keys(data.asm).length} symbols`);
  } catch (e) {
    console.warn(`  WARNING: ASM fetch failed (${e.message}). Keeping previous ASM section (${Object.keys(data.asm).length} symbols).`);
  }

  try {
    if (cookies == null) throw new Error('no session cookies');
    data.gsm = parseGsm(await fetchApi(GSM_URL, cookies));
    fetched++;
    console.log(`  GSM: ${Object.keys(data.gsm).length} symbols`);
  } catch (e) {
    console.warn(`  WARNING: GSM fetch failed (${e.message}). Keeping previous GSM section (${Object.keys(data.gsm).length} symbols).`);
  }

  try {
    if (cookies == null) throw new Error('no session cookies');
    data.fnoBan = parseFnoBanJson(await fetchApi(FNO_BAN_URL, cookies, 'https://www.nseindia.com/reports/fo-daily-reports'));
    fetched++;
    console.log(`  F&O ban: ${data.fnoBan.length} symbols`);
  } catch (e1) {
    try {
      const res = await tryFetch(FNO_BAN_CSV, { 'Accept': 'text/csv,*/*', 'Referer': 'https://www.nseindia.com/' });
      data.fnoBan = parseFnoBanCsv(res.body);
      fetched++;
      console.log(`  F&O ban (archives CSV fallback): ${data.fnoBan.length} symbols`);
    } catch (e2) {
      console.warn(`  WARNING: F&O ban fetch failed (API: ${e1.message}; CSV: ${e2.message}). Keeping previous list (${data.fnoBan.length} symbols).`);
    }
  }

  if (!fetched) {
    console.warn(`  WARNING: all surveillance fetches failed. Keeping existing ${OUT_PATH} unchanged.`);
    return;   // exit 0, old file untouched
  }

  data.updatedAt = new Date().toISOString();
  if (!fs.existsSync(path.dirname(OUT_PATH))) fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
  console.log(`  Wrote ${OUT_PATH} (${fetched}/3 datasets refreshed)`);
}

if (require.main === module) {
  main().catch(e => { console.warn(`  WARNING: surveillance fetch failed (${e.message}). Keeping old file.`); process.exit(0); });
}
module.exports = { main, parseAsm, parseGsm, parseFnoBanJson, parseFnoBanCsv, parseStage };

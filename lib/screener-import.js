'use strict';

// ── Screener.in export importer ───────────────────────────────────────────────
// Turns a CSV exported from a Screener.in Premium custom screen into rows the
// rest of the app understands (ticker + name + fundamental metrics).
//
// Two hard problems this module solves, both because Screener.in exports are
// built for humans, not pipelines:
//   1. COLUMN NAMES vary per screen (you pick the columns in your query) and are
//      abbreviated ("Mar Cap Rs.Cr.", "NP Qtr", "Qtr Profit Var %"). We fuzzy-match
//      headers against known concepts rather than hard-coding positions.
//   2. COMPANY NAMES are truncated ("Reliance Industr", "Hind. Unilever") and the
//      export carries NO NSE symbol. We resolve names to tickers against the app's
//      own universe (nse-tickers.json + every sidecar) with a normalize→prefix→token
//      matcher, plus a user-editable screener-aliases.json for the stubborn ones.
//
// Zero runtime dependencies (hand-rolled CSV parser) so the local ingest never
// needs npm install; xlsx is intentionally not supported — export as CSV.

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── CSV parsing ────────────────────────────────────────────────────────────────
// Full RFC-ish parser: handles quoted fields, embedded commas, escaped quotes ("").
function parseCsvText(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\r') { /* ignore, handle on \n */ }
    else if (c === '\n') { pushField(); pushRow(); }
    else field += c;
  }
  if (field.length || row.length) { pushField(); pushRow(); }
  return rows.filter(r => r.some(cell => String(cell).trim() !== '')); // drop blank lines
}

// Concept → header regexes. First match wins; order matters (specific before generic).
const COLUMN_MAP = [
  ['name',        [/^name$/i, /company/i, /^\s*name\b/i]],
  ['price',       [/\bcmp\b/i, /current price/i, /\bltp\b/i, /^price/i]],
  ['pe',          [/\bp\s*\/?\s*e\b/i, /price to earning/i]],
  ['marketCap',   [/mar(ket)?\.?\s*cap/i, /\bm[\-\s]?cap\b/i]],
  ['divYield',    [/div(idend)?\.?\s*yld|dividend yield/i]],
  ['roce',        [/\broce\b/i, /return on cap/i]],
  ['roe',         [/\broe\b/i, /return on equity/i]],
  ['salesGrowth', [/sales var|qtr sales var|sales growth|sales gr/i]],
  ['profitGrowth',[/profit var|qtr profit var|profit growth/i]],
  ['debtEquity',  [/debt\s*\/?\s*eq|d\s*\/\s*e/i]],
  ['promoter',    [/promoter/i]],
  ['pbv',         [/\bp\s*\/?\s*b\b|price to book/i]],
  ['eps',         [/\beps\b/i]],
  ['pctFrom52wHigh',[/52w?k?\.?\s*high|from high|down from/i]],
];

function detectColumns(headerCells) {
  const cols = {}; // concept -> index
  headerCells.forEach((h, i) => {
    const cell = String(h).trim();
    if (!cell) return;
    for (const [concept, regexes] of COLUMN_MAP) {
      if (cols[concept] != null) continue;
      if (regexes.some(re => re.test(cell))) { cols[concept] = i; break; }
    }
  });
  return cols;
}

// Find the header row: the first row that yields a 'name' column AND at least one
// numeric-concept column. Screener.in exports often have a title/blank line first.
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const cols = detectColumns(rows[i]);
    if (cols.name != null && Object.keys(cols).length >= 2) return { idx: i, cols };
  }
  // Fallback: assume first row is header.
  return { idx: 0, cols: detectColumns(rows[0] || []) };
}

function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[,%₹\s]/g, ''));
  return isFinite(n) ? n : null;
}

// ── Name normalisation & ticker resolution ──────────────────────────────────────
const SUFFIXES = /\b(ltd|limited|ltd\.|the|india|indian|corp|corporation|company|co|inds|industries|industr|enterprises|ent|technologies|tech|services|svcs|international|intl|finance|fin|financial|holdings|hldg|and|&)\b/gi;

function normName(s) {
  return String(s == null ? '' : s)
    .toUpperCase()
    .replace(/[.\-'’`()]/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build a resolver from the app's own universe: every (ticker,name) pair we know.
// Sources: docs/nse-tickers.json ({t,n}), every *-tickers.json sidecar, ticker-urls.
function buildResolver() {
  const pairs = []; // { ticker, name }
  const tickerSet = new Set();
  const add = (ticker, name) => {
    const t = String(ticker || '').trim().toUpperCase();
    if (!t) return;
    tickerSet.add(t);
    if (name) pairs.push({ ticker: t, name: String(name) });
  };

  try {
    const nse = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'nse-tickers.json'), 'utf8'));
    (Array.isArray(nse) ? nse : []).forEach(r => add(r.t || r.ticker || r.symbol, r.n || r.name));
  } catch { /* optional */ }

  // Pull names from all sidecars so we cover names Screener spells differently.
  const docsDir = path.join(ROOT, 'docs');
  try {
    for (const f of fs.readdirSync(docsDir)) {
      if (!/-tickers\.json$|-data\.json$/.test(f) || f === 'nse-tickers.json') continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(docsDir, f), 'utf8'));
        const arr = Array.isArray(raw) ? raw : (raw.rows || raw.stocks || raw.triggers || []);
        arr.forEach(r => add(r.ticker || r.t || r.symbol, r.name || r.n));
      } catch { /* skip bad file */ }
    }
  } catch { /* no docs dir */ }

  // exact + prefix indexes on normalised names
  const byNorm = new Map();      // normName -> ticker (first wins)
  const normList = [];           // { norm, ticker } for prefix/token matching
  for (const { ticker, name } of pairs) {
    const nn = normName(name);
    if (!nn) continue;
    if (!byNorm.has(nn)) byNorm.set(nn, ticker);
    normList.push({ norm: nn, ticker });
  }

  // user alias overrides: { "screener name or normalised": "TICKER" }
  let aliases = {};
  try { aliases = JSON.parse(fs.readFileSync(path.join(ROOT, 'screener-aliases.json'), 'utf8')); } catch { /* optional */ }
  const aliasNorm = new Map();
  for (const [k, v] of Object.entries(aliases)) aliasNorm.set(normName(k), String(v).toUpperCase());

  return { byNorm, normList, tickerSet, aliasNorm };
}

// Resolve one Screener.in company name (possibly truncated) to a ticker.
// Returns { ticker, method } or { ticker: null, method: 'none' }.
function resolveTicker(rawName, resolver) {
  const nn = normName(rawName);
  if (!nn) return { ticker: null, method: 'none' };

  // 0. explicit alias
  if (resolver.aliasNorm.has(nn)) return { ticker: resolver.aliasNorm.get(nn), method: 'alias' };
  // 0b. the raw string IS a ticker we know (some screens show symbols)
  const upper = String(rawName).trim().toUpperCase();
  if (resolver.tickerSet.has(upper)) return { ticker: upper, method: 'symbol' };

  // 1. exact normalised match
  if (resolver.byNorm.has(nn)) return { ticker: resolver.byNorm.get(nn), method: 'exact' };

  // 2. prefix match — Screener truncates, so a known name may START WITH the export
  //    string (or vice-versa). Prefer the shortest full name that contains it.
  let best = null;
  for (const { norm, ticker } of resolver.normList) {
    if (norm === nn) return { ticker, method: 'exact' };
    if (norm.startsWith(nn) || nn.startsWith(norm)) {
      if (!best || norm.length < best.len) best = { ticker, len: norm.length };
    }
  }
  if (best) return { ticker: best.ticker, method: 'prefix' };

  // 3. token-subset: all tokens of the (shorter) name appear in the other.
  const nnTokens = nn.split(' ').filter(Boolean);
  if (nnTokens.length) {
    let cand = null;
    for (const { norm, ticker } of resolver.normList) {
      const ntok = norm.split(' ').filter(Boolean);
      const short = nnTokens.length <= ntok.length ? nnTokens : ntok;
      const long = new Set(nnTokens.length <= ntok.length ? ntok : nnTokens);
      if (short.length >= 2 && short.every(t => long.has(t))) {
        if (!cand || norm.length < cand.len) cand = { ticker, len: norm.length };
      }
    }
    if (cand) return { ticker: cand.ticker, method: 'tokens' };
  }

  return { ticker: null, method: 'none' };
}

// Parse one CSV file into normalised rows.
// Returns { screenName, columns, rows:[{ticker,name,rawName,price,marketCap,metrics}], unmatched:[] }
function ingestCsv(filepath, resolver) {
  const text = fs.readFileSync(filepath, 'utf8');
  const grid = parseCsvText(text);
  if (!grid.length) return { screenName: path.basename(filepath), columns: {}, rows: [], unmatched: [] };

  const { idx, cols } = findHeaderRow(grid);
  const dataRows = grid.slice(idx + 1);
  const rows = [];
  const unmatched = [];
  const screenName = path.basename(filepath).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

  for (const cells of dataRows) {
    const name = cols.name != null ? String(cells[cols.name] || '').trim() : '';
    if (!name || /^(median|average|total|s\.?no)/i.test(name)) continue; // skip summary rows
    const { ticker, method } = resolveTicker(name, resolver);
    const metrics = {};
    for (const [concept, ci] of Object.entries(cols)) {
      if (concept === 'name') continue;
      const val = toNum(cells[ci]);
      if (val != null) metrics[concept] = val;
    }
    if (!ticker) { unmatched.push(name); continue; }
    rows.push({
      ticker,
      name,
      price: metrics.price ?? null,
      marketCap: metrics.marketCap ?? null,
      matchMethod: method,
      metrics,
    });
  }
  return { screenName, columns: cols, rows, unmatched };
}

module.exports = { parseCsvText, detectColumns, findHeaderRow, normName, buildResolver, resolveTicker, ingestCsv, COLUMN_MAP };

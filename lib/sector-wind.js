'use strict';

// Shared sector + sectoral headwind/tailwind for every stock page.
// Wind is derived from the existing NSE sector-index heat sidecar
// (docs/sectors-data.json, written by generate-sectors.js) — not a new feed.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT_NAME = 'sector-wind.js';
const SCRIPT_TAG = `<script src="${SCRIPT_NAME}" defer></script>`;

const SECTOR_INDEX_RULES = [
  { matchSrc: String.raw`\b(information technology|tech|technology|software|\bit\b)\b`, index: 'Nifty IT' },
  { matchSrc: String.raw`\b(pharma|pharmaceuticals|health\s*care|healthcare|hospital|medical|diagnostics)\b`, index: 'Nifty Pharma & Healthcare' },
  { matchSrc: String.raw`\b(realty|real\s*estate|construction)\b`, index: 'Nifty Realty' },
  { matchSrc: String.raw`\b(media|entertainment|broadcast|communication\s*services|telecom)\b`, index: 'Nifty Media' },
  { matchSrc: String.raw`\b(infrastructure|infra|capital\s*goods|industrials?|engineering|shipbuilding|defence)\b`, index: 'Nifty Infrastructure' },
  { matchSrc: String.raw`\b(metals?|mining|steel|materials?|chemicals?|alloys?|aluminium|ferro)\b`, index: 'Nifty Metal' },
  { matchSrc: String.raw`\b(energy|power|utilities|utility|oil|gas|petroleum)\b`, index: 'Nifty Energy' },
  { matchSrc: String.raw`\b(fmcg|consumer staples|staples)\b`, index: 'Nifty FMCG' },
  { matchSrc: String.raw`\b(auto|automobile|automotive)\b`, index: 'Nifty Auto' },
  { matchSrc: String.raw`\b(durables|consumer durables|appliances|electronics)\b`, index: 'Nifty Consumer Durables' },
  { matchSrc: String.raw`\b(consumer discretionary)\b`, index: 'Nifty Auto' },
  { matchSrc: String.raw`\b(bank|banking|psu bank)\b`, index: 'Nifty Bank' },
  { matchSrc: String.raw`\b(financial services|finance|nbfc|insurance|financials|capital markets|exchange|broking|housing finance)\b`, index: 'Nifty Services' },
];

const BANK_TICKERS = new Set([
  'HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK', 'MAHABANK',
  'INDIANB', 'CANBK', 'PNB', 'BANKBARODA', 'INDUSINDBK', 'IDFCFIRSTB',
]);

const TICKER_SECTOR_FALLBACK = {
  NETWEB: 'Information Technology',
  GRSE: 'Industrials',
  DYNAMATECH: 'Industrials',
  GMDCLTD: 'Materials',
  ARYACAPM: 'Financial Services',
  UNIABEXAL: 'Materials',
  BAJAJFINSV: 'Financial Services',
  LTF: 'Financial Services',
  IMFA: 'Materials',
  NATIONALUM: 'Materials',
  TRANSRAILL: 'Industrials',
  BAJAJHFL: 'Financial Services',
  NSE: 'Financial Services',
  BSE: 'Financial Services',
  VIYASH: 'Health Care',
  GRAPHITE: 'Materials',
  SHAKTIPUMP: 'Industrials',
  DIXON: 'Consumer Durables',
  MAITHANALL: 'Materials',
  EXIDEIND: 'Auto',
  SBILIFE: 'Financial Services',
  TECHM: 'Information Technology',
  IDFCFIRSTB: 'Banking',
  ICICIBANK: 'Banking',
  TCS: 'Information Technology',
  GUJENERGY: 'Energy',
};

const css = `
.wind-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:.66rem;font-weight:700;letter-spacing:.02em;user-select:none;vertical-align:middle;margin-left:4px;white-space:nowrap}
.wind-tail{background:rgba(34,197,94,.14);color:#22c55e;border:1px solid rgba(34,197,94,.4)}
.wind-head{background:rgba(239,68,68,.14);color:#ef4444;border:1px solid rgba(239,68,68,.4)}
.wind-neutral{background:rgba(148,163,184,.12);color:#94a3b8;border:1px solid rgba(148,163,184,.3)}
`;

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function loadSectorTrends(root = ROOT) {
  const map = new Map();
  const jsonPath = path.join(root, 'docs', 'sectors-data.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (Array.isArray(data)) {
        data.forEach(s => { if (s && s.name && s.name !== 'Unclassified / Other') map.set(s.name, s); });
      }
    } catch { /* keep empty */ }
  }
  if (!map.size) {
    const htmlPath = path.join(root, 'docs', 'sectors.html');
    if (fs.existsSync(htmlPath)) {
      try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        const m = html.match(/const RAW\s*=\s*(\[[\s\S]*?\]);/);
        if (m) {
          const raw = JSON.parse(m[1]);
          raw.forEach(s => { if (s && s.name && s.name !== 'Unclassified / Other') map.set(s.name, s); });
        }
      } catch { /* keep empty */ }
    }
  }
  return map;
}

function rowsFromJson(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const out = [];
  for (const key of ['stocks', 'rows', 'picks', 'triggers', 'armed', 'cards', 'results']) {
    if (Array.isArray(data[key])) out.push(...data[key]);
  }
  return out;
}

let _tickerSectorsCache;
function loadTickerSectors(root = ROOT) {
  if (_tickerSectorsCache) return _tickerSectorsCache;
  const map = { ...TICKER_SECTOR_FALLBACK };
  const docs = path.join(root, 'docs');
  let files = [];
  try { files = fs.readdirSync(docs).filter(f => f.endsWith('.json')); } catch { return map; }
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(docs, f), 'utf8')); } catch { continue; }
    for (const s of rowsFromJson(data)) {
      if (!s || !s.ticker || !s.sector) continue;
      const t = String(s.ticker).toUpperCase();
      if (!map[t]) map[t] = s.sector;
    }
  }
  _tickerSectorsCache = map;
  return map;
}

function resolveArgs(stockOrTicker, rawSectorOrTrends, maybeTrends) {
  let ticker = '';
  let rawSector = '';
  let sectorTrends;
  if (stockOrTicker && typeof stockOrTicker === 'object') {
    ticker = stockOrTicker.ticker || stockOrTicker.symbol || '';
    rawSector = stockOrTicker.sector || stockOrTicker.rawSector || '';
    sectorTrends = rawSectorOrTrends;
  } else {
    ticker = stockOrTicker || '';
    if (rawSectorOrTrends && typeof rawSectorOrTrends.get === 'function') {
      sectorTrends = rawSectorOrTrends;
    } else {
      rawSector = rawSectorOrTrends || '';
      sectorTrends = maybeTrends;
    }
  }
  return { ticker: String(ticker || '').toUpperCase(), rawSector, sectorTrends };
}

function matchIndexName(sec) {
  if (!sec) return null;
  for (const r of SECTOR_INDEX_RULES) {
    if (new RegExp(r.matchSrc, 'i').test(sec)) return r.index;
  }
  return null;
}

function classifyWind(score, trendClass) {
  if (score >= 55 || trendClass === 'up' || trendClass === 'up-strong') {
    return { wind: 'TAILWIND', windLabel: '🟢 Tailwind', windClass: 'wind-tail' };
  }
  if (score < 45 || trendClass === 'down' || trendClass === 'down-strong') {
    return { wind: 'HEADWIND', windLabel: '🔴 Headwind', windClass: 'wind-head' };
  }
  return { wind: 'NEUTRAL', windLabel: '⚪ Neutral', windClass: 'wind-neutral' };
}

/**
 * Given a stock (or ticker + sector), return its sector and whether that
 * sector has a tailwind / headwind / neutral climate from sector heat.
 *
 *   evaluateSectorWind(stock)
 *   evaluateSectorWind(stock, sectorTrends)
 *   evaluateSectorWind(ticker, rawSector, sectorTrends)  // alerts/special shape
 */
function evaluateSectorWind(stockOrTicker, rawSectorOrTrends, maybeTrends) {
  const { ticker, rawSector, sectorTrends } = resolveArgs(stockOrTicker, rawSectorOrTrends, maybeTrends);
  const trends = sectorTrends || loadSectorTrends();

  let sec = String(rawSector || '').trim();
  if (!sec || sec === '—' || sec === 'Unknown') {
    sec = loadTickerSectors()[ticker] || TICKER_SECTOR_FALLBACK[ticker] || 'Unknown';
  }
  if (BANK_TICKERS.has(ticker)) sec = 'Banking';

  const indexName = matchIndexName(sec);
  const sObj = indexName && trends ? trends.get(indexName) : null;
  const score = sObj ? (sObj.score ?? 50) : 50;
  const trend = sObj ? (sObj.trend ?? '—') : '—';
  const trendClass = sObj ? (sObj.trendClass ?? 'neutral') : 'neutral';
  const cls = classifyWind(score, trendClass);

  let windReason = 'Sector index is range-bound or neutral.';
  const label = indexName || sec;
  if (cls.wind === 'TAILWIND' || cls.wind === 'HEADWIND') {
    windReason = `${label} in ${trend} (Score: ${score}/100)`;
  } else {
    windReason = `${label} is consolidating / neutral (Score: ${score}/100)`;
  }

  return {
    sector: sec,
    indexName: indexName || 'Broad Market',
    score,
    trend,
    trendClass,
    ...cls,
    windReason,
  };
}

function chipHtml(wind, extraClass = '') {
  if (!wind) return '';
  const tip = esc((wind.sector && wind.sector !== 'Unknown' ? wind.sector + ' · ' : '') + (wind.windReason || ''));
  const cls = ['wind-badge', wind.windClass, 'tip', extraClass].filter(Boolean).join(' ');
  return `<span class="${cls}" tabindex="0" data-tip="${tip}" title="${tip}">${esc(wind.windLabel)}</span>`;
}

function chipFor(stock, sectorTrends) {
  return chipHtml(evaluateSectorWind(stock, sectorTrends));
}

function trendsObject(map) {
  const obj = {};
  for (const [name, s] of map.entries()) {
    obj[name] = { score: s.score ?? 50, trend: s.trend ?? '—', trendClass: s.trendClass ?? 'neutral' };
  }
  return obj;
}

function browserJs(root = ROOT) {
  const trends = trendsObject(loadSectorTrends(root));
  const tickerSectors = loadTickerSectors(root);
  const rules = SECTOR_INDEX_RULES.map(r => ({ matchSrc: r.matchSrc, index: r.index }));
  const banks = [...BANK_TICKERS];
  return `(function(){
if (window.evaluateSectorWind) return;
var TRENDS = ${JSON.stringify(trends)};
var TICKER_SECTOR = ${JSON.stringify(tickerSectors)};
var RULES = ${JSON.stringify(rules)};
var BANKS = ${JSON.stringify(banks)};
var FALLBACK = ${JSON.stringify(TICKER_SECTOR_FALLBACK)};
function matchIndex(sec){
  if (!sec) return null;
  for (var i = 0; i < RULES.length; i++) {
    if (new RegExp(RULES[i].matchSrc, 'i').test(sec)) return RULES[i].index;
  }
  return null;
}
function classify(score, trendClass){
  if (score >= 55 || trendClass === 'up' || trendClass === 'up-strong')
    return { wind: 'TAILWIND', windLabel: '🟢 Tailwind', windClass: 'wind-tail' };
  if (score < 45 || trendClass === 'down' || trendClass === 'down-strong')
    return { wind: 'HEADWIND', windLabel: '🔴 Headwind', windClass: 'wind-head' };
  return { wind: 'NEUTRAL', windLabel: '⚪ Neutral', windClass: 'wind-neutral' };
}
window.evaluateSectorWind = function(stock){
  var ticker = '', raw = '';
  if (stock && typeof stock === 'object') {
    ticker = String(stock.ticker || stock.symbol || '').toUpperCase();
    raw = String(stock.sector || stock.rawSector || '');
  } else {
    ticker = String(stock || '').toUpperCase();
  }
  var sec = raw.trim();
  if (!sec || sec === '—' || sec === 'Unknown') sec = TICKER_SECTOR[ticker] || FALLBACK[ticker] || 'Unknown';
  if (BANKS.indexOf(ticker) >= 0) sec = 'Banking';
  var indexName = matchIndex(sec);
  var sObj = indexName ? TRENDS[indexName] : null;
  var score = sObj ? (sObj.score != null ? sObj.score : 50) : 50;
  var trend = sObj ? (sObj.trend || '—') : '—';
  var trendClass = sObj ? (sObj.trendClass || 'neutral') : 'neutral';
  var cls = classify(score, trendClass);
  var label = indexName || sec;
  var windReason = (cls.wind === 'NEUTRAL')
    ? (label + ' is consolidating / neutral (Score: ' + score + '/100)')
    : (label + ' in ' + trend + ' (Score: ' + score + '/100)');
  return {
    sector: sec, indexName: indexName || 'Broad Market', score: score, trend: trend,
    trendClass: trendClass, wind: cls.wind, windLabel: cls.windLabel, windClass: cls.windClass,
    windReason: windReason
  };
};
function esc(s){
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
window.sectorWindChipHtml = function(w){
  if (!w) return '';
  var tip = esc((w.sector && w.sector !== 'Unknown' ? w.sector + ' · ' : '') + (w.windReason || ''));
  return '<span class="wind-badge ' + w.windClass + ' tip" tabindex="0" data-tip="' + tip + '" title="' + tip + '">' + esc(w.windLabel) + '</span>';
};
function inferSector(el, ticker){
  var n = el;
  for (var i = 0; i < 10 && n; i++, n = n.parentElement) {
    if (n.getAttribute) {
      var ds = n.getAttribute('data-sector');
      if (ds) return ds;
    }
  }
  var row = el.closest && el.closest('tr, .card, .stock-card, .alert-card, .sector-card, .wl-chip, .name-row, .stock-cell, .stock-name, .stock-name-cell');
  if (row) {
    var sub = row.querySelector && row.querySelector('.ticker-sub, .sector-tag, [data-sector]');
    if (sub) {
      var ds2 = sub.getAttribute && sub.getAttribute('data-sector');
      if (ds2) return ds2;
      var t = (sub.textContent || '').replace(/\\s+/g, ' ').trim();
      var parts = t.split(/[·•|]/);
      if (parts.length >= 2) return parts[parts.length - 1].trim();
    }
  }
  return TICKER_SECTOR[ticker] || FALLBACK[ticker] || '';
}
function tickerFrom(el){
  if (!el) return '';
  if (el.getAttribute) {
    var t = el.getAttribute('data-alert-ticker') || el.getAttribute('data-r-ticker') || el.getAttribute('data-ticker');
    if (t) return t.toUpperCase();
  }
  var btn = el.querySelector && el.querySelector('[data-alert-ticker], [data-r-ticker], [data-ticker]');
  if (btn) return (btn.getAttribute('data-alert-ticker') || btn.getAttribute('data-r-ticker') || btn.getAttribute('data-ticker') || '').toUpperCase();
  return '';
}
function alreadyHas(el){
  if (!el) return true;
  if (el.querySelector && el.querySelector('.wind-badge')) return true;
  var p = el.parentElement;
  if (p && p.querySelector) {
    var kids = p.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === el) continue;
      if (kids[i].classList && kids[i].classList.contains('wind-badge')) return true;
    }
  }
  var card = el.closest && el.closest('.alert-card, .ac-meta-tags');
  if (card && card.querySelector && card.querySelector('.wind-badge')) return true;
  return false;
}
function mountOne(host){
  if (!host || alreadyHas(host)) return;
  var ticker = tickerFrom(host);
  if (!ticker) return;
  var w = window.evaluateSectorWind({ ticker: ticker, sector: inferSector(host, ticker) });
  host.insertAdjacentHTML('afterend', window.sectorWindChipHtml(w));
}
window.mountSectorWindChips = function(){
  var nodes = document.querySelectorAll('.stock-actions, [data-alert-ticker], [data-r-ticker]');
  var seen = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var host = el.classList && el.classList.contains('stock-actions') ? el : (el.closest && el.closest('.stock-actions')) || el;
    if (seen.indexOf(host) >= 0) continue;
    seen.push(host);
    mountOne(host);
  }
};
if (!document.getElementById('sector-wind-css')) {
  var st = document.createElement('style');
  st.id = 'sector-wind-css';
  st.textContent = ${JSON.stringify(css)};
  document.head.appendChild(st);
}
function boot(){ window.mountSectorWindChips(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
if (window.MutationObserver) {
  var _t = null;
  new MutationObserver(function(){
    if (_t) clearTimeout(_t);
    _t = setTimeout(boot, 80);
  }).observe(document.documentElement, { childList: true, subtree: true });
}
})();`;
}

function writeBrowserBundle(root = ROOT) {
  const dest = path.join(root, 'docs', SCRIPT_NAME);
  fs.writeFileSync(dest, browserJs(root), 'utf8');
  return dest;
}

function injectHtml(html) {
  if (!html || html.includes(`${SCRIPT_NAME}"`)) return html;
  let out = html;
  if (!/sector-wind\.js/.test(out)) {
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, SCRIPT_TAG + '\n</body>');
    else out += '\n' + SCRIPT_TAG;
  }
  return out;
}

const loaderJs = `(function(){if(window.__SECTOR_WIND_SRC)return;window.__SECTOR_WIND_SRC=1;var s=document.createElement('script');s.src='${SCRIPT_NAME}';s.defer=true;document.head.appendChild(s);})();`;

module.exports = {
  SECTOR_INDEX_RULES,
  BANK_TICKERS,
  TICKER_SECTOR_FALLBACK,
  loadSectorTrends,
  loadTickerSectors,
  evaluateSectorWind,
  chipHtml,
  chipFor,
  css,
  browserJs,
  writeBrowserBundle,
  injectHtml,
  scriptTag: SCRIPT_TAG,
  loaderJs,
};

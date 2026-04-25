'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const WATCHLIST_PATH = path.join(__dirname, 'my-watchlists.json');
const OUTPUT_PATH = path.join(__dirname, 'docs', 'sectors.html');

// NSE sector index universe (Yahoo Finance tickers)
const SECTOR_INDICES = [
  { ticker: '^CNXIT',        name: 'Nifty IT',                 ttSectors: ['technology', 'it'] },
  { ticker: '^NSEBANK',      name: 'Nifty Bank',               ttSectors: ['banking', 'bank'] },
  { ticker: '^CNXSERVICE',   name: 'Nifty Services',           ttSectors: ['financial services', 'finance', 'nbfc', 'insurance'] },
  { ticker: '^CNXPSUBANK',   name: 'Nifty PSU Bank',           ttSectors: ['psu bank', 'public sector bank'] },
  { ticker: '^CNXAUTO',      name: 'Nifty Auto',               ttSectors: ['automobile', 'auto', 'automotive'] },
  { ticker: '^CNXPHARMA',    name: 'Nifty Pharma & Healthcare', ttSectors: ['pharmaceuticals', 'pharma', 'healthcare', 'health care', 'hospital', 'diagnostics', 'medical'] },
  { ticker: '^CNXFMCG',      name: 'Nifty FMCG',              ttSectors: ['fmcg', 'consumer staples', 'consumer goods'] },
  { ticker: '^CNXMETAL',     name: 'Nifty Metal',              ttSectors: ['metals', 'metal', 'mining', 'steel'] },
  { ticker: '^CNXREALTY',    name: 'Nifty Realty',             ttSectors: ['real estate', 'realty', 'construction'] },
  { ticker: '^CNXENERGY',    name: 'Nifty Energy',             ttSectors: ['energy', 'power', 'utilities'] },
  { ticker: '^CNXPSE',       name: 'Nifty PSE (Oil/Energy)',   ttSectors: ['oil & gas', 'oil and gas', 'petroleum', 'refinery'] },
  { ticker: '^CNXINFRA',     name: 'Nifty Infrastructure',     ttSectors: ['infrastructure', 'infra', 'cement'] },
  { ticker: '^CNXMEDIA',     name: 'Nifty Media',              ttSectors: ['media', 'entertainment', 'broadcast'] },
  { ticker: '^CNXCONSUM',    name: 'Nifty Consumer Durables',  ttSectors: ['consumer durables', 'consumer electronics', 'durables', 'appliances'] },
];
const BENCHMARK_TICKER = '^NSEI';
// 5 years of history (in calendar days)
const HISTORY_DAYS = 1825;
const SCREENER_URL = 'https://api.tickertape.in/screener/query';

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sma(arr, n) {
  const slice = arr.slice(-n);
  if (slice.length < n) return null;
  return avg(slice);
}

function smaAt(arr, n, offset) {
  // SMA(n) ending at index (arr.length - 1 - offset)
  const end = arr.length - offset;
  const start = end - n;
  if (start < 0) return null;
  const slice = arr.slice(start, end);
  return avg(slice);
}

function rsi14(closes) {
  if (closes.length < 15) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  for (let i = 15; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * 13 + Math.max(diff, 0)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(-diff, 0)) / 14;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function retPct(closes, n) {
  const len = closes.length;
  if (len <= n) return null;
  const base = closes[len - 1 - n];
  if (!base) return null;
  return ((closes[len - 1] / base) - 1) * 100;
}

function fmtPct(v, decimals = 1) {
  if (v == null || isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return sign + v.toFixed(decimals) + '%';
}

function colorClass(v) {
  if (v == null || isNaN(v)) return 'nc';
  if (v >= 5) return 'gn3';
  if (v >= 1) return 'gn2';
  if (v >= 0) return 'gn1';
  if (v > -1) return 'rd1';
  if (v > -5) return 'rd2';
  return 'rd3';
}

// ── Tickertape Screener (raw https) ───────────────────────────────────────

function apiPostOnce(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'api.tickertape.in',
      path: '/screener/query',
      method: 'POST',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://www.tickertape.in',
        'Referer': 'https://www.tickertape.in/',
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Screener JSON parse error')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Screener timeout')); });
    req.end(data);
  });
}

async function apiPost(body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await apiPostOnce(body); }
    catch (e) {
      if (i === retries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

// ── Load watchlist tickers ──────────────────────────────────────────────────

function loadWatchlistTickers() {
  if (!fs.existsSync(WATCHLIST_PATH)) return [];
  const watchlists = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
  const seen = new Set();
  const stocks = [];
  for (const wl of watchlists) {
    for (const period of Object.values(wl.periods || {})) {
      for (const s of (period.stocks || [])) {
        const parts = (s.name || '').split('\n');
        const ticker = (parts[1] || '').trim();
        const name = (parts[0] || '').trim();
        if (!ticker || seen.has(ticker)) continue;
        seen.add(ticker);
        stocks.push({ ticker, name });
      }
    }
  }
  return stocks;
}

// ── Fetch sector data from Tickertape screener ──────────────────────────────

async function fetchWatchlistSectors(tickers) {
  const tickerSet = new Set(tickers.map(t => t.ticker));
  const result = {};
  let offset = 0;
  const count = 500;
  while (true) {
    try {
      const res = await apiPost({
        match: {},
        project: ['ticker', 'sector'],
        offset,
        count,
        sortBy: 'mrktCapf',
        sortOrder: -1,
      });
      const items = (res && res.data && res.data.results) ? res.data.results : [];
      if (items.length === 0) break;
      for (const item of items) {
        const t = (item.stock && item.stock.info && item.stock.info.ticker) || item.ticker;
        const ar = (item.stock && item.stock.advancedRatios) || {};
        const sector = ar.sector || (item.stock && item.stock.info && item.stock.info.sector) || '';
        if (t && tickerSet.has(t)) result[t] = sector;
      }
      if (items.length < count) break;
      offset += count;
      await sleep(300);
    } catch (e) {
      console.warn('Screener page error:', e.message);
      break;
    }
  }
  return result;
}

// ── Fetch OHLCV history from Yahoo Finance ──────────────────────────────────

async function fetchHistory(ticker) {
  const period1 = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const period2 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    const rows = await yahooFinance.historical(ticker, { period1, period2, interval: '1d' });
    if (!rows || rows.length < 60) return null;
    return rows
      .filter(r => r.close != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (e) {
    console.warn(`  Yahoo history failed for ${ticker}: ${e.message}`);
    return null;
  }
}

// ── Analyse sector bars ──────────────────────────────────────────────────────

function analyzeSector(bars, benchmarkBars) {
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const price = closes[n - 1];

  // SMAs
  const s50  = sma(closes, 50);
  const s150 = sma(closes, 150);
  const s200 = sma(closes, 200);
  const s200_20ago = smaAt(closes, 200, 20);

  // Returns (trading-bar based)
  const ret1W  = retPct(closes, 5);
  const ret1M  = retPct(closes, 22);
  const ret3M  = retPct(closes, 66);
  const ret6M  = retPct(closes, 132);
  const ret1Y  = retPct(closes, 252);
  const ret3Y  = retPct(closes, 756);
  const ret5Y  = retPct(closes, 1260);

  // RSI
  const rsiVal = rsi14(closes.slice(-50)); // last 50 bars for efficiency

  // 52W high/low
  const last252 = closes.slice(-252);
  const high52w = Math.max(...last252);
  const low52w  = Math.min(...last252);
  const distFrom52wHigh = price != null && high52w ? ((price / high52w) - 1) * 100 : null;

  // RS vs benchmark
  let rs1M = null, rs3M = null, rs6M = null, rs1Y = null;
  if (benchmarkBars && benchmarkBars.length > 0) {
    const bc = benchmarkBars.map(b => b.close);
    const bRet1M = retPct(bc, 22);
    const bRet3M = retPct(bc, 66);
    const bRet6M = retPct(bc, 132);
    const bRet1Y = retPct(bc, 252);
    rs1M = (ret1M != null && bRet1M != null) ? ret1M - bRet1M : null;
    rs3M = (ret3M != null && bRet3M != null) ? ret3M - bRet3M : null;
    rs6M = (ret6M != null && bRet6M != null) ? ret6M - bRet6M : null;
    rs1Y = (ret1Y != null && bRet1Y != null) ? ret1Y - bRet1Y : null;
  }

  // ── Composite Trend Score (0–100) ────────────────────────────────────────
  let score = 0;

  // Factor 1: SMA Position (30 pts)
  if (s50  && price > s50)           score += 10;
  if (s200 && price > s200)          score += 10;
  if (s50 && s200 && s50 > s200)     score += 5;
  if (s200 && s200_20ago && s200 > s200_20ago) score += 5;

  // Factor 2: RS vs Nifty (25 pts)
  if (rs1M != null && rs1M > 0)  score += 5;
  if (rs3M != null && rs3M > 0)  score += 5;
  if (rs6M != null && rs6M > 0)  score += 8;
  if (rs1Y != null && rs1Y > 0)  score += 7;

  // Factor 3: Momentum (25 pts)
  const momentumFactors = [
    { v: ret1M,  threshold: 3,  pts: 4 },
    { v: ret3M,  threshold: 8,  pts: 7 },
    { v: ret6M,  threshold: 12, pts: 7 },
    { v: ret1Y,  threshold: 20, pts: 7 },
  ];
  for (const mf of momentumFactors) {
    if (mf.v == null) continue;
    if (mf.v >= mf.threshold) score += mf.pts;
    else if (mf.v > 0)        score += Math.round(mf.pts * mf.v / mf.threshold);
  }

  // Factor 4: RSI (20 pts)
  if (rsiVal != null) {
    if (rsiVal > 60)      score += 20;
    else if (rsiVal > 50) score += 12;
    else if (rsiVal > 40) score += 6;
  }

  score = Math.min(100, Math.max(0, Math.round(score)));

  // Trend label
  let trend, trendClass;
  if (score >= 70)      { trend = '🔥 Strong Uptrend';    trendClass = 'up-strong'; }
  else if (score >= 55) { trend = '📈 Uptrend';           trendClass = 'up'; }
  else if (score >= 45) { trend = '➡️ Neutral';           trendClass = 'neutral'; }
  else if (score >= 30) { trend = '📉 Downtrend';         trendClass = 'down'; }
  else                  { trend = '⬇️ Strong Downtrend';  trendClass = 'down-strong'; }

  return {
    price, s50, s150, s200, s200_20ago, rsiVal,
    ret1W, ret1M, ret3M, ret6M, ret1Y, ret3Y, ret5Y,
    rs1M, rs3M, rs6M, rs1Y,
    high52w, low52w, distFrom52wHigh,
    score, trend, trendClass,
    barsCount: n,
  };
}

// ── SVG Sparkline (server-side, 1Y last 252 bars) ──────────────────────────

function buildSparkline(bars, trendClass) {
  const raw = bars.map(b => b.close).slice(-252);
  if (raw.length < 2) return '';
  const W = 200, H = 60, PAD = 4;
  const mn = Math.min(...raw);
  const mx = Math.max(...raw);
  const range = mx - mn || 1;
  const points = raw.map((v, i) => {
    const x = PAD + (i / (raw.length - 1)) * (W - 2 * PAD);
    const y = PAD + (1 - (v - mn) / range) * (H - 2 * PAD);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const color = trendClass.startsWith('up') ? '#22c55e' : trendClass === 'neutral' ? '#eab308' : '#ef4444';
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><polyline fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="${points}"/></svg>`;
}

// ── Match watchlist stocks to sectors ──────────────────────────────────────

function matchSector(ttSector, sectorIndex) {
  if (!ttSector) return null;
  const low = ttSector.toLowerCase();
  for (const si of sectorIndex) {
    if (si.ttSectors.some(k => low.includes(k) || k.includes(low))) return si.ticker;
  }
  return null;
}

// ── Build HTML ──────────────────────────────────────────────────────────────

function buildHtml(sectors, generatedAt) {
  const heatmapRows = sectors.map(s => {
    const periods = [
      { label: '1W',  v: s.analysis.ret1W },
      { label: '1M',  v: s.analysis.ret1M },
      { label: '3M',  v: s.analysis.ret3M },
      { label: '6M',  v: s.analysis.ret6M },
      { label: '1Y',  v: s.analysis.ret1Y },
      { label: '3Y',  v: s.analysis.ret3Y },
      { label: '5Y',  v: s.analysis.ret5Y },
    ];
    const cells = periods.map(p => {
      const cls = colorClass(p.v);
      return `<td class="hm-cell ${cls}" title="${esc(p.label)}: ${fmtPct(p.v)}">${fmtPct(p.v, 0)}</td>`;
    }).join('');
    return `<tr><td class="hm-name">${esc(s.name)}</td>${cells}</tr>`;
  }).join('\n');

  const rawJson = JSON.stringify(sectors.map(s => ({
    ticker:     s.ticker,
    name:       s.name,
    trendClass: s.analysis.trendClass,
    trend:      s.analysis.trend,
    score:      s.analysis.score,
    sparkline:  s.sparklineSvg,
    rsi:        s.analysis.rsiVal != null ? Math.round(s.analysis.rsiVal) : null,
    price:      s.analysis.price,
    distFrom52wHigh: s.analysis.distFrom52wHigh,
    aboveSma50:  s.analysis.s50  != null && s.analysis.price > s.analysis.s50,
    aboveSma200: s.analysis.s200 != null && s.analysis.price > s.analysis.s200,
    sma200Up:    s.analysis.s200 != null && s.analysis.s200_20ago != null && s.analysis.s200 > s.analysis.s200_20ago,
    ret1W:  s.analysis.ret1W,
    ret1M:  s.analysis.ret1M,
    ret3M:  s.analysis.ret3M,
    ret6M:  s.analysis.ret6M,
    ret1Y:  s.analysis.ret1Y,
    ret3Y:  s.analysis.ret3Y,
    ret5Y:  s.analysis.ret5Y,
    rs1M:   s.analysis.rs1M,
    rs3M:   s.analysis.rs3M,
    rs6M:   s.analysis.rs6M,
    rs1Y:   s.analysis.rs1Y,
    watchlistStocks: s.watchlistStocks || [],
  })));

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sector Trends — NSE India</title>
<style>
:root{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#f97316;--tx:#e8e8f0;--t2:#9999b0;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7}
html[data-theme="light"]{--bg:#f8fafc;--s1:#fff;--s2:#f1f5f9;--s3:#e2e8f0;--bd:#cbd5e1;--tx:#0f172a;--t2:#475569}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;min-height:100vh}
a{text-decoration:none;color:inherit}

/* Header */
.header{position:sticky;top:0;z-index:100;background:var(--s1);border-bottom:1px solid var(--bd);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;backdrop-filter:blur(12px);gap:12px;flex-wrap:wrap}
.header-title{font-size:1.1rem;font-weight:700;color:var(--ac);white-space:nowrap}
.header-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.back-link{color:var(--t2);font-size:.78rem;padding:5px 10px;border:1px solid var(--bd);border-radius:6px;transition:all .2s;white-space:nowrap}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
.theme-toggle{width:36px;height:20px;background:var(--bd);border-radius:10px;cursor:pointer;position:relative;transition:background .3s;flex-shrink:0}
.theme-toggle::after{content:'';position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--t2);transition:transform .3s}
html[data-theme="light"] .theme-toggle{background:var(--ac)}
html[data-theme="light"] .theme-toggle::after{transform:translateX(16px);background:#fff}
.theme-label{font-size:.75rem;color:var(--t2)}
.gen-time{font-size:.72rem;color:var(--t2);padding:5px 10px;border:1px solid var(--bd);border-radius:6px}

/* Main layout */
.main{max-width:1400px;margin:0 auto;padding:20px}
h2{font-size:1rem;font-weight:600;color:var(--t2);margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em}

/* Heatmap */
.heatmap-wrap{overflow-x:auto;margin-bottom:32px;border-radius:10px;border:1px solid var(--bd)}
table.heatmap{width:100%;border-collapse:collapse}
.heatmap th{background:var(--s2);padding:8px 12px;font-size:.75rem;color:var(--t2);text-align:center;font-weight:600;border-bottom:1px solid var(--bd)}
.heatmap th:first-child{text-align:left;min-width:180px}
.hm-name{padding:8px 12px;font-size:.82rem;font-weight:500;border-bottom:1px solid var(--bd);white-space:nowrap}
.hm-cell{padding:8px 6px;text-align:center;font-size:.78rem;font-weight:600;border-bottom:1px solid var(--bd);min-width:60px;transition:filter .15s}
.hm-cell:hover{filter:brightness(1.3)}
/* Heat colors */
.gn3{background:rgba(34,197,94,.45);color:#86efac}
.gn2{background:rgba(34,197,94,.25);color:#86efac}
.gn1{background:rgba(34,197,94,.1);color:#86efac}
.rd1{background:rgba(239,68,68,.1);color:#fca5a5}
.rd2{background:rgba(239,68,68,.25);color:#fca5a5}
.rd3{background:rgba(239,68,68,.45);color:#fca5a5}
.nc{color:var(--t2)}

/* Filter / sort bar */
.controls{display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap}
.filter-btn{padding:6px 14px;border-radius:20px;border:1px solid var(--bd);background:transparent;color:var(--t2);font-size:.8rem;cursor:pointer;transition:all .2s}
.filter-btn.active,.filter-btn:hover{border-color:var(--ac);color:var(--ac);background:rgba(249,115,22,.1)}
.sort-label{font-size:.8rem;color:var(--t2);margin-left:12px}
select.sort-select{padding:6px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.8rem;cursor:pointer}
.stat-bar{display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.stat-pill{padding:6px 14px;border-radius:20px;font-size:.78rem;border:1px solid var(--bd);background:var(--s2)}
.stat-pill span{font-weight:700}

/* Cards */
#cards-container{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.sector-card{background:var(--s1);border:1px solid var(--bd);border-radius:12px;overflow:hidden;transition:border-color .2s,transform .15s}
.sector-card:hover{border-color:var(--ac);transform:translateY(-2px)}
.sector-card.hidden{display:none}
.card-head{padding:14px 16px 10px;border-bottom:1px solid var(--bd);display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.card-name{font-size:.95rem;font-weight:700}
.card-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.trend-badge{padding:3px 9px;border-radius:12px;font-size:.72rem;font-weight:700;white-space:nowrap}
.trend-up-strong{background:rgba(34,197,94,.2);color:#86efac;border:1px solid rgba(34,197,94,.4)}
.trend-up{background:rgba(34,197,94,.12);color:#86efac;border:1px solid rgba(34,197,94,.25)}
.trend-neutral{background:rgba(234,179,8,.12);color:#fde68a;border:1px solid rgba(234,179,8,.25)}
.trend-down{background:rgba(239,68,68,.12);color:#fca5a5;border:1px solid rgba(239,68,68,.25)}
.trend-down-strong{background:rgba(239,68,68,.2);color:#fca5a5;border:1px solid rgba(239,68,68,.4)}
.score-badge{padding:3px 9px;border-radius:12px;font-size:.72rem;font-weight:700;background:var(--s3);color:var(--tx);border:1px solid var(--bd)}
.card-spark{padding:8px 16px;border-bottom:1px solid var(--bd);overflow:hidden;line-height:0}
.card-spark svg{width:100%;height:60px}
.card-body{padding:10px 16px}
.metric-row{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center}
.metric-row .row-label{font-size:.72rem;color:var(--t2);min-width:36px;flex-shrink:0}
.metric-chip{padding:3px 7px;border-radius:6px;font-size:.72rem;font-weight:600;background:var(--s2);border:1px solid var(--bd)}
.metric-chip.gn{background:rgba(34,197,94,.15);color:#86efac;border-color:rgba(34,197,94,.3)}
.metric-chip.rd{background:rgba(239,68,68,.15);color:#fca5a5;border-color:rgba(239,68,68,.3)}
.metric-chip.yw{background:rgba(234,179,8,.15);color:#fde68a;border-color:rgba(234,179,8,.3)}
.sma-row{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center}
.sma-row .row-label{font-size:.72rem;color:var(--t2);min-width:36px;flex-shrink:0}
.sma-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px}
.sma-dot.on{background:var(--gn)}
.sma-dot.off{background:var(--rd)}
.sma-tag{font-size:.72rem;display:flex;align-items:center;gap:2px}
.rsi-pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;margin-bottom:8px}
.rsi-hot{background:rgba(239,68,68,.2);color:#fca5a5;border:1px solid rgba(239,68,68,.3)}
.rsi-bull{background:rgba(34,197,94,.15);color:#86efac;border:1px solid rgba(34,197,94,.3)}
.rsi-mid{background:rgba(234,179,8,.15);color:#fde68a;border:1px solid rgba(234,179,8,.3)}
.rsi-bear{background:rgba(99,102,241,.15);color:#c4b5fd;border:1px solid rgba(99,102,241,.3)}
/* Watchlist stocks collapsible */
.wl-toggle{width:100%;background:var(--s2);border:none;border-top:1px solid var(--bd);padding:8px 16px;text-align:left;cursor:pointer;color:var(--t2);font-size:.78rem;display:flex;justify-content:space-between;align-items:center;transition:background .2s}
.wl-toggle:hover{background:var(--s3);color:var(--tx)}
.wl-toggle .arrow{transition:transform .2s;font-size:.65rem}
.wl-toggle.open .arrow{transform:rotate(180deg)}
.wl-stocks{display:none;padding:10px 16px 12px;border-top:1px solid var(--bd);background:var(--s2);flex-wrap:wrap;gap:6px}
.wl-stocks.open{display:flex}
.wl-chip{padding:4px 10px;border-radius:20px;font-size:.72rem;background:var(--s3);border:1px solid var(--bd);color:var(--tx);cursor:default}
.no-wl{color:var(--t2);font-size:.75rem;font-style:italic;padding:10px 16px 12px;border-top:1px solid var(--bd)}

/* Unclassified */
.unclassified{background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-top:24px}
.unclassified h3{font-size:.85rem;color:var(--t2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em}
.unclassified-chips{display:flex;flex-wrap:wrap;gap:6px}

@media(max-width:600px){
  .header{padding:8px 12px}
  .main{padding:12px}
  #cards-container{grid-template-columns:1fr}
  .heatmap th,.hm-name,.hm-cell{font-size:.7rem;padding:6px 5px}
}
</style>
</head>
<body>
<div class="header">
  <div class="header-title">📊 Sector Trends</div>
  <div class="header-right">
    <span class="theme-label" id="theme-label">Dark</span>
    <div class="theme-toggle" id="theme-toggle" title="Toggle dark/light mode"></div>
    <a href="alerts.html"            class="back-link" style="color:var(--yw);border-color:rgba(234,179,8,.4)">🔔 Alerts</a>
    <a href="potential.html"         class="back-link" style="color:var(--pp);border-color:rgba(168,85,247,.4)">🌟 Potential</a>
    <a href="multibagger.html"        class="back-link" style="color:#f59e0b;border-color:rgba(245,158,11,.4)">🏆 Multibagger</a>
    <a href="breakout2.html"          class="back-link" style="color:#00d4aa;border-color:rgba(0,212,170,.3)">⚡ Breakout GEN2</a>
    <a href="breakout.html"           class="back-link">Breakout VCP</a>
    <a href="apex.html"               class="back-link" style="color:#6366f1;border-color:rgba(99,102,241,.4)">🔮 APEX</a>
    <a href="creamy.html"             class="back-link">Creamy Layer</a>
    <a href="trades.html"             class="back-link" style="color:#22c55e;border-color:rgba(34,197,94,.4)">📈 Trades</a>
    <a href="indian-research.html"    class="back-link" style="color:#fb923c;border-color:rgba(251,146,60,.4)">🇮🇳 India Research</a>
    <a href="index.html"              class="back-link">My Watchlist</a>
  </div>
</div>

<div class="main">
  <h2>Sector Rotation Heatmap</h2>
  <div class="heatmap-wrap">
    <table class="heatmap">
      <thead>
        <tr>
          <th>Sector</th>
          <th>1W</th><th>1M</th><th>3M</th><th>6M</th><th>1Y</th><th>3Y</th><th>5Y</th>
        </tr>
      </thead>
      <tbody>${heatmapRows}</tbody>
    </table>
  </div>

  <div class="controls">
    <button class="filter-btn active" data-filter="all">All</button>
    <button class="filter-btn" data-filter="up-strong">🔥 Strong Uptrend</button>
    <button class="filter-btn" data-filter="up">📈 Uptrend</button>
    <button class="filter-btn" data-filter="neutral">➡️ Neutral</button>
    <button class="filter-btn" data-filter="down">📉 Downtrend</button>
    <button class="filter-btn" data-filter="down-strong">⬇️ Strong Downtrend</button>
    <span class="sort-label">Sort:</span>
    <select class="sort-select" id="sort-select">
      <option value="score">Score ▼</option>
      <option value="rs1Y">RS 1Y ▼</option>
      <option value="ret1Y">1Y Return ▼</option>
      <option value="ret3Y">3Y Return ▼</option>
      <option value="ret5Y">5Y Return ▼</option>
    </select>
  </div>

  <div class="stat-bar" id="stat-bar"></div>
  <div id="cards-container"></div>
</div>

<script>
const RAW = ${rawJson};

function fmtPct(v, dec) {
  if (v == null || isNaN(v)) return '—';
  dec = dec === undefined ? 1 : dec;
  const s = v >= 0 ? '+' : '';
  return s + v.toFixed(dec) + '%';
}
function pctClass(v) {
  if (v == null || isNaN(v)) return '';
  return v >= 0 ? 'gn' : 'rd';
}
function rsiLabel(v) {
  if (v == null) return '';
  if (v >= 70)      return { cls: 'rsi-hot',  label: 'RSI ' + v + ' (Overbought)' };
  if (v >= 55)      return { cls: 'rsi-bull', label: 'RSI ' + v + ' (Bullish)' };
  if (v >= 45)      return { cls: 'rsi-mid',  label: 'RSI ' + v + ' (Neutral)' };
  return               { cls: 'rsi-bear', label: 'RSI ' + v + ' (Bearish)' };
}

let activeFilter = 'all';
let activeSort   = 'score';

function renderStats(sectors) {
  const counts = { 'up-strong': 0, 'up': 0, 'neutral': 0, 'down': 0, 'down-strong': 0 };
  sectors.forEach(s => { if (counts[s.trendClass] !== undefined) counts[s.trendClass]++; });
  document.getElementById('stat-bar').innerHTML =
    '<div class="stat-pill">🔥 Strong Up: <span style="color:#86efac">' + counts['up-strong'] + '</span></div>' +
    '<div class="stat-pill">📈 Uptrend: <span style="color:#86efac">' + counts['up'] + '</span></div>' +
    '<div class="stat-pill">➡️ Neutral: <span style="color:#fde68a">' + counts['neutral'] + '</span></div>' +
    '<div class="stat-pill">📉 Downtrend: <span style="color:#fca5a5">' + counts['down'] + '</span></div>' +
    '<div class="stat-pill">⬇️ Strong Down: <span style="color:#fca5a5">' + counts['down-strong'] + '</span></div>';
}

function renderCards() {
  const sorted = [...RAW].sort((a, b) => {
    if (activeSort === 'rs1Y')   return (b.rs1Y  || -999) - (a.rs1Y  || -999);
    if (activeSort === 'ret1Y')  return (b.ret1Y || -999) - (a.ret1Y || -999);
    if (activeSort === 'ret3Y')  return (b.ret3Y || -999) - (a.ret3Y || -999);
    if (activeSort === 'ret5Y')  return (b.ret5Y || -999) - (a.ret5Y || -999);
    return b.score - a.score;
  });

  const container = document.getElementById('cards-container');
  container.innerHTML = '';

  sorted.forEach((s, idx) => {
    const visible = activeFilter === 'all' || activeFilter === s.trendClass;
    const rsi = rsiLabel(s.rsi);
    const wlCount = s.watchlistStocks ? s.watchlistStocks.length : 0;
    const wlHtml = wlCount > 0
      ? s.watchlistStocks.map(w => '<span class="wl-chip">' + w.ticker + (w.ret1Y != null ? ' <span style="color:' + (w.ret1Y >= 0 ? '#86efac' : '#fca5a5') + '">' + fmtPct(w.ret1Y,0) + '</span>' : '') + '</span>').join('')
      : '';

    const card = document.createElement('div');
    card.className = 'sector-card' + (visible ? '' : ' hidden');
    card.dataset.trend = s.trendClass;
    card.innerHTML =
      '<div class="card-head">' +
        '<div class="card-name">' + s.name + '</div>' +
        '<div class="card-badges">' +
          '<span class="trend-badge trend-' + s.trendClass + '">' + s.trend + '</span>' +
          '<span class="score-badge">' + s.score + '/100</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-spark">' + (s.sparkline || '') + '</div>' +
      '<div class="card-body">' +
        '<div class="metric-row">' +
          '<span class="row-label">Ret</span>' +
          ['1W','1M','3M','6M','1Y','3Y','5Y'].map((lbl, i) => {
            const v = [s.ret1W,s.ret1M,s.ret3M,s.ret6M,s.ret1Y,s.ret3Y,s.ret5Y][i];
            return '<span class="metric-chip ' + pctClass(v) + '" title="' + lbl + ': ' + fmtPct(v) + '">' + lbl + ' ' + fmtPct(v,0) + '</span>';
          }).join('') +
        '</div>' +
        '<div class="metric-row">' +
          '<span class="row-label">RS</span>' +
          ['1M','3M','6M','1Y'].map((lbl, i) => {
            const v = [s.rs1M,s.rs3M,s.rs6M,s.rs1Y][i];
            return '<span class="metric-chip ' + pctClass(v) + '" title="RS vs Nifty ' + lbl + ': ' + fmtPct(v) + '">' + lbl + ' ' + fmtPct(v,0) + '</span>';
          }).join('') +
        '</div>' +
        '<div class="sma-row">' +
          '<span class="row-label">SMA</span>' +
          '<span class="sma-tag"><span class="sma-dot ' + (s.aboveSma50  ? 'on' : 'off') + '"></span>50</span>' +
          '<span class="sma-tag"><span class="sma-dot ' + (s.aboveSma200 ? 'on' : 'off') + '"></span>200</span>' +
          '<span class="sma-tag"><span class="sma-dot ' + (s.sma200Up    ? 'on' : 'off') + '"></span>200↑</span>' +
        '</div>' +
        (rsi ? '<div><span class="rsi-pill ' + rsi.cls + '">' + rsi.label + '</span></div>' : '') +
        (s.distFrom52wHigh != null ? '<div style="font-size:.72rem;color:var(--t2);margin-top:4px">52W High: <span style="color:' + (s.distFrom52wHigh >= -5 ? '#86efac' : '#fca5a5') + '">' + fmtPct(s.distFrom52wHigh,1) + '</span></div>' : '') +
      '</div>' +
      (wlCount > 0
        ? '<button class="wl-toggle" onclick="toggleWl(this)">📂 ' + wlCount + ' watchlist stock' + (wlCount > 1 ? 's' : '') + ' <span class="arrow">▼</span></button>' +
          '<div class="wl-stocks">' + wlHtml + '</div>'
        : '<div class="no-wl">No watchlist stocks in this sector</div>') ;
    container.appendChild(card);
  });
}

function toggleWl(btn) {
  btn.classList.toggle('open');
  const panel = btn.nextElementSibling;
  if (panel) panel.classList.toggle('open');
}

// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderCards();
  });
});

// Sort
document.getElementById('sort-select').addEventListener('change', e => {
  activeSort = e.target.value;
  renderCards();
});

// Theme toggle
const root = document.documentElement;
const toggle = document.getElementById('theme-toggle');
const label  = document.getElementById('theme-label');
toggle.addEventListener('click', () => {
  const isLight = root.getAttribute('data-theme') === 'light';
  root.setAttribute('data-theme', isLight ? 'dark' : 'light');
  label.textContent = isLight ? 'Dark' : 'Light';
  localStorage.setItem('sectors-theme', isLight ? 'dark' : 'light');
});
(function() {
  const saved = localStorage.getItem('sectors-theme') || 'dark';
  root.setAttribute('data-theme', saved);
  label.textContent = saved === 'dark' ? 'Dark' : 'Light';
})();

renderStats(RAW);
renderCards();
</script>
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== Sectors Page Generator ===');
  const period1 = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const period2 = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Step 1: Load watchlist tickers
  console.log('\n[1] Loading watchlist tickers...');
  const watchlistStocks = loadWatchlistTickers();
  console.log(`    ${watchlistStocks.length} unique tickers loaded`);

  // Step 2: Fetch benchmark (Nifty 50) history
  console.log('\n[2] Fetching Nifty 50 benchmark history...');
  let benchmarkBars = null;
  try {
    const rows = await yahooFinance.historical(BENCHMARK_TICKER, { period1, period2, interval: '1d' });
    if (rows && rows.length > 50) {
      benchmarkBars = rows.filter(r => r.close != null).sort((a, b) => new Date(a.date) - new Date(b.date));
      console.log(`    ${benchmarkBars.length} bars for ^NSEI`);
    }
  } catch (e) {
    console.warn('    Failed to fetch benchmark:', e.message);
  }

  // Step 3: Fetch all sector index histories (batched 3 at a time)
  console.log('\n[3] Fetching sector index histories (5Y)...');
  const sectorBars = {};
  for (let i = 0; i < SECTOR_INDICES.length; i += 3) {
    const batch = SECTOR_INDICES.slice(i, i + 3);
    await Promise.all(batch.map(async si => {
      try {
        const rows = await yahooFinance.historical(si.ticker, { period1, period2, interval: '1d' });
        if (rows && rows.length >= 252) {
          sectorBars[si.ticker] = rows.filter(r => r.close != null).sort((a, b) => new Date(a.date) - new Date(b.date));
          console.log(`    ✓ ${si.name}: ${sectorBars[si.ticker].length} bars`);
        } else {
          console.warn(`    ⚠ ${si.name} (${si.ticker}): insufficient data (${rows ? rows.length : 0} bars) — skipped`);
        }
      } catch (e) {
        console.warn(`    ✗ ${si.name} (${si.ticker}): ${e.message} — skipped`);
      }
    }));
    if (i + 3 < SECTOR_INDICES.length) await sleep(400);
  }

  // Step 4: Fetch watchlist sector mapping from Tickertape
  console.log('\n[4] Fetching sector classification for watchlist stocks...');
  let sectorMap = {};
  try {
    sectorMap = await fetchWatchlistSectors(watchlistStocks);
    console.log(`    ${Object.keys(sectorMap).length} tickers classified`);
  } catch (e) {
    console.warn('    Tickertape screener failed:', e.message);
  }

  // Step 5: Analyze sectors + match watchlist stocks
  console.log('\n[5] Analysing sectors...');
  const sectors = [];
  const unclassified = [];

  for (const si of SECTOR_INDICES) {
    const bars = sectorBars[si.ticker];
    if (!bars) continue;
    const analysis = analyzeSector(bars, benchmarkBars);
    const sparklineSvg = buildSparkline(bars, analysis.trendClass);

    // Match watchlist stocks to this sector
    const matchedStocks = watchlistStocks
      .filter(ws => {
        const wsSector = (sectorMap[ws.ticker] || '').toLowerCase();
        if (!wsSector) return false;
        return si.ttSectors.some(k => wsSector.includes(k) || k.includes(wsSector));
      })
      .map(ws => ({ ticker: ws.ticker, name: ws.name, ret1Y: null }));

    sectors.push({ ticker: si.ticker, name: si.name, analysis, sparklineSvg, watchlistStocks: matchedStocks });
    console.log(`    ${si.name}: score=${analysis.score} | ${analysis.trend} | ${matchedStocks.length} watchlist stocks`);
  }

  // Unclassified watchlist stocks (no sector match)
  const classifiedTickers = new Set(sectors.flatMap(s => s.watchlistStocks.map(w => w.ticker)));
  for (const ws of watchlistStocks) {
    if (!classifiedTickers.has(ws.ticker)) unclassified.push(ws);
  }
  console.log(`\n    ${unclassified.length} watchlist stocks unclassified`);

  // Step 6: Append unclassified section to HTML data
  sectors.push({
    ticker: '__unclassified__',
    name: 'Unclassified / Other',
    analysis: { trendClass: 'neutral', trend: '—', score: 0, ret1W: null, ret1M: null, ret3M: null, ret6M: null, ret1Y: null, ret3Y: null, ret5Y: null, rs1M: null, rs3M: null, rs6M: null, rs1Y: null, rsiVal: null, price: null, distFrom52wHigh: null, s50: null, s200: null, s200_20ago: null },
    sparklineSvg: '',
    watchlistStocks: unclassified,
    isUnclassified: true,
  });

  // Step 7: Generate and write HTML
  console.log('\n[6] Building HTML...');
  const generatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const filteredSectors = sectors.filter(s => !s.isUnclassified);
  const html = buildHtml(filteredSectors, generatedAt);
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');

  const sizeMB = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2);
  console.log(`\n✅ Written to ${OUTPUT_PATH} (${sizeMB} MB)`);
  console.log(`   ${filteredSectors.length} sector cards | Generated: ${generatedAt}`);
  if (unclassified.length) {
    console.log(`   Unclassified stocks (${unclassified.length}): ${unclassified.slice(0,10).map(w=>w.ticker).join(', ')}${unclassified.length>10?'...':''}`);
  }
}

run().catch(e => { console.error('\n❌ Fatal:', e); process.exit(1); });

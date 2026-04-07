'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const alertSystem = require('./alert-system');

const OUTPUT_PATH          = path.join(__dirname, 'docs', 'apex.html');
const WATCHLIST_PATH       = path.join(__dirname, 'my-watchlists.json');
const BREAKOUT2_DATA_PATH  = path.join(__dirname, 'docs', 'breakout2-data.json');
const SCORECARD_CACHE_PATH = path.join(__dirname, 'scorecard-cache.json');
const SCREENER_CAP         = 300;
const CONCURRENCY          = 50;
const SCORECARD_CACHE_TTL  = 6 * 60 * 60 * 1000; // 6 hours

// ── API helpers ───────────────────────────────────────────────────────────────

function apiPostOnce(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 15000,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://www.tickertape.in', 'Referer': 'https://www.tickertape.in/',
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse error')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(data);
  });
}
async function apiPost(url, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await apiPostOnce(url, body); }
    catch (e) { if (i === retries - 1) throw e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
}
function apiGetOnce(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse error')); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}
async function apiGet(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await apiGetOnce(url); }
    catch (e) { if (i === retries - 1) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmt(n, dec = 2) { if (n == null || isNaN(n)) return '—'; return Number(n).toFixed(dec); }
function fmtCr(n) { if (n == null) return '—'; if (n >= 100000) return (n / 100000).toFixed(1) + 'L'; if (n >= 10000) return (n / 1000).toFixed(1) + 'K'; return Math.round(n) + ''; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Load watchlist tickers ────────────────────────────────────────────────────

function loadWatchlistTickers() {
  if (!fs.existsSync(WATCHLIST_PATH)) return new Set();
  const watchlists = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
  const tickers = new Set();
  for (const wl of watchlists) {
    for (const period of Object.values(wl.periods || {})) {
      for (const s of (period.stocks || [])) {
        const ticker = (s.name || '').split('\n')[1]?.trim();
        if (ticker) tickers.add(ticker);
      }
    }
  }
  return tickers;
}

// ── Fetch fundamentals from Tickertape screener (top 300) ────────────────────

async function fetchFundamentals() {
  const fields = [
    'ticker', 'name', 'sector', 'mrktCapf', 'lastPrice',
    '52wpct', '26wpct', '4wpct',
    'roe', 'pftMrg', 'aopm', 'rvng', 'epsg', 'ebitg',
    'apef', 'pbr', 'evebitd',
    'epsGwth', '5YrevChg',
    'dbtEqt', 'aint',
    'strown', 'strown3', 'instown3', 'forInstHldng3M',
    'cafFcf', 'pab12Mma', '52whd',
  ];
  const allStocks = [];
  let offset = 0, total = Infinity;
  while (offset < total && allStocks.length < SCREENER_CAP) {
    const toFetch = Math.min(500, SCREENER_CAP - allStocks.length);
    const body = { match: {}, sortBy: 'mrktCapf', sortOrder: -1, project: fields, offset, count: toFetch };
    const r = await apiPost('https://api.tickertape.in/screener/query', body);
    if (!r.success) throw new Error('Screener API failed');
    total = r.data.stats.count;
    const results = r.data.results || [];
    if (!results.length) break;
    for (const item of results) {
      const ar = item.stock?.advancedRatios || {};
      const g = k => ar[k] != null ? ar[k] : null;
      allStocks.push({
        sid: item.sid,
        ticker: item.stock?.info?.ticker || '',
        name:   item.stock?.info?.name   || '',
        sector: ar.sector || item.stock?.info?.sector || '',
        slug:   item.stock?.slug || '',
        marketCap: g('mrktCapf'), price: g('lastPrice'),
        ret1Y: g('52wpct'), ret6M: g('26wpct'), ret1M: g('4wpct'),
        roe: g('roe'), npm: g('pftMrg'), ebitdaMargin: g('aopm'),
        revGrowth: g('rvng'), epsGrowth: g('epsg'), ebitdaGrowth: g('ebitg'),
        epsGwth5Y: g('epsGwth'), revGrowth5Y: g('5YrevChg'),
        pe: g('apef'), pb: g('pbr'), evEbitda: g('evebitd'),
        debtEquity: g('dbtEqt'), intCoverage: g('aint'),
        promoterHolding: g('strown'), promoterChg3M: g('strown3'),
        mfChg3M: g('instown3'), fiiChg3M: g('forInstHldng3M'),
        fcf: g('cafFcf'), priceAbove200SMA: g('pab12Mma'), awayFrom52WH: g('52whd'),
      });
    }
    offset += results.length;
    process.stdout.write(`  Screener: ${allStocks.length}/${Math.min(total, SCREENER_CAP)} fetched\r`);
    if (results.length < toFetch) break;
  }
  console.log(`\n  Screener: ${allStocks.length} stocks`);
  return allStocks.filter(s => s.ticker);
}

// ── Scorecard cache (6-hr TTL) ────────────────────────────────────────────────

async function loadOrFetchScorecards(stocks) {
  let cache = {}, cacheTs = 0;
  if (fs.existsSync(SCORECARD_CACHE_PATH)) {
    try { const saved = JSON.parse(fs.readFileSync(SCORECARD_CACHE_PATH, 'utf8')); cacheTs = saved.timestamp || 0; cache = saved.data || {}; }
    catch { /* ignore */ }
  }
  const now = Date.now();
  const toFetch = (now - cacheTs < SCORECARD_CACHE_TTL)
    ? stocks.filter(s => s.sid && !cache[s.sid])
    : stocks.filter(s => s.sid);

  if (toFetch.length > 0) {
    for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
      const batch = toFetch.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async s => {
        try {
          const r = await apiGet(`https://analyze.api.tickertape.in/stocks/scorecard/${s.sid}`);
          if (!r.success || !r.data) return { sid: s.sid, tags: {} };
          const tags = {};
          for (const item of r.data) {
            const key = (item.name || '').toLowerCase();
            if (['performance', 'growth', 'profitability', 'valuation'].includes(key)) tags[key] = item.tag || null;
          }
          return { sid: s.sid, tags };
        } catch { return { sid: s.sid, tags: {} }; }
      }));
      for (const { sid, tags } of results) cache[sid] = tags;
      process.stdout.write(`  Scorecards: ${Math.min(i + CONCURRENCY, toFetch.length)}/${toFetch.length}\r`);
    }
    fs.writeFileSync(SCORECARD_CACHE_PATH, JSON.stringify({ timestamp: now, data: cache }), 'utf8');
  }
  console.log(`  Scorecards: ${Object.keys(cache).length} cached        `);
  return cache;
}

// ── Load breakout2 technical data ─────────────────────────────────────────────

function loadTechData() {
  if (!fs.existsSync(BREAKOUT2_DATA_PATH)) {
    console.log('  breakout2-data.json not found — run npm run breakout2 first for technical signals');
    return new Map();
  }
  const data = JSON.parse(fs.readFileSync(BREAKOUT2_DATA_PATH, 'utf8'));
  const map = new Map();
  for (const item of data) { if (item.ticker) map.set(item.ticker, item); }
  console.log(`  Technical data: ${map.size} stocks from breakout2-data.json`);
  return map;
}

// ── APEX Score — 5-pillar algorithm (max 100 + 5 convergence bonus) ──────────

function calcApexScore(s, tech) {
  const isBanking = !!(s.sector && /bank|finance|nbfc/i.test(s.sector));

  // ── Pillar 1: Capital Quality (max 20) ────────────────────────────────────
  // [A] ROE (return quality proxy) — max 8
  const A = s.roe != null
    ? (s.roe >= 25 ? 8 : s.roe >= 20 ? 6 : s.roe >= 15 ? 4 : s.roe >= 10 ? 1 : 0) : 0;
  // [B] FCF yield (FCF / MCap × 100) — max 5, min -3
  let fcfYield = null, B = 0;
  if (s.fcf != null && s.marketCap != null && s.marketCap > 0) {
    fcfYield = (s.fcf / s.marketCap) * 100;
    B = fcfYield > 5 ? 5 : fcfYield > 2 ? 3 : fcfYield > 0 ? 1 : (s.fcf < 0 ? -3 : 0);
  }
  // [C] Debt/Equity — max 4 (banking gets neutral 3)
  let C = isBanking ? 3 : 0;
  if (!isBanking && s.debtEquity != null) {
    C = s.debtEquity < 0 ? 0
      : s.debtEquity <= 0.1 ? 4 : s.debtEquity <= 0.3 ? 3 : s.debtEquity <= 0.5 ? 2 : s.debtEquity <= 1.0 ? 1 : 0;
  }
  // [D] Interest coverage — max 3 (banking gets neutral 3)
  let D = isBanking ? 3 : 0;
  if (!isBanking && s.intCoverage != null) {
    D = s.intCoverage >= 10 ? 3 : s.intCoverage >= 5 ? 2 : s.intCoverage >= 1.5 ? 1 : 0;
  }
  const p1 = Math.min(20, Math.max(0, A + B + C + D));

  // ── Pillar 2: Growth Engine (max 20) ──────────────────────────────────────
  // [E] 5Y EPS CAGR — max 6
  const E = s.epsGwth5Y != null
    ? (s.epsGwth5Y >= 25 ? 6 : s.epsGwth5Y >= 20 ? 4 : s.epsGwth5Y >= 15 ? 2 : s.epsGwth5Y >= 10 ? 1 : 0) : 0;
  // [F] 5Y Revenue CAGR — max 4
  const F = s.revGrowth5Y != null
    ? (s.revGrowth5Y >= 20 ? 4 : s.revGrowth5Y >= 15 ? 3 : s.revGrowth5Y >= 10 ? 1 : 0) : 0;
  // [G] EPS acceleration (1Y vs 5Y CAGR ratio) — max 6
  let G = 0;
  if (s.epsGrowth != null && s.epsGwth5Y != null && s.epsGwth5Y > 0) {
    const ratio = s.epsGrowth / s.epsGwth5Y;
    G = (ratio >= 2 && s.epsGrowth > 20) ? 6 : ratio >= 1.5 ? 4 : ratio >= 1 ? 2 : 0;
  } else if (s.epsGrowth != null) {
    G = s.epsGrowth >= 30 ? 4 : s.epsGrowth >= 20 ? 2 : 0;
  }
  // [H] EBITDA margin expansion vs revenue growth — max 4
  let H = 0;
  if (s.ebitdaGrowth != null && s.revGrowth != null) {
    const diff = s.ebitdaGrowth - s.revGrowth;
    H = diff > 10 ? 4 : diff > 5 ? 2 : diff > 0 ? 1 : 0;
  }
  // Deceleration penalty: 1Y EPS growth < 60% of 5Y CAGR — -2
  const decelPenalty = (s.epsGrowth != null && s.epsGwth5Y != null && s.epsGwth5Y > 10 && s.epsGrowth < s.epsGwth5Y * 0.6) ? 2 : 0;
  const p2 = Math.min(20, Math.max(0, E + F + G + H - decelPenalty));

  // ── Pillar 3: Valuation Discipline (max 20) ───────────────────────────────
  // [I] PEG ratio (P/E ÷ 5Y EPS CAGR) — max 8, min -2
  let I = 0, pegVal = null;
  if (s.pe != null && s.pe > 0 && s.epsGwth5Y != null && s.epsGwth5Y > 0) {
    pegVal = parseFloat((s.pe / s.epsGwth5Y).toFixed(1));
    I = pegVal <= 0.8 ? 8 : pegVal <= 1.2 ? 5 : pegVal <= 1.8 ? 2 : pegVal > 2.5 ? -2 : 0;
  }
  // [J] EV/EBITDA — max 7
  let J = 0;
  if (s.evEbitda != null && s.evEbitda > 0) {
    J = s.evEbitda <= 8 ? 7 : s.evEbitda <= 12 ? 5 : s.evEbitda <= 18 ? 3 : s.evEbitda <= 25 ? 1 : 0;
  }
  // [K] FCF yield bonus — max 5
  const K = fcfYield != null ? (fcfYield > 5 ? 5 : fcfYield > 2 ? 3 : 0) : 0;
  const p3 = Math.min(20, Math.max(0, I + J + K));

  // ── Pillar 4: Insider Conviction (max 20) ─────────────────────────────────
  // [L] Promoter holding — max 8
  const L = s.promoterHolding != null
    ? (s.promoterHolding >= 65 ? 8 : s.promoterHolding >= 55 ? 6 : s.promoterHolding >= 50 ? 4 : s.promoterHolding >= 40 ? 2 : 0) : 0;
  // [M] Promoter 3M change — max 8; null → neutral 3
  const M = s.promoterChg3M != null
    ? (s.promoterChg3M > 0.5 ? 8 : s.promoterChg3M >= 0 ? 5 : s.promoterChg3M > -1 ? 2 : 0)
    : 3;
  // [N] FII+MF combo (de-weighted vs original design) — max 4
  const fiiPos = s.fiiChg3M != null && s.fiiChg3M > 0;
  const mfPos  = s.mfChg3M  != null && s.mfChg3M  > 0;
  const N = (fiiPos && mfPos) ? 4 : (fiiPos || mfPos) ? 2 : 0;
  const p4 = Math.min(20, Math.max(0, L + M + N));

  // ── Pillar 5: Technical Setup (max 20) ────────────────────────────────────
  // Hard Stage 2 gate: if stage2 = false → pillar = 0
  let p5 = 0;
  const rsRating = tech ? (tech.rsRating || 0) : 0;
  if (tech && tech.stage2) {
    const vcpPts = tech.vcpPass ? 8 : 0;                                   // VCP: 0 or 8
    const rsPts  = Math.round(Math.pow(rsRating / 99, 1.5) * 12);          // RS convex: 0–12
    p5 = Math.min(20, vcpPts + rsPts);
  }

  // ── Convergence Bonus (+5): all 5 pillars >= 12 (60% of max 20) ──────────
  const convergence = p1 >= 12 && p2 >= 12 && p3 >= 12 && p4 >= 12 && p5 >= 12;
  const bonus = convergence ? 5 : 0;
  const total = Math.min(100, p1 + p2 + p3 + p4 + p5 + bonus);

  // Tier labels
  const tier = total >= 80 ? 'Elite' : total >= 65 ? 'Strong' : total >= 50 ? 'Aligned' : 'Misaligned';

  // Action signal
  let action = 'PASS';
  if      (total >= 70 && tech && tech.stage2 && tech.vcpPass) action = 'BUY';
  else if (total >= 65 && tech && tech.stage2)                 action = 'BUILD';
  else if (total >= 50)                                        action = 'WATCH';

  // 2×2 Quadrant: fundamentals (P1+P2+P3/60 threshold 30), setup (P4+P5/40 threshold 20)
  const fundScore  = p1 + p2 + p3;
  const setupScore = p4 + p5;
  let quadrant = 'AV'; // Avoid
  if (fundScore >= 30 && setupScore >= 20) quadrant = 'SF'; // Safe Compounder
  else if (fundScore >= 30)               quadrant = 'WR'; // Waiting Room
  else if (setupScore >= 20)              quadrant = 'GB'; // Growth Bet

  return { p1, p2, p3, p4, p5, bonus, total, tier, action, convergence, quadrant,
           pegVal, fcfYield: fcfYield != null ? Math.round(fcfYield * 10) / 10 : null,
           rsRating, decelFlag: decelPenalty > 0, accrualFlag: B < 0 };
}

// ── Build HTML ────────────────────────────────────────────────────────────────

function buildHtml(stocks, updatedAt) {
  const genTime = new Date(updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  const eliteCnt = stocks.filter(s => s.total >= 80).length;
  const strongCnt = stocks.filter(s => s.total >= 65).length;
  const convCnt  = stocks.filter(s => s.convergence).length;
  const buyCnt   = stocks.filter(s => s.action === 'BUY').length;
  const wlCnt    = stocks.filter(s => s.inWatchlist).length;

  const dataJson = JSON.stringify(stocks);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>APEX Convergence Scout &middot; NSE India</title>
<script>
(function(){var s=localStorage.getItem('apex-theme');var p=s||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',p)})();
<\/script>
<style>
:root,html[data-theme="dark"]{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#6366f1;--tx:#e8e8f0;--t2:#9898b0;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7;--tl:#06b6d4;--or:#f97316;--hdr-bg:linear-gradient(135deg,#0d0d1f,#12121a);--shadow:0 8px 24px rgba(0,0,0,.4);--row-hover:rgba(99,102,241,.04);--card-border:rgba(42,42,56,.4)}
html[data-theme="light"]{--bg:#f8f9fc;--s1:#fff;--s2:#fff;--s3:#eef0f5;--bd:#d5d8e0;--ac:#4f46e5;--tx:#1e1e32;--t2:#44495e;--t3:#6b7188;--gn:#15803d;--rd:#b91c1c;--yw:#a16207;--bl:#1d4ed8;--pp:#6d28d9;--tl:#0e7490;--or:#c2410c;--hdr-bg:linear-gradient(135deg,#eef0ff,#eaecf2);--shadow:0 4px 16px rgba(0,0,0,.07);--row-hover:rgba(79,70,229,.03);--card-border:rgba(0,0,0,.08)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);overflow-x:hidden;line-height:1.55;transition:background .3s,color .3s}
.header{background:var(--hdr-bg);border-bottom:1px solid var(--bd);padding:18px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);transition:background .3s}
.header h1{font-size:1.4rem;font-weight:700;background:linear-gradient(90deg,var(--ac),#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .subtitle{font-size:.78rem;color:var(--t2);margin-top:3px}
.header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.back-link{color:var(--t2);text-decoration:none;font-size:.82rem;padding:7px 14px;border:1px solid var(--bd);border-radius:6px;transition:all .2s}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
.theme-toggle{width:42px;height:24px;border-radius:12px;border:1px solid var(--bd);background:var(--s3);cursor:pointer;position:relative;transition:all .3s;flex-shrink:0}
.theme-toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--ac);transition:transform .3s}
html[data-theme="light"] .theme-toggle::after{transform:translateX(18px)}
.theme-label{font-size:.68rem;color:var(--t3);white-space:nowrap}
.stats-bar{display:flex;gap:12px;padding:16px 28px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap;transition:background .3s}
.stat-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:12px 18px;min-width:100px;transition:background .3s,border .3s}
.stat-card .label{font-size:.7rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.stat-card .value{font-size:1.25rem;font-weight:700}
.stat-card .value.indigo{color:var(--ac)}.stat-card .value.green{color:var(--gn)}.stat-card .value.blue{color:var(--bl)}.stat-card .value.purple{color:var(--pp)}.stat-card .value.yellow{color:var(--yw)}.stat-card .value.teal{color:var(--tl)}
.controls{display:flex;gap:10px;padding:16px 28px;flex-wrap:wrap;align-items:center;transition:background .3s}
.filter-group{display:flex;gap:4px;align-items:center;border:1px solid var(--bd);border-radius:8px;padding:3px;background:var(--s1);transition:background .3s,border .3s}
.filter-group .fg-label{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.04em;padding:0 8px;white-space:nowrap;font-weight:600}
.btn{padding:6px 14px;border-radius:5px;border:1px solid transparent;background:transparent;color:var(--t2);cursor:pointer;font-size:.8rem;font-family:inherit;transition:all .2s}
.btn:hover{color:var(--tx);background:var(--s3)}
.btn.active{background:var(--ac);color:#fff;border-color:var(--ac);font-weight:600}
html[data-theme="light"] .btn.active{color:#fff}
.search{padding:8px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.88rem;font-family:inherit;width:230px;outline:none;transition:border .2s,background .3s}
.search:focus{border-color:var(--ac)}
.multi-dd{position:relative;display:inline-block}
.multi-dd .dd-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.85rem;font-family:inherit;cursor:pointer;min-width:160px;text-align:left;transition:border .2s,background .3s;white-space:nowrap;display:flex;align-items:center;justify-content:space-between;gap:6px}
.multi-dd .dd-btn:hover,.multi-dd.open .dd-btn{border-color:var(--ac)}
.multi-dd .dd-btn .dd-arrow{font-size:.6rem;color:var(--t3);transition:transform .2s}
.multi-dd.open .dd-arrow{transform:rotate(180deg)}
.multi-dd .dd-panel{position:absolute;top:calc(100% + 4px);left:0;min-width:220px;max-height:280px;overflow-y:auto;background:var(--s2);border:1px solid var(--bd);border-radius:10px;z-index:200;display:none;box-shadow:var(--shadow);transition:background .3s}
.multi-dd.open .dd-panel{display:block}
.dd-panel label{display:flex;align-items:center;gap:8px;padding:8px 14px;font-size:.84rem;cursor:pointer;transition:background .15s;color:var(--tx)}
.dd-panel label:hover{background:var(--s3)}
.dd-panel input[type=checkbox]{accent-color:var(--ac);width:16px;height:16px;cursor:pointer}
.dd-panel .dd-count{margin-left:auto;font-size:.72rem;color:var(--t3)}
.dd-panel .dd-actions{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:var(--s2);z-index:1}
.dd-panel .dd-actions button{flex:1;padding:5px 10px;border:1px solid var(--bd);border-radius:5px;background:var(--s3);color:var(--t2);cursor:pointer;font-size:.74rem;font-family:inherit;transition:all .15s}
.dd-panel .dd-actions button:hover{color:var(--tx);border-color:var(--ac)}
.table-container{padding:8px 28px 28px;overflow-x:auto}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:.84rem}
thead{position:sticky;top:0;z-index:10}
th{background:var(--s1);color:var(--ac);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;padding:12px;text-align:left;border-bottom:2px solid var(--bd);cursor:pointer;white-space:nowrap;user-select:none;transition:color .2s,background .3s}
th:hover{color:var(--tx)}
th .arrow{margin-left:4px;font-size:.6rem;opacity:.5}
th.sorted .arrow{opacity:1;color:var(--ac)}
.tip-icon{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;border-radius:50%;background:rgba(99,102,241,.18);color:var(--ac);font-size:.52rem;font-weight:800;margin-left:3px;cursor:help;line-height:1;vertical-align:middle;flex-shrink:0}
.tt{position:fixed;z-index:9999;background:#1e1e2e;color:#e8e8f0;font-size:.7rem;line-height:1.55;padding:8px 11px;border-radius:8px;border:1px solid rgba(99,102,241,.3);white-space:normal;width:240px;text-align:left;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.55);opacity:0;transition:opacity .15s .05s}
html[data-theme="light"] .tt{background:#1e1e32;color:#f0f0f8;border-color:rgba(79,70,229,.3)}
.tt.tt-vis{opacity:1}
td{padding:10px 12px;border-bottom:1px solid var(--card-border);white-space:nowrap;vertical-align:middle;transition:background .15s}
tr:hover td{background:var(--row-hover)}
.stock-name-cell{display:flex;align-items:flex-start;gap:4px;max-width:220px}
.stock-name a{color:var(--tx);text-decoration:none;font-weight:600;font-size:.88rem;transition:color .2s}
.stock-name a:hover{color:var(--ac)}
.stock-name .ticker{color:var(--t2);font-size:.74rem;margin-top:1px}
.wl-dot{color:var(--yw);font-size:.78rem}
.pos{color:var(--gn)}.neg{color:var(--rd)}.dim{color:var(--t3)}
/* APEX score ring */
.apex-ring{width:42px;height:42px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:800;border:3px solid;cursor:default;flex-shrink:0}
.r-elite {border-color:var(--ac);color:var(--ac);background:rgba(99,102,241,.10)}
.r-strong{border-color:var(--bl);color:var(--bl);background:rgba(59,130,246,.08)}
.r-aligned{border-color:var(--gn);color:var(--gn);background:rgba(34,197,94,.08)}
.r-low   {border-color:var(--t3);color:var(--t3);background:rgba(90,90,112,.06)}
.apex-cell{display:inline-flex;align-items:center;gap:8px}
/* Tier badge */
.tier-badge{display:inline-block;padding:3px 9px;border-radius:5px;font-size:.7rem;font-weight:700;white-space:nowrap}
.tier-elite {background:rgba(99,102,241,.15);color:var(--ac);border:1px solid rgba(99,102,241,.35)}
.tier-strong{background:rgba(59,130,246,.13);color:var(--bl);border:1px solid rgba(59,130,246,.3)}
.tier-aligned{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.tier-mis  {background:rgba(100,100,130,.08);color:var(--t3);border:1px solid rgba(100,100,130,.15)}
/* Action badge */
.act-badge{display:inline-block;padding:3px 9px;border-radius:5px;font-size:.72rem;font-weight:700;white-space:nowrap}
.act-buy  {background:rgba(34,197,94,.15);color:var(--gn);border:1px solid rgba(34,197,94,.3)}
.act-build{background:rgba(59,130,246,.13);color:var(--bl);border:1px solid rgba(59,130,246,.28)}
.act-watch{background:rgba(234,179,8,.10);color:var(--yw);border:1px solid rgba(234,179,8,.25)}
.act-pass {background:rgba(100,100,130,.07);color:var(--t3);border:1px solid rgba(100,100,130,.15)}
/* Pillar bars */
.pillar-bars{display:flex;flex-direction:column;gap:2px}
.pb-row{display:flex;align-items:center;gap:4px;font-size:.58rem;color:var(--t3);font-weight:600;line-height:1}
.pb-bg{width:48px;height:5px;background:var(--s3);border-radius:3px;overflow:hidden;flex-shrink:0}
.pb-fill{height:100%;border-radius:3px}
/* Convergence star */
.conv-star{font-size:.9rem;cursor:default;line-height:1}
/* RS badge */
.rs-badge{display:inline-block;padding:2px 8px;border-radius:5px;font-size:.76rem;font-weight:800;font-variant-numeric:tabular-nums}
.rs-elite{background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.3)}
.rs-high {background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.rs-mid  {background:rgba(234,179,8,.10);color:var(--yw);border:1px solid rgba(234,179,8,.2)}
.rs-low  {background:rgba(100,100,130,.07);color:var(--t3);border:1px solid rgba(100,100,130,.15)}
/* Tag */
.tag{display:inline-block;padding:2px 8px;border-radius:5px;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.tag-high{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.tag-avg {background:rgba(234,179,8,.10);color:var(--yw);border:1px solid rgba(234,179,8,.25)}
.tag-low {background:rgba(239,68,68,.10);color:var(--rd);border:1px solid rgba(239,68,68,.25)}
html[data-theme="light"] .tag-high{background:rgba(21,128,61,.08);color:#15803d;border-color:rgba(21,128,61,.2)}
html[data-theme="light"] .tag-avg {background:rgba(161,98,7,.07);color:#92400e;border-color:rgba(161,98,7,.18)}
html[data-theme="light"] .tag-low {background:rgba(185,28,28,.06);color:#991b1b;border-color:rgba(185,28,28,.18)}
/* 2×2 quadrant matrix */
.matrix-grid{display:none;grid-template-columns:1fr 1fr;grid-template-rows:auto auto;gap:14px;padding:14px 28px 24px}
.matrix-grid.show{display:grid}
.quad-card{border:1px solid var(--bd);border-radius:12px;padding:16px;background:var(--s1);min-height:140px;transition:background .3s,border .3s}
.quad-card .qh{font-size:.82rem;font-weight:700;margin-bottom:3px}.quad-card .qs{font-size:.7rem;color:var(--t2);margin-bottom:10px}
.quad-card .qchips{display:flex;flex-wrap:wrap;gap:5px}
.qchip{padding:3px 9px;border-radius:5px;font-size:.72rem;cursor:pointer;border:1px solid var(--bd);background:var(--s3);color:var(--tx);transition:border .15s,background .15s;white-space:nowrap}
.qchip:hover{border-color:var(--ac);color:var(--ac)}
.quad-sf{border-color:rgba(34,197,94,.35)}.quad-sf .qh{color:var(--gn)}
.quad-wr{border-color:rgba(99,102,241,.3)}.quad-wr .qh{color:var(--ac)}
.quad-gb{border-color:rgba(234,179,8,.35)}.quad-gb .qh{color:var(--yw)}
.quad-av{border-color:rgba(100,100,130,.2)}.quad-av .qh{color:var(--t2)}
/* Footer */
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.74rem;border-top:1px solid var(--bd);line-height:1.8;transition:background .3s}
#no-results{display:none;padding:40px;text-align:center;color:var(--t2)}
.hidden{display:none!important}
#cards-container{display:none;padding:0 14px 24px}
.stock-card{background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:12px;transition:background .3s,border .3s}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.card-name{font-weight:600;font-size:.9rem}.card-name a{color:var(--tx);text-decoration:none}
.card-ticker{color:var(--t2);font-size:.74rem;margin-top:2px}
.card-price .price{font-size:1.1rem;font-weight:700}
.card-row{display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--card-border);font-size:.8rem}
.card-label{color:var(--t2)}
.sort-select{display:none}
html[data-theme="light"] .stat-card{background:#fff;border-color:#dfe2ea}
html[data-theme="light"] th{background:#f5f6fa}
html[data-theme="light"] .filter-group{background:#f5f6fa;border-color:#dfe2ea}
html[data-theme="light"] .multi-dd .dd-btn{background:#fff;border-color:#d5d8e0}
html[data-theme="light"] .dd-panel{background:#fff;border-color:#d5d8e0}
html[data-theme="light"] .dd-panel .dd-actions{background:#fff}
/* DR modal */
.research-btn{background:none;border:none;cursor:pointer;padding:1px 4px;border-radius:4px;font-size:.82rem;color:var(--t3);transition:color .15s;vertical-align:middle;margin-left:2px;line-height:1;flex-shrink:0}
.research-btn:hover{color:var(--ac)}
#dr-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9991;overflow-y:auto;padding:20px 12px}
#dr-modal{background:var(--s2);border:1px solid var(--bd);border-radius:14px;max-width:640px;margin:20px auto;padding:22px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.dr-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--bd)}
.dr-title{font-size:1.1rem;font-weight:700;color:var(--tx)}.dr-subtitle{font-size:.75rem;color:var(--t2);margin-top:3px}
#dr-close{background:none;border:none;cursor:pointer;color:var(--t3);font-size:1.2rem;padding:0;line-height:1;flex-shrink:0}
.dr-section{margin-bottom:18px}.dr-section-title{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ac);font-weight:700;margin-bottom:8px}
.dr-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dr-metric{background:var(--s1);border:1px solid var(--bd);border-radius:8px;padding:10px 12px}
.dr-metric .dm-label{font-size:.65rem;color:var(--t2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.dr-metric .dm-val{font-size:.9rem;font-weight:600}
.dr-metric .dm-sub{font-size:.65rem;color:var(--t3);margin-top:2px}
.dr-signal{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:7px;margin-bottom:5px;font-size:.8rem;line-height:1.4}
.dr-signal.bull{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.18);color:var(--gn)}
.dr-signal.bear{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);color:var(--rd)}
.dr-signal.neut{background:rgba(234,179,8,.07);border:1px solid rgba(234,179,8,.18);color:var(--yw)}
.dr-signal .ds-icon{flex-shrink:0;margin-top:1px}
.dr-ai-box{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:14px;font-size:.82rem;line-height:1.7;color:var(--tx);min-height:80px}
.dr-ai-box.loading{color:var(--t2);font-style:italic}
.dr-ai-error{color:var(--rd);font-size:.78rem;padding:6px 0}
.dr-ai-key-row{display:flex;gap:8px;margin-top:10px;align-items:center}
.dr-ai-key-input{flex:1;padding:7px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--s3);color:var(--tx);font-size:.78rem;font-family:inherit;outline:none}
.dr-ai-key-btn{padding:7px 14px;border:none;border-radius:6px;background:var(--ac);color:#fff;cursor:pointer;font-size:.78rem;font-weight:700;font-family:inherit;white-space:nowrap}
.dr-ai-key-btn:hover{background:#4f46e5}
@media(max-width:768px){#dr-overlay{padding:0}#dr-modal{border-radius:0;min-height:100dvh;margin:0;max-width:100%}.dr-grid{grid-template-columns:1fr}}
${alertSystem.css}
@media(max-width:768px){
  .header{padding:14px 16px}.header h1{font-size:1.1rem}.header .subtitle{font-size:.68rem}
  .stats-bar{padding:12px 14px;gap:8px}
  .stat-card{min-width:0;flex:1 1 calc(33% - 8px);padding:10px 12px}.stat-card .value{font-size:1rem}
  .controls{padding:12px 14px;gap:8px}
  .filter-group{flex-wrap:wrap;width:100%}
  .search{width:100%;font-size:16px}
  .multi-dd{width:100%}.multi-dd .dd-btn{width:100%;font-size:16px}.multi-dd .dd-panel{width:100%}
  .table-container{display:none}
  #cards-container{display:block}
  .sort-select{display:block;width:100%;margin-top:4px}
  .back-link{font-size:.72rem;padding:5px 10px}
  .theme-label{display:none}
  .matrix-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>&#x1F52E; APEX Convergence Scout</h1>
    <div class="subtitle">5-pillar convergence score &nbsp;&middot;&nbsp; Capital Quality + Growth Engine + Valuation + Insider Conviction + Technical Setup &nbsp;&middot;&nbsp; Top ${SCREENER_CAP} NSE stocks &nbsp;&middot;&nbsp; <span style="color:var(--ac)">Generated: ${genTime} IST</span></div>
  </div>
  <div class="header-right">
    <div class="status" id="status-text"></div>
    <span class="theme-label" id="theme-label">Dark</span>
    <div class="theme-toggle" id="theme-toggle" title="Toggle dark/light mode"></div>
    <a href="alerts.html"     class="back-link" style="color:var(--yw);border-color:rgba(234,179,8,.4)">&#x1F514; Alerts</a>
    <a href="potential.html"  class="back-link" style="color:var(--pp);border-color:rgba(168,85,247,.4)">&#x1F31F; Potential</a>
    <a href="multibagger.html" class="back-link" style="color:#f59e0b;border-color:rgba(245,158,11,.4)">&#x1F3C6; Multibagger</a>
    <a href="breakout2.html"  class="back-link" style="color:var(--tl);border-color:rgba(6,182,212,.4)">Breakout GEN2</a>
    <a href="creamy.html"     class="back-link">Creamy Layer</a>
    <a href="index.html"      class="back-link">My Watchlist</a>
  </div>
</div>

<div class="stats-bar">
  <div class="stat-card"><div class="label">Universe</div><div class="value indigo">${stocks.length}</div></div>
  <div class="stat-card"><div class="label">&#x1F7E3; APEX Elite</div><div class="value indigo">${eliteCnt}</div></div>
  <div class="stat-card"><div class="label">&#x1F535; Strong</div><div class="value blue">${strongCnt}</div></div>
  <div class="stat-card"><div class="label">&#x2B50; Convergence</div><div class="value purple">${convCnt}</div></div>
  <div class="stat-card"><div class="label">&#x1F7E2; BUY Signals</div><div class="value green">${buyCnt}</div></div>
  <div class="stat-card"><div class="label">&#x2605; Watchlist</div><div class="value yellow">${wlCnt}</div></div>
  <div class="stat-card" style="margin-left:auto"><div class="label">Data</div><div class="value" style="font-size:.78rem;color:var(--t2)">${genTime} IST</div></div>
</div>

${alertSystem.bannerHtml}
${alertSystem.modalHtml}

<div id="dr-overlay">
  <div id="dr-modal">
    <div class="dr-header">
      <div><div class="dr-title" id="dr-title">APEX Deep Research</div><div class="dr-subtitle" id="dr-subtitle"></div></div>
      <button id="dr-close">&#x2715;</button>
    </div>
    <div id="dr-content"></div>
  </div>
</div>

<div class="controls">
  <div class="filter-group">
    <span class="fg-label">APEX</span>
    <button class="btn apex-btn active" data-min="0">All</button>
    <button class="btn apex-btn" data-min="50">50+</button>
    <button class="btn apex-btn" data-min="65">65+</button>
    <button class="btn apex-btn" data-min="80">80+</button>
    <button class="btn apex-btn" data-min="999" data-conv="1">&#x2B50; Convergence</button>
  </div>
  <div class="filter-group">
    <span class="fg-label">Action</span>
    <button class="btn act-filt-btn active" data-act="all">All</button>
    <button class="btn act-filt-btn" data-act="BUY"  >&#x1F7E2; BUY</button>
    <button class="btn act-filt-btn" data-act="BUILD">&#x1F535; BUILD</button>
    <button class="btn act-filt-btn" data-act="WATCH">&#x1F7E1; WATCH</button>
    <button class="btn act-filt-btn" data-act="wl"   >&#x2605; My WL</button>
  </div>
  <div class="multi-dd" id="sector-dd">
    <button class="dd-btn" type="button"><span id="sector-label">All Sectors</span><span class="dd-arrow">&#x25BC;</span></button>
    <div class="dd-panel" id="sector-panel"></div>
  </div>
  <button class="btn" id="matrix-toggle" style="border-color:var(--bd)">&#x22C2; Matrix View</button>
  <input type="text" class="search" id="search" placeholder="Search ticker or name&hellip;" style="margin-left:auto">
  <select id="sort-select" class="search sort-select">
    <option value="total:desc">Sort: APEX Score (best)</option>
    <option value="p1:desc">Sort: Capital Quality</option>
    <option value="p2:desc">Sort: Growth Engine</option>
    <option value="p3:desc">Sort: Valuation</option>
    <option value="p4:desc">Sort: Insider Conviction</option>
    <option value="p5:desc">Sort: Technical Setup</option>
    <option value="rsRating:desc">Sort: RS Rating</option>
    <option value="marketCap:desc">Sort: Market Cap</option>
    <option value="name:asc">Sort: Name A–Z</option>
  </select>
</div>

<div class="matrix-grid" id="matrix-grid">
  <div class="quad-card quad-sf"><div class="qh">&#x1F7E2; Safe Compounder</div><div class="qs">High quality &amp; valuation + strong setup</div><div class="qchips" id="q-sf"></div></div>
  <div class="quad-card quad-gb"><div class="qh">&#x1F7E1; Growth Bet</div><div class="qs">Setup ready, but quality/value needs monitoring</div><div class="qchips" id="q-gb"></div></div>
  <div class="quad-card quad-wr"><div class="qh">&#x1F7E3; Waiting Room</div><div class="qs">Quality confirmed, waiting for technical setup</div><div class="qchips" id="q-wr"></div></div>
  <div class="quad-card quad-av"><div class="qh">&#x26AA; Avoid</div><div class="qs">Neither quality nor setup criteria met</div><div class="qchips" id="q-av"></div></div>
</div>

<div class="table-container">
  <table>
    <thead><tr id="table-head"></tr></thead>
    <tbody id="table-body"></tbody>
  </table>
  <div id="no-results">No stocks match the current filter.</div>
</div>

<div id="cards-container"></div>

<div class="footer" id="footer"></div>
<div class="tt" id="tt"></div>

<script>
var RAW = ${dataJson};
var allStocks = RAW;
var sortCol = 'total', sortAsc = false;
var minApex = 0, convOnly = false, actFilter = 'all', excludedSectors = new Set(), searchTerm = '';

var COLS = [
  {key:'rank',    label:'#',w:'36px'},
  {key:'name',    label:'Stock',w:'210px',tip:'Company name and NSE ticker. \u25cf Watchlist stocks shown with \u2605. Click to open on Tickertape. \ud83e\udde0 button opens AI Deep Research powered by APEX score.'},
  {key:'total',   label:'APEX Score',w:'160px',num:true,tip:'APEX Convergence Score (0\u2013100). Synthesises 5 equally-weighted pillars (20 pts each). +5 Convergence Bonus when all pillars \u226512/20 simultaneously. Elite\u226580 | Strong\u226565 | Aligned\u226550 | Misaligned<50.'},
  {key:'action',  label:'Action',w:'80px',tip:'\ud83d\udfe2 BUY = APEX\u226570 + Stage2 + VCP confirmed. \ud83d\udd35 BUILD = APEX\u226565 + Stage2 uptrend. \ud83d\udfe1 WATCH = APEX\u226550. \u26d4 PASS = does not meet criteria.'},
  {key:'pillars', label:'Pillars (P1\u2013P5)',w:'200px',tip:'5 mini-bars showing each pillar fill out of 20 pts. P1=Capital Quality (green) | P2=Growth Engine (cyan) | P3=Valuation (amber) | P4=Insider Conviction (pink) | P5=Technical Setup (indigo). \u2B50 = Convergence bonus: all pillars\u226512.'},
  {key:'epsGwth5Y',label:'EPS 5Y%',w:'70px',num:true,tip:'5-year EPS CAGR (Tickertape). \u226525% = Pillar 2 max zone.'},
  {key:'roe',     label:'ROE',w:'60px',num:true,tip:'Return on Equity %. Pillar 1 key metric. \u226525% = 8 pts.'},
  {key:'pegVal',  label:'PEG',w:'56px',num:true,tip:'PEG Ratio = P/E \u00f7 5Y EPS CAGR. Pillar 3 key metric. \u22640.8 = 8 pts, >2.5 = penalty.'},
  {key:'p4',      label:'Promoter',w:'60px',num:true,tip:'Pillar 4: Insider Conviction score (0\u201320). Driven by promoter % holding and 3M buying/selling activity.'},
  {key:'rsRating',label:'RS',w:'52px',num:true,tip:'IBD-style Relative Strength Rating 1\u201399 (from breakout2 analysis). Convex-mapped to Pillar 5 score. RS\u226590 = \u26a1 Elite.'},
  {key:'sector',  label:'Sector',w:'110px'},
  {key:'marketCap',label:'MCap Cr',w:'78px',num:true,tip:'Market capitalisation in Indian Rupees (Crores). Top 300 by MCap universe.'},
];

function ringClass(t){return t>=80?'r-elite':t>=65?'r-strong':t>=50?'r-aligned':'r-low';}
function tierClass(t){return t>=80?'tier-elite':t>=65?'tier-strong':t>=50?'tier-aligned':'tier-mis';}
function tierLabel(t){return t>=80?'\ud83d\udfe3 Elite':t>=65?'\ud83d\udd35 Strong':t>=50?'\ud83d\udfe2 Aligned':'\u26aa Misaligned';}
function actClass(a){return a==='BUY'?'act-buy':a==='BUILD'?'act-build':a==='WATCH'?'act-watch':'act-pass';}
function actLabel(a){return a==='BUY'?'\ud83d\udfe2 BUY':a==='BUILD'?'\ud83d\udd35 BUILD':a==='WATCH'?'\ud83d\udfe1 WATCH':'\u26d4 PASS';}
function rsHtml(rs){if(!rs)return '<span class="dim">\u2014</span>';var c=rs>=90?'rs-elite':rs>=80?'rs-high':rs>=60?'rs-mid':'rs-low';return '<span class="rs-badge '+c+'" title="RS Rating '+rs+'/99">'+rs+'</span>';}
function tagHtml(t){if(!t)return '<span style="opacity:.3">\u2014</span>';var c=t==='High'?'tag-high':t==='Avg'?'tag-avg':'tag-low';return '<span class="tag '+c+'">'+t+'</span>';}
function retHtml(v){if(v==null)return '<span style="color:var(--t3)">\u2014</span>';var c=v>=0?'pos':'neg';return '<span class="'+c+'">'+(v>=0?'+':'')+v.toFixed(1)+'%</span>';}
function pillarsHtml(s){
  var bars=[
    {lbl:'P1',v:s.p1,c:'#22c55e'},{lbl:'P2',v:s.p2,c:'#06b6d4'},
    {lbl:'P3',v:s.p3,c:'#f59e0b'},{lbl:'P4',v:s.p4,c:'#ec4899'},{lbl:'P5',v:s.p5,c:'#6366f1'},
  ];
  return '<div class="pillar-bars">'
    +bars.map(function(b){var pct=Math.min(100,Math.round(b.v/20*100));return '<div class="pb-row"><span>'+b.lbl+'</span><div class="pb-bg"><div class="pb-fill" style="width:'+pct+'%;background:'+b.c+'"></div></div></div>';}).join('')
    +(s.convergence?'<span title="Convergence bonus: all pillars \u226512" style="margin-top:1px">\u2B50</span>':'')
    +'</div>';}

function buildHead(){
  document.getElementById('table-head').innerHTML=COLS.map(function(c){
    var tip=c.tip?(' data-tip="'+c.tip.replace(/"/g,'&quot;')+'"\u200b'):'';
    var icon=c.tip?'<span class="tip-icon">?</span>':'';
    var sorted=sortCol===c.key;
    var arrow=sorted?(sortAsc?'\u25b2':'\u25bc'):'\u21c5';
    return '<th style="width:'+c.w+'"'+tip+' class="'+(sorted?'sorted':'')+'" onclick="doSort(\''+c.key+'\','+(!!c.num)+')">'
      +c.label+'<span class="arrow">'+arrow+'</span>'+icon+'</th>';
  }).join('');
}

function getFiltered(){
  return allStocks.filter(function(s){
    if(convOnly&&!s.convergence)return false;
    if(!convOnly&&s.total<minApex)return false;
    if(actFilter==='BUY'&&s.action!=='BUY')return false;
    if(actFilter==='BUILD'&&s.action!=='BUILD')return false;
    if(actFilter==='WATCH'&&s.action!=='WATCH')return false;
    if(actFilter==='wl'&&!s.inWatchlist)return false;
    if(excludedSectors.size>0&&excludedSectors.has(s.sector))return false;
    if(searchTerm){var q=searchTerm.toLowerCase();if(s.ticker.toLowerCase().indexOf(q)<0&&s.name.toLowerCase().indexOf(q)<0&&(s.sector||'').toLowerCase().indexOf(q)<0)return false;}
    return true;
  }).sort(function(a,b){
    var av=a[sortCol],bv=b[sortCol];
    if(sortCol==='name'){return sortAsc?a.name.localeCompare(b.name):b.name.localeCompare(a.name);}
    if(sortCol==='action'){var ord={BUY:0,BUILD:1,WATCH:2,PASS:3};av=ord[a.action]||3;bv=ord[b.action]||3;}
    if(av==null&&bv==null)return 0;if(av==null)return 1;if(bv==null)return -1;
    return sortAsc?(av-bv):(bv-av);
  });
}

function renderTable(){
  var list=getFiltered();
  document.getElementById('status-text').textContent=list.length+' stocks';
  var rows=list.slice(0,200).map(function(s,i){
    var url=s.slug?'https://www.tickertape.in'+s.slug:'https://www.tickertape.in/stocks/'+s.ticker+'-XXXXX';
    return '<tr>'
      +'<td style="color:var(--t3);font-size:.8rem">'+(i+1)+'</td>'
      +'<td><div class="stock-name-cell"><div class="stock-name"><a href="'+url+'" target="_blank" rel="noopener">'+s.name+'</a>'
        +'<div class="ticker">'+s.ticker+(s.inWatchlist?' <span class="wl-dot" title="In your watchlist">\u2605</span>':'')+'</div></div>'
        +'<button class="alert-btn" data-alert-ticker="'+s.ticker+'" data-alert-price="'+(s.price||0)+'" data-alert-name="'+s.name.replace(/"/g,'&quot;')+'">&#x1F514;</button>'
        +'<button class="research-btn" data-r-ticker="'+s.ticker+'" title="APEX AI Deep Research">&#x1F9E0;</button></div></td>'
      +'<td><div class="apex-cell"><div class="apex-ring '+ringClass(s.total)+'">'+s.total+'</div>'
        +'<span class="tier-badge '+tierClass(s.total)+'" style="font-size:.68rem">'+tierLabel(s.total)+'</span></div></td>'
      +'<td><span class="act-badge '+actClass(s.action)+'">'+actLabel(s.action)+'</span></td>'
      +'<td>'+pillarsHtml(s)+'</td>'
      +'<td>'+retHtml(s.epsGwth5Y)+'</td>'
      +'<td>'+(s.roe!=null?'<span class="'+(s.roe>=20?'pos':s.roe>=10?'':'neg')+'">'+s.roe.toFixed(1)+'%</span>':'\u2014')+'</td>'
      +'<td>'+(s.pegVal!=null?'<span class="'+(s.pegVal<=1.2?'pos':s.pegVal>2.0?'neg':'')+'">'+s.pegVal+'</span>':'\u2014')+'</td>'
      +'<td style="text-align:center"><span class="apex-ring" style="width:28px;height:28px;font-size:.72rem;border-width:2px;'+(s.p4>=14?'border-color:#ec4899;color:#ec4899':s.p4>=8?'border-color:var(--yw);color:var(--yw)':'border-color:var(--t3);color:var(--t3)')+'">'+s.p4+'</span></td>'
      +'<td>'+rsHtml(s.rsRating)+'</td>'
      +'<td style="font-size:.78rem;color:var(--t2)">'+esc(s.sector||'')+'</td>'
      +'<td style="font-size:.8rem;color:var(--t2)">'+fmtCr(s.marketCap)+' Cr</td>'
      +'</tr>';
  }).join('');
  document.getElementById('table-body').innerHTML=rows||'';
  document.getElementById('no-results').style.display=list.length===0?'block':'none';
  renderCards(list);
  renderMatrix(list);
}

function renderCards(list){
  var el=document.getElementById('cards-container');
  el.innerHTML=list.slice(0,200).map(function(s){
    var url=s.slug?'https://www.tickertape.in'+s.slug:'#';
    return '<div class="stock-card">'
      +'<div class="card-header">'
        +'<div><div class="card-name"><a href="'+url+'" target="_blank" rel="noopener">'+s.name+'</a></div>'
          +'<div class="card-ticker">'+s.ticker+(s.inWatchlist?' \u2605':'')
          +' <button class="alert-btn" data-alert-ticker="'+s.ticker+'" data-alert-price="'+(s.price||0)+'" data-alert-name="'+s.name.replace(/"/g,'&quot;')+'">&#x1F514;</button>'
          +' <button class="research-btn" data-r-ticker="'+s.ticker+'" title="APEX AI Deep Research">&#x1F9E0;</button></div></div>'
        +'<div><div class="apex-ring '+ringClass(s.total)+'" style="width:38px;height:38px;font-size:.8rem">'+s.total+'</div></div>'
      +'</div>'
      +'<div class="card-row"><span class="card-label">Action</span><span><span class="act-badge '+actClass(s.action)+'">'+actLabel(s.action)+'</span></span></div>'
      +'<div class="card-row"><span class="card-label">Tier</span><span><span class="tier-badge '+tierClass(s.total)+'">'+tierLabel(s.total)+'</span></span></div>'
      +'<div class="card-row"><span class="card-label">EPS 5Y CAGR</span><span>'+retHtml(s.epsGwth5Y)+'</span></div>'
      +'<div class="card-row"><span class="card-label">ROE</span><span>'+(s.roe!=null?s.roe.toFixed(1)+'%':'\u2014')+'</span></div>'
      +'<div class="card-row"><span class="card-label">PEG</span><span>'+(s.pegVal!=null?s.pegVal:'\u2014')+'</span></div>'
      +'<div class="card-row"><span class="card-label">RS Rating</span><span>'+rsHtml(s.rsRating)+'</span></div>'
      +'<div class="card-row"><span class="card-label">MCap</span><span>'+fmtCr(s.marketCap)+' Cr</span></div>'
      +'</div>';
  }).join('');
}

function renderMatrix(list){
  var qs={SF:[],WR:[],GB:[],AV:[]};
  list.forEach(function(s){if(qs[s.quadrant])qs[s.quadrant].push(s);});
  ['SF','WR','GB','AV'].forEach(function(q){
    var el=document.getElementById('q-'+q.toLowerCase());
    if(!el)return;
    el.innerHTML=qs[q].slice(0,30).map(function(s){
      return '<span class="qchip" title="APEX '+s.total+'" onclick="jumpToTicker(\''+s.ticker+'\')">'+s.ticker+'<span style="font-size:.6rem;color:var(--t3);margin-left:3px">'+s.total+'</span></span>';
    }).join('')+(qs[q].length>30?'<span class="qchip" style="color:var(--t3)">+'+( qs[q].length-30)+' more</span>':'');
  });
}

window.jumpToTicker=function(ticker){
  searchTerm=ticker;
  document.getElementById('search').value=ticker;
  applyFilters();
  document.getElementById('matrix-toggle').click();
};

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtCr(n){if(n==null)return'\u2014';if(n>=100000)return(n/100000).toFixed(1)+'L';if(n>=10000)return(n/1000).toFixed(1)+'K';return Math.round(n)+'';}

function doSort(col,isNum){
  if(sortCol===col){sortAsc=!sortAsc;}else{sortCol=col;sortAsc=(col==='name');}
  buildHead();renderTable();
}

function applyFilters(){renderTable();}

// Sector dropdown
function buildSectorDd(){
  var counts={};allStocks.forEach(function(s){if(s.sector)counts[s.sector]=(counts[s.sector]||0)+1;});
  var sectors=Object.keys(counts).sort();
  document.getElementById('sector-panel').innerHTML=
    '<div class="dd-actions"><button id="sel-all">All</button><button id="sel-none">None</button></div>'
    +sectors.map(function(sec){return'<label><input type="checkbox" checked data-sector="'+sec.replace(/"/g,'&quot;')+'"><span>'+sec+'</span><span class="dd-count">'+counts[sec]+'</span></label>';}).join('');
  document.getElementById('sel-all').addEventListener('click',function(){
    excludedSectors=new Set();document.querySelectorAll('#sector-panel input').forEach(function(c){c.checked=true;});
    document.getElementById('sector-label').textContent='All Sectors';renderTable();
  });
  document.getElementById('sel-none').addEventListener('click',function(){
    excludedSectors=new Set(allStocks.map(function(s){return s.sector;}));
    document.querySelectorAll('#sector-panel input').forEach(function(c){c.checked=false;});
    document.getElementById('sector-label').textContent='0 Sectors';renderTable();
  });
  document.getElementById('sector-panel').addEventListener('change',function(e){
    if(e.target.type!=='checkbox')return;
    var sec=e.target.dataset.sector;
    if(e.target.checked)excludedSectors.delete(sec);else excludedSectors.add(sec);
    document.getElementById('sector-label').textContent=excludedSectors.size===0?'All Sectors':(allStocks.filter(function(s){return !excludedSectors.has(s.sector);}).length+' shown');
    renderTable();
  });
}

// Init
document.addEventListener('DOMContentLoaded',function(){
  buildHead();buildSectorDd();renderTable();

  // Theme
  var toggle=document.getElementById('theme-toggle'),lbl=document.getElementById('theme-label');
  function applyTheme(t){document.documentElement.setAttribute('data-theme',t);localStorage.setItem('apex-theme',t);lbl.textContent=t==='dark'?'Dark':'Light';}
  applyTheme(document.documentElement.getAttribute('data-theme')||'dark');
  toggle.addEventListener('click',function(){applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');});

  // APEX filter
  document.querySelectorAll('.apex-btn').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.apex-btn').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active');
      convOnly=!!b.dataset.conv;
      minApex=convOnly?0:parseInt(b.dataset.min)||0;
      renderTable();
    });
  });

  // Action filter
  document.querySelectorAll('.act-filt-btn').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.act-filt-btn').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active');actFilter=b.dataset.act;renderTable();
    });
  });

  // Sector dropdown
  var dd=document.getElementById('sector-dd');
  dd.querySelector('.dd-btn').addEventListener('click',function(e){e.stopPropagation();dd.classList.toggle('open');});
  document.addEventListener('click',function(e){if(!e.target.closest('#sector-dd'))dd.classList.remove('open');});
  document.getElementById('sector-panel').addEventListener('click',function(e){e.stopPropagation();});

  // Matrix toggle
  document.getElementById('matrix-toggle').addEventListener('click',function(){
    var g=document.getElementById('matrix-grid');var t=document.getElementById('table-container')||document.querySelector('.table-container');var c=document.getElementById('cards-container');
    var show=!g.classList.contains('show');
    g.classList.toggle('show',show);
    if(t)t.style.display=show?'none':'';
    if(c)c.style.display=show?'none':'';
    this.textContent=show?'\u22C2 Table View':'\u22C2 Matrix View';
  });

  // Search
  document.getElementById('search').addEventListener('input',function(){searchTerm=this.value.trim();renderTable();});

  // Mobile sort
  document.getElementById('sort-select').addEventListener('change',function(){
    var p=this.value.split(':');sortCol=p[0];sortAsc=p[1]==='asc';buildHead();renderTable();
  });

  // Tooltips
  var tt=document.getElementById('tt');
  document.addEventListener('mouseover',function(e){var el=e.target.closest('[data-tip]');if(!el)return;tt.textContent=el.getAttribute('data-tip');tt.classList.add('tt-vis');});
  document.addEventListener('mouseout',function(e){if(!e.target.closest('[data-tip]'))tt.classList.remove('tt-vis');});
  document.addEventListener('mousemove',function(e){if(tt.classList.contains('tt-vis')){var x=e.clientX+14,y=e.clientY+14;if(x+250>window.innerWidth)x=e.clientX-260;if(y+140>window.innerHeight)y=e.clientY-150;tt.style.left=x+'px';tt.style.top=y+'px';}});

  // Footer
  document.getElementById('footer').innerHTML=
    'APEX Convergence Scout &middot; 5-pillar framework: Capital Quality\u00b720 + Growth Engine\u00b720 + Valuation Discipline\u00b720 + Insider Conviction\u00b720 + Technical Setup\u00b720 + Convergence Bonus\u00b75 = 100 pts<br>'
    +'Universe: Top '+${SCREENER_CAP}+' NSE stocks by MCap &middot; Technical data: breakout2-data.json (Stage2+VCP+RS) &middot; Fundamentals: Tickertape screener<br>'
    +'Generated ${genTime} IST &nbsp;&middot;&nbsp; Not financial advice. Always do your own research.';
});

window._GH_ALERTS_REPO='amitiyer99/watchlist-app';
${alertSystem.js}

// ─────── Deep Research AI (APEX edition) ───────
(function(){
  var DR_PROV_KEY='dr_provider';
  var DR_PROVIDERS={groq:{label:'Groq (Llama/Mixtral) \u2014 30 req/min free \u2605',keyName:'dr_groq_key',keyPlaceholder:'Paste Groq API key (console.groq.com)',keyLink:'https://console.groq.com/keys',keyLinkLabel:'console.groq.com',models:[{id:'llama-3.3-70b-versatile',label:'Llama 3.3 70B \u2014 best quality'},{id:'llama3-8b-8192',label:'Llama 3 8B \u2014 fastest'},{id:'mixtral-8x7b-32768',label:'Mixtral 8x7B'}]},openrouter:{label:'OpenRouter \u2014 free tier models',keyName:'dr_openrouter_key',keyPlaceholder:'Paste OpenRouter API key (openrouter.ai/keys)',keyLink:'https://openrouter.ai/keys',keyLinkLabel:'openrouter.ai',models:[{id:'meta-llama/llama-3.1-8b-instruct:free',label:'Llama 3.1 8B (free)'},{id:'mistralai/mistral-7b-instruct:free',label:'Mistral 7B (free)'},{id:'google/gemma-3-27b-it:free',label:'Gemma 3 27B (free)'}]},gemini:{label:'Google Gemini',keyName:'dr_gemini_key',keyPlaceholder:'Paste Gemini API key (aistudio.google.com)',keyLink:'https://aistudio.google.com/app/apikey',keyLinkLabel:'aistudio.google.com',models:[{id:'gemini-2.0-flash-lite',label:'Gemini 2.0 Flash Lite \u2014 30 req/min'},{id:'gemini-2.0-flash',label:'Gemini 2.0 Flash \u2014 15 req/min'},{id:'gemini-1.5-flash-8b',label:'Gemini 1.5 Flash 8B'}]}};
  var drCur=null;
  document.addEventListener('click',function(e){
    var btn=e.target.closest('.research-btn');if(!btn)return;e.stopPropagation();
    var ticker=btn.dataset.rTicker;
    var s=allStocks.find(function(x){return x.ticker===ticker;});if(!s)return;
    drCur=s;
    document.getElementById('dr-title').textContent=s.name;
    document.getElementById('dr-subtitle').textContent=s.ticker+' \u00b7 NSE India \u00b7 '+s.sector+' \u00b7 APEX '+s.total+(s.convergence?' \u2B50':'')+(s.inWatchlist?' \u00b7 \u2605 WL':'');
    document.getElementById('dr-content').innerHTML=buildDrContent(s);
    document.getElementById('dr-overlay').style.display='block';document.body.style.overflow='hidden';
    var sp=localStorage.getItem(DR_PROV_KEY)||'groq';var psel=document.getElementById('dr-provider-select');if(psel)psel.value=sp;
    drChangeProvider();
    var sprov=DR_PROVIDERS[sp];var key=sprov?localStorage.getItem(sprov.keyName):null;
    if(key){var inp=document.getElementById('dr-key-input');if(inp)inp.value='\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';var msel=document.getElementById('dr-model-select');runAIAnalysis(s,key,sp,msel?msel.value:null);}
  });
  document.getElementById('dr-close').addEventListener('click',closeDr);
  document.getElementById('dr-overlay').addEventListener('click',function(e){if(e.target===document.getElementById('dr-overlay'))closeDr();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDr();});
  function closeDr(){document.getElementById('dr-overlay').style.display='none';document.body.style.overflow='';}
  window.drRunWithKey=function(){
    var inp=document.getElementById('dr-key-input');if(!inp)return;
    var psel=document.getElementById('dr-provider-select');var pid=(psel&&psel.value)||localStorage.getItem(DR_PROV_KEY)||'groq';var prov=DR_PROVIDERS[pid]||DR_PROVIDERS.groq;
    var typedKey=inp.value.trim().replace(/[^\x20-\x7E]/g,'');var key=typedKey||localStorage.getItem(prov.keyName)||'';
    if(!key){inp.focus();return;}
    localStorage.setItem(DR_PROV_KEY,pid);localStorage.setItem(prov.keyName,key);inp.value='\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    var msel=document.getElementById('dr-model-select');var model=msel?msel.value:prov.models[0].id;
    if(drCur)runAIAnalysis(drCur,key,pid,model);
  };
  window.drChangeProvider=function(){
    var psel=document.getElementById('dr-provider-select');var msel=document.getElementById('dr-model-select');var inp=document.getElementById('dr-key-input');var link=document.getElementById('dr-key-link');
    if(!psel)return;var prov=DR_PROVIDERS[psel.value];if(!prov)return;
    if(msel){msel.innerHTML=prov.models.map(function(m){return'<option value="'+m.id+'">'+m.label+'</option>';}).join('');var sm=localStorage.getItem('dr_model.'+psel.value);if(sm)msel.value=sm;}
    var sk=localStorage.getItem(prov.keyName);if(inp){inp.value=sk?'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022':'';inp.placeholder=prov.keyPlaceholder;}
    if(link){link.href=prov.keyLink;link.textContent=prov.keyLinkLabel;}
  };
  function dm(lbl,val,sub,cls){return'<div class="dr-metric"><div class="dm-label">'+lbl+'</div><div class="dm-val'+(cls?' '+cls:'')+'">'+(val||'\u2014')+'</div>'+(sub?'<div class="dm-sub">'+sub+'</div>':'')+'</div>';}
  function buildDrContent(s){
    var signals=[];
    if(s.p1>=16)signals.push({type:'bull',icon:'\u25b2',text:'Capital Quality '+s.p1+'/20 \u2014 strong ROE + balance sheet.'});
    else if(s.p1<=6)signals.push({type:'bear',icon:'\u25bc',text:'Capital Quality '+s.p1+'/20 \u2014 weak quality metrics.'});
    if(s.p2>=16)signals.push({type:'bull',icon:'\u25b2',text:'Growth Engine '+s.p2+'/20 \u2014 strong recurring growth with acceleration.'});
    else if(s.p2<=6)signals.push({type:'neut',icon:'\u25c6',text:'Growth Engine '+s.p2+'/20 \u2014 limited growth momentum.'});
    if(s.p3>=14)signals.push({type:'bull',icon:'\u25c6',text:'Valuation '+s.p3+'/20 \u2014 reasonable price relative to growth.'+(s.pegVal?' PEG '+s.pegVal:'')});
    else if(s.p3<=4)signals.push({type:'bear',icon:'\u25bc',text:'Valuation '+s.p3+'/20 \u2014 expensive relative to growth.'+(s.pegVal?' PEG '+s.pegVal+'x':'')});
    if(s.p4>=16)signals.push({type:'bull',icon:'\u25c6',text:'Insider Conviction '+s.p4+'/20 \u2014 strong promoter holding with buying.'});
    if(s.p5>=14)signals.push({type:'bull',icon:'\u25b2',text:'Technical Setup '+s.p5+'/20 \u2014 Stage 2 confirmed, VCP/RS aligned.'});
    else if(s.p5===0)signals.push({type:'bear',icon:'\u25bc',text:'Technical Setup 0/20 \u2014 Stage 2 not confirmed. Wait for technical breakout.'});
    if(s.convergence)signals.push({type:'bull',icon:'\u2B50',text:'CONVERGENCE: All 5 pillars \u226512/20 \u2014 strongest APEX signal!'});
    if(s.decelFlag)signals.push({type:'neut',icon:'\u26a0',text:'Deceleration flag: 1Y EPS growth significantly below 5Y CAGR trend.'});
    if(s.accrualFlag)signals.push({type:'bear',icon:'\u26a0',text:'FCF warning: Negative free cash flow \u2014 earnings may not be fully cash-backed.'});
    if(!signals.length)signals.push({type:'neut',icon:'\u25c6',text:'Moderate signal quality. Review pillar details below.'});
    var html='<div class="dr-section"><div class="dr-section-title">\ud83d\udd2e APEX Score Breakdown</div><div class="dr-grid">'
      +dm('APEX Total',s.total+(s.convergence?' \u2B50':''),s.tier,'')
      +dm('P1 Capital Quality',s.p1+'/20','ROE: '+(s.roe!=null?s.roe.toFixed(1)+'%':'\u2014'),'')
      +dm('P2 Growth Engine',s.p2+'/20','EPS 5Y: '+(s.epsGwth5Y!=null?'+'+s.epsGwth5Y.toFixed(1)+'%':'\u2014'),'')
      +dm('P3 Valuation',s.p3+'/20','PEG: '+(s.pegVal!=null?s.pegVal:'\u2014'),'')
      +dm('P4 Insider',s.p4+'/20','Promoter: '+(s.promoterHolding!=null?s.promoterHolding.toFixed(1)+'%':'\u2014'),'')
      +dm('P5 Technical',s.p5+'/20','RS: '+(s.rsRating||'\u2014')+' | Stage2: '+(s.stage2?'\u2713':'\u2717'),'')
      +'</div></div>';
    html+='<div class="dr-section"><div class="dr-section-title">&#x1F4CA; Key Metrics</div><div class="dr-grid">'
      +dm('Price',s.price!=null?'\u20b9'+s.price.toFixed(2):'\u2014','','')
      +dm('Action','<span style="'+(s.action==='BUY'?'color:#22c55e':s.action==='BUILD'?'color:#3b82f6':s.action==='WATCH'?'color:#eab308':'color:var(--t3)')+'">'+(s.action==='BUY'?'\ud83d\udfe2':s.action==='BUILD'?'\ud83d\udd35':s.action==='WATCH'?'\ud83d\udfe1':'\u26d4')+' '+s.action+'</span>','','')
      +dm('D/E',s.debtEquity!=null?s.debtEquity.toFixed(2):'\u2014',s.debtEquity!=null&&s.debtEquity<=0.3?'Fortress':s.debtEquity>1.5?'High leverage':'',s.debtEquity!=null&&s.debtEquity<=0.3?'pos':s.debtEquity>1.5?'neg':'')
      +dm('EV/EBITDA',s.evEbitda!=null?s.evEbitda.toFixed(1)+'x':'\u2014',s.evEbitda!=null&&s.evEbitda<=12?'Attractive':s.evEbitda>25?'Stretched':'','')
      +dm('FCF Yield',s.fcfYield!=null?s.fcfYield.toFixed(1)+'%':'\u2014','','')
      +dm('MCap',fmtCr(s.marketCap)+' Cr','','')
      +'</div></div>';
    html+='<div class="dr-section"><div class="dr-section-title">&#x2728; Signals</div>';
    for(var i=0;i<signals.length;i++)html+='<div class="dr-signal '+signals[i].type+'"><span class="ds-icon">'+signals[i].icon+'</span><span>'+signals[i].text+'</span></div>';
    html+='</div>';
    html+='<div class="dr-section"><div class="dr-section-title">\ud83e\udde0 AI Deep Analysis</div>'
      +'<div id="dr-ai-box" class="dr-ai-box loading">Enter your API key below for APEX-powered multi-dimensional analysis \u2014 quality assessment, growth outlook, valuation, insider signals &amp; verdict.</div>'
      +'<div id="dr-ai-error" class="dr-ai-error" style="display:none"></div>'
      +'<div style="margin-bottom:6px"><select id="dr-provider-select" onchange="drChangeProvider()" style="width:100%;background:var(--s3);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;font-size:.78rem;cursor:pointer">'
      +Object.keys(DR_PROVIDERS).map(function(k){return'<option value="'+k+'">'+DR_PROVIDERS[k].label+'</option>';}).join('')+'</select></div>'
      +'<div style="margin-bottom:6px"><select id="dr-model-select" style="width:100%;background:var(--s3);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;font-size:.78rem;cursor:pointer"></select></div>'
      +'<div class="dr-ai-key-row"><input type="password" class="dr-ai-key-input" id="dr-key-input" placeholder="Paste API key"><button class="dr-ai-key-btn" onclick="drRunWithKey()">Analyse \u2726</button></div>'
      +'<div style="font-size:.62rem;color:var(--t3);margin-top:5px">Get free key at <a id="dr-key-link" href="https://console.groq.com/keys" target="_blank" rel="noopener" style="color:var(--ac)">console.groq.com</a> &middot; Stored only in your browser</div>'
      +'</div>';
    return html;
  }
  function buildAIPrompt(s){
    return 'You are a professional Indian equity analyst. Analyse this stock using the APEX Convergence Score framework.\n\n'
      +'STOCK: '+s.name+' ('+s.ticker+') | NSE India | Sector: '+(s.sector||'N/A')+'\n\n'
      +'APEX SCORE: '+s.total+'/100 ('+s.tier+(s.convergence?' \u2605 CONVERGENCE':'')+') | Action: '+s.action+'\n\n'
      +'PILLAR BREAKDOWN:\n'
      +'- P1 Capital Quality: '+s.p1+'/20 (ROE '+(s.roe!=null?s.roe.toFixed(1)+'%':'N/A')+', D/E '+(s.debtEquity!=null?s.debtEquity.toFixed(2):'N/A')+')\n'
      +'- P2 Growth Engine: '+s.p2+'/20 (EPS 5Y CAGR '+(s.epsGwth5Y!=null?s.epsGwth5Y.toFixed(1)+'%':'N/A')+', Rev 5Y '+(s.revGrowth5Y!=null?s.revGrowth5Y.toFixed(1)+'%':'N/A')+')\n'
      +'- P3 Valuation: '+s.p3+'/20 (PEG '+(s.pegVal!=null?s.pegVal:'N/A')+', EV/EBITDA '+(s.evEbitda!=null?s.evEbitda.toFixed(1)+'x':'N/A')+')\n'
      +'- P4 Insider Conviction: '+s.p4+'/20 (Promoter '+(s.promoterHolding!=null?s.promoterHolding.toFixed(1)+'%':'N/A')+', 3M chg '+(s.promoterChg3M!=null?s.promoterChg3M.toFixed(2)+'%':'N/A')+')\n'
      +'- P5 Technical Setup: '+s.p5+'/20 (Stage 2: '+(s.stage2?'YES':'NO')+', VCP: '+(s.vcpPass?'YES':'NO')+', RS Rating: '+(s.rsRating||'N/A')+')\n\n'
      +'Write a concise APEX research note:\n\n'
      +'**QUALITY & MOAT**\nAssess capital quality, ROE trend, and balance sheet strength.\n\n'
      +'**GROWTH OUTLOOK**\nEPS/revenue compounding trend, acceleration or deceleration signals.\n\n'
      +'**VALUATION**\nIs the PEG/EV-EBITDA justified? Fair value perspective.\n\n'
      +'**INSIDER & INSTITUTIONAL**\nPromoter conviction signals and smart money flow.\n\n'
      +'**TECHNICAL STATUS**\nStage 2 confirmation, VCP setup, RS momentum.\n\n'
      +'**VERDICT**: ['+s.action+'] \u2014 [one sentence reasons why]';
  }
  function runAIAnalysis(s,apiKey,provId,model){
    var prov=DR_PROVIDERS[provId]||DR_PROVIDERS.groq;
    if(!model)model=prov.models[0].id;
    localStorage.setItem('dr_model.'+provId,model);
    var box=document.getElementById('dr-ai-box'),errEl=document.getElementById('dr-ai-error');
    if(!box)return;
    box.className='dr-ai-box loading';box.textContent='\u23f3 Analysing '+s.name+'\u2026';errEl.style.display='none';
    var prompt=buildAIPrompt(s);
    apiKey=String(apiKey).replace(/[^\x20-\x7E]/g,'');
    if(!apiKey){box.className='dr-ai-box';errEl.style.display='block';errEl.textContent='\u26a0\ufe0f Invalid API key.';return;}
    var fUrl,fBody,fH={'Content-Type':'application/json'};
    if(provId==='gemini'){fUrl='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(apiKey);fBody=JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.65,maxOutputTokens:1024}});}
    else if(provId==='openrouter'){fUrl='https://openrouter.ai/api/v1/chat/completions';fH['Authorization']='Bearer '+apiKey;fH['HTTP-Referer']='https://amitiyer99.github.io/watchlist-app/';fBody=JSON.stringify({model:model,messages:[{role:'user',content:prompt}],temperature:0.65,max_tokens:1024});}
    else{fUrl='https://api.groq.com/openai/v1/chat/completions';fH['Authorization']='Bearer '+apiKey;fBody=JSON.stringify({model:model,messages:[{role:'user',content:prompt}],temperature:0.65,max_tokens:1024});}
    fetch(fUrl,{method:'POST',headers:fH,body:fBody})
    .then(function(r){if(!r.ok)return r.json().then(function(e){throw new Error((e.error&&(e.error.message||JSON.stringify(e.error)))||'API error '+r.status);});return r.json();})
    .then(function(data){
      var text=provId==='gemini'?(data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts&&data.candidates[0].content.parts[0]&&data.candidates[0].content.parts[0].text):(data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content);
      if(!text)throw new Error('Empty response');
      box.className='dr-ai-box';
      box.innerHTML=text.replace(/\*\*([^*]+)\*\*/g,'<strong style="color:var(--ac);display:block;margin-top:12px;margin-bottom:4px">$1</strong>').replace(/\n\n/g,'</p><p style="margin:4px 0">').replace(/\n/g,'<br>').replace(/^/,'<p style="margin:0">').replace(/$/,'</p>');
    }).catch(function(err){box.className='dr-ai-box';box.innerHTML='<span style="opacity:.5">Could not generate analysis.</span>';errEl.style.display='block';errEl.textContent='\u26a0\ufe0f '+err.message;});
  }
})();
<\/script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== APEX Convergence Scout ===\n');

  console.log('Step 1: Loading watchlist tickers...');
  const wlTickers = loadWatchlistTickers();
  console.log(`  ${wlTickers.size} watchlist tickers`);

  console.log('Step 2: Loading breakout2 technical data (Stage2/VCP/RS)...');
  const techMap = loadTechData();

  console.log('Step 3: Fetching fundamentals from Tickertape screener...');
  const stocks = await fetchFundamentals();

  console.log('Step 4: Fetching scorecard tags (6-hr cache)...');
  const scorecards = await loadOrFetchScorecards(stocks);

  console.log('Step 5: Computing APEX scores...');
  const apex = stocks.map(s => {
    const tech = techMap.get(s.ticker) || null;
    const sc   = scorecards[s.sid]     || {};
    const score = calcApexScore(s, tech);
    return {
      ...s,
      ...score,
      perfTag:  sc.performance  || null,
      growthTag: sc.growth      || null,
      profitTag: sc.profitability || null,
      valTag:   sc.valuation    || null,
      inWatchlist: wlTickers.has(s.ticker),
      stage2: tech ? !!tech.stage2  : false,
      vcpPass: tech ? !!tech.vcpPass : false,
      techScore: tech ? (tech.score || 0) : 0,
      // keep only what's needed for DR modal (trim big arrays)
      marketCap: s.marketCap ? Math.round(s.marketCap) : null,
    };
  });

  // Sort: APEX score desc, tiebreak by P1+P2+P3 (fundamentals quality)
  apex.sort((a, b) => b.total !== a.total ? b.total - a.total : (b.p1 + b.p2 + b.p3) - (a.p1 + a.p2 + a.p3));

  const eliteCnt  = apex.filter(s => s.total >= 80).length;
  const strongCnt = apex.filter(s => s.total >= 65).length;
  const convCnt   = apex.filter(s => s.convergence).length;
  const buyCnt    = apex.filter(s => s.action === 'BUY').length;
  console.log(`\nResults: ${apex.length} stocks | ${eliteCnt} Elite | ${strongCnt} Strong | ${convCnt} Convergence | ${buyCnt} BUY signals`);

  if (!fs.existsSync(path.join(__dirname, 'docs'))) fs.mkdirSync(path.join(__dirname, 'docs'));
  fs.writeFileSync(OUTPUT_PATH, buildHtml(apex, Date.now()), 'utf8');
  console.log(`\nSaved → ${OUTPUT_PATH}`);
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });

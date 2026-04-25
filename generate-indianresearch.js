'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const OUTPUT_PATH  = path.join(__dirname, 'docs', 'indian-research.html');
const TECH_BATCH   = 5;
const HISTORY_DAYS = 295;

// ── Filter thresholds ─────────────────────────────────────────────────────────
const F1_MCAP_MIN   = 500;   // ₹Cr – Filter 1A
const F1_MCAP_MAX   = 10000; // ₹Cr – Filter 1A
const F1_ROE_MIN    = 15;    // % – Filter 1B (proxy for ROCE ≥ 20%)
const F1_DE_MAX     = 0.5;   // Filter 1C
const F2_EPS5Y_MIN  = 18;    // % – Filter 2D (EPS 5Y CAGR proxy for 3Y PAT CAGR)
const F2_EBITDA_MIN = 15;    // % – Filter 2E (EBITDA margin proxy for OPM)
const F2_PROMO_MIN  = 50;    // % – Filter 2F
const F3_VOL_MULT   = 3;     // Filter 3H – volume surge multiple

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
        'Origin': 'https://www.tickertape.in', 'Referer': 'https://www.tickertape.in/screener',
        'Accept': 'application/json',
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Fetch all NSE stocks from Tickertape Screener ─────────────────────────────
async function fetchAllStocks() {
  const PAGE = 1000;
  const fields = [
    'ticker', 'name', 'sector', 'mrktCapf', 'lastPrice',
    'roe', 'aopm', 'epsGwth', 'dbtEqt', 'strown', 'strown3',
    'acVol', '52wpct', '26wpct', 'apef', 'pbr',
  ];
  const allStocks = [];
  let offset = 0, total = Infinity;
  while (offset < total) {
    const body = { match: {}, sortBy: 'mrktCapf', sortOrder: -1, project: fields, offset, count: PAGE };
    const r = await apiPost('https://api.tickertape.in/screener/query', body);
    if (!r.success) throw new Error('Screener API failed');
    total = r.data.stats.count;
    const results = r.data.results || [];
    if (!results.length) break;
    for (const item of results) {
      const ar = item.stock?.advancedRatios || {};
      const g = k => ar[k] != null ? ar[k] : null;
      allStocks.push({
        sid:             item.sid,
        ticker:          item.stock?.info?.ticker || '',
        name:            item.stock?.info?.name   || '',
        sector:          ar.sector || item.stock?.info?.sector || '',
        slug:            item.stock?.slug || '',
        marketCap:       g('mrktCapf'),
        price:           g('lastPrice'),
        roe:             g('roe'),
        ebitdaMargin:    g('aopm'),
        epsGrowth5Y:     g('epsGwth'),
        debtEquity:      g('dbtEqt'),
        promoterHolding: g('strown'),
        promoterChg3M:   g('strown3'),
        volume:          g('acVol'),
        ret1Y:           g('52wpct'),
        ret6M:           g('26wpct'),
        pe:              g('apef'),
        pb:              g('pbr'),
      });
    }
    offset += PAGE;
    process.stdout.write(`  Fetched ${allStocks.length}/${total} stocks\r`);
  }
  console.log(`  Fetched ${allStocks.length} total stocks             `);
  return allStocks.filter(s => s.ticker);
}

// ── Filter 1: Quality & Survival Sieve ───────────────────────────────────────
function applyFilter1(stocks) {
  return stocks.filter(s =>
    s.marketCap  != null && s.marketCap  >= F1_MCAP_MIN && s.marketCap <= F1_MCAP_MAX &&
    s.roe        != null && s.roe        >= F1_ROE_MIN &&
    s.debtEquity != null && s.debtEquity <  F1_DE_MAX
  );
}

// ── Filter 2: Growth Engine ───────────────────────────────────────────────────
function applyFilter2(stocks) {
  return stocks.filter(s =>
    s.epsGrowth5Y     != null && s.epsGrowth5Y     >= F2_EPS5Y_MIN &&
    s.ebitdaMargin    != null && s.ebitdaMargin    >= F2_EBITDA_MIN &&
    s.promoterHolding != null && s.promoterHolding >= F2_PROMO_MIN
  );
}

// ── Technical helpers ─────────────────────────────────────────────────────────
function computeEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
function computeSMA(closes, period) {
  const slice = closes.slice(-period);
  if (slice.length < period) return null;
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ── Fetch Yahoo Finance historical for one ticker ─────────────────────────────
async function fetchTechnical(ticker) {
  const period1 = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const period2 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    const rows = await yahooFinance.historical(ticker + '.NS', { period1, period2, interval: '1d' });
    if (!rows || rows.length < 60) return null;
    const bars = rows
      .filter(r => r.close != null && r.volume != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const closes  = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);
    const n = closes.length;
    const ema50    = computeEMA(closes, 50);
    const sma200   = computeSMA(closes, 200);
    const price    = closes[n - 1];
    const todayVol = volumes[n - 1];
    const avgVol20d = n >= 20
      ? volumes.slice(n - 20).reduce((a, b) => a + b, 0) / 20
      : volumes.reduce((a, b) => a + b, 0) / n;
    const volRatio = avgVol20d > 0 ? todayVol / avgVol20d : 0;
    // Filter 3G: price > EMA50 AND EMA50 > SMA200
    const trendOk = ema50 != null && sma200 != null && price > ema50 && ema50 > sma200;
    // Filter 3H: current volume >= 3x 20-day average
    const volOk = volRatio >= F3_VOL_MULT;
    return { ema50, sma200, price, todayVol, avgVol20d, volRatio, trendOk, volOk, bars: n };
  } catch {
    return null;
  }
}

// ── Fetch technical data for the entire fundamental watchlist ─────────────────
async function fetchTechnicalBatch(watchlist) {
  const techMap = new Map();
  for (let i = 0; i < watchlist.length; i += TECH_BATCH) {
    const batch = watchlist.slice(i, i + TECH_BATCH);
    const results = await Promise.all(batch.map(s => fetchTechnical(s.ticker)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) techMap.set(batch[j].ticker, results[j]);
    }
    process.stdout.write(`  Technical: ${Math.min(i + TECH_BATCH, watchlist.length)}/${watchlist.length}\r`);
    if (i + TECH_BATCH < watchlist.length) await sleep(300);
  }
  console.log(`  Technical: ${techMap.size}/${watchlist.length} fetched       `);
  return techMap;
}

// ── HTML helpers (server-side) ────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmt(n, dec = 1) { if (n == null || isNaN(n)) return '—'; return Number(n).toFixed(dec); }
function fmtCr(n) {
  if (n == null) return '—';
  if (n >= 100000) return (n / 100000).toFixed(1) + 'L';
  if (n >= 1000)   return (n / 1000).toFixed(1) + 'K';
  return Math.round(n) + '';
}
function fmtPrice(p) {
  if (p == null) return '—';
  return '₹' + Number(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) { if (n == null || isNaN(n)) return '—'; return (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%'; }

// ── Build HTML ────────────────────────────────────────────────────────────────
function buildHtml(breakouts, watchlist, stats, generatedAt) {
  const genTime = new Date(generatedAt).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
  });

  // Breakout rows — sorted by vol ratio desc
  const bRows = breakouts.length === 0
    ? `<tr><td colspan="9" class="empty-td">No active breakouts today — all watched stocks are awaiting a volume+trend catalyst.</td></tr>`
    : [...breakouts]
        .sort((a, b) => (b.tech?.volRatio || 0) - (a.tech?.volRatio || 0))
        .map((s, i) => {
          const url   = s.slug ? `https://www.tickertape.in/stocks/${esc(s.slug)}` : '#';
          const volX  = s.tech?.volRatio != null ? fmt(s.tech.volRatio, 1) + '×' : '—';
          const volCl = s.tech?.volRatio >= 7 ? 'rd' : 'yw';
          const deCl  = s.debtEquity != null && s.debtEquity < 0.3 ? 'pos' : '';
          return `<tr class="data-row" data-ticker="${esc(s.ticker)}" data-type="breakout">
            <td class="num dim">${i + 1}</td>
            <td><div class="stock-cell"><div><a href="${url}" target="_blank" class="stock-link">${esc(s.name)}</a><div class="ticker-sub">${esc(s.ticker)}&ensp;&middot;&ensp;${esc(s.sector || '—')}</div></div><button class="detail-btn" title="View details">&#x2922;</button></div></td>
            <td class="num">${fmtPrice(s.price)}</td>
            <td class="num ${volCl}" style="font-weight:700">${volX}</td>
            <td class="num">₹${fmtCr(s.marketCap)}&thinsp;Cr</td>
            <td class="num pos">${fmt(s.roe)}%</td>
            <td class="num pos">${fmt(s.epsGrowth5Y)}%</td>
            <td class="num ${deCl}">${fmt(s.debtEquity, 2)}</td>
            <td class="num">${fmt(s.promoterHolding)}%</td>
          </tr>`;
        }).join('');

  // Watchlist rows — sorted by ROE desc
  const wRows = watchlist.length === 0
    ? `<tr><td colspan="9" class="empty-td">No stocks currently in the fundamental watchlist.</td></tr>`
    : [...watchlist]
        .sort((a, b) => (b.roe || 0) - (a.roe || 0))
        .map((s, i) => {
          const url  = s.slug ? `https://www.tickertape.in/stocks/${esc(s.slug)}` : '#';
          const deCl = s.debtEquity != null && s.debtEquity < 0.3 ? 'pos' : '';
          const retCl = s.ret1Y != null ? (s.ret1Y >= 0 ? 'pos' : 'neg') : '';
          return `<tr class="data-row" data-ticker="${esc(s.ticker)}" data-type="watchlist">
            <td class="num dim">${i + 1}</td>
            <td><div class="stock-cell"><div><a href="${url}" target="_blank" class="stock-link">${esc(s.name)}</a><div class="ticker-sub">${esc(s.ticker)}&ensp;&middot;&ensp;${esc(s.sector || '—')}</div><span class="await-badge">&#x23F3; Awaiting Breakout</span></div><button class="detail-btn" title="View details">&#x2922;</button></div></td>
            <td class="num">${fmtPrice(s.price)}</td>
            <td class="num">₹${fmtCr(s.marketCap)}&thinsp;Cr</td>
            <td class="num pos">${fmt(s.roe)}%</td>
            <td class="num pos">${fmt(s.epsGrowth5Y)}%</td>
            <td class="num ${deCl}">${fmt(s.debtEquity, 2)}</td>
            <td class="num">${fmt(s.promoterHolding)}%</td>
            <td class="num ${retCl}">${fmtPct(s.ret1Y)}</td>
          </tr>`;
        }).join('');

  const pageData = JSON.stringify({
    breakouts: breakouts.map(s => ({
      ticker: s.ticker, name: s.name, sector: s.sector, slug: s.slug,
      price: s.price, marketCap: s.marketCap,
      roe: s.roe, ebitdaMargin: s.ebitdaMargin, epsGrowth5Y: s.epsGrowth5Y,
      debtEquity: s.debtEquity, promoterHolding: s.promoterHolding,
      pe: s.pe, ret1Y: s.ret1Y, ret6M: s.ret6M,
      ema50: s.tech?.ema50, sma200: s.tech?.sma200,
      volRatio: s.tech?.volRatio, todayVol: s.tech?.todayVol, avgVol20d: s.tech?.avgVol20d,
    })),
    watchlist: watchlist.map(s => ({
      ticker: s.ticker, name: s.name, sector: s.sector, slug: s.slug,
      price: s.price, marketCap: s.marketCap,
      roe: s.roe, ebitdaMargin: s.ebitdaMargin, epsGrowth5Y: s.epsGrowth5Y,
      debtEquity: s.debtEquity, promoterHolding: s.promoterHolding,
      pe: s.pe, ret1Y: s.ret1Y, ret6M: s.ret6M,
    })),
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>India Research &middot; Hybrid Multibagger Screener</title>
<script>(function(){var s=localStorage.getItem('ir-theme');document.documentElement.setAttribute('data-theme',s||'dark');})();<\/script>
<style>
:root,html[data-theme="dark"]{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#f97316;--tx:#e8e8f0;--t2:#9898b0;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7;--tl:#06b6d4;--hdr-bg:linear-gradient(135deg,#180e06,#12121a);--shadow:0 8px 24px rgba(0,0,0,.4);--row-hover:rgba(249,115,22,.05);--card-border:rgba(42,42,56,.5)}
html[data-theme="light"]{--bg:#f8f9fc;--s1:#fff;--s2:#fff;--s3:#eef0f5;--bd:#d5d8e0;--ac:#ea580c;--tx:#1e1e32;--t2:#44495e;--t3:#6b7188;--gn:#15803d;--rd:#b91c1c;--yw:#a16207;--bl:#1d4ed8;--pp:#6d28d9;--tl:#0e7490;--hdr-bg:linear-gradient(135deg,#fff5ee,#eaecf2);--shadow:0 4px 16px rgba(0,0,0,.07);--row-hover:rgba(234,88,12,.04);--card-border:rgba(0,0,0,.08)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);line-height:1.55;transition:background .3s,color .3s}
/* ── Header ── */
.header{background:var(--hdr-bg);border-bottom:1px solid var(--bd);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.3rem;font-weight:700;background:linear-gradient(90deg,var(--ac),#fb923c);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.header .subtitle{font-size:.73rem;color:var(--t2);margin-top:3px}
.header-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.back-link{color:var(--t2);text-decoration:none;font-size:.79rem;padding:6px 12px;border:1px solid var(--bd);border-radius:6px;transition:all .2s;white-space:nowrap}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
.theme-toggle{width:40px;height:22px;border-radius:11px;border:1px solid var(--bd);background:var(--s3);cursor:pointer;position:relative;transition:all .3s;flex-shrink:0}
.theme-toggle::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--ac);transition:transform .3s}
html[data-theme="light"] .theme-toggle::after{transform:translateX(18px)}
/* ── Pipeline bar ── */
.pipeline{display:flex;align-items:center;padding:12px 24px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap;gap:0;overflow-x:auto;transition:background .3s}
.pipe-step{display:flex;flex-direction:column;align-items:center;padding:10px 22px;position:relative;min-width:110px}
.pipe-step:not(:last-child)::after{content:'▶';position:absolute;right:-10px;top:50%;transform:translateY(-50%);color:var(--t3);font-size:.75rem;z-index:1}
.pipe-step .ps-count{font-size:1.55rem;font-weight:800;line-height:1.15}
.pipe-step .ps-label{font-size:.66rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-top:4px;text-align:center;line-height:1.4}
.pipe-step.ps-total  .ps-count{color:var(--t2)}
.pipe-step.ps-f1     .ps-count{color:var(--yw)}
.pipe-step.ps-f2     .ps-count{color:var(--bl)}
.pipe-step.ps-active .ps-count{color:var(--gn)}
/* ── Tabs ── */
.tabs{display:flex;gap:6px;padding:14px 24px 0;background:var(--s1);border-bottom:1px solid var(--bd)}
.tab-btn{padding:9px 18px;border:1px solid var(--bd);border-bottom:none;border-radius:8px 8px 0 0;background:var(--s2);color:var(--t2);cursor:pointer;font-size:.84rem;font-family:inherit;font-weight:500;transition:all .2s;margin-bottom:-1px;display:flex;align-items:center;gap:6px}
.tab-btn.active{background:var(--bg);color:var(--tx);border-color:var(--bd);border-bottom:1px solid var(--bg);font-weight:700}
.tab-count{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;border-radius:10px;font-size:.68rem;font-weight:700;padding:0 6px;background:var(--s3);color:var(--t2);transition:background .2s,color .2s}
.tab-btn.active .tab-count{background:var(--ac);color:#fff}
/* ── Controls bar ── */
.controls-bar{display:flex;gap:10px;padding:12px 24px;background:var(--bg);border-bottom:1px solid var(--bd);align-items:center;flex-wrap:wrap;transition:background .3s}
.search-box{padding:7px 12px;border-radius:7px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.85rem;font-family:inherit;outline:none;width:220px;transition:border .2s,background .3s}
.search-box:focus{border-color:var(--ac)}
.ctrl-note{font-size:.76rem;color:var(--t2);margin-left:auto}
/* ── Table ── */
.table-wrap{padding:0 24px 28px;overflow-x:auto}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:.83rem;margin-top:14px}
thead{position:sticky;top:62px;z-index:10}
th{background:var(--s1);color:var(--ac);font-weight:700;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;padding:11px 12px;text-align:left;border-bottom:2px solid var(--bd);cursor:pointer;white-space:nowrap;user-select:none;transition:color .2s,background .3s}
th:hover{color:var(--tx)}
th .arr{margin-left:3px;opacity:.4;font-size:.6rem}
th.sorted .arr{opacity:1}
td{padding:10px 12px;border-bottom:1px solid var(--card-border);white-space:nowrap;vertical-align:middle;transition:background .15s}
tr:hover td{background:var(--row-hover)}
.stock-cell{display:flex;align-items:flex-start;gap:8px}
.stock-link{color:var(--tx);text-decoration:none;font-weight:600;font-size:.87rem;display:block}
.stock-link:hover{color:var(--ac)}
.ticker-sub{color:var(--t2);font-size:.71rem;margin-top:1px}
.await-badge{display:inline-block;padding:2px 7px;border-radius:5px;font-size:.66rem;font-weight:600;background:rgba(59,130,246,.12);color:var(--bl);border:1px solid rgba(59,130,246,.25);margin-top:4px}
.detail-btn{background:none;border:1px solid var(--bd);border-radius:5px;cursor:pointer;padding:3px 7px;font-size:.8rem;color:var(--t3);transition:all .15s;flex-shrink:0;margin-top:2px;line-height:1}
.detail-btn:hover{color:var(--ac);border-color:var(--ac)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--gn)}.neg{color:var(--rd)}.yw{color:var(--yw)}.rd{color:var(--rd)}.dim{color:var(--t3)}
.empty-td{text-align:center;padding:44px;color:var(--t2);font-style:italic}
.hidden{display:none!important}
/* ── Modal ── */
#modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9900;overflow-y:auto;padding:20px 12px}
#modal-overlay.open{display:block}
#modal-box{background:var(--s2);border:1px solid var(--bd);border-radius:14px;width:100%;max-width:680px;margin:20px auto;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.6);overflow:hidden;transition:background .3s}
.modal-header{display:flex;justify-content:space-between;align-items:flex-start;padding:20px 22px 16px;border-bottom:1px solid var(--bd)}
.mh-title{font-size:1.05rem;font-weight:700}
.mh-sub{font-size:.73rem;color:var(--t2);margin-top:3px}
#modal-close{background:none;border:none;cursor:pointer;color:var(--t3);font-size:1.25rem;padding:2px;line-height:1;flex-shrink:0}
.modal-body{padding:20px 22px}
.modal-section{margin-bottom:20px}
.ms-title{font-size:.63rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ac);font-weight:700;margin-bottom:10px}
.filter-checks{display:flex;flex-direction:column;gap:6px}
.fc-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;font-size:.81rem}
.fc-pass{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2)}
.fc-fail{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18)}
.fc-icon{font-size:.9rem;flex-shrink:0}
.fc-label{flex:1;font-weight:500}
.fc-val{font-size:.78rem;color:var(--t3);text-align:right;white-space:nowrap}
.metrics-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.metric-card{background:var(--s1);border:1px solid var(--bd);border-radius:8px;padding:10px 12px;text-align:center;transition:background .3s}
.metric-card .mc-val{font-size:.94rem;font-weight:700;margin-bottom:3px}
.metric-card .mc-lbl{font-size:.62rem;color:var(--t2);text-transform:uppercase;letter-spacing:.04em}
#tv-chart-wrap{height:350px;background:var(--s3);border-radius:8px;overflow:hidden}
.tv-link{font-size:.72rem;color:var(--t3);display:block;text-align:right;margin-top:5px}
.tv-link a{color:var(--ac);text-decoration:none}
.tv-link a:hover{text-decoration:underline}
/* ── Footer ── */
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.73rem;border-top:1px solid var(--bd);line-height:1.9;transition:background .3s}
/* ── Responsive ── */
@media(max-width:768px){
  .header{padding:12px 14px}.header h1{font-size:1.05rem}
  .header-right{gap:5px}
  .back-link{font-size:.69rem;padding:4px 8px}
  .pipeline{padding:10px 14px}
  .pipe-step{min-width:80px;padding:8px 10px}.pipe-step .ps-count{font-size:1.2rem}
  .tabs{padding:10px 14px 0;gap:4px}.tab-btn{padding:7px 12px;font-size:.78rem}
  .controls-bar{padding:10px 14px}
  .search-box{width:100%;font-size:16px}
  .table-wrap{padding:0 8px 16px}
  td,th{padding:8px 8px;font-size:.78rem}
  #modal-overlay{padding:0}
  #modal-box{border-radius:0;min-height:100dvh;margin:0;max-width:100%}
  .metrics-grid{grid-template-columns:repeat(2,1fr)}
}
</style>
</head>
<body>

<!-- ── Header ── -->
<div class="header">
  <div>
    <h1>&#x1F1EE;&#x1F1F3; India Research &middot; Hybrid Screener</h1>
    <div class="subtitle">3-phase algorithm: Quality Sieve &rarr; Growth Engine &rarr; Technical Catalyst &nbsp;&middot;&nbsp; Full NSE Universe &nbsp;&middot;&nbsp; <span style="color:var(--ac)">Generated: ${genTime} IST</span></div>
  </div>
  <div class="header-right">
    <button class="theme-toggle" id="theme-toggle" title="Toggle theme"></button>
    <a href="alerts.html"          class="back-link" style="color:var(--yw);border-color:rgba(234,179,8,.4)">&#x1F514; Alerts</a>
    <a href="potential.html"       class="back-link" style="color:#a855f7;border-color:rgba(168,85,247,.4)">&#x1F31F; Potential</a>
    <a href="multibagger.html"     class="back-link" style="color:#f59e0b;border-color:rgba(245,158,11,.4)">&#x1F3C6; Multibagger</a>
    <a href="breakout2.html"       class="back-link" style="color:#06b6d4;border-color:rgba(6,182,212,.4)">&#x26A1; Breakout GEN2</a>
    <a href="breakout.html"        class="back-link">Breakout VCP</a>
    <a href="apex.html"            class="back-link" style="color:#6366f1;border-color:rgba(99,102,241,.4)">&#x1F52E; APEX</a>
    <a href="creamy.html"          class="back-link">Creamy Layer</a>
    <a href="trades.html"          class="back-link" style="color:#22c55e;border-color:rgba(34,197,94,.4)">&#x1F4C8; Trades</a>
    <a href="sectors.html"         class="back-link" style="color:#f97316;border-color:rgba(249,115,22,.4)">&#x1F4CA; Sectors</a>
    <a href="index.html"           class="back-link">My Watchlist</a>
  </div>
</div>

<!-- ── Pipeline stats ── -->
<div class="pipeline">
  <div class="pipe-step ps-total">
    <div class="ps-count">${stats.total.toLocaleString('en-IN')}</div>
    <div class="ps-label">NSE Universe</div>
  </div>
  <div class="pipe-step ps-f1">
    <div class="ps-count">${stats.f1Pass}</div>
    <div class="ps-label">Filter 1 Pass<br><span style="color:var(--t3);font-size:.58rem">MCap &middot; ROE &middot; D/E</span></div>
  </div>
  <div class="pipe-step ps-f2">
    <div class="ps-count">${stats.f2Pass}</div>
    <div class="ps-label">Filter 2 Pass<br><span style="color:var(--t3);font-size:.58rem">EPS Growth &middot; Margin &middot; Promoter</span></div>
  </div>
  <div class="pipe-step ps-active">
    <div class="ps-count">${breakouts.length}</div>
    <div class="ps-label">Active Breakouts<br><span style="color:var(--t3);font-size:.58rem">EMA50 trend &middot; Volume surge</span></div>
  </div>
</div>

<!-- ── Tabs ── -->
<div class="tabs">
  <button class="tab-btn active" id="tab-btn-breakouts" onclick="switchTab('breakouts')">
    &#x1F525; Active Breakouts <span class="tab-count" id="cnt-breakouts">${breakouts.length}</span>
  </button>
  <button class="tab-btn" id="tab-btn-watchlist" onclick="switchTab('watchlist')">
    &#x1F4CB; Fundamental Watchlist <span class="tab-count" id="cnt-watchlist">${watchlist.length}</span>
  </button>
</div>

<!-- ── Breakouts tab ── -->
<div id="tab-breakouts">
  <div class="controls-bar">
    <input type="text" class="search-box" id="search-breakouts" placeholder="Search ticker or name&hellip;" oninput="filterTable('breakouts')">
    <span class="ctrl-note">${breakouts.length === 0 ? 'No breakouts today — check back tomorrow' : `${breakouts.length} stock${breakouts.length !== 1 ? 's' : ''} passed all 3 filters`}</span>
  </div>
  <div class="table-wrap">
    <table id="tbl-breakouts">
      <thead><tr>
        <th class="num" onclick="sortTable('breakouts',0,true)"># <span class="arr">&#x2195;</span></th>
        <th onclick="sortTable('breakouts',1,false)">Stock <span class="arr">&#x2195;</span></th>
        <th class="num" onclick="sortTable('breakouts',2,true)">Price <span class="arr">&#x2195;</span></th>
        <th class="num sorted" onclick="sortTable('breakouts',3,true)">Vol / 20d Avg <span class="arr">&#x2193;</span></th>
        <th class="num" onclick="sortTable('breakouts',4,true)">Market Cap <span class="arr">&#x2195;</span></th>
        <th class="num" onclick="sortTable('breakouts',5,true)">ROE % <span class="arr">&#x2195;</span></th>
        <th class="num" onclick="sortTable('breakouts',6,true)">EPS 5Y CAGR <span class="arr">&#x2195;</span></th>
        <th class="num" onclick="sortTable('breakouts',7,true)">D/E <span class="arr">&#x2195;</span></th>
        <th class="num" onclick="sortTable('breakouts',8,true)">Promoter % <span class="arr">&#x2195;</span></th>
      </tr></thead>
      <tbody id="tbody-breakouts">${bRows}</tbody>
    </table>
  </div>
</div>

<!-- ── Watchlist tab ── -->
<div id="tab-watchlist" class="hidden">
  <div class="controls-bar">
    <input type="text" class="search-box" id="search-watchlist" placeholder="Search ticker or name&hellip;" oninput="filterTable('watchlist')">
    <span class="ctrl-note">${watchlist.length} stock${watchlist.length !== 1 ? 's' : ''} awaiting technical trigger</span>
  </div>
  <div class="table-wrap">
    <table id="tbl-watchlist">
      <thead><tr>
        <th class="num" onclick="sortTable('watchlist',0,true)"># <span class="arr">&#x2195;</span></th>
        <th onclick="sortTable('watchlist',1,false)">Stock <span class="arr">&#x2195;</span></th>
        <th class="num" onclick="sortTable('watchlist',2,true)">Price <span class="arr">&#x2195;</span></th>
        <th class="num" onclick="sortTable('watchlist',3,true)">Market Cap <span class="arr">&#x2195;</span></th>
        <th class="num sorted" onclick="sortTable('watchlist',4,true)">ROE % <span class="arr">&#x2193;</span></th>
        <th class="num" onclick="sortTable('watchlist',5,true)">EPS 5Y CAGR <span class="arr">&#x2195;</span></th>
        <th class="num" onclick="sortTable('watchlist',6,true)">D/E <span class="arr">&#x2195;</span></th>
        <th class="num" onclick="sortTable('watchlist',7,true)">Promoter % <span class="arr">&#x2195;</span></th>
        <th class="num" onclick="sortTable('watchlist',8,true)">1Y Return <span class="arr">&#x2195;</span></th>
      </tr></thead>
      <tbody id="tbody-watchlist">${wRows}</tbody>
    </table>
  </div>
</div>

<!-- ── Stock detail modal ── -->
<div id="modal-overlay">
  <div id="modal-box">
    <div class="modal-header">
      <div>
        <div class="mh-title" id="modal-title">Stock Details</div>
        <div class="mh-sub" id="modal-sub"></div>
      </div>
      <button id="modal-close" onclick="closeModal()">&#x2715;</button>
    </div>
    <div class="modal-body">
      <div class="modal-section">
        <div class="ms-title">Algorithm Filter Checklist</div>
        <div class="filter-checks" id="modal-checks"></div>
      </div>
      <div class="modal-section">
        <div class="ms-title">Key Metrics</div>
        <div class="metrics-grid" id="modal-metrics"></div>
      </div>
      <div class="modal-section">
        <div class="ms-title">Chart &nbsp;<span style="color:var(--t3);font-size:.65rem;text-transform:none;font-weight:400">(EMA 50 &amp; SMA 200 via TradingView)</span></div>
        <div id="tv-chart-wrap"></div>
        <div class="tv-link">Open full chart: <a href="#" id="tv-link-out" target="_blank" rel="noopener">TradingView &#x2197;</a></div>
      </div>
    </div>
  </div>
</div>

<div class="footer">
  &#x1F1EE;&#x1F1F3; India Research &middot; Hybrid Multibagger Screener &nbsp;&middot;&nbsp;
  Generated: ${genTime} IST &nbsp;&middot;&nbsp;
  Data: Tickertape Screener API + Yahoo Finance &nbsp;&middot;&nbsp;
  <strong>Not investment advice. Do your own research.</strong>
</div>

<script src="https://s3.tradingview.com/tv.js"><\/script>
<script>
var DATA = ${pageData};

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  ['breakouts','watchlist'].forEach(function(t) {
    document.getElementById('tab-' + t).classList.toggle('hidden', t !== tab);
    document.getElementById('tab-btn-' + t).classList.toggle('active', t === tab);
  });
}

// ── Search filter ─────────────────────────────────────────────────────────────
function filterTable(tab) {
  var q = (document.getElementById('search-' + tab).value || '').toLowerCase();
  document.getElementById('tbody-' + tab).querySelectorAll('tr').forEach(function(row) {
    row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

// ── Table sort ────────────────────────────────────────────────────────────────
var sortState = { breakouts: { col: 3, asc: false }, watchlist: { col: 4, asc: false } };
function sortTable(tab, col, numeric) {
  var ss = sortState[tab];
  ss.asc = (ss.col === col) ? !ss.asc : false;
  ss.col = col;
  var tbody = document.getElementById('tbody-' + tab);
  var rows = Array.from(tbody.querySelectorAll('tr.data-row'));
  rows.sort(function(a, b) {
    var ac = (a.cells[col] ? a.cells[col].textContent : '').replace(/[₹,×%+\\s]/g, '').trim();
    var bc = (b.cells[col] ? b.cells[col].textContent : '').replace(/[₹,×%+\\s]/g, '').trim();
    if (numeric) { var an = parseFloat(ac) || 0, bn = parseFloat(bc) || 0; return ss.asc ? an - bn : bn - an; }
    return ss.asc ? ac.localeCompare(bc) : bc.localeCompare(ac);
  });
  rows.forEach(function(r) { tbody.appendChild(r); });
  // Reset rank numbers
  rows.forEach(function(r, i) { if (r.cells[0]) r.cells[0].textContent = i + 1; });
  var ths = document.getElementById('tbl-' + tab).querySelectorAll('th');
  ths.forEach(function(th, i) {
    th.classList.toggle('sorted', i === col);
    var arr = th.querySelector('.arr');
    if (arr) arr.innerHTML = (i === col) ? (ss.asc ? '&#x2191;' : '&#x2193;') : '&#x2195;';
  });
}

// ── Number formatters (client-side) ──────────────────────────────────────────
function fmt1(n) { return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(1); }
function fmt2(n) { return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(2); }
function fmtCr(n) {
  if (n == null) return '—';
  if (n >= 100000) return (n / 100000).toFixed(1) + 'L';
  if (n >= 1000)   return (n / 1000).toFixed(1) + 'K';
  return Math.round(n) + '';
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(ticker, type) {
  var list  = (type === 'breakout') ? DATA.breakouts : DATA.watchlist;
  var s     = list.find(function(x) { return x.ticker === ticker; });
  if (!s) return;
  var theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

  document.getElementById('modal-title').textContent = s.name;
  document.getElementById('modal-sub').textContent   = s.ticker + ' \u00b7 ' + (s.sector || '') + (type === 'breakout' ? ' \u00b7 \uD83D\uDD25 Active Breakout' : ' \u00b7 \u23F3 Awaiting Breakout');
  document.getElementById('tv-link-out').href = 'https://www.tradingview.com/chart/?symbol=NSE:' + s.ticker;

  // Filter checklist
  var checks = [];
  var mcOk   = s.marketCap != null && s.marketCap >= ${F1_MCAP_MIN} && s.marketCap <= ${F1_MCAP_MAX};
  checks.push({ label: 'Market Cap \u20b9${F1_MCAP_MIN}\u2013${F1_MCAP_MAX}\u00a0Cr', pass: mcOk, val: s.marketCap != null ? '\u20b9' + fmtCr(s.marketCap) + '\u00a0Cr' : '\u2014' });
  var roeOk  = s.roe != null && s.roe >= ${F1_ROE_MIN};
  checks.push({ label: 'ROE \u2265 ${F1_ROE_MIN}% (quality proxy)', pass: roeOk, val: s.roe != null ? fmt1(s.roe) + '%' : '\u2014' });
  var deOk   = s.debtEquity != null && s.debtEquity < ${F1_DE_MAX};
  checks.push({ label: 'Debt/Equity < ${F1_DE_MAX}', pass: deOk, val: s.debtEquity != null ? fmt2(s.debtEquity) : '\u2014' });
  var epsOk  = s.epsGrowth5Y != null && s.epsGrowth5Y >= ${F2_EPS5Y_MIN};
  checks.push({ label: 'EPS 5Y CAGR \u2265 ${F2_EPS5Y_MIN}% (growth proxy)', pass: epsOk, val: s.epsGrowth5Y != null ? fmt1(s.epsGrowth5Y) + '%' : '\u2014' });
  var ebitOk = s.ebitdaMargin != null && s.ebitdaMargin >= ${F2_EBITDA_MIN};
  checks.push({ label: 'EBITDA Margin \u2265 ${F2_EBITDA_MIN}% (OPM proxy)', pass: ebitOk, val: s.ebitdaMargin != null ? fmt1(s.ebitdaMargin) + '%' : '\u2014' });
  var promoOk = s.promoterHolding != null && s.promoterHolding >= ${F2_PROMO_MIN};
  checks.push({ label: 'Promoter Holding \u2265 ${F2_PROMO_MIN}%', pass: promoOk, val: s.promoterHolding != null ? fmt1(s.promoterHolding) + '%' : '\u2014' });
  if (type === 'breakout') {
    var trendOk = s.ema50 != null && s.sma200 != null && s.price > s.ema50 && s.ema50 > s.sma200;
    checks.push({ label: 'Price > EMA\u202f50 > SMA\u202f200', pass: trendOk, val: s.ema50 ? 'EMA\u202f\u20b9' + fmt1(s.ema50) + ' / SMA\u202f\u20b9' + fmt1(s.sma200) : '\u2014' });
    var volOk = s.volRatio != null && s.volRatio >= ${F3_VOL_MULT};
    checks.push({ label: 'Volume \u2265 ${F3_VOL_MULT}\u00d7 20-day Average', pass: volOk, val: s.volRatio != null ? fmt1(s.volRatio) + '\u00d7 avg' : '\u2014' });
  }
  document.getElementById('modal-checks').innerHTML = checks.map(function(c) {
    return '<div class="fc-item ' + (c.pass ? 'fc-pass' : 'fc-fail') + '">' +
      '<span class="fc-icon">' + (c.pass ? '\u2705' : '\u274C') + '</span>' +
      '<span class="fc-label">' + c.label + '</span>' +
      '<span class="fc-val">' + c.val + '</span></div>';
  }).join('');

  // Metrics grid
  var mets = [
    { val: s.price != null ? '\u20b9' + Number(s.price).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '\u2014', lbl: 'Price' },
    { val: s.marketCap != null ? '\u20b9' + fmtCr(s.marketCap) + '\u00a0Cr' : '\u2014', lbl: 'Market Cap' },
    { val: s.roe != null ? fmt1(s.roe) + '%' : '\u2014', lbl: 'ROE' },
    { val: s.epsGrowth5Y != null ? fmt1(s.epsGrowth5Y) + '%' : '\u2014', lbl: 'EPS 5Y CAGR' },
    { val: s.ebitdaMargin != null ? fmt1(s.ebitdaMargin) + '%' : '\u2014', lbl: 'EBITDA Margin' },
    { val: s.debtEquity != null ? fmt2(s.debtEquity) : '\u2014', lbl: 'Debt / Equity' },
    { val: s.promoterHolding != null ? fmt1(s.promoterHolding) + '%' : '\u2014', lbl: 'Promoter' },
    { val: s.pe != null ? fmt1(s.pe) + '\u00d7' : '\u2014', lbl: 'P/E' },
    { val: s.ret1Y != null ? (s.ret1Y >= 0 ? '+' : '') + fmt1(s.ret1Y) + '%' : '\u2014', lbl: '1Y Return' },
  ];
  document.getElementById('modal-metrics').innerHTML = mets.map(function(m) {
    return '<div class="metric-card"><div class="mc-val">' + m.val + '</div><div class="mc-lbl">' + m.lbl + '</div></div>';
  }).join('');

  // TradingView chart
  var wrap = document.getElementById('tv-chart-wrap');
  wrap.innerHTML = '<div id="tv-chart-inner" style="height:350px"></div>';
  try {
    if (typeof TradingView !== 'undefined') {
      new TradingView.widget({
        container_id: 'tv-chart-inner',
        autosize: false, width: '100%', height: 350,
        symbol: 'NSE:' + s.ticker,
        interval: 'D', timezone: 'Asia/Kolkata',
        theme: theme, style: '1', locale: 'in',
        enable_publishing: false, hide_top_toolbar: false,
        save_image: false, allow_symbol_change: false,
        studies: ['MAExp@tv-basicstudies', 'MASimple@tv-basicstudies'],
      });
    } else {
      wrap.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--t2);font-size:.84rem;flex-direction:column;gap:8px"><span>Chart not available (TradingView blocked)</span><a href="https://www.tradingview.com/chart/?symbol=NSE:' + s.ticker + '" target="_blank" rel="noopener" style="color:var(--ac)">Open on TradingView \u2197</a></div>';
    }
  } catch(e) {
    wrap.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--t2);font-size:.84rem">Chart error. <a href="https://www.tradingview.com/chart/?symbol=NSE:' + s.ticker + '" target="_blank" rel="noopener" style="color:var(--ac);margin-left:6px">Open on TradingView \u2197</a></div>';
  }

  document.getElementById('modal-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
  document.getElementById('tv-chart-wrap').innerHTML = ''; // free memory
}

// Close on backdrop click
document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
// Close on Escape
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

// Detail button delegation
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.detail-btn');
  if (!btn) return;
  var row = btn.closest('tr');
  if (row) openModal(row.dataset.ticker, row.dataset.type);
});

// ── Theme toggle ──────────────────────────────────────────────────────────────
document.getElementById('theme-toggle').addEventListener('click', function() {
  var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('ir-theme', next);
});
<\/script>
</body>
</html>`;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n\uD83C\uDDEE\uD83C\uDDF3  India Research \u00b7 Hybrid Multibagger Screener');
  console.log('\u2500'.repeat(52));

  console.log('\n[1/5] Fetching NSE universe from Tickertape Screener\u2026');
  const allStocks = await fetchAllStocks();

  console.log('\n[2/5] Applying Filter 1 \u2014 Quality & Survival Sieve\u2026');
  const f1 = applyFilter1(allStocks);
  console.log(`  MCap \u20b9${F1_MCAP_MIN}\u2013${F1_MCAP_MAX}Cr + ROE \u2265${F1_ROE_MIN}% + D/E <${F1_DE_MAX}: ${allStocks.length} \u2192 ${f1.length} stocks`);

  console.log('\n[3/5] Applying Filter 2 \u2014 Growth Engine\u2026');
  const f2 = applyFilter2(f1);
  console.log(`  EPS5Y \u2265${F2_EPS5Y_MIN}% + EBITDA \u2265${F2_EBITDA_MIN}% + Promoter \u2265${F2_PROMO_MIN}%: ${f1.length} \u2192 ${f2.length} stocks (Fundamental Watchlist)`);

  const stats = { total: allStocks.length, f1Pass: f1.length, f2Pass: f2.length };

  console.log(`\n[4/5] Fetching technical data for ${f2.length} watchlist stocks\u2026`);
  const techMap = await fetchTechnicalBatch(f2);

  console.log('\n[5/5] Applying Filter 3 \u2014 Technical Catalyst + generating HTML\u2026');
  const breakouts = [], watchlist = [];
  for (const s of f2) {
    const tech = techMap.get(s.ticker);
    if (tech && tech.trendOk && tech.volOk) breakouts.push({ ...s, tech });
    else watchlist.push({ ...s, tech: tech || null });
  }
  console.log(`  Active Breakouts (all 3 filters): ${breakouts.length}`);
  console.log(`  Awaiting Breakout (Filters 1+2):  ${watchlist.length}`);

  const html = buildHtml(breakouts, watchlist, stats, Date.now());
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  console.log(`\n  \u2705  Written: ${OUTPUT_PATH}`);
  console.log('\nDone.\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

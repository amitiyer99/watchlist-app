'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'docs', 'multibagger.html');
const CONCURRENCY = 50;

function apiPostOnce(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://www.tickertape.in',
        'Referer': 'https://www.tickertape.in/screener',
        'Accept': 'application/json',
      }
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

async function fetchAllStocks() {
  const PAGE = 1000;
  const allStocks = [];
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
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const body = { match: {}, sortBy: 'mrktCapf', sortOrder: -1, project: fields, offset, count: PAGE };
    const r = await apiPost('https://api.tickertape.in/screener/query', body);
    if (!r.success) throw new Error('Screener API failed');
    total = r.data.stats.count;
    const results = r.data.results || [];
    if (results.length === 0) break;
    for (const item of results) {
      const ar = item.stock?.advancedRatios || {};
      const g = k => ar[k] != null ? ar[k] : null;
      allStocks.push({
        sid: item.sid,
        ticker: item.stock?.info?.ticker || '',
        name: item.stock?.info?.name || '',
        sector: ar.sector || item.stock?.info?.sector || '',
        slug: item.stock?.slug || '',
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
    offset += PAGE;
    process.stdout.write(`  Fetched ${allStocks.length}/${total} stocks from screener\r`);
  }
  console.log(`  Fetched ${allStocks.length} stocks total       `);
  return allStocks;
}

async function fetchScorecardBatch(sids) {
  return Promise.all(sids.map(async sid => {
    try {
      const r = await apiGet(`https://analyze.api.tickertape.in/stocks/scorecard/${sid}`);
      if (!r.success || !r.data) return { sid, tags: {} };
      const tags = {};
      for (const item of r.data) {
        const key = (item.name || '').toLowerCase();
        if (['performance', 'growth', 'profitability', 'valuation'].includes(key)) {
          tags[key] = { tag: item.tag, desc: item.description || '' };
        }
      }
      return { sid, tags };
    } catch {
      return { sid, tags: {} };
    }
  }));
}

async function fetchAllScorecards(stocks) {
  const scorecards = {};
  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY).map(s => s.sid);
    const results = await fetchScorecardBatch(batch);
    for (const r of results) scorecards[r.sid] = r.tags;
    const pct = ((i + batch.length) / stocks.length * 100).toFixed(1);
    process.stdout.write(`  Scorecards: ${i + batch.length}/${stocks.length} (${pct}%)\r`);
  }
  console.log(`  Scorecards: ${stocks.length}/${stocks.length} (100%)       `);
  return scorecards;
}

// ─────── MBF Score v3 — 6-Factor Algorithm (0–100) ───────
function calcMbfScore(s, rsRank) {
  const mcapCr = s.marketCap;
  const isBanking = !!(s.sector && /bank|finance|nbfc/i.test(s.sector));

  // Factor 1: EARNINGS ENGINE (0–25)
  // [A] 5Y EPS CAGR
  const A = s.epsGwth5Y != null
    ? (s.epsGwth5Y >= 25 ? 9 : s.epsGwth5Y >= 20 ? 7 : s.epsGwth5Y >= 15 ? 5 : s.epsGwth5Y >= 10 ? 2 : 0)
    : 0;
  // [B] 5Y Revenue CAGR
  const B = s.revGrowth5Y != null
    ? (s.revGrowth5Y >= 20 ? 6 : s.revGrowth5Y >= 15 ? 4 : s.revGrowth5Y >= 10 ? 2 : 0)
    : 0;
  // [C] Earnings Acceleration (1Y EPS growth vs 5Y CAGR)
  let C = 0;
  if (s.epsGrowth != null && s.epsGwth5Y != null && s.epsGwth5Y > 0) {
    const ratio = s.epsGrowth / s.epsGwth5Y;
    if (ratio >= 2 && s.epsGrowth > 20) C = 10;
    else if (ratio >= 1.5 && s.epsGrowth > 15) C = 7;
    else if (ratio >= 1.2) C = 4;
    else if (ratio < 0.5 || s.epsGrowth < 0) C = 0;
    else C = 2;
  } else if (s.epsGrowth != null) {
    C = s.epsGrowth > 40 ? 7 : s.epsGrowth > 25 ? 4 : s.epsGrowth > 15 ? 2 : 0;
  }
  // Accruals penalty: strong reported EPS growth but negative free cash flow → earnings not cash-backed
  const accrualsPenalty = (s.epsGrowth != null && s.epsGrowth > 20 && s.fcf != null && s.fcf <= 0) ? 5 : 0;
  const factor1 = Math.max(-5, A + B + C - accrualsPenalty);

  // Factor 2: CAPITAL QUALITY (0–20)
  // [D] ROE
  const D = s.roe != null
    ? (s.roe >= 25 ? 8 : s.roe >= 20 ? 6 : s.roe >= 15 ? 4 : s.roe >= 10 ? 1 : 0)
    : 0;
  // [E] FCF Yield (FCF in Cr / MCap in Cr)
  let E = 0;
  if (s.fcf != null && mcapCr != null && mcapCr > 0) {
    const fcfYield = (s.fcf / mcapCr) * 100;
    E = fcfYield > 5 ? 8 : fcfYield > 2 ? 6 : s.fcf > 0 ? 4 : 0;
  } else if (s.fcf != null) {
    E = s.fcf > 0 ? 4 : 0;
  }
  // [F] Margin Expansion (EBITDA growth - Revenue growth)
  let F = 0;
  if (s.ebitdaGrowth != null && s.revGrowth != null) {
    const diff = s.ebitdaGrowth - s.revGrowth;
    F = diff > 10 ? 4 : diff > 5 ? 2 : diff > 0 ? 1 : 0;
  }
  const factor2 = D + E + F;

  // Factor 3: BALANCE SHEET FORTRESS (0–18)
  // [G] D/E (banking sector gets neutral score — different capital norms)
  let G = 3;
  if (!isBanking && s.debtEquity != null) {
    G = s.debtEquity < 0 ? 0
      : s.debtEquity <= 0.1 ? 10 : s.debtEquity <= 0.3 ? 8 : s.debtEquity <= 0.5 ? 6
        : s.debtEquity <= 1.0 ? 4 : s.debtEquity <= 2.0 ? 1 : 0;
  }
  // [H] Interest coverage
  let H = 3;
  if (s.intCoverage != null) {
    H = s.intCoverage >= 10 ? 8 : s.intCoverage >= 5 ? 6 : s.intCoverage >= 3 ? 4 : s.intCoverage >= 1.5 ? 2 : 0;
  }
  const factor3 = G + H;

  // Factor 4: VALUATION DISCIPLINE (0–12)
  // [I] PEG ratio
  let I = 0;
  let pegVal = null;
  if (s.pe != null && s.pe > 0 && s.epsGwth5Y != null && s.epsGwth5Y > 0) {
    pegVal = s.pe / s.epsGwth5Y;
    I = pegVal <= 0.5 ? 7 : pegVal <= 1.0 ? 5 : pegVal <= 1.2 ? 3 : pegVal <= 1.5 ? 1 : 0;
  }
  // [J] EV/EBITDA
  let J = 0;
  if (s.evEbitda != null && s.evEbitda > 0) {
    J = s.evEbitda <= 10 ? 5 : s.evEbitda <= 15 ? 3 : s.evEbitda <= 20 ? 1 : 0;
  }
  const factor4 = I + J;

  // Factor 5: PRICE MOMENTUM (0–15) — Jegadeesh-Titman composite
  // [K] RS Rank percentile
  const K = rsRank >= 90 ? 5 : rsRank >= 75 ? 3 : rsRank >= 50 ? 1 : 0;
  // [L] JT Composite: 1Y*0.40 + 6M*0.35 - 1M*0.15 (filters short-term reversals)
  let L = 0;
  if (s.ret1Y != null && s.ret6M != null && s.ret1M != null) {
    const jt = s.ret1Y * 0.40 + s.ret6M * 0.35 - s.ret1M * 0.15;
    L = jt > 25 ? 5 : jt > 15 ? 3 : jt > 0 ? 1 : 0;
  } else if (s.ret1Y != null) {
    L = s.ret1Y > 30 ? 3 : s.ret1Y > 15 ? 1 : 0;
  }
  // [M] Price vs 200 SMA
  let M = 0;
  if (s.priceAbove200SMA != null) {
    M = s.priceAbove200SMA > 15 ? 5 : s.priceAbove200SMA > 5 ? 3 : s.priceAbove200SMA > 0 ? 2 : s.priceAbove200SMA > -10 ? 1 : 0;
  }
  const factor5 = K + L + M;

  // Factor 6: SMART MONEY (0–10)
  // [N] Promoter holding
  const N = s.promoterHolding != null
    ? (s.promoterHolding >= 65 ? 4 : s.promoterHolding >= 55 ? 3 : s.promoterHolding >= 50 ? 2 : s.promoterHolding >= 40 ? 1 : 0)
    : 0;
  // [O] Promoter 3M change
  const O = s.promoterChg3M != null
    ? (s.promoterChg3M > 0.5 ? 3 : s.promoterChg3M >= 0 ? 2 : s.promoterChg3M > -1 ? 1 : 0)
    : 1; // null → neutral
  // [P] FII + MF combo
  const fiiPos = s.fiiChg3M != null && s.fiiChg3M > 0;
  const mfPos  = s.mfChg3M  != null && s.mfChg3M  > 0;
  const P = (fiiPos && mfPos) ? 3 : (fiiPos || mfPos) ? 1 : 0;
  const factor6 = N + O + P;

  const total = Math.max(0, Math.round(factor1 + factor2 + factor3 + factor4 + factor5 + factor6));
  return {
    total,
    f1: Math.max(0, Math.round(factor1)),
    f2: Math.round(factor2),
    f3: Math.round(factor3),
    f4: Math.round(factor4),
    f5: Math.round(factor5),
    f6: Math.round(factor6),
    accrualsPenalty: accrualsPenalty > 0,
    peg: pegVal != null ? Math.round(pegVal * 10) / 10 : null,
    rsRank: Math.round(rsRank),
  };
}

function calcBadges(s, mbf, mcapCr) {
  const badges = [];
  if (s.epsGwth5Y >= 25 && s.debtEquity != null && s.debtEquity >= 0 && s.debtEquity <= 0.3 && s.roe >= 20 && s.fcf != null && s.fcf > 0)
    badges.push({ icon: '\u{1F525}', label: 'Compounding Machine' });
  if (s.pe != null && s.pe > 0 && s.pe < 15 && s.roe != null && s.roe >= 20 && s.evEbitda != null && s.evEbitda <= 12)
    badges.push({ icon: '\u{1F48E}', label: 'Deep Value' });
  if (mcapCr >= 500 && mcapCr <= 2000 && mbf.total >= 55)
    badges.push({ icon: '\u{1F680}', label: 'Discovery Zone' });
  if (s.epsGwth5Y != null && s.epsGwth5Y > 0 && s.epsGrowth != null && (s.epsGrowth / s.epsGwth5Y) >= 1.5 && s.epsGrowth >= 20)
    badges.push({ icon: '\u26A1', label: 'Accelerating Growth' });
  if (mcapCr != null && mcapCr > 0 && s.fcf != null && s.fcf > 0 && (s.fcf / mcapCr) * 100 > 5)
    badges.push({ icon: '\u{1F4B0}', label: 'FCF Champion' });
  if (s.debtEquity != null && s.debtEquity >= 0 && s.debtEquity <= 0.1 && s.intCoverage != null && s.intCoverage >= 10)
    badges.push({ icon: '\u{1F6E1}\uFE0F', label: 'Fortress' });
  if (mbf.rsRank >= 80 && s.priceAbove200SMA != null && s.priceAbove200SMA > 5)
    badges.push({ icon: '\u{1F4C8}', label: 'Momentum Leader' });
  return badges;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(stocks, updatedAt) {
  const dataJson = JSON.stringify({ stocks, updatedAt });
  const genTime = new Date(updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Multibagger Blueprint - India</title>
<script>
(function(){var s=localStorage.getItem('mbf-theme');var p=s||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',p)})();
</script>
<style>
:root,html[data-theme="dark"]{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#f59e0b;--tx:#e8e8f0;--t2:#9898b0;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7;--tl:#06b6d4;--hdr-bg:linear-gradient(135deg,#1a1508,#121211);--shadow:0 8px 24px rgba(0,0,0,.4);--row-hover:rgba(245,158,11,.04);--card-border:rgba(42,42,56,.4)}
html[data-theme="light"]{--bg:#f8f9fc;--s1:#ffffff;--s2:#ffffff;--s3:#eef0f5;--bd:#d5d8e0;--ac:#d97706;--tx:#1e1e32;--t2:#44495e;--t3:#6b7188;--gn:#15803d;--rd:#b91c1c;--yw:#a16207;--bl:#1d4ed8;--pp:#6d28d9;--tl:#0e7490;--hdr-bg:linear-gradient(135deg,#fef3c7,#eaecf2);--shadow:0 4px 16px rgba(0,0,0,.07);--row-hover:rgba(217,119,6,.03);--card-border:rgba(0,0,0,.08)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);overflow-x:hidden;line-height:1.55;transition:background .3s,color .3s}
.header{background:var(--hdr-bg);border-bottom:1px solid var(--bd);padding:18px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);transition:background .3s}
.header h1{font-size:1.4rem;font-weight:700;background:linear-gradient(90deg,var(--ac),#fb923c);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .subtitle{font-size:.78rem;color:var(--t2);margin-top:3px}
.header-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.status{font-size:.74rem;color:var(--t2)}
.back-link{color:var(--t2);text-decoration:none;font-size:.82rem;padding:7px 14px;border:1px solid var(--bd);border-radius:6px;transition:all .2s}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
.theme-toggle{width:42px;height:24px;border-radius:12px;border:1px solid var(--bd);background:var(--s3);cursor:pointer;position:relative;transition:all .3s;flex-shrink:0}
.theme-toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--ac);transition:transform .3s}
html[data-theme="light"] .theme-toggle::after{transform:translateX(18px)}
.theme-label{font-size:.68rem;color:var(--t3);white-space:nowrap}
.stats-bar{display:flex;gap:12px;padding:16px 28px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap;transition:background .3s}
.stat-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:12px 18px;min-width:130px;transition:background .3s,border .3s}
.stat-card .label{font-size:.7rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.stat-card .value{font-size:1.35rem;font-weight:700}
.stat-card .value.amber{color:var(--ac)}
.stat-card .value.green{color:var(--gn)}
.stat-card .value.gem{color:#c084fc}
.stat-card .value.blue{color:var(--bl)}
.controls{display:flex;gap:10px;padding:16px 28px;flex-wrap:wrap;align-items:center;transition:background .3s}
.controls .label{font-size:.78rem;color:var(--t2);margin-right:4px}
.filter-group{display:flex;gap:4px;align-items:center;border:1px solid var(--bd);border-radius:8px;padding:3px;background:var(--s1);transition:background .3s,border .3s}
.filter-group .fg-label{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.04em;padding:0 8px;white-space:nowrap;font-weight:600}
.btn{padding:6px 14px;border-radius:5px;border:1px solid transparent;background:transparent;color:var(--t2);cursor:pointer;font-size:.8rem;font-family:inherit;transition:all .2s}
.btn:hover{color:var(--tx);background:var(--s3)}
.btn.active{background:var(--ac);color:#fff;border-color:var(--ac);font-weight:600}
.search{padding:8px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.88rem;font-family:inherit;width:230px;outline:none;transition:border .2s,background .3s}
.search:focus{border-color:var(--ac)}
select.search{cursor:pointer}
.multi-dd{position:relative;display:inline-block}
.multi-dd .dd-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.85rem;font-family:inherit;cursor:pointer;min-width:170px;text-align:left;transition:border .2s,background .3s;white-space:nowrap;display:flex;align-items:center;justify-content:space-between;gap:6px}
.multi-dd .dd-btn:hover,.multi-dd.open .dd-btn{border-color:var(--ac)}
.multi-dd .dd-btn .dd-arrow{font-size:.6rem;color:var(--t3);transition:transform .2s}
.multi-dd.open .dd-arrow{transform:rotate(180deg)}
.multi-dd .dd-panel{position:absolute;top:calc(100% + 4px);left:0;min-width:230px;max-height:300px;overflow-y:auto;background:var(--s2);border:1px solid var(--bd);border-radius:10px;z-index:200;display:none;box-shadow:var(--shadow);transition:background .3s}
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
th{background:var(--s1);color:var(--ac);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;padding:12px 12px;text-align:left;border-bottom:2px solid var(--bd);cursor:pointer;white-space:nowrap;user-select:none;transition:color .2s,background .3s}
th:hover{color:var(--tx)}
th .arrow{margin-left:4px;font-size:.6rem;opacity:.5}
th.sorted .arrow{opacity:1;color:var(--ac)}
.tip-icon{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;border-radius:50%;background:rgba(245,158,11,.18);color:var(--ac);font-size:.52rem;font-weight:800;margin-left:3px;cursor:help;line-height:1;vertical-align:middle;flex-shrink:0}
.tt{position:fixed;z-index:9999;background:#1e1e2e;color:#e8e8f0;font-size:.7rem;line-height:1.55;padding:8px 11px;border-radius:8px;border:1px solid rgba(245,158,11,.3);white-space:normal;width:240px;text-align:left;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.55);opacity:0;transition:opacity .15s .05s}
.tt.tt-vis{opacity:1}
td{padding:10px 12px;border-bottom:1px solid var(--card-border);white-space:nowrap;transition:background .15s}
tr:hover td{background:var(--row-hover)}
.stock-name{max-width:200px;overflow:hidden;text-overflow:ellipsis}
.stock-name a{color:var(--tx);text-decoration:none;font-weight:600;font-size:.88rem;transition:color .2s}
.stock-name a:hover{color:var(--ac)}
.stock-name .ticker{color:var(--t2);font-size:.74rem;font-weight:400;margin-top:1px}
.pos{color:var(--gn)}.neg{color:var(--rd)}
.tag{display:inline-block;padding:3px 10px;border-radius:5px;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.tag-high{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.tag-avg{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.25)}
.tag-low{background:rgba(239,68,68,.1);color:var(--rd);border:1px solid rgba(239,68,68,.25)}
html[data-theme="light"] .tag-high{background:rgba(21,128,61,.08);color:#15803d;border-color:rgba(21,128,61,.2)}
html[data-theme="light"] .tag-avg{background:rgba(161,98,7,.07);color:#92400e;border-color:rgba(161,98,7,.18)}
html[data-theme="light"] .tag-low{background:rgba(185,28,28,.06);color:#991b1b;border-color:rgba(185,28,28,.18)}
.mbf-ring{width:42px;height:42px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:800;border:3px solid;cursor:default}
.mbf-ring.s-high{border-color:var(--gn);color:var(--gn);background:rgba(34,197,94,.08)}
.mbf-ring.s-med{border-color:var(--ac);color:var(--ac);background:rgba(245,158,11,.07)}
.mbf-ring.s-low{border-color:var(--t3);color:var(--t3);background:rgba(90,90,112,.06)}
.mbf-score-cell{display:inline-flex;align-items:center;gap:8px}
.mbf-bars{display:flex;flex-direction:column;gap:2px}
.mbf-bar-row{display:flex;align-items:center;gap:4px;font-size:.6rem;color:var(--t3);font-weight:500}
.mbf-bar-bg{width:48px;height:5px;background:var(--s3);border-radius:3px;overflow:hidden}
.mbf-bar-fill{height:100%;border-radius:3px}
.accruals-warn{font-size:.75rem;cursor:help;margin-left:2px}
.badge-wrap{display:flex;gap:3px;flex-wrap:wrap;min-width:80px}
.badge{font-size:.72rem;padding:2px 7px;border-radius:4px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.28);color:var(--ac);white-space:nowrap}
.mcap-label{font-size:.68rem;padding:2px 7px;border-radius:4px;font-weight:600}
.mcap-mid{background:rgba(168,85,247,.12);color:var(--pp);border:1px solid rgba(168,85,247,.25)}
.mcap-small{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.25)}
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.74rem;border-top:1px solid var(--bd);transition:background .3s;line-height:1.8}
#cards-container{display:none;padding:0 14px 24px}
.stock-card{background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:12px;transition:background .3s,border .3s}
.stock-card .card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.stock-card .card-name{font-weight:600;font-size:.92rem;line-height:1.35}
.stock-card .card-name a{color:var(--tx);text-decoration:none}
.stock-card .card-ticker{color:var(--t2);font-size:.74rem;margin-top:3px}
.stock-card .card-row{display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--card-border);font-size:.8rem}
.stock-card .card-label{color:var(--t2)}
.stock-card .card-val{font-weight:500}
.stock-card .card-badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--card-border)}
.sort-select{display:none}
html[data-theme="light"] .mbf-ring.s-high{background:rgba(21,128,61,.07)}
html[data-theme="light"] .mbf-ring.s-med{background:rgba(161,98,7,.07)}
html[data-theme="light"] .stat-card{background:#fff;border-color:#dfe2ea}
html[data-theme="light"] th{background:#f5f6fa}
html[data-theme="light"] .btn.active{background:#d97706;border-color:#d97706}
html[data-theme="light"] .filter-group{background:#f5f6fa;border-color:#dfe2ea}
html[data-theme="light"] .multi-dd .dd-btn{background:#fff;border-color:#d5d8e0}
html[data-theme="light"] .dd-panel{background:#fff;border-color:#d5d8e0}
html[data-theme="light"] .dd-panel .dd-actions{background:#fff}
html[data-theme="light"] .tt{background:#fff;color:#1e1e32;border-color:rgba(217,119,6,.3);box-shadow:0 4px 16px rgba(0,0,0,.12)}
@media(max-width:768px){
  .header{padding:14px 16px}
  .header h1{font-size:1.1rem}
  .header .subtitle{font-size:.68rem}
  .stats-bar{padding:12px 14px;gap:8px}
  .stat-card{min-width:0;flex:1 1 calc(50% - 8px);padding:10px 12px}
  .stat-card .label{font-size:.62rem}
  .stat-card .value{font-size:1.05rem}
  .controls{padding:12px 14px;gap:8px}
  .filter-group{flex-wrap:wrap;width:100%}
  .search{width:100%;font-size:16px}
  select.search{width:100%}
  .multi-dd{width:100%}
  .multi-dd .dd-btn{width:100%;font-size:16px}
  .multi-dd .dd-panel{width:100%}
  .table-container{display:none}
  #cards-container{display:block}
  .sort-select{display:block;width:100%;margin-top:4px}
  .back-link{font-size:.72rem;padding:5px 10px}
  .footer{font-size:.66rem;padding:14px}
  .theme-label{display:none}
}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>&#x1F3C6; Multibagger Blueprint</h1>
    <div class="subtitle">MBF Score v3 &mdash; 6-factor algorithm &middot; NSE growth compounders (500&ndash;15,000 Cr MCap) &nbsp;&middot;&nbsp; <span style="color:var(--ac)">Generated: ${genTime} IST</span></div>
  </div>
  <div class="header-right">
    <div class="status" id="status-text"></div>
    <span class="theme-label" id="theme-label">Dark</span>
    <div class="theme-toggle" id="theme-toggle" title="Toggle dark/light mode"></div>
    <a href="alerts.html" class="back-link" style="color:var(--yw);border-color:rgba(234,179,8,.4)">&#x1F514; Alerts</a>
    <a href="potential.html" class="back-link" style="color:var(--pp);border-color:rgba(168,85,247,.4)">&#x1F31F; Potential</a>
    <a href="creamy.html" class="back-link">Creamy Layer</a>
    <a href="index.html" class="back-link">My Watchlist</a>
  </div>
</div>

<div class="stats-bar" id="stats-bar"></div>

<div class="controls">
  <div class="filter-group">
    <span class="fg-label">MBF</span>
    <button class="btn mbf-btn active" data-min="0">All</button>
    <button class="btn mbf-btn" data-min="40">40+</button>
    <button class="btn mbf-btn" data-min="55">55+</button>
    <button class="btn mbf-btn" data-min="65">65+</button>
    <button class="btn mbf-btn" data-min="75">75+</button>
  </div>
  <div class="filter-group">
    <span class="fg-label">Cap</span>
    <button class="btn cap-btn active" data-cap="Small">Small</button>
    <button class="btn cap-btn active" data-cap="Mid">Mid</button>
  </div>
  <div class="multi-dd" id="sector-dd">
    <button class="dd-btn" type="button"><span id="sector-label">All Sectors</span><span class="dd-arrow">&#x25BC;</span></button>
    <div class="dd-panel" id="sector-panel"></div>
  </div>
  <input type="text" class="search" id="search" placeholder="Search ticker or name..." style="margin-left:auto">
  <select id="sort-select" class="search sort-select">
    <option value="mbfTotal:desc">Sort: MBF Score (best)</option>
    <option value="epsGwth5Y:desc">Sort: Profit 5Y CAGR</option>
    <option value="revGrowth5Y:desc">Sort: Revenue 5Y CAGR</option>
    <option value="roe:desc">Sort: ROE</option>
    <option value="peg:asc">Sort: PEG (lowest)</option>
    <option value="mcapCr:desc">Sort: Market Cap</option>
    <option value="name:asc">Sort: Name A-Z</option>
  </select>
</div>

<div class="table-container">
  <table><thead><tr id="table-head"></tr></thead><tbody id="table-body"></tbody></table>
</div>
<div id="cards-container"></div>
<div class="footer" id="footer"></div>
<div class="tt" id="tt"></div>

<script>
var RAW = ${dataJson};
var allStocks = RAW.stocks;
var sortCol = 'mbfTotal', sortAsc = false;
var minMbf = 0;
var activeCaps = new Set(['Small','Mid']);
var excludedSectors = new Set();
var searchTerm = '';

var COLS = [
  {key:'rank',label:'#',w:'36px'},
  {key:'name',label:'Stock',w:'200px',tip:'Company name and ticker. Click to open on Tickertape. Badges: \\uD83D\\uDD25 Compounding Machine | \\uD83D\\uDC8E Deep Value | \\uD83D\\uDE80 Discovery Zone (MCap<2000Cr+MBF\u226555) | \\u26A1 Accelerating Growth | \\uD83D\\uDCB0 FCF Champion | \\uD83D\\uDEE1\\uFE0F Fortress | \\uD83D\\uDCC8 Momentum Leader'},
  {key:'mbfTotal',label:'MBF Score',w:'140px',num:true,tip:'Multibagger Blueprint Score (0\\u2013100). Six factors: E=Earnings Engine (max 25) + Q=Capital Quality (max 20) + F=Balance Sheet Fortress (max 18) + V=Valuation (max 12) + M=Price Momentum (max 15) + S=Smart Money (max 10). Accruals warning \\u26A0\\uFE0F shown if strong EPS growth but negative free cash flow.'},
  {key:'revGrowth5Y',label:'Rev 5Y%',w:'74px',num:true,tip:'5-year revenue CAGR (Tickertape). Compound annual growth of sales. \\u226520% = exceptional, \\u226515% = very good, \\u226510% = good.'},
  {key:'epsGwth5Y',label:'EPS 5Y%',w:'72px',num:true,tip:'5-year EPS (earnings per share) CAGR (Tickertape). The primary earnings compounding measure. \\u226525% = multibagger zone, \\u226520% = strong, \\u226515% = solid base.'},
  {key:'roe',label:'ROE',w:'56px',num:true,tip:'Return on Equity (%): net profit / book value. Measures capital efficiency. \\u226525% = exceptional business economics. Core Factor 2 metric.'},
  {key:'peg',label:'PEG',w:'52px',num:true,tip:'Price/Earnings to Growth ratio: P/E \\u00F7 5Y EPS CAGR. \\u22640.5 = deep value (7 pts), \\u22641.0 = fairly priced (5 pts), \\u22641.5 = stretched (1 pt), >1.5 = expensive (0 pts). Null if PE or EPS CAGR is unavailable.'},
  {key:'debtEquity',label:'D/E',w:'50px',num:true,tip:'Debt-to-Equity ratio. \\u22640.1 = debt-free (10 pts), \\u22640.3 = very strong (8 pts), \\u22640.5 = healthy (6 pts), >2 = high risk (0 pts). Banking/Finance sector gets neutral score (different capital norms).'},
  {key:'promoterHolding',label:'Promo%',w:'65px',num:true,tip:'Promoter % shareholding. \\u226565% = very high skin-in-game (4 pts), \\u226555% = strong (3 pts). Part of Smart Money factor.'},
  {key:'mcapCr',label:'MCap Cr',w:'82px',num:true,tip:'Market capitalisation in Indian Rupees (Crores). Small = 500\\u20132000 Cr, Mid = 2000\\u201315000 Cr. Universe is filtered to this range for discovery potential.'},
  {key:'badges',label:'Badges',w:'200px',tip:'Re-rating signal badges. These do not affect the score but identify special patterns: \\uD83D\\uDD25 Compounding Machine: best composite (EPS CAGR\\u226525% + D/E\\u22640.3 + ROE\\u226520% + FCF positive). \\uD83D\\uDC8E Deep Value: cheap+quality (PE<15 + ROE\\u226520% + EV/EBITDA\\u226412). \\uD83D\\uDE80 Discovery Zone: small cap under-the-radar (MCap\\u22642000 Cr + MBF\\u226555). \\u26A1 Accelerating Growth. \\uD83D\\uDCB0 FCF Champion (FCF yield>5%). \\uD83D\\uDEE1\\uFE0F Fortress (near-zero debt + high interest cover). \\uD83D\\uDCC8 Momentum Leader (RS Rank top 20% + above 200SMA).'},
  {key:'perfTag',label:'Perf',w:'52px',tip:'Tickertape Performance scorecard tag (High/Avg/Low). Peer price performance rank.'},
  {key:'growthTag',label:'Grw',w:'50px',tip:'Tickertape Growth scorecard tag (High/Avg/Low). Revenue, EPS, EBITDA growth trends vs peers.'},
];

function buildHead() {
  document.getElementById('table-head').innerHTML = COLS.map(function(c) {
    var tipAttr = c.tip ? ' data-tip="' + c.tip.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') + '"' : '';
    var icon = c.tip ? '<span class="tip-icon">?</span>' : '';
    return '<th style="width:' + c.w + '"' + tipAttr + ' class="' + (sortCol === c.key ? 'sorted' : '')
      + '" onclick="doSort(\\'' + c.key + '\\',' + !!c.num + ')">'
      + c.label + '<span class="arrow">' + (sortCol === c.key ? (sortAsc ? '\\u25B2' : '\\u25BC') : '\\u21C5') + '</span>' + icon + '</th>';
  }).join('');
}

function retHtml(v) {
  if (v == null) return '<span style="color:var(--t3)">\\u2014</span>';
  var cls = v >= 0 ? 'pos' : 'neg';
  return '<span class="' + cls + '">' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</span>';
}

function tagHtml(t) {
  if (!t) return '<span class="tag" style="opacity:.3">\\u2014</span>';
  var c = t === 'High' ? 'tag-high' : t === 'Avg' ? 'tag-avg' : 'tag-low';
  return '<span class="tag ' + c + '">' + t + '</span>';
}

function mcapHtml(lbl) {
  if (!lbl) return '';
  var c = lbl === 'Mid' ? 'mcap-mid' : 'mcap-small';
  return '<span class="mcap-label ' + c + '">' + lbl + '</span>';
}

function fmtCr(n) {
  if (n == null) return '\\u2014';
  if (n >= 10000) return (n / 1000).toFixed(1) + 'K';
  return Math.round(n) + '';
}

function mbfScoreHtml(s) {
  var t = s.mbfTotal;
  var cls = t >= 65 ? 's-high' : t >= 40 ? 's-med' : 's-low';
  function bar(lbl, val, mx, clr) {
    var pct = Math.min(100, Math.round(val / mx * 100));
    return '<div class="mbf-bar-row"><span>' + lbl + '</span>'
      + '<div class="mbf-bar-bg"><div class="mbf-bar-fill" style="width:' + pct + '%;background:' + clr + '"></div></div></div>';
  }
  return '<div class="mbf-score-cell">'
    + '<div class="mbf-ring ' + cls + '">' + t + '</div>'
    + '<div class="mbf-bars">'
    + bar('E', s.mbf.f1, 25, '#22c55e')
    + bar('Q', s.mbf.f2, 20, '#06b6d4')
    + bar('F', s.mbf.f3, 18, '#3b82f6')
    + bar('V', s.mbf.f4, 12, '#a855f7')
    + bar('M', s.mbf.f5, 15, '#f59e0b')
    + bar('S', s.mbf.f6, 10, '#ec4899')
    + '</div>'
    + (s.mbf.accrualsPenalty ? '<span class="accruals-warn" title="Accruals warning: strong EPS growth but free cash flow is negative. Earnings may not be fully cash-backed (Piotroski F-Score signal). -5 pts applied.">\\u26A0\\uFE0F</span>' : '')
    + '</div>';
}

function badgesHtml(bs) {
  if (!bs || !bs.length) return '<span style="color:var(--t3);font-size:.7rem">\\u2014</span>';
  return '<div class="badge-wrap">'
    + bs.map(function(b) { return '<span class="badge" title="' + b.label + '">' + b.icon + '</span>'; }).join('')
    + '</div>';
}

function getFiltered() {
  var list = allStocks.filter(function(s) {
    if (s.mbfTotal < minMbf) return false;
    if (activeCaps.size > 0 && activeCaps.size < 2 && !activeCaps.has(s.mcapLabel)) return false;
    if (excludedSectors.size > 0 && excludedSectors.has(s.sector)) return false;
    if (searchTerm) {
      var q = searchTerm.toLowerCase();
      if (s.ticker.toLowerCase().indexOf(q) < 0 && s.name.toLowerCase().indexOf(q) < 0 && s.sector.toLowerCase().indexOf(q) < 0) return false;
    }
    return true;
  });
  list.sort(function(a, b) {
    var av, bv;
    if (sortCol === 'peg') { av = a.peg; bv = b.peg; }
    else if (sortCol === 'name') { av = a.name; bv = b.name; return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av); }
    else { av = a[sortCol]; bv = b[sortCol]; }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return sortAsc ? (av - bv) : (bv - av);
  });
  return list;
}

function renderTable() {
  var list = getFiltered();
  var rows = list.slice(0, 200).map(function(s, i) {
    var url = 'https://www.tickertape.in' + s.slug;
    return '<tr>'
      + '<td style="color:var(--t3);font-size:.8rem">' + (i + 1) + '</td>'
      + '<td><div class="stock-name"><a href="' + url + '" target="_blank" rel="noopener">' + s.name + '</a>'
        + '<div class="ticker">' + s.ticker + ' &nbsp;' + mcapHtml(s.mcapLabel) + '</div></div></td>'
      + '<td>' + mbfScoreHtml(s) + '</td>'
      + '<td>' + retHtml(s.revGrowth5Y) + '</td>'
      + '<td>' + retHtml(s.epsGwth5Y) + '</td>'
      + '<td>' + (s.roe != null ? '<span class="' + (s.roe >= 20 ? 'pos' : s.roe >= 10 ? '' : 'neg') + '">' + (+s.roe.toFixed(1)) + '%</span>' : '\\u2014') + '</td>'
      + '<td>' + (s.peg != null ? '<span class="' + (s.peg <= 1 ? 'pos' : s.peg > 1.5 ? 'neg' : '') + '">' + s.peg + '</span>' : '\\u2014') + '</td>'
      + '<td>' + (s.debtEquity != null ? '<span class="' + (s.debtEquity <= 0.5 ? 'pos' : s.debtEquity > 1.5 ? 'neg' : '') + '">' + s.debtEquity.toFixed(2) + '</span>' : '\\u2014') + '</td>'
      + '<td>' + (s.promoterHolding != null ? (+s.promoterHolding.toFixed(1)) + '%' : '\\u2014') + '</td>'
      + '<td><span style="font-size:.8rem;color:var(--t2)">' + fmtCr(s.mcapCr) + ' Cr</span></td>'
      + '<td>' + badgesHtml(s.badges) + '</td>'
      + '<td>' + tagHtml(s.perfTag) + '</td>'
      + '<td>' + tagHtml(s.growthTag) + '</td>'
      + '</tr>';
  });
  document.getElementById('table-body').innerHTML = rows.join('');
  document.getElementById('status-text').textContent = list.length + ' stocks';
  renderCards(list);
  updateStats(list);
}

function renderCards(list) {
  var el = document.getElementById('cards-container');
  el.innerHTML = list.slice(0, 200).map(function(s) {
    var url = 'https://www.tickertape.in' + s.slug;
    var t = s.mbfTotal;
    var cls = t >= 65 ? 's-high' : t >= 40 ? 's-med' : 's-low';
    return '<div class="stock-card">'
      + '<div class="card-header">'
        + '<div><div class="card-name"><a href="' + url + '" target="_blank" rel="noopener">' + s.name + '</a></div>'
          + '<div class="card-ticker">' + s.ticker + ' &nbsp;|&nbsp; ' + s.sector + '</div></div>'
        + '<div class="mbf-ring ' + cls + '" style="width:44px;height:44px;font-size:.9rem">' + t + '</div>'
      + '</div>'
      + '<div class="card-row"><span class="card-label">Rev 5Y CAGR</span><span class="card-val">' + retHtml(s.revGrowth5Y) + '</span></div>'
      + '<div class="card-row"><span class="card-label">EPS 5Y CAGR</span><span class="card-val">' + retHtml(s.epsGwth5Y) + '</span></div>'
      + '<div class="card-row"><span class="card-label">ROE</span><span class="card-val">' + (s.roe != null ? (+s.roe.toFixed(1)) + '%' : '\\u2014') + '</span></div>'
      + '<div class="card-row"><span class="card-label">PEG</span><span class="card-val">' + (s.peg != null ? s.peg : '\\u2014') + '</span></div>'
      + '<div class="card-row"><span class="card-label">D/E</span><span class="card-val">' + (s.debtEquity != null ? s.debtEquity.toFixed(2) : '\\u2014') + '</span></div>'
      + '<div class="card-row"><span class="card-label">MCap</span><span class="card-val">' + fmtCr(s.mcapCr) + ' Cr</span></div>'
      + (s.badges && s.badges.length ? '<div class="card-badges">' + s.badges.map(function(b){ return '<span class="badge">' + b.icon + ' ' + b.label + '</span>'; }).join('') + '</div>' : '')
      + '</div>';
  }).join('');
}

function updateStats(filtered) {
  var total = filtered.length;
  var high = filtered.filter(function(s){ return s.mbfTotal >= 65; }).length;
  var cm   = filtered.filter(function(s){ return s.badges && s.badges.some(function(b){ return b.icon === '\\uD83D\\uDD25'; }); }).length;
  var dv   = filtered.filter(function(s){ return s.badges && s.badges.some(function(b){ return b.icon === '\\uD83D\\uDC8E'; }); }).length;
  var acc  = filtered.filter(function(s){ return s.badges && s.badges.some(function(b){ return b.icon === '\\u26A1'; }); }).length;
  document.getElementById('stats-bar').innerHTML =
    '<div class="stat-card"><div class="label">Candidates</div><div class="value amber">' + total + '</div></div>'
    + '<div class="stat-card"><div class="label">High Conviction (65+)</div><div class="value green">' + high + '</div></div>'
    + '<div class="stat-card"><div class="label">&#x1F525; Compounding</div><div class="value amber">' + cm + '</div></div>'
    + '<div class="stat-card"><div class="label">&#x1F48E; Deep Value</div><div class="value gem">' + dv + '</div></div>'
    + '<div class="stat-card"><div class="label">&#x26A1; Accelerating</div><div class="value blue">' + acc + '</div></div>';
}

function buildSectorDd() {
  var counts = {};
  allStocks.forEach(function(s){ counts[s.sector] = (counts[s.sector] || 0) + 1; });
  var sectors = Object.keys(counts).sort();
  var rows = sectors.map(function(sec){
    return '<label><input type="checkbox" checked data-sector="' + sec.replace(/"/g,'&quot;') + '">'
      + '<span>' + sec + '</span><span class="dd-count">' + counts[sec] + '</span></label>';
  }).join('');
  document.getElementById('sector-panel').innerHTML =
    '<div class="dd-actions">'
    + '<button id="sel-all-btn">All</button>'
    + '<button id="sel-none-btn">None</button>'
    + '</div>' + rows;
  document.getElementById('sel-all-btn').addEventListener('click', function(){
    excludedSectors = new Set();
    document.querySelectorAll('#sector-panel input[type=checkbox]').forEach(function(c){ c.checked = true; });
    document.getElementById('sector-label').textContent = 'All Sectors';
    renderTable();
  });
  document.getElementById('sel-none-btn').addEventListener('click', function(){
    excludedSectors = new Set(allStocks.map(function(s){ return s.sector; }));
    document.querySelectorAll('#sector-panel input[type=checkbox]').forEach(function(c){ c.checked = false; });
    document.getElementById('sector-label').textContent = '0 Sectors';
    renderTable();
  });
  document.getElementById('sector-panel').addEventListener('change', function(e){
    if (e.target.type !== 'checkbox') return;
    var sec = e.target.dataset.sector;
    if (e.target.checked) { excludedSectors.delete(sec); } else { excludedSectors.add(sec); }
    var shown = allStocks.filter(function(s){ return !excludedSectors.has(s.sector); }).length;
    document.getElementById('sector-label').textContent = excludedSectors.size === 0 ? 'All Sectors' : shown + ' shown';
    renderTable();
  });
}

function doSort(col, isNum) {
  if (sortCol === col) { sortAsc = !sortAsc; }
  else { sortCol = col; sortAsc = col === 'name'; }
  buildHead();
  renderTable();
}

document.addEventListener('DOMContentLoaded', function(){
  buildHead();
  buildSectorDd();
  renderTable();

  // MBF threshold filter
  document.querySelectorAll('.mbf-btn').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('.mbf-btn').forEach(function(x){ x.classList.remove('active'); });
      this.classList.add('active');
      minMbf = parseInt(this.dataset.min) || 0;
      renderTable();
    });
  });

  // Cap filter
  document.querySelectorAll('.cap-btn').forEach(function(b){
    b.addEventListener('click', function(){
      this.classList.toggle('active');
      var cap = this.dataset.cap;
      if (activeCaps.has(cap)) activeCaps.delete(cap); else activeCaps.add(cap);
      renderTable();
    });
  });

  // Sector dropdown
  var dd = document.getElementById('sector-dd');
  dd.querySelector('.dd-btn').addEventListener('click', function(e){
    e.stopPropagation();
    dd.classList.toggle('open');
  });
  document.addEventListener('click', function(e){
    if (!e.target.closest('#sector-dd')) dd.classList.remove('open');
  });
  document.getElementById('sector-panel').addEventListener('click', function(e){ e.stopPropagation(); });

  // Search
  document.getElementById('search').addEventListener('input', function(){
    searchTerm = this.value.trim();
    renderTable();
  });

  // Mobile sort
  document.getElementById('sort-select').addEventListener('change', function(){
    var parts = this.value.split(':');
    sortCol = parts[0];
    sortAsc = parts[1] === 'asc';
    buildHead();
    renderTable();
  });

  // Tooltips
  var tt = document.getElementById('tt');
  document.addEventListener('mouseover', function(e){
    var el = e.target.closest('[data-tip]');
    if (!el) return;
    tt.textContent = el.getAttribute('data-tip');
    tt.classList.add('tt-vis');
  });
  document.addEventListener('mouseout', function(e){
    if (!e.target.closest('[data-tip]')) tt.classList.remove('tt-vis');
  });
  document.addEventListener('mousemove', function(e){
    if (tt.classList.contains('tt-vis')) {
      var x = e.clientX + 14, y = e.clientY + 14;
      if (x + 250 > window.innerWidth) x = e.clientX - 260;
      if (y + 140 > window.innerHeight) y = e.clientY - 150;
      tt.style.left = x + 'px';
      tt.style.top = y + 'px';
    }
  });

  // Theme toggle
  var toggle = document.getElementById('theme-toggle');
  var lbl = document.getElementById('theme-label');
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('mbf-theme', t);
    lbl.textContent = t === 'dark' ? 'Dark' : 'Light';
  }
  var cur = document.documentElement.getAttribute('data-theme') || 'dark';
  lbl.textContent = cur === 'dark' ? 'Dark' : 'Light';
  toggle.addEventListener('click', function(){
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // Footer
  document.getElementById('footer').innerHTML =
    'Updated: ' + new Date(RAW.updatedAt).toLocaleString('en-IN', {timeZone:'Asia/Kolkata'}) + ' IST<br>'
    + 'MBF Score v3: Earnings Engine (25) + Capital Quality (20) + Balance Sheet Fortress (18) + Valuation Discipline (12) + Price Momentum (15) + Smart Money (10) = 100 pts<br>'
    + 'Universe: NSE stocks with MCap 500\u201315,000 Cr &amp; 5Y EPS CAGR &gt; 5% &nbsp;&middot;&nbsp; Top 200 shown &nbsp;&middot;&nbsp; Data: Tickertape screener &amp; scorecards';
});
</script>
</body>
</html>`;
}

// ─────── Main ───────
async function main() {
  const start = Date.now();

  console.log('Step 1: Fetching all stocks from Tickertape screener...');
  const stocks = await fetchAllStocks();

  console.log('Step 2: Computing RS Rank across full screener universe...');
  const sortedReturns = stocks.map(s => s.ret1Y != null ? s.ret1Y : -Infinity).sort((a, b) => a - b);
  const n = sortedReturns.length;
  function getRsRank(ret1Y) {
    if (ret1Y == null) return 0;
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedReturns[mid] < ret1Y) lo = mid + 1; else hi = mid; }
    return (lo / n) * 100;
  }

  console.log('Step 3: Filtering to MCap 500-15,000 Cr + EPS 5Y CAGR > 5%...');
  const universe = stocks.filter(s => {
    if (s.marketCap == null) return false;
    return s.marketCap >= 500 && s.marketCap <= 15000 && s.epsGwth5Y != null && s.epsGwth5Y > 5;
  });
  console.log(`  Universe: ${universe.length} stocks (from ${stocks.length} total)`);

  console.log('Step 4: Fetching scorecards for universe stocks...');
  const scorecards = await fetchAllScorecards(universe);

  console.log('Step 5: Scoring all stocks...');
  const mbfStocks = [];
  for (const s of universe) {
    const sc = scorecards[s.sid] || {};
    const perfTag   = sc.performance?.tag   || null;
    const growthTag = sc.growth?.tag         || null;
    const profitTag = sc.profitability?.tag  || null;
    const valTag    = sc.valuation?.tag      || null;

    const mcapCr = s.marketCap;
    const mcapLabel = mcapCr <= 2000 ? 'Small' : 'Mid';
    const rsRank = getRsRank(s.ret1Y);
    const mbf = calcMbfScore(s, rsRank);
    const badges = calcBadges(s, mbf, mcapCr);

    mbfStocks.push({
      sid: s.sid, ticker: s.ticker, name: s.name, sector: s.sector, slug: s.slug,
      mcapCr: Math.round(mcapCr), mcapLabel,
      price: s.price != null ? Math.round(s.price * 100) / 100 : null,
      ret1Y:  s.ret1Y  != null ? Math.round(s.ret1Y  * 10) / 10 : null,
      ret6M:  s.ret6M  != null ? Math.round(s.ret6M  * 10) / 10 : null,
      ret1M:  s.ret1M  != null ? Math.round(s.ret1M  * 10) / 10 : null,
      roe:       s.roe       != null ? Math.round(s.roe       * 10) / 10 : null,
      epsGwth5Y: s.epsGwth5Y != null ? Math.round(s.epsGwth5Y * 10) / 10 : null,
      revGrowth5Y: s.revGrowth5Y != null ? Math.round(s.revGrowth5Y * 10) / 10 : null,
      epsGrowth:  s.epsGrowth  != null ? Math.round(s.epsGrowth  * 10) / 10 : null,
      revGrowth:  s.revGrowth  != null ? Math.round(s.revGrowth  * 10) / 10 : null,
      pe:       s.pe       != null ? Math.round(s.pe       * 10) / 10 : null,
      evEbitda: s.evEbitda != null ? Math.round(s.evEbitda * 10) / 10 : null,
      debtEquity:   s.debtEquity   != null ? Math.round(s.debtEquity   * 100) / 100 : null,
      intCoverage:  s.intCoverage  != null ? Math.round(s.intCoverage  * 10)  / 10  : null,
      promoterHolding: s.promoterHolding != null ? Math.round(s.promoterHolding * 10) / 10 : null,
      promoterChg3M:   s.promoterChg3M   != null ? Math.round(s.promoterChg3M   * 100) / 100 : null,
      mfChg3M:  s.mfChg3M  != null ? Math.round(s.mfChg3M  * 100) / 100 : null,
      fiiChg3M: s.fiiChg3M != null ? Math.round(s.fiiChg3M * 100) / 100 : null,
      priceAbove200SMA: s.priceAbove200SMA != null ? Math.round(s.priceAbove200SMA * 10) / 10 : null,
      fcf: s.fcf != null ? Math.round(s.fcf) : null,
      perfTag, growthTag, profitTag, valTag,
      mbf, badges,
      mbfTotal: mbf.total,
      peg: mbf.peg,    // top-level for sorting
    });
  }

  mbfStocks.sort((a, b) => b.mbfTotal - a.mbfTotal);

  const high = mbfStocks.filter(s => s.mbfTotal >= 65).length;
  const med  = mbfStocks.filter(s => s.mbfTotal >= 40 && s.mbfTotal < 65).length;
  const cm   = mbfStocks.filter(s => s.badges.some(b => b.label === 'Compounding Machine')).length;
  const dv   = mbfStocks.filter(s => s.badges.some(b => b.label === 'Deep Value')).length;
  console.log(`  Total: ${mbfStocks.length} | MBF 65+: ${high} | MBF 40-64: ${med} | Compounders: ${cm} | Deep Value: ${dv}`);
  if (high > 0 || mbfStocks.length > 0) {
    console.log('  Top 10 by MBF score:');
    mbfStocks.slice(0, 10).forEach((s, i) => {
      const m = s.mbf;
      console.log(`    ${i + 1}. ${s.ticker.padEnd(14)} MBF=${m.total} E${m.f1} Q${m.f2} F${m.f3} V${m.f4} M${m.f5} S${m.f6}${m.accrualsPenalty ? ' \u26A0\uFE0F' : ''}`);
    });
  }
  const small = mbfStocks.filter(s => s.mcapLabel === 'Small').length;
  const midCp = mbfStocks.filter(s => s.mcapLabel === 'Mid').length;
  console.log(`  Small (500-2000 Cr): ${small} | Mid (2000-15000 Cr): ${midCp}`);

  console.log('\nStep 6: Generating HTML...');
  const docsDir = path.join(__dirname, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const updatedAt = new Date().toISOString();
  fs.writeFileSync(OUTPUT_PATH, buildHtml(mbfStocks, updatedAt), 'utf8');
  console.log(`  Saved to ${OUTPUT_PATH}`);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ${mbfStocks.length} candidates, ${high} high-conviction opportunities`);
}

main().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });

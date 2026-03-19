const https = require('https');
const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const alertSystem = require('./alert-system');

const OUTPUT_PATH = path.join(__dirname, 'docs', 'creamy.html');
const CONCURRENCY = 50;

function apiPostOnce(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
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
    https.get(url, { timeout: 10000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse error')); } });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
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
    '52wpct', '26wpct', '4wpct', 'pr1w', 'pr1d',
    'roe', 'pftMrg', 'aopm', 'rvng', 'epsg', 'ebitg',
    'apef', 'pbr', 'divDps', 'evebitd',
    'acVol', '52whd', '52wld',
    'epsGwth', '5YrevChg', 'earnings',
    'dbtEqt', 'aint',
    'strown', 'strown3', 'instown3', 'forInstHldng3M',
    'beta', 'relVol', 'pab12Mma', 'vol1wChPct',
    'cafFcf',
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
        ret1Y: g('52wpct'), ret6M: g('26wpct'), ret1M: g('4wpct'), ret1W: g('pr1w'), ret1D: g('pr1d'),
        roe: g('roe'), npm: g('pftMrg'), ebitdaMargin: g('aopm'),
        revGrowth: g('rvng'), epsGrowth: g('epsg'), ebitdaGrowth: g('ebitg'),
        epsGrowth5Y: g('epsGwth'), revGrowth5Y: g('5YrevChg'), ebitdaGrowth5Y: g('earnings'),
        pe: g('apef'), pb: g('pbr'), divYield: g('divDps'), evEbitda: g('evebitd'),
        volume: g('acVol'), awayFrom52WH: g('52whd'), awayFrom52WL: g('52wld'),
        debtEquity: g('dbtEqt'), intCoverage: g('aint'),
        promoterHolding: g('strown'), promoterChg3M: g('strown3'),
        mfChg3M: g('instown3'), fiiChg3M: g('forInstHldng3M'),
        beta: g('beta'), relVol: g('relVol'),
        priceAbove200SMA: g('pab12Mma'), volChg1W: g('vol1wChPct'),
        fcf: g('cafFcf'),
      });
    }
    offset += PAGE;
    process.stdout.write(`  Fetched ${allStocks.length}/${total} stocks from screener\r`);
  }
  console.log(`  Fetched ${allStocks.length} stocks from screener       `);
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

async function fetchYahooData(tickers) {
  const data = {};
  const BATCH = 12;
  const MODULES = ['financialData', 'recommendationTrend', 'earningsTrend', 'defaultKeyStatistics'];
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async ticker => {
      try {
        const qs = await yahooFinance.quoteSummary(ticker + '.NS', { modules: MODULES });
        const fd = qs.financialData || {};
        const rt = qs.recommendationTrend?.trend || [];
        const et = qs.earningsTrend?.trend || [];
        const ks = qs.defaultKeyStatistics || {};

        const curMonth = rt.find(t => t.period === '0m') || {};
        const prevMonth = rt.find(t => t.period === '-1m') || {};
        const totalCur = (curMonth.strongBuy||0) + (curMonth.buy||0) + (curMonth.hold||0) + (curMonth.sell||0) + (curMonth.strongSell||0);
        const buyCur = (curMonth.strongBuy||0) + (curMonth.buy||0);
        const buyPrev = (prevMonth.strongBuy||0) + (prevMonth.buy||0);

        const fwdEps0q = et.find(t => t.period === '0q');
        const fwdEps0y = et.find(t => t.period === '0y');

        const result = {
          targetMean: fd.targetMeanPrice || null,
          targetHigh: fd.targetHighPrice || null,
          targetLow: fd.targetLowPrice || null,
          numAnalysts: fd.numberOfAnalystOpinions || null,
          recoKey: fd.recommendationKey || null,
          currentPrice: fd.currentPrice || null,
          strongBuy: curMonth.strongBuy || 0,
          buy: curMonth.buy || 0,
          hold: curMonth.hold || 0,
          sell: curMonth.sell || 0,
          strongSell: curMonth.strongSell || 0,
          totalAnalysts: totalCur || null,
          buyPct: totalCur > 0 ? Math.round(buyCur / totalCur * 100) : null,
          consensusShift: buyCur - buyPrev,
          fwdEpsQ: fwdEps0q?.earningsEstimate?.avg || null,
          fwdEpsY: fwdEps0y?.earningsEstimate?.avg || null,
          fwdRevY: fwdEps0y?.revenueEstimate?.avg || null,
          forwardPE: ks.forwardPE || null,
          beta: ks.beta || null,
          bookValue: ks.bookValue || null,
          earningsGrowthQ: ks.earningsQuarterlyGrowth || null,
          profitMargins: ks.profitMargins || null,
          enterpriseValue: ks.enterpriseValue || null,
        };

        const hasData = result.targetMean || result.totalAnalysts || result.forwardPE;
        return { ticker, data: hasData ? result : null };
      } catch { return { ticker, data: null }; }
    }));
    for (const r of results) if (r.data) data[r.ticker] = r.data;
    process.stdout.write(`  Yahoo Finance data: ${Math.min(i + BATCH, tickers.length)}/${tickers.length}\r`);
  }
  console.log(`  Yahoo Finance data: ${tickers.length}/${tickers.length} (${Object.keys(data).length} with data)       `);
  return data;
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

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function score(val, threshold, maxPts, invert) {
  if (val == null) return 0;
  if (invert) return val <= 0 ? maxPts : clamp((threshold - val) / threshold, 0, 1) * maxPts;
  return val <= 0 ? 0 : clamp(val / threshold, 0, 1) * maxPts;
}

function calcBreakoutScore(s) {
  // 1. GROWTH ENGINE (0-25) — Is the company growing fast?
  const g1 = score(s.revGrowth, 40, 7);           // Revenue growth 1Y (7pts, max at 40%+)
  const g2 = score(s.epsGrowth, 40, 7);            // EPS growth 1Y (7pts, max at 40%+)
  const g3 = score(s.ebitdaGrowth, 40, 6);         // EBITDA growth 1Y (6pts, max at 40%+)
  const g4 = score(s.revGrowth5Y, 25, 5);          // 5Y revenue CAGR (5pts, max at 25%+)
  const growthScore = g1 + g2 + g3 + g4;

  // 2. PROFITABILITY & QUALITY (0-25) — Is the growth sustainable?
  const q1 = score(s.roe, 25, 8);                  // ROE (8pts, max at 25%+)
  const q2 = score(s.npm, 20, 5);                  // Net profit margin (5pts, max at 20%+)
  const q3 = score(s.ebitdaMargin, 25, 4);         // EBITDA margin (4pts, max at 25%+)
  const q4 = s.debtEquity != null ? (s.debtEquity <= 0.1 ? 4 : s.debtEquity <= 0.5 ? 3 : s.debtEquity <= 1 ? 2 : s.debtEquity <= 2 ? 1 : 0) : 0;
  const q5 = s.intCoverage != null ? (s.intCoverage >= 10 ? 4 : s.intCoverage >= 5 ? 3 : s.intCoverage >= 3 ? 2 : s.intCoverage >= 1.5 ? 1 : 0) : 0;
  const qualityScore = q1 + q2 + q3 + q4 + q5;

  // 3. MOMENTUM & TREND (0-25) — Is it technically strong?
  const m1 = score(s.ret1Y, 50, 8);                // 1Y return (8pts, max at 50%+)
  const m2 = s.priceAbove200SMA != null ? (s.priceAbove200SMA > 10 ? 5 : s.priceAbove200SMA > 0 ? 3 : s.priceAbove200SMA > -5 ? 1 : 0) : 0;
  const near52WH = s.awayFrom52WH != null ? s.awayFrom52WH : 100;
  const m3 = near52WH <= 5 ? 7 : near52WH <= 10 ? 5 : near52WH <= 20 ? 3 : near52WH <= 30 ? 1 : 0;
  const m4 = s.relVol != null ? (s.relVol >= 2.5 ? 5 : s.relVol >= 1.5 ? 3 : s.relVol >= 1.0 ? 1 : 0) : 0;
  const momentumScore = m1 + m2 + m3 + m4;

  // 4. VALUATION EFFICIENCY (0-15) — Is the growth fairly priced?
  const peg = (s.pe != null && s.epsGrowth != null && s.epsGrowth > 0) ? s.pe / s.epsGrowth : null;
  const v1 = peg != null ? (peg <= 0.5 ? 8 : peg <= 1 ? 6 : peg <= 1.5 ? 4 : peg <= 2 ? 2 : 0) : 0;
  const v2 = s.evEbitda != null ? (s.evEbitda <= 8 ? 7 : s.evEbitda <= 12 ? 5 : s.evEbitda <= 18 ? 3 : s.evEbitda <= 25 ? 1 : 0) : 0;
  const valuationScore = v1 + v2;

  // 5. SMART MONEY (0-10) — Are institutions accumulating?
  const s1 = s.fiiChg3M != null ? (s.fiiChg3M > 1 ? 3 : s.fiiChg3M > 0 ? 2 : s.fiiChg3M > -0.5 ? 1 : 0) : 0;
  const s2 = s.mfChg3M != null ? (s.mfChg3M > 1 ? 3 : s.mfChg3M > 0 ? 2 : s.mfChg3M > -0.5 ? 1 : 0) : 0;
  const s3 = s.promoterChg3M != null ? (s.promoterChg3M > 0.5 ? 4 : s.promoterChg3M >= 0 ? 3 : s.promoterChg3M > -1 ? 1 : 0) : (s.promoterHolding != null && s.promoterHolding > 50 ? 2 : 0);
  const smartMoneyScore = s1 + s2 + s3;

  const total = Math.round(growthScore + qualityScore + momentumScore + valuationScore + smartMoneyScore);

  return {
    total,
    growth: Math.round(growthScore),
    quality: Math.round(qualityScore),
    momentum: Math.round(momentumScore),
    valuation: Math.round(valuationScore),
    smartMoney: Math.round(smartMoneyScore),
    peg: peg != null ? Math.round(peg * 10) / 10 : null,
  };
}

function buildHtml(stocks, updatedAt) {
  const dataJson = JSON.stringify({ stocks, updatedAt });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Creamy Layer Stocks - India</title>
<script>
(function(){var s=localStorage.getItem('creamy-theme');var p=s||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',p)})();
</script>
<style>
:root,html[data-theme="dark"]{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#a855f7;--tx:#e8e8f0;--t2:#9898b0;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7;--tl:#06b6d4;--hdr-bg:linear-gradient(135deg,#1a1028,#12121a);--shadow:0 8px 24px rgba(0,0,0,.4);--row-hover:rgba(168,85,247,.04);--card-border:rgba(42,42,56,.4)}
html[data-theme="light"]{--bg:#f8f9fc;--s1:#ffffff;--s2:#ffffff;--s3:#eef0f5;--bd:#d5d8e0;--ac:#6d28d9;--tx:#1e1e32;--t2:#44495e;--t3:#6b7188;--gn:#15803d;--rd:#b91c1c;--yw:#a16207;--bl:#1d4ed8;--pp:#6d28d9;--tl:#0e7490;--hdr-bg:linear-gradient(135deg,#eee8f6,#eaecf2);--shadow:0 4px 16px rgba(0,0,0,.07);--row-hover:rgba(109,40,217,.03);--card-border:rgba(0,0,0,.08)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);overflow-x:hidden;line-height:1.55;transition:background .3s,color .3s}
.header{background:var(--hdr-bg);border-bottom:1px solid var(--bd);padding:18px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);transition:background .3s}
.header h1{font-size:1.4rem;font-weight:700;background:linear-gradient(90deg,var(--pp),var(--tl));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .subtitle{font-size:.78rem;color:var(--t2);margin-top:3px}
.header-right{display:flex;align-items:center;gap:12px}
.status{font-size:.74rem;color:var(--t2)}
.back-link{color:var(--t2);text-decoration:none;font-size:.82rem;padding:7px 14px;border:1px solid var(--bd);border-radius:6px;transition:all .2s}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
.theme-toggle{width:42px;height:24px;border-radius:12px;border:1px solid var(--bd);background:var(--s3);cursor:pointer;position:relative;transition:all .3s;flex-shrink:0}
.theme-toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--ac);transition:transform .3s,background .3s}
html[data-theme="light"] .theme-toggle{background:var(--s3);border-color:var(--bd)}
html[data-theme="light"] .theme-toggle::after{transform:translateX(18px);background:var(--ac)}
.theme-label{font-size:.68rem;color:var(--t3);white-space:nowrap}
.stats-bar{display:flex;gap:12px;padding:16px 28px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap;transition:background .3s}
.stat-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:12px 18px;min-width:135px;transition:background .3s,border .3s}
.stat-card .label{font-size:.7rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.stat-card .value{font-size:1.35rem;font-weight:700}
.stat-card .value.purple{color:var(--pp)}
.stat-card .value.green{color:var(--gn)}
.stat-card .value.red{color:var(--rd)}
.stat-card .value.blue{color:var(--bl)}
.stat-card .value.teal{color:var(--tl)}
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
td{padding:10px 12px;border-bottom:1px solid var(--card-border);white-space:nowrap;transition:background .15s}
tr:hover td{background:var(--row-hover)}
.stock-name{max-width:230px;overflow:hidden;text-overflow:ellipsis}
.stock-name a{color:var(--tx);text-decoration:none;font-weight:600;font-size:.88rem;transition:color .2s}
.stock-name a:hover{color:var(--ac)}
.stock-name .ticker{color:var(--t2);font-size:.74rem;font-weight:400;margin-top:1px}
.stock-name .sector{color:var(--t3);font-size:.68rem}
.pos{color:var(--gn)}.neg{color:var(--rd)}
.tag{display:inline-block;padding:3px 10px;border-radius:5px;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.tag-high{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.tag-avg{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.25)}
.tag-low{background:rgba(239,68,68,.1);color:var(--rd);border:1px solid rgba(239,68,68,.25)}
.tag-creamy{background:rgba(168,85,247,.15);color:var(--pp);border:1px solid rgba(168,85,247,.35);font-weight:700;font-size:.74rem;padding:3px 10px}
.score-bar{display:inline-flex;gap:3px;align-items:center}
.score-pip{width:9px;height:9px;border-radius:2px;display:inline-block}
.bo-score{display:inline-flex;align-items:center;gap:8px}
.bo-ring{width:38px;height:38px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:.82rem;font-weight:800;border:3px solid}
.bo-ring.s-high{border-color:var(--gn);color:var(--gn);background:rgba(34,197,94,.08)}
.bo-ring.s-med{border-color:var(--yw);color:var(--yw);background:rgba(234,179,8,.06)}
.bo-ring.s-low{border-color:var(--t3);color:var(--t3);background:rgba(90,90,112,.06)}
html[data-theme="light"] .bo-ring.s-high{background:rgba(21,128,61,.08);border-color:var(--gn);color:var(--gn)}
html[data-theme="light"] .bo-ring.s-med{background:rgba(161,98,7,.07);border-color:var(--yw);color:var(--yw)}
html[data-theme="light"] .bo-ring.s-low{background:rgba(107,113,136,.08);border-color:var(--t3);color:var(--t3)}
html[data-theme="light"] .tag-high{background:rgba(21,128,61,.08);color:#15803d;border-color:rgba(21,128,61,.2)}
html[data-theme="light"] .tag-avg{background:rgba(161,98,7,.07);color:#92400e;border-color:rgba(161,98,7,.18)}
html[data-theme="light"] .tag-low{background:rgba(185,28,28,.06);color:#991b1b;border-color:rgba(185,28,28,.18)}
html[data-theme="light"] .tag-creamy{background:rgba(109,40,217,.08);color:#5b21b6;border-color:rgba(109,40,217,.22)}
html[data-theme="light"] .mcap-large{background:rgba(29,78,216,.07);color:#1e40af;border-color:rgba(29,78,216,.18)}
html[data-theme="light"] .mcap-mid{background:rgba(109,40,217,.07);color:#5b21b6;border-color:rgba(109,40,217,.18)}
html[data-theme="light"] .mcap-small{background:rgba(161,98,7,.07);color:#92400e;border-color:rgba(161,98,7,.18)}
html[data-theme="light"] .stat-card{background:#fff;border-color:#dfe2ea;box-shadow:0 1px 3px rgba(0,0,0,.04)}
html[data-theme="light"] .stock-card{background:#fff;border-color:#dfe2ea;box-shadow:0 1px 4px rgba(0,0,0,.05)}
html[data-theme="light"] th{background:#f5f6fa;color:#5b21b6}
html[data-theme="light"] .btn.active{background:#6d28d9;border-color:#6d28d9}
html[data-theme="light"] .filter-group{background:#f5f6fa;border-color:#dfe2ea}
.bo-mini{display:flex;flex-direction:column;gap:2px}
.bo-mini-row{display:flex;align-items:center;gap:4px;font-size:.6rem;color:var(--t3);font-weight:500}
.bo-mini-bar{width:44px;height:5px;background:var(--s3);border-radius:3px;overflow:hidden}
.bo-mini-fill{height:100%;border-radius:3px}
.mcap-label{font-size:.68rem;padding:2px 7px;border-radius:4px;font-weight:600}
.mcap-large{background:rgba(59,130,246,.12);color:var(--bl);border:1px solid rgba(59,130,246,.25)}
.mcap-mid{background:rgba(168,85,247,.12);color:var(--pp);border:1px solid rgba(168,85,247,.25)}
.mcap-small{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.25)}
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.76rem;border-top:1px solid var(--bd);transition:background .3s}

#cards-container{display:none;padding:0 14px 24px}
.stock-card{background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:12px;transition:background .3s,border .3s;box-shadow:0 1px 4px rgba(0,0,0,.04)}
.stock-card .card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.stock-card .card-name{font-weight:600;font-size:.92rem;line-height:1.35}
.stock-card .card-name a{color:var(--tx);text-decoration:none}
.stock-card .card-ticker{color:var(--t2);font-size:.74rem;margin-top:3px}
.stock-card .card-price{text-align:right}
.stock-card .card-price .price{font-size:1.1rem;font-weight:700}
.stock-card .card-price .change{font-size:.82rem;font-weight:600}
.stock-card .card-row{display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--card-border);font-size:.8rem}
.stock-card .card-label{color:var(--t2)}
.stock-card .card-val{font-weight:500}
.stock-card .card-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--card-border)}
.sort-select{display:none}
${alertSystem.css}
/* ─────── Deep Research AI ─────── */
.research-btn{background:none;border:none;cursor:pointer;padding:1px 4px;border-radius:4px;font-size:.82rem;color:var(--t3);transition:color .15s;vertical-align:middle;margin-left:2px;line-height:1;flex-shrink:0}.research-btn:hover{color:#a78bfa}
#dr-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9991;overflow-y:auto;padding:20px 12px}
#dr-modal{background:var(--card-bg, var(--s2,#1a1a24));border:1px solid var(--card-border, var(--bd,#2a2a38));border-radius:14px;max-width:640px;margin:20px auto;padding:22px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.dr-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--card-border, var(--bd,#2a2a38))}
.dr-title{font-size:1.1rem;font-weight:700}.dr-subtitle{font-size:.75rem;color:var(--t2,#8888a0);margin-top:3px}
#dr-close{background:none;border:none;cursor:pointer;color:var(--t3,#5a5a70);font-size:1.2rem;padding:0;line-height:1;flex-shrink:0}
.dr-section{margin-bottom:18px}.dr-section-title{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--green,#00d4aa);font-weight:700;margin-bottom:8px}
.dr-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dr-metric{background:var(--header-bg,var(--s1,#12121a));border:1px solid var(--card-border,var(--bd,#2a2a38));border-radius:8px;padding:10px 12px}.dr-metric .dm-label{font-size:.65rem;color:var(--t2,#8888a0);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}.dr-metric .dm-val{font-size:.9rem;font-weight:600}.dr-metric .dm-sub{font-size:.65rem;color:var(--t3,#5a5a70);margin-top:2px}
.dr-signal{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:7px;margin-bottom:5px;font-size:.8rem;line-height:1.4}.dr-signal.bull{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.18);color:#22c55e}.dr-signal.bear{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);color:#ef4444}.dr-signal.neut{background:rgba(234,179,8,.07);border:1px solid rgba(234,179,8,.18);color:#eab308}.dr-signal .ds-icon{flex-shrink:0;margin-top:1px}
.dr-ai-box{background:var(--header-bg,var(--s1,#12121a));border:1px solid var(--card-border,var(--bd,#2a2a38));border-radius:10px;padding:14px;font-size:.82rem;line-height:1.7;min-height:80px}.dr-ai-box.loading{color:var(--t2,#8888a0);font-style:italic}
.dr-ai-error{color:#ef4444;font-size:.78rem;padding:6px 0}.dr-ai-key-row{display:flex;gap:8px;margin-top:10px;align-items:center}
.dr-ai-key-input{flex:1;padding:7px 10px;border-radius:6px;border:1px solid var(--card-border,var(--bd,#2a2a38));background:var(--card-bg,var(--s2,#1a1a24));font-size:.78rem;font-family:inherit;outline:none;transition:border .2s}
.dr-ai-key-btn{padding:7px 14px;border:none;border-radius:6px;background:#a78bfa;color:#fff;cursor:pointer;font-size:.78rem;font-weight:700;font-family:inherit;white-space:nowrap}.dr-ai-key-btn:hover{background:#9061f9}
@media(max-width:768px){#dr-overlay{padding:0}#dr-modal{border-radius:0;min-height:100dvh;margin:0;max-width:100%}.dr-grid{grid-template-columns:1fr}}

@media(max-width:768px){
  .header{padding:14px 16px}
  .header h1{font-size:1.1rem}
  .header .subtitle{font-size:.68rem}
  .stats-bar{padding:12px 14px;gap:8px}
  .stat-card{min-width:0;flex:1 1 calc(33.3% - 8px);padding:10px 12px}
  .stat-card .label{font-size:.62rem}
  .stat-card .value{font-size:1.05rem}
  .controls{padding:12px 14px;gap:8px}
  .controls .label{display:none}
  .filter-group{flex-wrap:wrap;width:100%}
  .filter-group .fg-label{width:100%;padding:2px 6px}
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
    <h1>Creamy Layer Stocks</h1>
    <div class="subtitle">Multi-source analysis: Tickertape scorecards + Yahoo Finance consensus &amp; estimates</div>
  </div>
  <div class="header-right">
    <div class="status" id="status-text"></div>
    <span class="theme-label" id="theme-label">Dark</span>
    <div class="theme-toggle" id="theme-toggle" title="Toggle dark/light mode"></div>
    <a href="breakout.html" class="back-link">Breakout Scanner</a>
    <a href="index.html" class="back-link">My Watchlist</a>
  </div>
</div>

<div class="stats-bar" id="stats-bar"></div>

${alertSystem.bannerHtml}
${alertSystem.modalHtml}

<div id="dr-overlay">
  <div id="dr-modal">
    <div class="dr-header">
      <div><div class="dr-title" id="dr-title">Deep Research</div><div class="dr-subtitle" id="dr-subtitle"></div></div>
      <button id="dr-close">&#x2715;</button>
    </div>
    <div id="dr-content"></div>
  </div>
</div>

<div class="controls">
  <div class="filter-group">
    <span class="fg-label">Breakout</span>
    <button class="btn bo-btn active" data-bo="0">All</button>
    <button class="btn bo-btn" data-bo="40">40+</button>
    <button class="btn bo-btn" data-bo="55">55+</button>
    <button class="btn bo-btn" data-bo="65">65+</button>
  </div>
  <div class="filter-group">
    <span class="fg-label">Scorecard</span>
    <button class="btn score-btn active" data-min="1">1+</button>
    <button class="btn score-btn" data-min="2">2+</button>
    <button class="btn score-btn" data-min="3">3+</button>
    <button class="btn score-btn" data-min="4">4/4</button>
  </div>
  <div class="filter-group">
    <span class="fg-label">Cap</span>
    <button class="btn cap-btn active" data-cap="Large">Large</button>
    <button class="btn cap-btn active" data-cap="Mid">Mid</button>
    <button class="btn cap-btn active" data-cap="Small">Small</button>
  </div>
  <div class="multi-dd" id="sector-dd">
    <button class="dd-btn" type="button"><span id="sector-label">All Sectors</span><span class="dd-arrow">\\u25BC</span></button>
    <div class="dd-panel" id="sector-panel"></div>
  </div>
  <input type="text" class="search" id="search" placeholder="Search ticker, name or sector..." style="margin-left:auto">
  <select id="sort-select" class="search sort-select">
    <option value="breakoutTotal:desc">Sort: Breakout Score (best)</option>
    <option value="buyPct:desc">Sort: Consensus (most bullish)</option>
    <option value="upside:desc">Sort: Projected Return (best)</option>
    <option value="forwardPE:asc">Sort: Forward PE (lowest)</option>
    <option value="earningsGrowthQ:desc">Sort: Earnings Growth (best)</option>
    <option value="scoreTotal:desc">Sort: Scorecard (4 High)</option>
    <option value="marketCap:desc">Sort: Market Cap</option>
    <option value="ret1Y:desc">Sort: 1Y Return (best)</option>
    <option value="roe:desc">Sort: ROE (highest)</option>
    <option value="debtEquity:asc">Sort: Debt/Equity (lowest)</option>
    <option value="name:asc">Sort: Name A-Z</option>
  </select>
</div>

<div class="table-container">
  <table><thead><tr id="table-head"></tr></thead><tbody id="table-body"></tbody></table>
</div>
<div id="cards-container"></div>
<div class="footer" id="footer"></div>
<div style="text-align:center;padding:8px 24px 16px;font-size:.65rem;color:var(--t3)">
  Data sources: <strong>Tickertape</strong> (scorecards, ratios, ownership) \\u00B7 <strong>Yahoo Finance</strong> (analyst consensus, target prices, forward estimates, earnings growth) \\u00B7 <strong>NSE India</strong> (exchange data via Yahoo)
</div>

<script>
const RAW = ${dataJson};
const allStocks = RAW.stocks;

let sortCol = 'breakoutTotal', sortAsc = false, minBO = 0, minScore = 1, activeCaps = new Set(['Large','Mid','Small']), activeSectors = new Set(), searchTerm = '';

const COLS = [
  {key:'rank',label:'#',w:'36px'},
  {key:'name',label:'Stock',w:'190px'},
  {key:'breakoutTotal',label:'Breakout',w:'140px',num:true},
  {key:'buyPct',label:'Consensus',w:'85px',num:true},
  {key:'upside',label:'Projected',w:'80px',num:true},
  {key:'price',label:'Price',w:'75px',num:true},
  {key:'forwardPE',label:'Fwd PE',w:'60px',num:true},
  {key:'earningsGrowthQ',label:'EPS Qtr',w:'65px',num:true},
  {key:'ret1Y',label:'1Y',w:'58px',num:true},
  {key:'perfTag',label:'Perf',w:'55px'},
  {key:'growthTag',label:'Grw',w:'50px'},
  {key:'profitTag',label:'Prf',w:'50px'},
  {key:'valTag',label:'Val',w:'50px'},
  {key:'roe',label:'ROE',w:'52px',num:true},
  {key:'debtEquity',label:'D/E',w:'48px',num:true},
  {key:'marketCap',label:'Mkt Cap',w:'78px',num:true},
];

function buildHead(){
  document.getElementById('table-head').innerHTML=COLS.map(c=>
    '<th style="width:'+c.w+'" class="'+(sortCol===c.key?'sorted':'')+'" onclick="doSort(\\''+c.key+'\\','+!!c.num+')">'+c.label+'<span class="arrow">'+(sortCol===c.key?(sortAsc?'\\u25B2':'\\u25BC'):'\\u21C5')+'</span></th>'
  ).join('');
}

function fmt(n,d){return n==null?'\\u2014':Number(n).toFixed(d??2)}
function fmtCr(n){
  if(n==null)return'\\u2014';
  if(n>=1e5)return(n/1e5).toFixed(0)+'LCr';
  if(n>=100)return(n).toFixed(0)+'Cr';
  return n.toFixed(1)+'Cr';
}
function retHtml(v){
  if(v==null)return'<span style="color:var(--t3)">\\u2014</span>';
  const cls=v>=0?'pos':'neg';
  return'<span class="'+cls+'">'+(v>=0?'+':'')+v.toFixed(1)+'%</span>';
}
function tagHtml(t){
  if(!t)return'<span class="tag" style="opacity:.3">\\u2014</span>';
  const c=t==='High'?'tag-high':t==='Avg'?'tag-avg':'tag-low';
  return'<span class="tag '+c+'">'+t+'</span>';
}
function mcapHtml(label){
  if(!label)return'';
  const c=label==='Large'?'mcap-large':label==='Mid'?'mcap-mid':'mcap-small';
  return'<span class="mcap-label '+c+'">'+label+'</span>';
}
function scoreHtml(n){
  const pips=[];
  for(let i=0;i<4;i++){
    const col=i<n?'var(--gn)':'var(--s3)';
    pips.push('<span class="score-pip" style="background:'+col+'"></span>');
  }
  return'<span class="score-bar">'+pips.join('')+' <span style="font-size:.72rem;font-weight:700;color:'+(n>=3?'var(--gn)':n>=2?'var(--yw)':'var(--t3)')+'">'+n+'/4</span></span>';
}
function upsideHtml(v){
  if(v==null)return'<span style="color:var(--t3);font-size:.72rem">\\u2014</span>';
  const cls=v>=20?'pos':v>=0?'':'neg';
  const icon=v>=20?'\\u{1F525}':v>=0?'\\u25B2':'\\u25BC';
  return'<span class="'+cls+'" style="font-weight:700">'+icon+(v>=0?'+':'')+v.toFixed(1)+'%</span>';
}
function recoHtml(key,n){
  if(!key)return'<span style="color:var(--t3)">\\u2014</span>';
  const map={strong_buy:{c:'var(--gn)',l:'Strong Buy'},buy:{c:'var(--gn)',l:'Buy'},hold:{c:'var(--yw)',l:'Hold'},sell:{c:'var(--rd)',l:'Sell'},strong_sell:{c:'var(--rd)',l:'Str Sell'}};
  const m=map[key]||{c:'var(--t2)',l:key};
  return'<span style="color:'+m.c+';font-size:.68rem;font-weight:600">'+m.l+'</span>'+(n?'<br><span style="color:var(--t3);font-size:.6rem">'+n+' analysts</span>':'');
}
function consensusHtml(s){
  if(!s.totalAnalysts)return'<span style="color:var(--t3)">\\u2014</span>';
  const pct=s.buyPct||0;
  const col=pct>=75?'var(--gn)':pct>=50?'var(--yw)':'var(--rd)';
  const shift=s.consensusShift||0;
  const arrow=shift>0?'\\u25B2':shift<0?'\\u25BC':'';
  const shiftCol=shift>0?'var(--gn)':shift<0?'var(--rd)':'var(--t3)';
  return '<div style="font-size:.76rem"><span style="color:'+col+';font-weight:700">'+pct+'% Buy</span>'
    +'<br><span style="font-size:.6rem;color:var(--t3)">'+s.totalAnalysts+' analysts</span>'
    +(shift!==0?'<span style="color:'+shiftCol+';font-size:.58rem;margin-left:3px">'+arrow+Math.abs(shift)+'</span>':'')
    +'</div>';
}
function fwdPeHtml(v,trailingPe){
  if(v==null)return'<span style="color:var(--t3)">\\u2014</span>';
  const col=v<=15?'var(--gn)':v<=25?'var(--t2)':v<=40?'var(--yw)':'var(--rd)';
  let discount='';
  if(trailingPe!=null&&trailingPe>0){
    const d=Math.round((1-v/trailingPe)*100);
    if(d>0)discount='<br><span style="font-size:.58rem;color:var(--gn)">-'+d+'% vs trail</span>';
  }
  return '<span style="color:'+col+';font-weight:600;font-size:.78rem">'+v.toFixed(1)+'</span>'+discount;
}
function epsQHtml(v){
  if(v==null)return'<span style="color:var(--t3)">\\u2014</span>';
  const pct=Math.round(v*100);
  const cls=pct>=0?'pos':'neg';
  return '<span class="'+cls+'" style="font-weight:600">'+(pct>=0?'+':'')+pct+'%</span>';
}
function boScoreHtml(s){
  if(!s.breakout)return'\\u2014';
  const b=s.breakout;
  const t=b.total;
  const cls=t>=65?'s-high':t>=40?'s-med':'s-low';
  function miniBar(val,max,label){
    const pct=Math.round(val/max*100);
    const col=pct>=70?'var(--gn)':pct>=40?'var(--yw)':'var(--t3)';
    return '<div class="bo-mini-row"><span style="width:14px">'+label+'</span><div class="bo-mini-bar"><div class="bo-mini-fill" style="width:'+pct+'%;background:'+col+'"></div></div><span>'+val+'</span></div>';
  }
  return '<div class="bo-score"><div class="bo-ring '+cls+'">'+t+'</div><div class="bo-mini">'
    +miniBar(b.growth,25,'G')+miniBar(b.quality,25,'Q')+miniBar(b.momentum,25,'M')+miniBar(b.valuation,15,'V')+miniBar(b.smartMoney,10,'S')
    +'</div></div>';
}
function boCardHtml(s){
  if(!s.breakout)return'';
  const b=s.breakout;
  const t=b.total;
  const cls=t>=65?'s-high':t>=40?'s-med':'s-low';
  function row(label,val,max){
    const pct=Math.round(val/max*100);
    const col=pct>=70?'var(--gn)':pct>=40?'var(--yw)':'var(--t3)';
    return '<div style="display:flex;align-items:center;gap:6px;font-size:.7rem"><span style="width:75px;color:var(--t2)">'+label+'</span><div style="flex:1;height:6px;background:var(--s3);border-radius:3px;overflow:hidden"><div style="width:'+pct+'%;height:100%;background:'+col+';border-radius:3px"></div></div><span style="width:28px;text-align:right;font-weight:600;color:'+col+'">'+val+'/'+max+'</span></div>';
  }
  return '<div style="background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.15);border-radius:8px;padding:10px;margin:6px 0">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><span style="font-size:.72rem;font-weight:600;color:var(--pp)">BREAKOUT SCORE</span><div class="bo-ring '+cls+'" style="width:32px;height:32px;font-size:.72rem">'+t+'</div></div>'
    +row('Growth',b.growth,25)+row('Quality',b.quality,25)+row('Momentum',b.momentum,25)+row('Valuation',b.valuation,15)+row('Smart Money',b.smartMoney,10)
    +(b.peg!=null?'<div style="font-size:.6rem;color:var(--t3);margin-top:4px">PEG Ratio: '+b.peg+'</div>':'')
    +'</div>';
}

function getFiltered(){
  return allStocks.filter(s=>{
    if(minBO>0&&(s.breakoutTotal==null||s.breakoutTotal<minBO))return false;
    if(s.scoreTotal<minScore)return false;
    if(!activeCaps.has(s.mcapLabel))return false;
    if(activeSectors.size>0&&!activeSectors.has(s.sector))return false;
    if(searchTerm){
      const q=searchTerm.toLowerCase();
      if(!s.ticker.toLowerCase().includes(q)&&!s.name.toLowerCase().includes(q)&&!s.sector.toLowerCase().includes(q))return false;
    }
    return true;
  });
}

function renderTable(){
  let filtered=getFiltered();
  filtered.sort((a,b)=>{
    let va=a[sortCol],vb=b[sortCol];
    if(va==null)va=sortAsc?Infinity:-Infinity;
    if(vb==null)vb=sortAsc?Infinity:-Infinity;
    if(typeof va==='string')return sortAsc?va.localeCompare(vb):vb.localeCompare(va);
    return sortAsc?va-vb:vb-va;
  });

  document.getElementById('table-body').innerHTML=filtered.map((s,i)=>{
    return '<tr>'
     +'<td style="color:var(--t3)">'+(i+1)+'</td>'
     +'<td><div class="stock-name"><a href="'+s.url+'" target="_blank">'+s.name+'</a><div class="ticker">'+s.ticker+' '+mcapHtml(s.mcapLabel)+' <span style="color:var(--t3);font-size:.6rem">'+s.sector+'</span></div></div><button class="alert-btn" data-alert-ticker="'+s.ticker+'" data-alert-price="'+(s.price||0)+'" data-alert-name="'+(s.name||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'">&#x1F514;</button><button class="research-btn" data-r-ticker="'+s.ticker+'" title="AI Deep Research">&#x1F9E0;</button></td>'
     +'<td>'+boScoreHtml(s)+'</td>'
     +'<td>'+consensusHtml(s)+'</td>'
     +'<td>'+upsideHtml(s.upside)+'</td>'
     +'<td style="font-weight:600">'+(s.price?'\\u20B9'+fmt(s.price):'\\u2014')+'</td>'
     +'<td>'+fwdPeHtml(s.forwardPE,s.pe)+'</td>'
     +'<td>'+epsQHtml(s.earningsGrowthQ)+'</td>'
     +'<td>'+retHtml(s.ret1Y)+'</td>'
     +'<td>'+tagHtml(s.perfTag)+'</td>'
     +'<td>'+tagHtml(s.growthTag)+'</td>'
     +'<td>'+tagHtml(s.profitTag)+'</td>'
     +'<td>'+tagHtml(s.valTag)+'</td>'
     +'<td>'+(s.roe!=null?'<span class="'+(s.roe>=15?'pos':s.roe>=0?'':'neg')+'">'+fmt(s.roe,1)+'%</span>':'\\u2014')+'</td>'
     +'<td style="color:var(--t2)">'+(s.debtEquity!=null?fmt(s.debtEquity,2):'\\u2014')+'</td>'
     +'<td style="color:var(--t2)">'+fmtCr(s.marketCap)+'</td>'
     +'</tr>';
  }).join('');
  buildHead();

  document.getElementById('cards-container').innerHTML=filtered.map(s=>{
    return '<div class="stock-card">'
     +'<div class="card-header">'
     +'<div><div class="card-name"><a href="'+s.url+'" target="_blank">'+s.name+'</a></div>'
     +'<div class="card-ticker">'+s.ticker+' '+mcapHtml(s.mcapLabel)+' <span style="color:var(--t3);font-size:.62rem">'+s.sector+'</span> <button class="alert-btn" data-alert-ticker="'+s.ticker+'" data-alert-price="'+(s.price||0)+'" data-alert-name="'+(s.name||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'">&#x1F514;</button><button class="research-btn" data-r-ticker="'+s.ticker+'" title="AI Deep Research">&#x1F9E0;</button></div></div>'
     +'<div class="card-price"><div class="price">'+(s.price?'\\u20B9'+fmt(s.price):'\\u2014')+'</div>'
     +'<div class="change '+(s.ret1D>=0?'pos':'neg')+'">'+(s.ret1D!=null?(s.ret1D>=0?'+':'')+fmt(s.ret1D,1)+'%':'')+'</div></div>'
     +'</div>'
     +boCardHtml(s)
     +'<div class="card-row" style="background:rgba(34,197,94,.06);border-radius:6px;padding:6px 8px;margin:4px 0"><span class="card-label" style="font-weight:600">Analyst Consensus</span><span class="card-val">'+consensusHtml(s)+'</span></div>'
     +'<div class="card-row"><span class="card-label">Projected Return</span><span class="card-val">'+upsideHtml(s.upside)+'</span></div>'
     +'<div class="card-row"><span class="card-label">Forward PE / Trail PE</span><span class="card-val">'+(s.forwardPE!=null?fmt(s.forwardPE,1):'\\u2014')+' / '+(s.pe!=null?fmt(s.pe,1):'\\u2014')+'</span></div>'
     +'<div class="card-row"><span class="card-label">EPS Qtr Growth</span><span class="card-val">'+epsQHtml(s.earningsGrowthQ)+'</span></div>'
     +'<div class="card-row"><span class="card-label">1Y Return</span><span class="card-val">'+retHtml(s.ret1Y)+'</span></div>'
     +'<div class="card-row"><span class="card-label">ROE / D/E</span><span class="card-val">'+(s.roe!=null?fmt(s.roe,1)+'%':'\\u2014')+' / '+(s.debtEquity!=null?fmt(s.debtEquity,2):'\\u2014')+'</span></div>'
     +'<div class="card-row"><span class="card-label">Market Cap</span><span class="card-val">'+fmtCr(s.marketCap)+'</span></div>'
     +'<div class="card-tags">'
     +'<span class="tag tag-creamy">CREAMY</span>'
     +tagHtml(s.growthTag)+tagHtml(s.profitTag)+tagHtml(s.valTag)
     +'</div></div>';
  }).join('');

  document.getElementById('footer').textContent='Showing '+filtered.length+' of '+allStocks.length+' creamy layer stocks';
}

function renderStats(){
  const total=allStocks.length;
  const withBO=allStocks.filter(s=>s.breakoutTotal!=null);
  const avgBO=withBO.length?withBO.reduce((a,s)=>a+s.breakoutTotal,0)/withBO.length:0;
  const highBO=withBO.filter(s=>s.breakoutTotal>=65).length;
  const withConsensus=allStocks.filter(s=>s.totalAnalysts>0);
  const avgBuyPct=withConsensus.length?withConsensus.reduce((a,s)=>a+(s.buyPct||0),0)/withConsensus.length:0;
  const withUpside=allStocks.filter(s=>s.upside!=null);
  const avgUpside=withUpside.length?withUpside.reduce((a,s)=>a+s.upside,0)/withUpside.length:0;
  const upgrades=allStocks.filter(s=>s.consensusShift>0).length;

  document.getElementById('stats-bar').innerHTML=[
    {l:'Creamy Layer',v:total,c:'purple'},
    {l:'Breakout 65+',v:highBO,c:'green'},
    {l:'Avg Breakout',v:avgBO.toFixed(0)+'/100',c:avgBO>=50?'green':'red'},
    {l:'Avg Buy %',v:avgBuyPct.toFixed(0)+'%',c:avgBuyPct>=60?'green':'red'},
    {l:'Avg Projected',v:(avgUpside>=0?'+':'')+avgUpside.toFixed(1)+'%',c:avgUpside>=0?'green':'red'},
    {l:'Analyst Coverage',v:withConsensus.length+'/'+total,c:'teal'},
    {l:'Recent Upgrades',v:upgrades,c:'green'},
  ].map(s=>'<div class="stat-card"><div class="label">'+s.l+'</div><div class="value '+s.c+'">'+s.v+'</div></div>').join('');
}

function populateSectors(){
  const sectors=[...new Set(allStocks.map(s=>s.sector))].filter(Boolean).sort();
  const panel=document.getElementById('sector-panel');
  panel.innerHTML='<div class="dd-actions"><button onclick="sectorAll()">Select All</button><button onclick="sectorNone()">Clear All</button></div>'
    +sectors.map(s=>{
      const c=allStocks.filter(x=>x.sector===s).length;
      return'<label><input type="checkbox" value="'+s+'" class="sector-cb"><span>'+s+'</span><span class="dd-count">'+c+'</span></label>';
    }).join('');
  panel.querySelectorAll('.sector-cb').forEach(cb=>{
    cb.addEventListener('change',()=>{
      if(cb.checked)activeSectors.add(cb.value);else activeSectors.delete(cb.value);
      updateSectorLabel();renderTable();
    });
  });
}
function updateSectorLabel(){
  const el=document.getElementById('sector-label');
  if(activeSectors.size===0)el.textContent='All Sectors';
  else if(activeSectors.size<=2)el.textContent=[...activeSectors].join(', ');
  else el.textContent=activeSectors.size+' Sectors';
}
function sectorAll(){
  document.querySelectorAll('.sector-cb').forEach(cb=>{cb.checked=true;activeSectors.add(cb.value);});
  updateSectorLabel();renderTable();
}
function sectorNone(){
  document.querySelectorAll('.sector-cb').forEach(cb=>{cb.checked=false;});
  activeSectors.clear();updateSectorLabel();renderTable();
}

function doSort(col,isNum){
  if(sortCol===col)sortAsc=!sortAsc;
  else{sortCol=col;sortAsc=isNum?false:true;}
  renderTable();
}

// Breakout filter (exclusive within group)
document.querySelectorAll('.bo-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.bo-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    minBO=parseInt(btn.dataset.bo);
    renderTable();
  });
});

// Score filter (exclusive within group)
document.querySelectorAll('.score-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.score-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    minScore=parseInt(btn.dataset.min);
    renderTable();
  });
});

// Market cap filter (multi-select toggle)
document.querySelectorAll('.cap-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const cap=btn.dataset.cap;
    if(activeCaps.has(cap)){
      if(activeCaps.size>1){activeCaps.delete(cap);btn.classList.remove('active');}
    }else{activeCaps.add(cap);btn.classList.add('active');}
    renderTable();
  });
});

// Sector dropdown toggle
document.getElementById('sector-dd').querySelector('.dd-btn').addEventListener('click',e=>{
  e.stopPropagation();
  document.getElementById('sector-dd').classList.toggle('open');
});
document.addEventListener('click',e=>{
  if(!e.target.closest('#sector-dd'))document.getElementById('sector-dd').classList.remove('open');
});

document.getElementById('search').addEventListener('input',e=>{searchTerm=e.target.value;renderTable();});
document.getElementById('sort-select').addEventListener('change',e=>{
  const[col,dir]=e.target.value.split(':');
  sortCol=col;sortAsc=dir==='asc';
  renderTable();
});

const t=new Date(RAW.updatedAt);
document.getElementById('status-text').textContent='Updated: '+t.toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' IST';

(function initTheme(){
  const saved=localStorage.getItem('creamy-theme');
  const pref=saved||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');
  document.documentElement.setAttribute('data-theme',pref);
  document.getElementById('theme-label').textContent=pref==='dark'?'Dark':'Light';
})();
document.getElementById('theme-toggle').addEventListener('click',function(){
  const cur=document.documentElement.getAttribute('data-theme')||'dark';
  const next=cur==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',next);
  localStorage.setItem('creamy-theme',next);
  document.getElementById('theme-label').textContent=next==='dark'?'Dark':'Light';
});

renderStats();populateSectors();renderTable();
${alertSystem.js}
// ─────── Deep Research AI ───────
(function(){
  var DR_KEY='dr_gemini_key';
  var DR_MODEL_KEY='dr_gemini_model';
  var DR_MODELS=[{id:'gemini-2.0-flash-lite',label:'Gemini 2.0 Flash Lite \u2014 30 req/min free \u2605'},{id:'gemini-2.0-flash',label:'Gemini 2.0 Flash \u2014 15 req/min free'},{id:'gemini-1.5-flash-8b',label:'Gemini 1.5 Flash 8B \u2014 15 req/min free'}];
  var drCur=null;
  document.addEventListener('click',function(e){
    var btn=e.target.closest('.research-btn');if(!btn)return;e.stopPropagation();
    var ticker=btn.dataset.rTicker;
    var s=allStocks.find(function(x){return x.ticker===ticker;});
    if(!s)return;
    drCur=s;
    document.getElementById('dr-title').textContent=s.name;
    document.getElementById('dr-subtitle').textContent=s.ticker+' \u00b7 NSE India \u00b7 '+s.sector;
    document.getElementById('dr-content').innerHTML=buildDrContent(s);
    document.getElementById('dr-overlay').style.display='block';
    document.body.style.overflow='hidden';
    var key=localStorage.getItem(DR_KEY);
    var savedModel=localStorage.getItem(DR_MODEL_KEY)||'gemini-2.0-flash-lite';
    var sel=document.getElementById('dr-model-select');if(sel)sel.value=savedModel;
    if(key){var inp=document.getElementById('dr-key-input');if(inp)inp.value='\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';runGeminiAnalysis(s,key,savedModel);}
  });
  document.getElementById('dr-close').addEventListener('click',closeDr);
  document.getElementById('dr-overlay').addEventListener('click',function(e){if(e.target===document.getElementById('dr-overlay'))closeDr();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDr();});
  function closeDr(){document.getElementById('dr-overlay').style.display='none';document.body.style.overflow='';}
  window.drRunWithKey=function(){
    var inp=document.getElementById('dr-key-input');if(!inp)return;
    var key=inp.value.trim();
    if(key.indexOf('\u2022')!==-1)key=localStorage.getItem(DR_KEY)||'';
    if(!key){inp.focus();return;}
    localStorage.setItem(DR_KEY,key);inp.value='\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    var sel=document.getElementById('dr-model-select');var model=(sel&&sel.value)||localStorage.getItem(DR_MODEL_KEY)||'gemini-2.0-flash-lite';localStorage.setItem(DR_MODEL_KEY,model);
    if(drCur)runGeminiAnalysis(drCur,key,model);
  };
  function tagHtmlDr(tag){
    if(!tag)return'<span style="opacity:.3">\u2014</span>';
    var cls=tag==='High'?'style="color:#22c55e"':tag==='Avg'?'style="color:#eab308"':'style="color:#ef4444"';
    return'<span '+cls+'>'+tag+'</span>';
  }
  function buildDrContent(s){
    var relVol=(s.volume&&s.avgVolume)?(s.volume/s.avgVolume):null;
    var signals=[];
    if(s.ret1D!=null){if(s.ret1D>=5)signals.push({type:'bull',icon:'\u25b2',text:'Strong day: +'+(s.ret1D).toFixed(1)+'% \u2014 bullish momentum.'});else if(s.ret1D<=-5)signals.push({type:'bear',icon:'\u25bc',text:'Weak day: '+(s.ret1D).toFixed(1)+'% \u2014 selling pressure.'});}
    if(s.upside!=null){if(s.upside>=20)signals.push({type:'bull',icon:'\u25b2',text:'High analyst upside: '+s.upside.toFixed(0)+'% \u2014 consensus sees meaningful appreciation.'});else if(s.upside<0)signals.push({type:'bear',icon:'\u25bc',text:'Negative analyst upside: '+s.upside.toFixed(0)+'% \u2014 consensus below current price.'});}
    if(s.earningsGrowthQ!=null&&s.earningsGrowthQ>25)signals.push({type:'bull',icon:'\u25b2',text:'Q earnings growth: +'+s.earningsGrowthQ.toFixed(0)+'% \u2014 accelerating earnings.'});
    if(s.roe!=null){if(s.roe>=20)signals.push({type:'bull',icon:'\u25c6',text:'High ROE '+s.roe.toFixed(1)+'% \u2014 capital-efficient business.'});else if(s.roe<5)signals.push({type:'neut',icon:'\u25c6',text:'Low ROE '+s.roe.toFixed(1)+'% \u2014 check if structural or cyclical.'});}
    if(!signals.length)signals.push({type:'neut',icon:'\u25c6',text:'No strong immediate signals from available data.'});
    var score=0;
    if(s.perfTag==='High')score+=2;else if(s.perfTag==='Low')score-=2;
    if(s.growthTag==='High')score+=1;else if(s.growthTag==='Low')score-=1;
    if(s.profitTag==='High')score+=1;else if(s.profitTag==='Low')score-=1;
    if(s.upside!=null&&s.upside>20)score+=1;
    var stance=score>=3?'bull':score<=-2?'bear':'neut';
    var stanceLbl=stance==='bull'?'\u25b2 Bullish Setup':stance==='bear'?'\u25bc Bearish Setup':'\u25c6 Neutral Setup';
    var stanceCls=stance==='bull'?'style="color:#22c55e"':stance==='bear'?'style="color:#ef4444"':'';
    function dm(lbl,val,sub,cls){return'<div class="dr-metric"><div class="dm-label">'+lbl+'</div><div class="dm-val'+(cls?' '+cls:'')+'">'+val+'</div>'+(sub?'<div class="dm-sub">'+sub+'</div>':'')+'</div>';}
    var chgSign=(s.ret1D||0)>=0?'+':'';
    var html='<div class="dr-section"><div class="dr-section-title">\ud83d\udcca Price Metrics</div><div class="dr-grid">'
      +dm('Current Price',s.price?'\u20b9'+s.price.toFixed(2):'\u2014',s.ret1D!=null?chgSign+s.ret1D.toFixed(2)+'% today':'',(s.ret1D||0)>=0?'pos':'neg')
      +dm('Market Cap',s.marketCap?(s.marketCap>=1e12?(s.marketCap/1e12).toFixed(1)+'T':s.marketCap>=1e7?(s.marketCap/1e7).toFixed(0)+'Cr':'\u2014'):'\u2014','','')
      +dm('Analyst Upside',s.upside!=null?s.upside.toFixed(0)+'%':'\u2014',(s.consensus||'')+'',s.upside!=null?(s.upside>=15?'pos':s.upside<0?'neg':''):'')
      +dm('Fwd PE / PE',s.forwardPE!=null?s.forwardPE.toFixed(1):'\u2014',s.pe!=null?'Trail '+s.pe.toFixed(1):'',' ')
      +dm('ROE',s.roe!=null?s.roe.toFixed(1)+'%':'\u2014',s.debtEquity!=null?'D/E '+s.debtEquity.toFixed(2):'',(s.roe||0)>=15?'pos':'')
      +dm('EPS Qtr Growth',s.earningsGrowthQ!=null?(s.earningsGrowthQ>=0?'+':'')+s.earningsGrowthQ.toFixed(0)+'%':'\u2014','',s.earningsGrowthQ!=null?(s.earningsGrowthQ>0?'pos':'neg'):'')
      +'</div></div>';
    html+='<div class="dr-section"><div class="dr-section-title">\ud83d\udcc8 Signals</div>';
    for(var i=0;i<signals.length;i++)html+='<div class="dr-signal '+signals[i].type+'"><span class="ds-icon">'+signals[i].icon+'</span><span>'+signals[i].text+'</span></div>';
    html+='</div>';
    html+='<div class="dr-section"><div class="dr-section-title">\ud83c\udfe2 Fundamental Scorecard</div><div class="dr-grid">'
      +dm('Performance',tagHtmlDr(s.perfTag),'','')
      +dm('Growth',tagHtmlDr(s.growthTag),'','')
      +dm('Profitability',tagHtmlDr(s.profitTag),'','')
      +dm('Valuation',tagHtmlDr(s.valTag),'','')
      +'</div><div style="margin-top:8px;padding:8px 12px;border-radius:8px;background:var(--header-bg,#12121a);border:1px solid var(--card-border,#2a2a38);font-size:.78rem">Overall: <strong '+stanceCls+'>'+stanceLbl+'</strong></div></div>';
    html+='<div class="dr-section"><div class="dr-section-title">\ud83e\udde0 AI Deep Analysis <span style="font-size:.6rem;font-weight:400;text-transform:none;opacity:.6">(Google Gemini)</span></div>'
      +'<div id="dr-ai-box" class="dr-ai-box loading">Enter your Gemini API key below to get AI-powered analysis \u2014 technical, fundamental, risks &amp; verdict.</div>'
      +'<div id="dr-ai-error" class="dr-ai-error" style="display:none"></div>'
      +'<div style="margin-bottom:6px"><select id="dr-model-select" style="width:100%;background:var(--header-bg,#12121a);color:var(--t1,#e4e4ea);border:1px solid var(--card-border,#2a2a38);border-radius:6px;padding:7px 10px;font-size:.78rem;cursor:pointer">'
      +DR_MODELS.map(function(m){return'<option value="'+m.id+'">'+m.label+'</option>';}).join('')
      +'</select></div>'
      +'<div class="dr-ai-key-row"><input type="password" class="dr-ai-key-input" id="dr-key-input" placeholder="Paste Gemini API key (saved in browser)"><button class="dr-ai-key-btn" onclick="drRunWithKey()">Analyse \u2726</button></div>'
      +'<div style="font-size:.62rem;color:var(--t3,#5a5a70);margin-top:5px">Free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" style="color:#00d4aa">aistudio.google.com</a> \u00b7 Stored only in your browser</div>'
      +'</div>';
    return html;
  }
  function runGeminiAnalysis(s,apiKey,model){
    var box=document.getElementById('dr-ai-box');
    var errEl=document.getElementById('dr-ai-error');
    if(!box)return;
    box.className='dr-ai-box loading';box.textContent='\u23f3 Analysing '+s.name+' with Gemini AI\u2026';errEl.style.display='none';
    var chgSign=(s.ret1D||0)>=0?'+':'';
    var prompt='You are a professional Indian stock market analyst. Analyse this NSE-listed stock and write a concise research note.\\n\\n'
      +'STOCK: '+s.name+' ('+s.ticker+') | NSE India | Sector: '+s.sector+'\\n\\n'
      +'PRICE DATA:\\n'
      +'- Current: \u20b9'+(s.price?s.price.toFixed(2):'N/A')+' | Day Change: '+(s.ret1D!=null?chgSign+s.ret1D.toFixed(2)+'%':'N/A')+'\\n'
      +'- Market Cap: '+(s.marketCap?(s.marketCap>=1e12?(s.marketCap/1e12).toFixed(1)+'T':s.marketCap>=1e7?(s.marketCap/1e7).toFixed(0)+'Cr':'N/A'):'N/A')+'\\n'
      +'- 1Y Return: '+(s.ret1Y!=null?s.ret1Y.toFixed(1)+'%':'N/A')+'\\n\\n'
      +'ANALYST DATA:\\n'
      +'- Consensus upside: '+(s.upside!=null?s.upside.toFixed(0)+'%':'N/A')+'\\n'
      +'- Forward PE: '+(s.forwardPE!=null?s.forwardPE.toFixed(1):'N/A')+' | Trailing PE: '+(s.pe!=null?s.pe.toFixed(1):'N/A')+'\\n'
      +'- ROE: '+(s.roe!=null?s.roe.toFixed(1)+'%':'N/A')+' | D/E: '+(s.debtEquity!=null?s.debtEquity.toFixed(2):'N/A')+'\\n'
      +'- EPS Qtr Growth: '+(s.earningsGrowthQ!=null?s.earningsGrowthQ.toFixed(1)+'%':'N/A')+'\\n\\n'
      +'TICKERTAPE SCORECARD: Performance='+s.perfTag+' | Growth='+s.growthTag+' | Profitability='+s.profitTag+' | Valuation='+s.valTag+'\\n\\n'
      +'Write a concise research note in this format:\\n\\n'
      +'**TECHNICAL OUTLOOK**\\nPrice trend, momentum, key levels.\\n\\n'
      +'**FUNDAMENTAL VIEW**\\nBusiness quality, growth, valuation.\\n\\n'
      +'**ANALYST PERSPECTIVE**\\nNear-term (3\u20136M) and medium-term (1\u20132Y) view.\\n\\n'
      +'**KEY RISKS**\\nTop 2 risks.\\n\\n'
      +'**KEY OPPORTUNITY**\\nMain upside catalyst.\\n\\n'
      +'**VERDICT**: [BULLISH / NEUTRAL / BEARISH] \u2014 [one sentence]';
    fetch('https://generativelanguage.googleapis.com/v1beta/models/'+(model||'gemini-2.0-flash-lite')+':generateContent?key='+encodeURIComponent(apiKey),{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.65,maxOutputTokens:1024}})
    }).then(function(r){if(!r.ok)return r.json().then(function(e){throw new Error(e.error&&e.error.message?e.error.message:'API error '+r.status);});return r.json();})
    .then(function(data){
      var text=data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts&&data.candidates[0].content.parts[0]&&data.candidates[0].content.parts[0].text;
      if(!text)throw new Error('Empty response');
      box.className='dr-ai-box';
      box.innerHTML=text.replace(/\*\*([^*]+)\*\*/g,'<strong style="color:#00d4aa;display:block;margin-top:12px;margin-bottom:4px">$1</strong>').replace(/\\n\\n/g,'</p><p style="margin:4px 0">').replace(/\\n/g,'<br>').replace(/^/,'<p style="margin:0">').replace(/$/,'</p>');
    }).catch(function(err){box.className='dr-ai-box';box.innerHTML='<span style="opacity:.5">Could not generate analysis.</span>';errEl.style.display='block';errEl.textContent='\u26a0\ufe0f '+err.message;});
  }
})();
</script>
</body>
</html>`;
}

async function main() {
  const start = Date.now();

  console.log('Step 1: Fetching all stocks from Tickertape screener...');
  const stocks = await fetchAllStocks();

  console.log('Step 2: Fetching scorecards for all stocks...');
  const scorecards = await fetchAllScorecards(stocks);

  console.log('Step 3: Filtering creamy layer stocks...');
  const creamyStocks = [];
  for (const s of stocks) {
    const sc = scorecards[s.sid] || {};
    const perfTag = sc.performance?.tag || null;
    if (perfTag !== 'High') continue;

    const growthTag = sc.growth?.tag || null;
    const profitTag = sc.profitability?.tag || null;
    const valTag = sc.valuation?.tag || null;
    const scoreTotal = [perfTag, growthTag, profitTag, valTag].filter(t => t === 'High').length;
    const mcapLabel = s.marketCap >= 100000 ? 'Large' : s.marketCap >= 30000 ? 'Mid' : 'Small';

    creamyStocks.push({
      sid: s.sid, ticker: s.ticker, name: s.name, sector: s.sector,
      url: `https://www.tickertape.in${s.slug}`,
      mcapLabel, marketCap: s.marketCap, price: s.price,
      ret1Y: s.ret1Y, ret6M: s.ret6M, ret1M: s.ret1M, ret1W: s.ret1W, ret1D: s.ret1D,
      roe: s.roe, npm: s.npm, ebitdaMargin: s.ebitdaMargin,
      revGrowth: s.revGrowth, epsGrowth: s.epsGrowth, ebitdaGrowth: s.ebitdaGrowth,
      epsGrowth5Y: s.epsGrowth5Y, revGrowth5Y: s.revGrowth5Y,
      pe: s.pe, pb: s.pb, divYield: s.divYield, evEbitda: s.evEbitda,
      debtEquity: s.debtEquity, intCoverage: s.intCoverage,
      promoterHolding: s.promoterHolding, promoterChg3M: s.promoterChg3M,
      mfChg3M: s.mfChg3M, fiiChg3M: s.fiiChg3M,
      beta: s.beta, relVol: s.relVol, priceAbove200SMA: s.priceAbove200SMA,
      awayFrom52WH: s.awayFrom52WH, fcf: s.fcf,
      perfTag, growthTag, profitTag, valTag, scoreTotal,
    });
  }

  for (const s of creamyStocks) {
    s.breakout = calcBreakoutScore(s);
    s.breakoutTotal = s.breakout.total;
  }

  console.log(`  Found ${creamyStocks.length} creamy layer stocks out of ${stocks.length} total`);

  console.log('Step 4: Fetching multi-source data (Yahoo Finance)...');
  const yfData = await fetchYahooData(creamyStocks.map(s => s.ticker));
  for (const s of creamyStocks) {
    const y = yfData[s.ticker];
    if (y) {
      s.targetMean = y.targetMean; s.targetHigh = y.targetHigh; s.targetLow = y.targetLow;
      s.numAnalysts = y.numAnalysts; s.recoKey = y.recoKey;
      s.upside = y.currentPrice && y.targetMean ? ((y.targetMean - y.currentPrice) / y.currentPrice * 100) : null;
      s.strongBuy = y.strongBuy; s.buy = y.buy; s.hold = y.hold; s.sell = y.sell; s.strongSell = y.strongSell;
      s.totalAnalysts = y.totalAnalysts; s.buyPct = y.buyPct; s.consensusShift = y.consensusShift;
      s.forwardPE = y.forwardPE; s.earningsGrowthQ = y.earningsGrowthQ;
      s.fwdEpsY = y.fwdEpsY; s.profitMarginsYF = y.profitMargins;
    } else {
      s.targetMean = null; s.targetHigh = null; s.targetLow = null;
      s.numAnalysts = null; s.recoKey = null; s.upside = null;
      s.strongBuy = 0; s.buy = 0; s.hold = 0; s.sell = 0; s.strongSell = 0;
      s.totalAnalysts = null; s.buyPct = null; s.consensusShift = 0;
      s.forwardPE = null; s.earningsGrowthQ = null;
      s.fwdEpsY = null; s.profitMarginsYF = null;
    }
  }

  creamyStocks.sort((a, b) => (b.breakoutTotal || 0) - (a.breakoutTotal || 0) || b.scoreTotal - a.scoreTotal);

  const all4 = creamyStocks.filter(s => s.scoreTotal === 4).length;
  const h3 = creamyStocks.filter(s => s.scoreTotal >= 3).length;
  const highBO = creamyStocks.filter(s => s.breakoutTotal >= 65).length;
  const medBO = creamyStocks.filter(s => s.breakoutTotal >= 40 && s.breakoutTotal < 65).length;
  console.log(`  All 4 High: ${all4} | 3+ High: ${h3}`);
  console.log(`  Breakout 65+: ${highBO} | Breakout 40-64: ${medBO}`);
  if (highBO > 0) {
    console.log('  Top 5 Breakout Candidates:');
    creamyStocks.slice(0, 5).forEach((s, i) => {
      const b = s.breakout;
      console.log(`    ${i+1}. ${s.ticker.padEnd(15)} BO=${b.total} (G${b.growth} Q${b.quality} M${b.momentum} V${b.valuation} S${b.smartMoney})`);
    });
  }
  const large = creamyStocks.filter(s => s.mcapLabel === 'Large');
  const mid = creamyStocks.filter(s => s.mcapLabel === 'Mid');
  const small = creamyStocks.filter(s => s.mcapLabel === 'Small');
  console.log(`  Largecap: ${large.length} | Midcap: ${mid.length} | Smallcap: ${small.length}`);
  const withTargets = creamyStocks.filter(s => s.targetMean != null).length;
  const withConsensus = creamyStocks.filter(s => s.totalAnalysts != null && s.totalAnalysts > 0).length;
  const withFwdPE = creamyStocks.filter(s => s.forwardPE != null).length;
  console.log(`  Yahoo Finance coverage: targets=${withTargets} consensus=${withConsensus} forwardPE=${withFwdPE}`);

  console.log('\nStep 5: Generating HTML dashboard...');
  const docsDir = path.join(__dirname, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);

  const updatedAt = new Date().toISOString();
  fs.writeFileSync(OUTPUT_PATH, buildHtml(creamyStocks, updatedAt), 'utf8');
  console.log(`  Saved to ${OUTPUT_PATH}`);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });

'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
const alertSystem  = require('./alert-system');

const OUTPUT_PATH   = path.join(__dirname, 'docs', 'potential.html');
const SCREENER_CAP  = 800;
const TOP_N         = 50;

// ── Helpers ──────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt2(n)   { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtPct(n) { if (n == null) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function fmtLakh(n) {
  if (n == null) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (n >= 1e7)  return (n / 1e7).toFixed(0)  + 'Cr';
  if (n >= 1e5)  return (n / 1e5).toFixed(1)  + 'L';
  return n.toLocaleString('en-IN');
}

function tagScore(tag) { return tag === 'High' ? 2 : tag === 'Avg' ? 1 : 0; }

// ── Screener universe ─────────────────────────────────────────────────

function apiPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u    = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(data);
  });
}

async function fetchScreenerUniverse() {
  const PAGE = 500;
  const all  = [];
  let offset = 0, total = Infinity;
  while (offset < total && all.length < SCREENER_CAP) {
    const count = Math.min(PAGE, SCREENER_CAP - all.length);
    try {
      const r = await apiPost('https://api.tickertape.in/screener/query', {
        match: {}, sortBy: 'mrktCapf', sortOrder: -1,
        project: ['ticker', 'name', 'sector', 'mrktCapf'],
        offset, count,
      });
      if (!r.success) break;
      total = r.data.stats.count;
      for (const item of (r.data.results || [])) {
        const ticker = item.stock?.info?.ticker || '';
        if (!ticker) continue;
        const slug = item.stock?.slug || '';
        all.push({
          ticker,
          name:     item.stock?.info?.name   || ticker,
          sector:   item.stock?.info?.sector || '',
          stockUrl: slug ? `https://www.tickertape.in${slug}` : '',
          sid:      slug ? slug.match(/-([A-Z0-9_]+)$/)?.[1] || null : null,
        });
      }
      offset += (r.data.results || []).length;
      process.stdout.write(`  Screener: ${all.length}/${Math.min(total, SCREENER_CAP)}\r`);
      if ((r.data.results || []).length < count) break;
    } catch (e) { console.error('  Screener error:', e.message); break; }
  }
  console.log(`\n  ${all.length} stocks fetched from screener`);
  return all;
}

// ── Scorecard ─────────────────────────────────────────────────────────

function fetchScorecard(sid) {
  return new Promise(resolve => {
    if (!sid) return resolve(null);
    https.get(`https://analyze.api.tickertape.in/stocks/scorecard/${sid}`, { timeout: 8000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.success && j.data) {
            const r = {};
            for (const item of j.data) r[item.name] = { tag: item.tag, desc: item.description };
            resolve(r);
          } else resolve(null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function fetchAllScorecards(stocks) {
  const map = {};
  let done = 0;
  for (let i = 0; i < stocks.length; i += 8) {
    const batch = stocks.slice(i, i + 8);
    const results = await Promise.all(batch.map(s => fetchScorecard(s.sid).then(sc => ({ ticker: s.ticker, sc }))));
    for (const { ticker, sc } of results) map[ticker] = sc;
    done += batch.length;
    process.stdout.write(`  Scorecards: ${done}/${stocks.length}\r`);
    await sleep(120);
  }
  console.log(`\n  ${Object.values(map).filter(Boolean).length} scorecards loaded`);
  return map;
}

// ── Yahoo quotes ──────────────────────────────────────────────────────

async function fetchQuotes(tickers) {
  const results = {};
  for (let i = 0; i < tickers.length; i += 15) {
    const batch = tickers.slice(i, i + 15);
    const res = await Promise.all(batch.map(async t => {
      try {
        const q = await yahooFinance.quote(t + '.NS');
        return { ticker: t, price: q.regularMarketPrice, changePct: q.regularMarketChangePercent,
          marketCap: q.marketCap, fiftyTwoWeekHigh: q.fiftyTwoWeekHigh, fiftyTwoWeekLow: q.fiftyTwoWeekLow,
          volume: q.regularMarketVolume, avgVolume: q.averageDailyVolume3Month };
      } catch { return { ticker: t }; }
    }));
    for (const r of res) results[r.ticker] = r;
    await sleep(80);
  }
  return results;
}

// ── HTML builder ──────────────────────────────────────────────────────

function tagHtml(tag) {
  if (!tag) return '<span class="tag tag-na">—</span>';
  if (tag === 'High') return '<span class="tag tag-high">High</span>';
  if (tag === 'Avg')  return '<span class="tag tag-avg">Avg</span>';
  return '<span class="tag tag-low">Low</span>';
}

function scoreBadgeHtml(score, max) {
  const pct = max > 0 ? Math.round(score / max * 100) : 0;
  const bg  = pct >= 100 ? 'rgba(34,197,94,.18)'  : pct >= 67 ? 'rgba(0,212,170,.15)'  : pct >= 33 ? 'rgba(234,179,8,.12)'  : 'rgba(239,68,68,.1)';
  const cl  = pct >= 100 ? 'var(--gn)'             : pct >= 67 ? 'var(--ac)'             : pct >= 33 ? 'var(--yw)'             : 'var(--rd)';
  const bdr = pct >= 100 ? 'rgba(34,197,94,.3)'    : pct >= 67 ? 'rgba(0,212,170,.25)'   : pct >= 33 ? 'rgba(234,179,8,.25)'   : 'rgba(239,68,68,.25)';
  return `<div class="score-badge" style="background:${bg};color:${cl};border:1px solid ${bdr}">${score}<span style="font-size:.6rem;opacity:.7">/${max}</span></div>`;
}

function buildHtml(stocks, generatedAt) {
  const rows = stocks.map((s, i) => {
    const chgCls  = (s.changePct || 0) >= 0 ? 'pos' : 'neg';
    const chgSign = (s.changePct || 0) >= 0 ? '+' : '';
    const pos52w  = (s.price && s.fiftyTwoWeekLow && s.fiftyTwoWeekHigh)
      ? ((s.price - s.fiftyTwoWeekLow) / (s.fiftyTwoWeekHigh - s.fiftyTwoWeekLow) * 100) : null;
    const barColor = pos52w == null ? 'var(--s3)' : pos52w >= 70 ? 'var(--gn)' : pos52w >= 40 ? 'var(--ac)' : pos52w >= 20 ? 'var(--yw)' : 'var(--rd)';
    return `<tr>
      <td style="color:var(--t2);font-weight:600">${i + 1}</td>
      <td>
        <div class="stock-name"><a href="${esc(s.stockUrl)}" target="_blank" rel="noopener">${esc(s.name)}</a></div>
        <div class="stock-sub">${esc(s.ticker)} · <span class="sector-lbl">${esc(s.sector)}</span></div>
      </td>
      <td style="font-weight:700">${s.price ? fmt2(s.price) : '—'}</td>
      <td class="${chgCls}">${s.changePct != null ? chgSign + s.changePct.toFixed(2) + '%' : '—'}</td>
      <td>${scoreBadgeHtml(s.totalScore, s.maxScore)}</td>
      <td>${tagHtml(s.perfTag)}</td>
      <td>${tagHtml(s.growthTag)}</td>
      <td>${tagHtml(s.profitTag)}</td>
      <td>${tagHtml(s.valTag)}</td>
      <td>
        ${pos52w != null ? `<div style="display:flex;align-items:center;gap:6px">
          <div class="range-bar"><div class="fill" style="width:${Math.max(0,Math.min(100,pos52w)).toFixed(1)}%;background:${barColor}"></div></div>
          <span style="font-size:.75rem;color:${barColor};font-weight:600">${pos52w.toFixed(0)}%</span>
        </div>` : '—'}
      </td>
      <td style="color:var(--t2);font-size:.78rem">${fmtLakh(s.marketCap)}</td>
    </tr>`;
  }).join('');

  const cardsMobile = stocks.map((s, i) => {
    const chgCls  = (s.changePct || 0) >= 0 ? 'pos' : 'neg';
    const chgSign = (s.changePct || 0) >= 0 ? '+' : '';
    return `<div class="card">
      <div class="card-rank">${i + 1}</div>
      <div class="card-body">
        <div class="card-top">
          <div>
            <div class="card-name"><a href="${esc(s.stockUrl)}" target="_blank" rel="noopener">${esc(s.name)}</a></div>
            <div class="card-sub">${esc(s.ticker)} · ${esc(s.sector)}</div>
          </div>
          <div class="card-price-block">
            <div class="card-price">${s.price ? fmt2(s.price) : '—'}</div>
            <div class="card-chg ${chgCls}">${s.changePct != null ? chgSign + s.changePct.toFixed(2) + '%' : ''}</div>
          </div>
        </div>
        <div class="card-tags">
          ${scoreBadgeHtml(s.totalScore, s.maxScore)}
          <div class="tag-row">Perf ${tagHtml(s.perfTag)} Growth ${tagHtml(s.growthTag)}</div>
          <div class="tag-row">Profit ${tagHtml(s.profitTag)} Val ${tagHtml(s.valTag)}</div>
        </div>
        <div class="card-mcap" style="font-size:.72rem;color:var(--t2);margin-top:6px">MCap: ${fmtLakh(s.marketCap)}</div>
      </div>
    </div>`;
  }).join('');

  // Sector breakdown for stats bar
  const sectorCounts = {};
  stocks.forEach(s => { sectorCounts[s.sector || 'Unknown'] = (sectorCounts[s.sector || 'Unknown'] || 0) + 1; });
  const topSector = Object.entries(sectorCounts).sort((a,b) => b[1]-a[1])[0];
  const perfectScore = stocks.filter(s => s.totalScore === s.maxScore).length;
  const highAll3 = stocks.filter(s => s.perfTag === 'High' && s.growthTag === 'High' && s.profitTag === 'High').length;

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Potential Stocks — Top 50 Quality Picks</title>
<script>(function(){var s=localStorage.getItem('creamy-theme');var p=s||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',p);})();<\/script>
<style>
:root{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#00d4aa;--tx:#e8e8f0;--t2:#8888a0;--t3:#5a5a70;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7}
html[data-theme="light"]{--bg:#f4f5f7;--s1:#ffffff;--s2:#ffffff;--s3:#f0f0f5;--tx:#111118;--t2:#505068;--t3:#8888a0;--bd:#dcdce8;--ac:#009980;--gn:#16a34a;--rd:#dc2626;--yw:#ca8a04;--pp:#7c3aed}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);overflow-x:hidden}

.header{background:var(--s1);border-bottom:1px solid var(--bd);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.15rem;font-weight:700}.header h1 span{color:var(--ac)}
.header-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nav-link{color:var(--t2);text-decoration:none;font-size:.8rem;padding:6px 12px;border:1px solid var(--bd);border-radius:6px;transition:all .2s;white-space:nowrap}
.nav-link:hover,.nav-link.active{color:var(--ac);border-color:var(--ac)}
.nav-link.active{background:rgba(0,212,170,.06)}
.theme-btn{background:none;border:1px solid var(--bd);border-radius:6px;padding:5px 10px;cursor:pointer;color:var(--t2);font-size:.8rem;transition:all .2s}
.theme-btn:hover{color:var(--ac);border-color:var(--ac)}

.hero{padding:22px 24px 14px;border-bottom:1px solid var(--bd)}
.hero h2{font-size:1.3rem;font-weight:700;margin-bottom:4px}.hero p{color:var(--t2);font-size:.85rem;max-width:600px;line-height:1.5}
.hero-meta{font-size:.72rem;color:var(--t3);margin-top:6px}

.stats-bar{display:flex;gap:10px;padding:14px 24px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap}
.stat-card{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 16px;min-width:110px}
.stat-card .lbl{font-size:.68rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.stat-card .val{font-size:1.25rem;font-weight:700}
.val.green{color:var(--gn)}.val.accent{color:var(--ac)}.val.yellow{color:var(--yw)}

.controls{display:flex;gap:8px;padding:12px 24px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--bd)}
.search{padding:7px 12px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.85rem;font-family:inherit;width:220px;outline:none;transition:border .2s}
.search:focus{border-color:var(--ac)}
.filter-group{display:flex;gap:4px;align-items:center;border:1px solid var(--bd);border-radius:8px;padding:3px;background:var(--s1)}
.filter-group .fg-label{font-size:.62rem;color:var(--t3);text-transform:uppercase;padding:0 6px;white-space:nowrap}
.btn{padding:6px 12px;border-radius:5px;border:1px solid transparent;background:transparent;color:var(--t2);cursor:pointer;font-size:.78rem;font-family:inherit;transition:all .2s}
.btn:hover{color:var(--tx)}.btn.active{background:var(--ac);color:var(--bg);font-weight:600}

table{width:100%;border-collapse:collapse;font-size:.82rem}
.table-wrap{padding:0 24px 24px;overflow-x:auto}
thead{position:sticky;top:57px;z-index:10}
th{background:var(--s1);color:var(--ac);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;padding:9px 12px;text-align:left;border-bottom:2px solid var(--bd);cursor:pointer;white-space:nowrap;user-select:none}
th:hover{color:var(--tx)}th .arr{margin-left:3px;font-size:.6rem;opacity:.4}th.sorted .arr{opacity:1}
td{padding:9px 12px;border-bottom:1px solid rgba(42,42,56,.45);white-space:nowrap;vertical-align:middle}
tr:hover td{background:rgba(0,212,170,.025)}
.stock-name a{color:var(--tx);text-decoration:none;font-weight:500;transition:color .2s}.stock-name a:hover{color:var(--ac)}
.stock-sub{font-size:.7rem;color:var(--t2);margin-top:1px}.sector-lbl{color:var(--t3)}
.pos{color:var(--gn)}.neg{color:var(--rd)}
.tag{display:inline-block;padding:2px 7px;border-radius:4px;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.tag-high{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.2)}
.tag-avg{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.2)}
.tag-low{background:rgba(239,68,68,.1);color:var(--rd);border:1px solid rgba(239,68,68,.2)}
.tag-na{color:var(--t3);border:1px solid var(--bd)}
.range-bar{width:70px;height:5px;background:var(--s3);border-radius:3px;position:relative;display:inline-block;vertical-align:middle}
.range-bar .fill{height:100%;border-radius:3px;position:absolute;left:0;top:0}

/* Score badge */
.score-badge{display:inline-flex;align-items:center;justify-content:center;gap:1px;padding:4px 10px;border-radius:20px;font-size:.82rem;font-weight:700;white-space:nowrap;min-width:48px;text-align:center}

/* Mobile cards */
#cards{display:none;padding:0 12px 24px}
.card{display:flex;gap:10px;background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:10px}
.card-rank{font-size:1.1rem;font-weight:700;color:var(--t3);min-width:28px;padding-top:2px}
.card-body{flex:1;min-width:0}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.card-name a{color:var(--tx);text-decoration:none;font-weight:600;font-size:.9rem}.card-name a:hover{color:var(--ac)}
.card-sub{font-size:.7rem;color:var(--t2);margin-top:2px}
.card-price-block{text-align:right;flex-shrink:0}
.card-price{font-size:1rem;font-weight:700}
.card-chg{font-size:.75rem;font-weight:600}
.card-tags{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
.tag-row{display:flex;gap:4px;align-items:center;font-size:.7rem;color:var(--t2)}

.empty{text-align:center;padding:48px 20px;color:var(--t2);font-size:.9rem}
.footer{text-align:center;padding:16px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd)}

${alertSystem.css}

@media(max-width:768px){
  .header{padding:10px 14px}.hero{padding:14px 14px 10px}.stats-bar{padding:10px 12px;gap:8px}
  .stat-card{min-width:0;flex:1 1 calc(33% - 6px);padding:8px 10px}.stat-card .val{font-size:1rem}
  .controls{padding:10px 12px}.search{width:100%;font-size:16px}
  .filter-group{flex-wrap:wrap;width:100%}.filter-group .fg-label{width:100%}
  .table-wrap{display:none}#cards{display:block}
}
</style>
</head>
<body>

<div class="header">
  <h1>🌟 <span>Potential</span> Stocks</h1>
  <div class="header-right">
    <a href="index.html" class="nav-link">Dashboard</a>
    <a href="creamy.html" class="nav-link">Creamy Layer</a>
    <a href="breakout.html" class="nav-link">Breakout Scanner</a>
    <a href="breakout2.html" class="nav-link">Gen2 Breakout</a>
    <a href="alerts.html" class="nav-link">🔔 Alerts</a>
    <button class="theme-btn" id="theme-btn">◐ Theme</button>
  </div>
</div>

${alertSystem.bannerHtml}
${alertSystem.modalHtml}

<div class="hero">
  <h2>Top ${TOP_N} Quality Stocks</h2>
  <p>Ranked by composite Tickertape scorecard: <strong>Performance + Growth + Profitability</strong> (High=2, Avg=1, Low=0) across the top 800 NSE stocks by market cap. Valuation shown for context.</p>
  <div class="hero-meta">Generated ${generatedAt} IST &nbsp;·&nbsp; Universe: top ${SCREENER_CAP} NSE stocks by market cap</div>
</div>

<div class="stats-bar">
  <div class="stat-card"><div class="lbl">Showing</div><div class="val accent">${TOP_N}</div></div>
  <div class="stat-card"><div class="lbl">All 3 High</div><div class="val green">${highAll3}</div></div>
  <div class="stat-card"><div class="lbl">Perfect Score</div><div class="val yellow">${perfectScore}</div></div>
  <div class="stat-card"><div class="lbl">Top Sector</div><div class="val" style="font-size:.85rem;color:var(--ac)">${esc(topSector ? topSector[0] : '—')}</div></div>
</div>

<div class="controls">
  <input class="search" id="search" placeholder="Search stock or ticker…" autocomplete="off">
  <div class="filter-group">
    <span class="fg-label">Filter</span>
    <button class="btn tog-btn" data-tog="all3high">All 3 High</button>
    <button class="btn tog-btn" data-tog="perf">Perf High</button>
    <button class="btn tog-btn" data-tog="growth">Growth High</button>
    <button class="btn tog-btn" data-tog="profit">Profit High</button>
  </div>
</div>

<div class="table-wrap">
  <table id="main-table">
    <thead id="tbl-head"></thead>
    <tbody id="tbl-body"></tbody>
  </table>
</div>
<div id="cards"></div>

<div class="footer">
  Scorecard data from Tickertape · Prices from Yahoo Finance · Top ${SCREENER_CAP} NSE stocks by market cap screened ·
  <a href="index.html" style="color:var(--ac);text-decoration:none">Dashboard</a>
</div>

<script>
window._GH_ALERTS_REPO = 'amitiyer99/watchlist-app';
var ALL = ${JSON.stringify(stocks)};
var filtered = ALL.slice();
var sortCol = 'totalScore', sortAsc = false;
var searchTerm = '';
var filterAll3 = false, filterPerf = false, filterGrowth = false, filterProfit = false;

var COLS = [
  {key:'rank',     label:'#',           w:'40px'},
  {key:'name',     label:'Stock',        w:'200px'},
  {key:'price',    label:'Price',        w:'90px',  num:true},
  {key:'changePct',label:'Change',       w:'80px',  num:true},
  {key:'totalScore',label:'Score',       w:'70px',  num:true},
  {key:'perfTag',  label:'Performance',  w:'105px'},
  {key:'growthTag',label:'Growth',       w:'80px'},
  {key:'profitTag',label:'Profitability',w:'100px'},
  {key:'valTag',   label:'Valuation',    w:'80px'},
  {key:'pos52w',   label:'52W Position', w:'130px', num:true},
  {key:'marketCap',label:'Market Cap',   w:'100px', num:true},
];

function buildHead() {
  document.getElementById('tbl-head').innerHTML = COLS.map(function(c,i){
    return '<th style="width:'+c.w+'" data-ci="'+i+'" class="'+(sortCol===c.key?'sorted':'')+'">'
      +c.label+'<span class="arr">'+(sortCol===c.key?(sortAsc?'\u25b2':'\u25bc'):'\u21c5')+'</span></th>';
  }).join('');
  document.querySelectorAll('#tbl-head th').forEach(function(th){
    th.addEventListener('click',function(){ var c=COLS[+th.dataset.ci]; doSort(c.key,!!c.num); });
  });
}

function tagHtml(tag) {
  if (!tag) return '<span class="tag tag-na">—</span>';
  var cls = tag==='High'?'tag-high':tag==='Avg'?'tag-avg':'tag-low';
  return '<span class="tag '+cls+'">'+tag+'</span>';
}
function fmtLakh(n){
  if(n==null)return '—';
  if(n>=1e12)return (n/1e12).toFixed(1)+'T';
  if(n>=1e7)return (n/1e7).toFixed(0)+'Cr';
  if(n>=1e5)return (n/1e5).toFixed(1)+'L';
  return n.toLocaleString('en-IN');
}
function fmt2(n){ return n==null?'—':'₹'+Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function scoreBadgeHtml(score, max) {
  var pct = max>0?Math.round(score/max*100):0;
  var bg  = pct>=100?'rgba(34,197,94,.18)':pct>=67?'rgba(0,212,170,.15)':pct>=33?'rgba(234,179,8,.12)':'rgba(239,68,68,.1)';
  var cl  = pct>=100?'var(--gn)':pct>=67?'var(--ac)':pct>=33?'var(--yw)':'var(--rd)';
  var bdr = pct>=100?'rgba(34,197,94,.3)':pct>=67?'rgba(0,212,170,.25)':pct>=33?'rgba(234,179,8,.25)':'rgba(239,68,68,.25)';
  return '<div class="score-badge" style="background:'+bg+';color:'+cl+';border:1px solid '+bdr+'">'+score+'<span style="font-size:.6rem;opacity:.7">/'+max+'</span></div>';
}

function applyFilters() {
  filtered = ALL.filter(function(s) {
    if (filterAll3 && !(s.perfTag==='High'&&s.growthTag==='High'&&s.profitTag==='High')) return false;
    if (filterPerf   && s.perfTag   !== 'High') return false;
    if (filterGrowth && s.growthTag !== 'High') return false;
    if (filterProfit && s.profitTag !== 'High') return false;
    if (searchTerm) {
      var q = searchTerm.toLowerCase();
      if (!s.name.toLowerCase().includes(q) && !s.ticker.toLowerCase().includes(q) && !(s.sector||'').toLowerCase().includes(q)) return false;
    }
    return true;
  });
  filtered.sort(function(a,b) {
    var va=a[sortCol], vb=b[sortCol];
    if(va==null)va=sortAsc?Infinity:-Infinity;
    if(vb==null)vb=sortAsc?Infinity:-Infinity;
    if(typeof va==='string') return sortAsc?va.localeCompare(vb):vb.localeCompare(va);
    return sortAsc?va-vb:vb-va;
  });
}

function renderTable() {
  applyFilters();
  buildHead();
  if (!filtered.length) {
    document.getElementById('tbl-body').innerHTML = '<tr><td colspan="11" class="empty">No stocks match your filters</td></tr>';
    document.getElementById('cards').innerHTML = '<div class="empty">No stocks match your filters</div>';
    return;
  }
  document.getElementById('tbl-body').innerHTML = filtered.map(function(s,i) {
    var chgCls=(s.changePct||0)>=0?'pos':'neg';
    var chgSign=(s.changePct||0)>=0?'+':'';
    var pos52w = (s.price&&s.fiftyTwoWeekLow&&s.fiftyTwoWeekHigh)
      ?((s.price-s.fiftyTwoWeekLow)/(s.fiftyTwoWeekHigh-s.fiftyTwoWeekLow)*100):null;
    var barColor=pos52w==null?'var(--s3)':pos52w>=70?'var(--gn)':pos52w>=40?'var(--ac)':pos52w>=20?'var(--yw)':'var(--rd)';
    return '<tr>'
      +'<td style="color:var(--t2);font-weight:600">'+(i+1)+'</td>'
      +'<td><div class="stock-name"><a href="'+esc(s.stockUrl)+'" target="_blank" rel="noopener">'+esc(s.name)+'</a>'
          +'<button class="alert-btn" data-alert-ticker="'+esc(s.ticker)+'" data-alert-price="'+(s.price||0)+'" data-alert-name="'+esc(s.name)+'">\uD83D\uDD14</button></div>'
          +'<div class="stock-sub">'+esc(s.ticker)+' \u00b7 <span class="sector-lbl">'+esc(s.sector)+'</span></div></td>'
      +'<td style="font-weight:600">'+(s.price?fmt2(s.price):'\u2014')+'</td>'
      +'<td class="'+chgCls+'">'+(s.changePct!=null?chgSign+s.changePct.toFixed(2)+'%':'\u2014')+'</td>'
      +'<td>'+scoreBadgeHtml(s.totalScore,s.maxScore)+'</td>'
      +'<td>'+tagHtml(s.perfTag)+'</td>'
      +'<td>'+tagHtml(s.growthTag)+'</td>'
      +'<td>'+tagHtml(s.profitTag)+'</td>'
      +'<td>'+tagHtml(s.valTag)+'</td>'
      +'<td>'+(pos52w!=null?'<div style="display:flex;align-items:center;gap:6px"><div class="range-bar"><div class="fill" style="width:'+Math.max(0,Math.min(100,pos52w)).toFixed(0)+'%;background:'+barColor+'"></div></div><span style="font-size:.75rem;color:'+barColor+';font-weight:600">'+pos52w.toFixed(0)+'%</span></div>':'—')+'</td>'
      +'<td style="color:var(--t2);font-size:.78rem">'+fmtLakh(s.marketCap)+'</td>'
      +'</tr>';
  }).join('');
  document.getElementById('cards').innerHTML = filtered.map(function(s,i) {
    var chgCls=(s.changePct||0)>=0?'pos':'neg';
    var chgSign=(s.changePct||0)>=0?'+':'';
    return '<div class="card">'
      +'<div class="card-rank">'+(i+1)+'</div>'
      +'<div class="card-body">'
      +'<div class="card-top"><div><div class="card-name"><a href="'+esc(s.stockUrl)+'" target="_blank" rel="noopener">'+esc(s.name)+'</a></div>'
      +'<div class="card-sub">'+esc(s.ticker)+' \u00b7 '+esc(s.sector)+'</div></div>'
      +'<div class="card-price-block"><div class="card-price">'+(s.price?fmt2(s.price):'\u2014')+'</div>'
      +'<div class="card-chg '+chgCls+'">'+(s.changePct!=null?chgSign+s.changePct.toFixed(2)+'%':'')+'</div></div></div>'
      +'<div class="card-tags">'+scoreBadgeHtml(s.totalScore,s.maxScore)
      +'<div><div class="tag-row">Perf '+tagHtml(s.perfTag)+' Growth '+tagHtml(s.growthTag)+'</div>'
      +'<div class="tag-row" style="margin-top:4px">Profit '+tagHtml(s.profitTag)+' Val '+tagHtml(s.valTag)+'</div>'
      +'<button class="alert-btn" data-alert-ticker="'+esc(s.ticker)+'" data-alert-price="'+(s.price||0)+'" data-alert-name="'+esc(s.name)+'">\uD83D\uDD14 Alert</button></div></div>'
      +'<div class="card-mcap">MCap: '+fmtLakh(s.marketCap)+'</div>'
      +'</div></div>';
  }).join('');
}

function doSort(col, isNum) {
  if (sortCol===col) sortAsc=!sortAsc; else { sortCol=col; sortAsc=col==='name'; }
  renderTable();
}

document.getElementById('search').addEventListener('input', function(e) { searchTerm=e.target.value; renderTable(); });

document.querySelectorAll('.tog-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    btn.classList.toggle('active');
    var t=btn.dataset.tog;
    if(t==='all3high') filterAll3=btn.classList.contains('active');
    if(t==='perf')     filterPerf=btn.classList.contains('active');
    if(t==='growth')   filterGrowth=btn.classList.contains('active');
    if(t==='profit')   filterProfit=btn.classList.contains('active');
    renderTable();
  });
});

(function(){
  var btn=document.getElementById('theme-btn');
  function applyTheme(t){document.documentElement.setAttribute('data-theme',t);localStorage.setItem('creamy-theme',t);}
  btn.onclick=function(){applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');};
})();

window.onAlertChange = function() { renderTable(); };
${alertSystem.js}
renderTable();
</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('Step 1: Fetching screener universe...');
  const universe = await fetchScreenerUniverse();

  console.log('Step 2: Fetching Tickertape scorecards...');
  const scMap = await fetchAllScorecards(universe);

  console.log('Step 3: Scoring and ranking...');
  const tagS = t => t === 'High' ? 2 : t === 'Avg' ? 1 : 0;
  const scored = universe.map(s => {
    const sc = scMap[s.ticker] || {};
    const perfTag   = sc.Performance?.tag  || null;
    const growthTag = sc.Growth?.tag       || null;
    const profitTag = sc.Profitability?.tag || null;
    const valTag    = sc.Valuation?.tag    || null;
    const totalScore = tagS(perfTag) + tagS(growthTag) + tagS(profitTag);
    const maxScore   = 6;
    return { ...s, perfTag, growthTag, profitTag, valTag, totalScore, maxScore };
  });

  // Sort by totalScore desc, break tie by Valuation tag
  scored.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return tagS(b.valTag) - tagS(a.valTag);
  });

  const top = scored.slice(0, TOP_N);
  console.log(`  Top ${TOP_N}: scores ${top[0]?.totalScore} → ${top[TOP_N-1]?.totalScore}`);

  console.log('Step 4: Fetching Yahoo Finance quotes...');
  const quotes = await fetchQuotes(top.map(s => s.ticker));
  const withPrice = Object.values(quotes).filter(q => q.price).length;
  console.log(`  ${withPrice}/${top.length} prices loaded`);

  const stocks = top.map(s => {
    const q = quotes[s.ticker] || {};
    const pos52w = (q.price && q.fiftyTwoWeekLow && q.fiftyTwoWeekHigh)
      ? ((q.price - q.fiftyTwoWeekLow) / (q.fiftyTwoWeekHigh - q.fiftyTwoWeekLow) * 100) : null;
    return { ...s, price: q.price ?? null, changePct: q.changePct ?? null,
      marketCap: q.marketCap ?? null, fiftyTwoWeekHigh: q.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: q.fiftyTwoWeekLow ?? null, volume: q.volume ?? null,
      avgVolume: q.avgVolume ?? null, pos52w };
  });

  const generatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log('Step 5: Writing HTML...');
  fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, buildHtml(stocks, generatedAt), 'utf8');
  console.log(`  Saved to ${OUTPUT_PATH}`);
  console.log(`  Done — ${stocks.filter(s=>s.totalScore===6).length} perfect-score stocks`);
}

main().catch(e => { console.error(e); process.exit(1); });

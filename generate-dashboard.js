const https = require('https');
const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const alertSystem = require('./alert-system');

const WATCHLIST_PATH = path.join(__dirname, 'my-watchlists.json');
const TICKER_URLS_PATH = path.join(__dirname, 'ticker-urls.json');
const OUTPUT_PATH = path.join(__dirname, 'docs', 'index.html');

function loadStaticData() {
  const watchlists = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
  const tickerUrls = JSON.parse(fs.readFileSync(TICKER_URLS_PATH, 'utf8'));
  const stocks = [];
  const seen = new Set();
  for (const wl of watchlists) {
    const data3m = wl.periods?.['3M'];
    if (!data3m) continue;
    for (const s of data3m.stocks || []) {
      const parts = (s.name || '').split('\n');
      const fullName = parts[0] || '';
      const ticker = (parts[1] || '').trim();
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      const p = v => parseFloat(String(v || '').replace(/[₹,]/g, ''));
      const low3m = p(s.cells[3]), high3m = p(s.cells[4]);
      stocks.push({
        ticker, fullName,
        watchlist: wl.name.replace(/^Equity Watchlist\s*/, '') || 'Main',
        stockUrl: s.stockUrl || tickerUrls[ticker] || '',
        low3m: isNaN(low3m) ? null : low3m,
        high3m: isNaN(high3m) ? null : high3m,
      });
    }
  }
  return stocks;
}

function extractSid(url) {
  const m = (url || '').match(/-([A-Z0-9_]+)$/);
  return m ? m[1] : null;
}

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

async function fetchYahooQuotes(tickers) {
  const results = {};
  for (let i = 0; i < tickers.length; i += 15) {
    const batch = tickers.slice(i, i + 15);
    const promises = batch.map(async t => {
      try {
        const q = await yahooFinance.quote(t + '.NS');
        return { ticker: t, price: q.regularMarketPrice, change: q.regularMarketChange, changePct: q.regularMarketChangePercent, dayHigh: q.regularMarketDayHigh, dayLow: q.regularMarketDayLow, prevClose: q.regularMarketPreviousClose, open: q.regularMarketOpen, volume: q.regularMarketVolume, marketCap: q.marketCap, fiftyTwoWeekHigh: q.fiftyTwoWeekHigh, fiftyTwoWeekLow: q.fiftyTwoWeekLow, avgVolume: q.averageDailyVolume3Month };
      } catch { return { ticker: t, price: null }; }
    });
    const br = await Promise.all(promises);
    for (const r of br) results[r.ticker] = r;
  }
  return results;
}

async function main() {
  console.log('Loading watchlist data...');
  const stocks = loadStaticData();
  console.log(`  ${stocks.length} stocks loaded`);

  console.log('Fetching Tickertape scorecards...');
  const scMap = {};
  for (let i = 0; i < stocks.length; i += 8) {
    const batch = stocks.slice(i, i + 8);
    const results = await Promise.all(batch.map(s => fetchScorecard(extractSid(s.stockUrl)).then(sc => ({ ticker: s.ticker, sc }))));
    for (const { ticker, sc } of results) scMap[ticker] = sc;
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(` done`);

  console.log('Fetching Yahoo Finance quotes...');
  const quotes = await fetchYahooQuotes(stocks.map(s => s.ticker));
  const withPrice = Object.values(quotes).filter(q => q.price).length;
  console.log(`  ${withPrice}/${stocks.length} prices loaded`);

  const merged = stocks.map(s => {
    const q = quotes[s.ticker] || {};
    const sc = scMap[s.ticker] || {};
    const range3m = (s.high3m && s.low3m) ? s.high3m - s.low3m : null;
    const pctInRange = (q.price && range3m && range3m > 0) ? ((q.price - s.low3m) / range3m * 100) : null;
    return {
      ...s, price: q.price ?? null, change: q.change ?? null, changePct: q.changePct ?? null,
      dayHigh: q.dayHigh ?? null, dayLow: q.dayLow ?? null, prevClose: q.prevClose ?? null,
      open: q.open ?? null, volume: q.volume ?? null, marketCap: q.marketCap ?? null,
      fiftyTwoWeekHigh: q.fiftyTwoWeekHigh ?? null, fiftyTwoWeekLow: q.fiftyTwoWeekLow ?? null,
      avgVolume: q.avgVolume ?? null, range3m, pctInRange,
      perfTag: sc.Performance?.tag || null, growthTag: sc.Growth?.tag || null,
      profitTag: sc.Profitability?.tag || null, valTag: sc.Valuation?.tag || null,
      perfDesc: sc.Performance?.desc || '',
    };
  });

  const updatedAt = new Date().toISOString();
  const dataJson = JSON.stringify({ stocks: merged, updatedAt });

  console.log('Generating dashboard HTML...');
  const docsDir = path.join(__dirname, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);
  fs.writeFileSync(OUTPUT_PATH, buildStaticHtml(dataJson), 'utf8');
  console.log(`  Saved to ${OUTPUT_PATH}`);

  // Write lightweight sidecar for monitor.js to read scorecard tags
  const tagsMap = {};
  merged.forEach(s => { tagsMap[s.ticker] = { perfTag: s.perfTag, growthTag: s.growthTag, profitTag: s.profitTag, valTag: s.valTag }; });
  fs.writeFileSync(path.join(__dirname, 'scorecard-tags.json'), JSON.stringify(tagsMap, null, 2), 'utf8');
  console.log(`  Saved scorecard-tags.json (${Object.keys(tagsMap).length} stocks)`);
}

function buildStaticHtml(dataJson) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stock Dashboard</title>
<style>
:root{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#00d4aa;--tx:#e8e8f0;--t2:#8888a0;--t3:#5a5a70;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);overflow-x:hidden}
.header{background:var(--s1);border-bottom:1px solid var(--bd);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.2rem;font-weight:600;color:var(--tx)}
.header h1 span{color:var(--ac);font-weight:700}
.header-right{display:flex;align-items:center;gap:16px}
.status{font-size:.75rem;color:var(--t2);display:flex;align-items:center;gap:6px}
.status .dot{width:8px;height:8px;border-radius:50%;background:var(--yw)}
.btn{padding:6px 14px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--t2);cursor:pointer;font-size:.8rem;font-family:inherit;transition:all .2s}
.btn:hover{color:var(--tx);border-color:var(--ac);background:var(--s3)}
.btn.active{background:var(--ac);color:var(--bg);border-color:var(--ac);font-weight:600}
.stats-bar{display:flex;gap:12px;padding:14px 24px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap}
.stat-card{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 16px;min-width:120px}
.stat-card .label{font-size:.7rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.stat-card .value{font-size:1.3rem;font-weight:700}
.stat-card .value.green{color:var(--gn)}
.stat-card .value.red{color:var(--rd)}
.stat-card .value.accent{color:var(--ac)}
.controls{display:flex;gap:8px;padding:14px 24px;flex-wrap:wrap;align-items:center}
.controls .label{font-size:.75rem;color:var(--t2);margin-right:4px}
.filter-group{display:flex;gap:4px;align-items:center;border:1px solid var(--bd);border-radius:8px;padding:3px;background:var(--s1)}
.filter-group .fg-label{font-size:.62rem;color:var(--t3);text-transform:uppercase;letter-spacing:.04em;padding:0 6px;white-space:nowrap}
.search{padding:7px 12px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.85rem;font-family:inherit;width:200px;outline:none;transition:border .2s}
.search:focus{border-color:var(--ac)}
.multi-dd{position:relative;display:inline-block}
.multi-dd .dd-btn{padding:7px 12px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.82rem;font-family:inherit;cursor:pointer;min-width:160px;text-align:left;transition:border .2s;white-space:nowrap;display:flex;align-items:center;justify-content:space-between;gap:6px}
.multi-dd .dd-btn:hover,.multi-dd.open .dd-btn{border-color:var(--ac)}
.multi-dd .dd-btn .dd-arrow{font-size:.6rem;color:var(--t3);transition:transform .2s}
.multi-dd.open .dd-arrow{transform:rotate(180deg)}
.multi-dd .dd-panel{position:absolute;top:calc(100% + 4px);left:0;min-width:200px;max-height:260px;overflow-y:auto;background:var(--s2);border:1px solid var(--bd);border-radius:8px;z-index:200;display:none;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.multi-dd.open .dd-panel{display:block}
.dd-panel label{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:.8rem;cursor:pointer;transition:background .15s;color:var(--tx)}
.dd-panel label:hover{background:var(--s3)}
.dd-panel input[type=checkbox]{accent-color:var(--ac);width:15px;height:15px;cursor:pointer}
.dd-panel .dd-count{margin-left:auto;font-size:.68rem;color:var(--t3)}
.dd-panel .dd-actions{display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:var(--s2);z-index:1}
.dd-panel .dd-actions button{flex:1;padding:4px 8px;border:1px solid var(--bd);border-radius:4px;background:var(--s3);color:var(--t2);cursor:pointer;font-size:.7rem;font-family:inherit;transition:all .15s}
.dd-panel .dd-actions button:hover{color:var(--tx);border-color:var(--ac)}
.table-container{padding:0 24px 24px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.82rem}
thead{position:sticky;top:0;z-index:10}
th{background:var(--s1);color:var(--ac);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;padding:10px 12px;text-align:left;border-bottom:2px solid var(--bd);cursor:pointer;white-space:nowrap;user-select:none;transition:color .2s}
th:hover{color:var(--tx)}
th .arrow{margin-left:4px;font-size:.65rem;opacity:.5}
th.sorted .arrow{opacity:1;color:var(--ac)}
td{padding:9px 12px;border-bottom:1px solid rgba(42,42,56,.5);white-space:nowrap;transition:background .15s}
tr:hover td{background:rgba(0,212,170,.03)}
.stock-name{max-width:200px;overflow:hidden;text-overflow:ellipsis}
.stock-name a{color:var(--tx);text-decoration:none;font-weight:500;transition:color .2s}
.stock-name a:hover{color:var(--ac)}
.stock-name .ticker{color:var(--t2);font-size:.72rem;font-weight:400}
.pos{color:var(--gn)}.neg{color:var(--rd)}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.tag-high{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.2)}
.tag-avg{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.2)}
.tag-low{background:rgba(239,68,68,.1);color:var(--rd);border:1px solid rgba(239,68,68,.2)}
.tag-creamy{background:rgba(168,85,247,.15);color:var(--pp);border:1px solid rgba(168,85,247,.3);font-weight:700}
.range-bar{width:80px;height:6px;background:var(--s3);border-radius:3px;position:relative;display:inline-block;vertical-align:middle}
.range-bar .fill{height:100%;border-radius:3px;position:absolute;left:0;top:0}
.range-pct{font-size:.75rem;margin-left:6px;font-weight:600}
.vol{color:var(--t2);font-size:.78rem}
.mcap{color:var(--t2);font-size:.78rem}
.wl-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.68rem;background:var(--s3);color:var(--t2);border:1px solid var(--bd);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.footer{text-align:center;padding:16px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd)}

/* Mobile card view */
#cards-container{display:none;padding:0 12px 24px}
.stock-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:10px}
.stock-card .card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.stock-card .card-name{font-weight:600;font-size:.9rem;line-height:1.3}
.stock-card .card-name a{color:var(--tx);text-decoration:none}
.stock-card .card-ticker{color:var(--t2);font-size:.72rem}
.stock-card .card-price{text-align:right}
.stock-card .card-price .price{font-size:1.1rem;font-weight:700}
.stock-card .card-price .change{font-size:.8rem;font-weight:600}
.stock-card .card-row{display:flex;justify-content:space-between;padding:4px 0;border-top:1px solid rgba(42,42,56,.4);font-size:.78rem}
.stock-card .card-row:first-of-type{border-top:none}
.stock-card .card-label{color:var(--t2)}
.stock-card .card-val{font-weight:500}
.stock-card .card-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid rgba(42,42,56,.4)}
.stock-card .card-range{margin:8px 0 4px}
.stock-card .card-range .range-bar{width:100%}
.sort-select{display:none}

/* ─────── Deep Research AI ─────── */
.research-btn{background:none;border:none;cursor:pointer;padding:1px 4px;border-radius:4px;font-size:.82rem;color:var(--t3);transition:color .15s;vertical-align:middle;margin-left:2px;line-height:1;flex-shrink:0}.research-btn:hover{color:#a78bfa}
#dr-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9991;overflow-y:auto;padding:20px 12px}
#dr-modal{background:var(--s2);border:1px solid var(--bd);border-radius:14px;max-width:640px;margin:20px auto;padding:22px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.dr-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--bd)}
.dr-title{font-size:1.1rem;font-weight:700;color:var(--tx)}.dr-subtitle{font-size:.75rem;color:var(--t2);margin-top:3px}
#dr-close{background:none;border:none;cursor:pointer;color:var(--t3);font-size:1.2rem;padding:0;line-height:1;flex-shrink:0}
.dr-section{margin-bottom:18px}.dr-section-title{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ac);font-weight:700;margin-bottom:8px}
.dr-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dr-metric{background:var(--s1);border:1px solid var(--bd);border-radius:8px;padding:10px 12px}.dr-metric .dm-label{font-size:.65rem;color:var(--t2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}.dr-metric .dm-val{font-size:.9rem;font-weight:600}.dr-metric .dm-sub{font-size:.65rem;color:var(--t3);margin-top:2px}
.dr-signal{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:7px;margin-bottom:5px;font-size:.8rem;line-height:1.4}.dr-signal.bull{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.18);color:var(--gn)}.dr-signal.bear{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);color:var(--rd)}.dr-signal.neut{background:rgba(234,179,8,.07);border:1px solid rgba(234,179,8,.18);color:var(--yw)}.dr-signal .ds-icon{flex-shrink:0;margin-top:1px}
.dr-ai-box{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:14px;font-size:.82rem;line-height:1.7;color:var(--tx);min-height:80px}.dr-ai-box.loading{color:var(--t2);font-style:italic}
.dr-ai-error{color:var(--rd);font-size:.78rem;padding:6px 0}.dr-ai-key-row{display:flex;gap:8px;margin-top:10px;align-items:center}
.dr-ai-key-input{flex:1;padding:7px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--s3);color:var(--tx);font-size:.78rem;font-family:inherit;outline:none;transition:border .2s}.dr-ai-key-input:focus{border-color:var(--ac)}
.dr-ai-key-btn{padding:7px 14px;border:none;border-radius:6px;background:#a78bfa;color:#fff;cursor:pointer;font-size:.78rem;font-weight:700;font-family:inherit;white-space:nowrap}.dr-ai-key-btn:hover{background:#9061f9}
@media(max-width:768px){#dr-overlay{padding:0}#dr-modal{border-radius:0;min-height:100dvh;margin:0;max-width:100%}.dr-grid{grid-template-columns:1fr}}

@media(max-width:768px){
  .header{padding:12px 14px}
  .header h1{font-size:1rem}
  .stats-bar{padding:10px 12px;gap:8px}
  .stat-card{min-width:0;flex:1 1 calc(33.3% - 8px);padding:8px 10px}
  .stat-card .label{font-size:.6rem}
  .stat-card .value{font-size:1.05rem}
  .controls{padding:10px 12px;gap:6px}
  .controls .label{display:none}
  .filter-group{flex-wrap:wrap;width:100%}
  .filter-group .fg-label{width:100%;padding:2px 6px}
  .search{width:100%;font-size:16px}
  .multi-dd{width:100%}
  .multi-dd .dd-btn{width:100%;font-size:16px}
  .multi-dd .dd-panel{width:100%}
  .table-container{display:none}
  #cards-container{display:block}
  .sort-select{display:block;width:100%;margin-top:4px}
  .footer{font-size:.65rem;padding:12px}
}
${alertSystem.css}
/* Alerted rows — pinned to top with amber highlight */
tr.alerted-row{background:rgba(234,179,8,.07)!important;box-shadow:inset 3px 0 0 var(--yw)}
.stock-card.alerted-row{border-left:3px solid var(--yw)!important;background:rgba(234,179,8,.05)!important}
</style>
</head>
<body>

<div class="header">
  <h1><span>Stock</span> Dashboard</h1>
  <div class="header-right">
    <a href="creamy.html" style="color:var(--t2);text-decoration:none;font-size:.8rem;padding:6px 12px;border:1px solid var(--bd);border-radius:6px;transition:all .2s" onmouseover="this.style.color='var(--ac)';this.style.borderColor='var(--ac)'" onmouseout="this.style.color='var(--t2)';this.style.borderColor='var(--bd)'">Creamy Layer</a>
    <a href="breakout.html" style="color:var(--t2);text-decoration:none;font-size:.8rem;padding:6px 12px;border:1px solid var(--bd);border-radius:6px;transition:all .2s" onmouseover="this.style.color='var(--ac)';this.style.borderColor='var(--ac)'" onmouseout="this.style.color='var(--t2)';this.style.borderColor='var(--bd)'">Breakout Scanner</a>
    <div class="status"><div class="dot"></div><span id="status-text">Snapshot</span></div>
  </div>
</div>

<div class="stats-bar" id="stats-bar"></div>

${alertSystem.bannerHtml}
${alertSystem.modalHtml}

<div id="dr-overlay">
  <div id="dr-modal">
    <div class="dr-header">
      <div>
        <div class="dr-title" id="dr-title">Deep Research</div>
        <div class="dr-subtitle" id="dr-subtitle"></div>
      </div>
      <button id="dr-close">&#x2715;</button>
    </div>
    <div id="dr-content"></div>
  </div>
</div>

<div class="controls">
  <div class="filter-group">
    <span class="fg-label">Show</span>
    <button class="btn tog-btn" data-tog="creamy">Creamy Layer</button>
    <button class="btn tog-btn" data-tog="near3m">Near 3M Low</button>
  </div>
  <div class="multi-dd" id="wl-dd">
    <button class="dd-btn" type="button"><span id="wl-label">All Watchlists</span><span class="dd-arrow">\\u25BC</span></button>
    <div class="dd-panel" id="wl-panel"></div>
  </div>
  <input type="text" class="search" id="search" placeholder="Search ticker or name..." style="margin-left:auto">
  <select id="sort-select" class="search sort-select">
    <option value="pctInRange:asc">Sort: 3M Range (low first)</option>
    <option value="changePct:desc">Sort: Change (best first)</option>
    <option value="changePct:asc">Sort: Change (worst first)</option>
    <option value="fullName:asc">Sort: Name A-Z</option>
    <option value="price:desc">Sort: Price (high first)</option>
    <option value="marketCap:desc">Sort: Market Cap</option>
    <option value="volume:desc">Sort: Volume</option>
  </select>
</div>

<div class="table-container">
  <table id="stock-table">
    <thead><tr id="table-head"></tr></thead>
    <tbody id="table-body"></tbody>
  </table>
</div>

<div id="cards-container"></div>

<div class="footer" id="footer"></div>

<script>
const RAW_DATA = ${dataJson};

let allStocks = RAW_DATA.stocks;
let sortCol = 'pctInRange';
let sortAsc = true;
let filterCreamy = false;
let filterNear3m = false;
let activeWls = new Set();
let searchTerm = '';

const COLS = [
  { key: 'rank', label: '#', w: '40px' },
  { key: 'fullName', label: 'Stock', w: '200px' },
  { key: 'watchlist', label: 'Watchlist', w: '110px' },
  { key: 'price', label: 'Price', w: '85px', num: true },
  { key: 'changePct', label: 'Change', w: '90px', num: true },
  { key: 'pctInRange', label: '3M Range Position', w: '180px', num: true },
  { key: 'low3m', label: '3M Low', w: '80px', num: true },
  { key: 'high3m', label: '3M High', w: '80px', num: true },
  { key: 'perfTag', label: 'Performance', w: '95px' },
  { key: 'growthTag', label: 'Growth', w: '80px' },
  { key: 'profitTag', label: 'Profitability', w: '90px' },
  { key: 'valTag', label: 'Valuation', w: '80px' },
  { key: 'volume', label: 'Volume', w: '90px', num: true },
  { key: 'marketCap', label: 'Market Cap', w: '100px', num: true },
  { key: 'fiftyTwoWeekLow', label: '52W Low', w: '80px', num: true },
  { key: 'fiftyTwoWeekHigh', label: '52W High', w: '80px', num: true },
];

function buildHead() {
  document.getElementById('table-head').innerHTML = COLS.map(c =>
    '<th style="width:'+c.w+'" data-col="'+c.key+'" class="'+(sortCol===c.key?'sorted':'')+'" onclick="doSort(\\''+c.key+'\\','+!!c.num+')">'+c.label+'<span class="arrow">'+(sortCol===c.key?(sortAsc?'\\u25B2':'\\u25BC'):'\\u21C5')+'</span></th>'
  ).join('');
}

function fmt(n, d) { return n == null ? '\\u2014' : Number(n).toFixed(d ?? 2); }
function fmtLakh(n) {
  if (n == null) return '\\u2014';
  if (n >= 1e12) return (n/1e12).toFixed(1)+'T';
  if (n >= 1e7) return (n/1e7).toFixed(0)+'Cr';
  if (n >= 1e5) return (n/1e5).toFixed(1)+'L';
  return n.toLocaleString('en-IN');
}
function fmtVol(n) {
  if (n == null) return '\\u2014';
  if (n >= 1e7) return (n/1e7).toFixed(1)+'Cr';
  if (n >= 1e5) return (n/1e5).toFixed(1)+'L';
  if (n >= 1e3) return (n/1e3).toFixed(0)+'K';
  return n.toString();
}

function tagHtml(tag) {
  if (!tag) return '<span class="tag" style="opacity:.3">\\u2014</span>';
  const cls = tag === 'High' ? 'tag-high' : tag === 'Avg' ? 'tag-avg' : 'tag-low';
  return '<span class="tag '+cls+'">'+tag+'</span>';
}

function rangeBarHtml(pct) {
  if (pct == null) return '\\u2014';
  const clamped = Math.max(0, Math.min(100, pct));
  const color = pct <= 10 ? 'var(--rd)' : pct <= 30 ? 'var(--yw)' : pct <= 70 ? 'var(--ac)' : 'var(--gn)';
  const pctCls = pct <= 10 ? 'neg' : pct >= 70 ? 'pos' : '';
  return '<span class="range-bar"><span class="fill" style="width:'+clamped+'%;background:'+color+'"></span></span><span class="range-pct '+pctCls+'">'+pct.toFixed(1)+'%</span>';
}

function renderTable() {
  var _al={};try{_al=JSON.parse(localStorage.getItem('stockAlerts_v1')||'{}')}catch(e){}
  let filtered = allStocks.filter(s => {
    if (filterCreamy && s.perfTag !== 'High') return false;
    if (filterNear3m && (s.pctInRange == null || s.pctInRange > 10)) return false;
    if (activeWls.size > 0 && !activeWls.has(s.watchlist)) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      if (!s.ticker.toLowerCase().includes(q) && !s.fullName.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const aA=!!_al[a.ticker], bA=!!_al[b.ticker];
    if (aA !== bA) return aA ? -1 : 1;
    let va = a[sortCol], vb = b[sortCol];
    if (va == null) va = sortAsc ? Infinity : -Infinity;
    if (vb == null) vb = sortAsc ? Infinity : -Infinity;
    if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return sortAsc ? va - vb : vb - va;
  });

  // Desktop table
  document.getElementById('table-body').innerHTML = filtered.map((s, i) => {
    const chgCls = (s.changePct||0) >= 0 ? 'pos' : 'neg';
    const chgSign = (s.changePct||0) >= 0 ? '+' : '';
    const isCreamy = s.perfTag === 'High';
    return '<tr'+((_al[s.ticker])?' class="alerted-row"':'')+'>'
      + '<td style="color:var(--t3)">'+(i+1)+'</td>'
      + '<td><div class="stock-name"><a href="'+s.stockUrl+'" target="_blank">'+s.fullName+'</a><div class="ticker">'+s.ticker+(isCreamy?' <span class="tag tag-creamy">CREAMY</span>':'')+'</div></div><button class="alert-btn" data-alert-ticker="'+s.ticker+'" data-alert-price="'+(s.price||0)+'" data-alert-name="'+(s.fullName||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'">&#x1F514;</button><button class="research-btn" data-r-ticker="'+s.ticker+'" title="AI Deep Research">&#x1F9E0;</button></td>'
      + '<td><span class="wl-badge" title="'+s.watchlist+'">'+s.watchlist+'</span></td>'
      + '<td style="font-weight:600">'+(s.price?'\\u20B9'+fmt(s.price):'\\u2014')+'</td>'
      + '<td class="'+chgCls+'">'+(s.changePct!=null?chgSign+fmt(s.changePct,2)+'%':'\\u2014')+'</td>'
      + '<td>'+rangeBarHtml(s.pctInRange)+'</td>'
      + '<td style="color:var(--t2)">'+(s.low3m?'\\u20B9'+fmt(s.low3m):'\\u2014')+'</td>'
      + '<td style="color:var(--t2)">'+(s.high3m?'\\u20B9'+fmt(s.high3m):'\\u2014')+'</td>'
      + '<td>'+tagHtml(s.perfTag)+'</td>'
      + '<td>'+tagHtml(s.growthTag)+'</td>'
      + '<td>'+tagHtml(s.profitTag)+'</td>'
      + '<td>'+tagHtml(s.valTag)+'</td>'
      + '<td class="vol">'+fmtVol(s.volume)+'</td>'
      + '<td class="mcap">'+fmtLakh(s.marketCap)+'</td>'
      + '<td style="color:var(--t2)">'+(s.fiftyTwoWeekLow?'\\u20B9'+fmt(s.fiftyTwoWeekLow):'\\u2014')+'</td>'
      + '<td style="color:var(--t2)">'+(s.fiftyTwoWeekHigh?'\\u20B9'+fmt(s.fiftyTwoWeekHigh):'\\u2014')+'</td>'
      + '</tr>';
  }).join('');
  buildHead();

  // Mobile cards
  document.getElementById('cards-container').innerHTML = filtered.map(s => {
    const chgCls = (s.changePct||0) >= 0 ? 'pos' : 'neg';
    const chgSign = (s.changePct||0) >= 0 ? '+' : '';
    const isCreamy = s.perfTag === 'High';
    const pctClamped = s.pctInRange != null ? Math.max(0,Math.min(100,s.pctInRange)) : 0;
    const barColor = s.pctInRange == null ? 'var(--s3)' : s.pctInRange <= 10 ? 'var(--rd)' : s.pctInRange <= 30 ? 'var(--yw)' : s.pctInRange <= 70 ? 'var(--ac)' : 'var(--gn)';
    return '<div class="stock-card'+(_al[s.ticker]?' alerted-row':'')+'">'
      + '<div class="card-header">'
      +   '<div><div class="card-name"><a href="'+s.stockUrl+'" target="_blank">'+s.fullName+'</a></div>'
      +   '<div class="card-ticker">'+s.ticker+(isCreamy?' <span class="tag tag-creamy">CREAMY</span>':'')
      +   ' <span class="wl-badge">'+s.watchlist+'</span> <button class="alert-btn" data-alert-ticker="'+s.ticker+'" data-alert-price="'+(s.price||0)+'" data-alert-name="'+(s.fullName||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'">&#x1F514;</button><button class="research-btn" data-r-ticker="'+s.ticker+'" title="AI Deep Research">&#x1F9E0;</button></div></div>'
      +   '<div class="card-price"><div class="price">'+(s.price?'\\u20B9'+fmt(s.price):'\\u2014')+'</div>'
      +   '<div class="change '+chgCls+'">'+(s.changePct!=null?chgSign+fmt(s.changePct,2)+'%':'')+'</div></div>'
      + '</div>'
      + '<div class="card-range"><span style="font-size:.7rem;color:var(--t2)">3M Range: '+(s.pctInRange!=null?'<span class="'+(s.pctInRange<=10?'neg':s.pctInRange>=70?'pos':'')+'">'+s.pctInRange.toFixed(1)+'%</span>':'\\u2014')+'</span>'
      +   '<div class="range-bar" style="width:100%;height:6px;margin-top:4px"><span class="fill" style="width:'+pctClamped+'%;background:'+barColor+'"></span></div>'
      +   '<div style="display:flex;justify-content:space-between;font-size:.65rem;color:var(--t3);margin-top:2px"><span>'+(s.low3m?'\\u20B9'+fmt(s.low3m):'')+'</span><span>'+(s.high3m?'\\u20B9'+fmt(s.high3m):'')+'</span></div>'
      + '</div>'
      + '<div class="card-row"><span class="card-label">Volume</span><span class="card-val">'+fmtVol(s.volume)+'</span></div>'
      + '<div class="card-row"><span class="card-label">Market Cap</span><span class="card-val">'+fmtLakh(s.marketCap)+'</span></div>'
      + '<div class="card-row"><span class="card-label">52W Range</span><span class="card-val">'+(s.fiftyTwoWeekLow?'\\u20B9'+fmt(s.fiftyTwoWeekLow):'\\u2014')+' \\u2013 '+(s.fiftyTwoWeekHigh?'\\u20B9'+fmt(s.fiftyTwoWeekHigh):'\\u2014')+'</span></div>'
      + '<div class="card-tags">'
      +   '<span style="font-size:.65rem;color:var(--t3);width:100%;margin-bottom:2px">Perf '+tagHtml(s.perfTag)+' Growth '+tagHtml(s.growthTag)+' Profit '+tagHtml(s.profitTag)+' Val '+tagHtml(s.valTag)+'</span>'
      + '</div>'
      + '</div>';
  }).join('');
}

function renderStats() {
  const total = allStocks.length;
  const withPrice = allStocks.filter(s => s.price != null);
  const gainers = withPrice.filter(s => (s.changePct||0) > 0).length;
  const losers = withPrice.filter(s => (s.changePct||0) < 0).length;
  const creamy = allStocks.filter(s => s.perfTag === 'High').length;
  const nearBottom = allStocks.filter(s => s.pctInRange != null && s.pctInRange <= 10).length;
  const near52Low = allStocks.filter(s => s.price && s.fiftyTwoWeekLow && s.price <= s.fiftyTwoWeekLow * 1.05).length;

  document.getElementById('stats-bar').innerHTML = [
    { l: 'Total Stocks', v: total, c: 'accent' },
    { l: 'Gainers', v: gainers, c: 'green' },
    { l: 'Losers', v: losers, c: 'red' },
    { l: 'Creamy Layer', v: creamy, c: 'accent' },
    { l: 'Near 3M Low (<10%)', v: nearBottom, c: 'red' },
    { l: 'Near 52W Low', v: near52Low, c: 'red' },
  ].map(s => '<div class="stat-card"><div class="label">'+s.l+'</div><div class="value '+s.c+'">'+s.v+'</div></div>').join('');
}

function populateWlFilter() {
  const wls = [...new Set(allStocks.map(s => s.watchlist))].sort();
  const panel = document.getElementById('wl-panel');
  panel.innerHTML = '<div class="dd-actions"><button onclick="wlAll()">Select All</button><button onclick="wlNone()">Clear All</button></div>'
    + wls.map(w => {
      const c = allStocks.filter(s => s.watchlist === w).length;
      return '<label><input type="checkbox" value="'+w+'" class="wl-cb"><span>'+w+'</span><span class="dd-count">'+c+'</span></label>';
    }).join('');
  panel.querySelectorAll('.wl-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) activeWls.add(cb.value); else activeWls.delete(cb.value);
      updateWlLabel(); renderTable();
    });
  });
}
function updateWlLabel() {
  const el = document.getElementById('wl-label');
  if (activeWls.size === 0) el.textContent = 'All Watchlists';
  else if (activeWls.size <= 2) el.textContent = [...activeWls].join(', ');
  else el.textContent = activeWls.size + ' Watchlists';
}
function wlAll() {
  document.querySelectorAll('.wl-cb').forEach(cb => { cb.checked = true; activeWls.add(cb.value); });
  updateWlLabel(); renderTable();
}
function wlNone() {
  document.querySelectorAll('.wl-cb').forEach(cb => { cb.checked = false; });
  activeWls.clear(); updateWlLabel(); renderTable();
}

function doSort(col, isNum) {
  if (sortCol === col) sortAsc = !sortAsc;
  else { sortCol = col; sortAsc = true; }
  renderTable();
}

// Toggle filter buttons (multi-select, AND logic)
document.querySelectorAll('.tog-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('active');
    const tog = btn.dataset.tog;
    if (tog === 'creamy') filterCreamy = btn.classList.contains('active');
    if (tog === 'near3m') filterNear3m = btn.classList.contains('active');
    renderTable();
  });
});

// Watchlist dropdown toggle
document.getElementById('wl-dd').querySelector('.dd-btn').addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('wl-dd').classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!e.target.closest('#wl-dd')) document.getElementById('wl-dd').classList.remove('open');
});

document.getElementById('search').addEventListener('input', e => { searchTerm = e.target.value; renderTable(); });
document.getElementById('sort-select').addEventListener('change', e => {
  const [col, dir] = e.target.value.split(':');
  sortCol = col; sortAsc = dir === 'asc';
  renderTable();
});

// Boot
const t = new Date(RAW_DATA.updatedAt);
document.getElementById('status-text').textContent = 'Snapshot: ' + t.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
document.getElementById('footer').textContent = 'Data as of ' + t.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST — Auto-updates every 10 min during market hours (Mon\\u2013Fri, 9:15 AM\\u20133:30 PM IST)';
renderStats();
populateWlFilter();
renderTable();
window.onAlertChange=function(){renderTable();};
${alertSystem.js}
// ─────── Deep Research AI ───────
(function(){
  var DR_KEY = 'dr_gemini_key';
  var drCurrentStock = null;

  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.research-btn');
    if (!btn) return;
    e.stopPropagation();
    var ticker = btn.dataset.rTicker;
    if (ticker) openDeepResearch(ticker);
  });

  document.getElementById('dr-close').addEventListener('click', closeDr);
  document.getElementById('dr-overlay').addEventListener('click', function(e){
    if (e.target === document.getElementById('dr-overlay')) closeDr();
  });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeDr(); });

  function closeDr() {
    document.getElementById('dr-overlay').style.display = 'none';
    document.body.style.overflow = '';
  }

  window.openDeepResearch = function(ticker) {
    var s = allStocks.find(function(x){ return x.ticker === ticker; });
    if (!s) return;
    drCurrentStock = s;
    document.getElementById('dr-title').textContent = s.fullName;
    document.getElementById('dr-subtitle').textContent = s.ticker + ' \u00b7 NSE India \u00b7 ' + s.watchlist;
    document.getElementById('dr-content').innerHTML = buildDrContent(s);
    document.getElementById('dr-overlay').style.display = 'block';
    document.body.style.overflow = 'hidden';
    var key = localStorage.getItem(DR_KEY);
    if (key) {
      var inp = document.getElementById('dr-key-input');
      if (inp) inp.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      runGeminiAnalysis(s, key);
    }
  };

  window.drRunWithKey = function() {
    var inp = document.getElementById('dr-key-input');
    if (!inp) return;
    var key = inp.value.trim();
    if (key.indexOf('\u2022') !== -1) key = localStorage.getItem(DR_KEY) || '';
    if (!key) { inp.focus(); return; }
    localStorage.setItem(DR_KEY, key);
    inp.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    if (drCurrentStock) runGeminiAnalysis(drCurrentStock, key);
  };

  function buildDrContent(s) {
    var pos52w = (s.price && s.fiftyTwoWeekLow && s.fiftyTwoWeekHigh)
      ? ((s.price - s.fiftyTwoWeekLow) / (s.fiftyTwoWeekHigh - s.fiftyTwoWeekLow) * 100)
      : null;
    var relVol = (s.volume && s.avgVolume) ? (s.volume / s.avgVolume) : null;
    var signals = computeDrSignals(s, pos52w, relVol);
    var stance = computeDrStance(s);
    var stanceCls = stance === 'bull' ? 'pos' : stance === 'bear' ? 'neg' : '';
    var stanceLabel = stance === 'bull' ? '\u25b2 Bullish Setup' : stance === 'bear' ? '\u25bc Bearish Setup' : '\u25c6 Neutral Setup';
    var chgCls = (s.changePct||0) >= 0 ? 'pos' : 'neg';
    var chgSign = (s.changePct||0) >= 0 ? '+' : '';
    var html = '';
    html += '<div class="dr-section">'
      + '<div class="dr-section-title">\ud83d\udcca Price Metrics</div>'
      + '<div class="dr-grid">'
      + drMetric('Current Price', s.price ? '\u20b9' + s.price.toFixed(2) : '\u2014', s.changePct != null ? chgSign+s.changePct.toFixed(2)+'% today' : '', chgCls)
      + drMetric('3M Range Position', s.pctInRange != null ? s.pctInRange.toFixed(1)+'%' : '\u2014', 'Low \u20b9'+(s.low3m||'\u2014')+' \u00b7 High \u20b9'+(s.high3m||'\u2014'), s.pctInRange != null ? (s.pctInRange <= 15 ? 'neg' : s.pctInRange >= 70 ? 'pos' : '') : '')
      + drMetric('52W Range Position', pos52w != null ? pos52w.toFixed(1)+'%' : '\u2014', 'Low \u20b9'+(s.fiftyTwoWeekLow||'\u2014')+' \u00b7 High \u20b9'+(s.fiftyTwoWeekHigh||'\u2014'), pos52w != null ? (pos52w <= 10 ? 'neg' : pos52w >= 80 ? 'pos' : '') : '')
      + drMetric('Relative Volume', relVol != null ? relVol.toFixed(2)+'x' : '\u2014', s.volume ? fmtVol(s.volume)+' vs '+fmtVol(s.avgVolume)+' avg' : '', relVol != null ? (relVol >= 2 ? 'pos' : relVol < 0.5 ? 'neg' : '') : '')
      + drMetric('Market Cap', fmtLakh(s.marketCap), '', '')
      + drMetric('Day Range', (s.dayLow && s.dayHigh) ? '\u20b9'+s.dayLow.toFixed(0)+' \u2013 \u20b9'+s.dayHigh.toFixed(0) : '\u2014', s.prevClose ? 'Prev Close \u20b9'+s.prevClose.toFixed(2) : '', '')
      + '</div></div>';
    html += '<div class="dr-section"><div class="dr-section-title">\ud83d\udcc8 Technical Signals</div>';
    for (var i = 0; i < signals.length; i++) {
      html += '<div class="dr-signal '+signals[i].type+'"><span class="ds-icon">'+signals[i].icon+'</span><span>'+signals[i].text+'</span></div>';
    }
    html += '</div>';
    html += '<div class="dr-section"><div class="dr-section-title">\ud83c\udfe2 Fundamental Scorecard (Tickertape)</div>'
      + '<div class="dr-grid">'
      + drMetric('Performance', tagHtml(s.perfTag), s.perfDesc || '', '')
      + drMetric('Growth', tagHtml(s.growthTag), '', '')
      + drMetric('Profitability', tagHtml(s.profitTag), '', '')
      + drMetric('Valuation', tagHtml(s.valTag), '', '')
      + '</div>'
      + '<div style="margin-top:8px;padding:8px 12px;border-radius:8px;background:var(--s1);border:1px solid var(--bd);font-size:.78rem;color:var(--t2)">'
      + 'Overall Signal: <strong class="'+stanceCls+'" style="margin-left:6px">'+stanceLabel+'</strong>'
      + '</div></div>';
    html += '<div class="dr-section">'
      + '<div class="dr-section-title">\ud83e\udde0 AI Deep Analysis <span style="font-size:.6rem;color:var(--t3);font-weight:400;text-transform:none">(Google Gemini)</span></div>'
      + '<div id="dr-ai-box" class="dr-ai-box loading">Enter your Gemini API key below to get comprehensive AI-powered analysis — technical, fundamental, analyst perspective, risks &amp; verdict.</div>'
      + '<div id="dr-ai-error" class="dr-ai-error" style="display:none"></div>'
      + '<div class="dr-ai-key-row">'
      + '<input type="password" class="dr-ai-key-input" id="dr-key-input" placeholder="Paste Gemini API key (saved locally in browser)">'
      + '<button class="dr-ai-key-btn" onclick="drRunWithKey()">Analyse \u2726</button>'
      + '</div>'
      + '<div style="font-size:.62rem;color:var(--t3);margin-top:5px">Free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" style="color:var(--ac)">aistudio.google.com</a> \u00b7 Stored only in your browser</div>'
      + '</div>';
    return html;
  }

  function drMetric(label, val, sub, valCls) {
    return '<div class="dr-metric">'
      + '<div class="dm-label">'+label+'</div>'
      + '<div class="dm-val'+(valCls?' '+valCls:'')+'">'+val+'</div>'
      + (sub ? '<div class="dm-sub">'+sub+'</div>' : '')
      + '</div>';
  }

  function computeDrSignals(s, pos52w, relVol) {
    var signals = [];
    if (s.pctInRange != null) {
      if (s.pctInRange <= 10) signals.push({type:'bull', icon:'\u25b2', text:'Near 3-month low ('+s.pctInRange.toFixed(1)+'%) \u2014 price is at near-term support; watch for a reversal or bounce.'});
      else if (s.pctInRange >= 80) signals.push({type:'bear', icon:'\u25bc', text:'Near 3-month high ('+s.pctInRange.toFixed(1)+'%) \u2014 approaching resistance; momentum buyers may face selling pressure.'});
      else if (s.pctInRange <= 30) signals.push({type:'neut', icon:'\u25c6', text:'Lower third of 3M range ('+s.pctInRange.toFixed(1)+'%) \u2014 below recent midpoint; cautious accumulation zone.'});
      else signals.push({type:'neut', icon:'\u25c6', text:'Mid-range position ('+s.pctInRange.toFixed(1)+'% of 3M range) \u2014 no strong immediate technical signal.'});
    }
    if (pos52w != null) {
      if (pos52w <= 10) signals.push({type:'bull', icon:'\u25b2', text:'Near annual low ('+pos52w.toFixed(1)+'% of 52W range) \u2014 historically attractive entry zone for patient investors.'});
      else if (pos52w >= 90) signals.push({type:'bear', icon:'\u25bc', text:'Near annual high ('+pos52w.toFixed(1)+'% of 52W range) \u2014 strong uptrend but limited runway in near term.'});
      else if (pos52w >= 60) signals.push({type:'bull', icon:'\u25c6', text:'Upper half of annual range ('+pos52w.toFixed(1)+'%) \u2014 maintains a bullish long-term structure.'});
      else signals.push({type:'neut', icon:'\u25c6', text:'Lower half of annual range ('+pos52w.toFixed(1)+'%) \u2014 recovering; watch for trend confirmation.'});
    }
    if (relVol != null) {
      if (relVol >= 2) signals.push({type:'bull', icon:'\u25b2', text:'Volume spike: '+relVol.toFixed(1)+'x average \u2014 high institutional participation validates today\\'s price move.'});
      else if (relVol < 0.5) signals.push({type:'neut', icon:'\u25c6', text:'Low volume: '+relVol.toFixed(2)+'x average \u2014 thin trading; treat price move with caution.'});
    }
    if (s.changePct != null) {
      if (s.changePct >= 5) signals.push({type:'bull', icon:'\u25b2', text:'Strong day: +'+(s.changePct).toFixed(1)+'% \u2014 bullish momentum; monitor for follow-through sessions.'});
      else if (s.changePct <= -5) signals.push({type:'bear', icon:'\u25bc', text:'Weak day: '+(s.changePct).toFixed(1)+'% \u2014 bearish pressure; check for support levels.'});
    }
    if (!signals.length) signals.push({type:'neut', icon:'\u25c6', text:'Price data unavailable \u2014 no technical signals can be computed.'});
    return signals;
  }

  function computeDrStance(s) {
    var score = 0;
    if (s.perfTag === 'High') score += 2; else if (s.perfTag === 'Low') score -= 2;
    if (s.growthTag === 'High') score += 1; else if (s.growthTag === 'Low') score -= 1;
    if (s.profitTag === 'High') score += 1; else if (s.profitTag === 'Low') score -= 1;
    if (s.valTag === 'High') score += 1; else if (s.valTag === 'Low') score -= 1;
    if (s.pctInRange != null && s.pctInRange <= 15) score += 1;
    if (score >= 3) return 'bull';
    if (score <= -2) return 'bear';
    return 'neut';
  }

  function runGeminiAnalysis(s, apiKey) {
    var box = document.getElementById('dr-ai-box');
    var errEl = document.getElementById('dr-ai-error');
    if (!box) return;
    box.className = 'dr-ai-box loading';
    box.textContent = '\u23f3 Analysing ' + s.fullName + ' with Gemini AI\u2026';
    errEl.style.display = 'none';
    var pos52w = (s.price && s.fiftyTwoWeekLow && s.fiftyTwoWeekHigh)
      ? ((s.price - s.fiftyTwoWeekLow) / (s.fiftyTwoWeekHigh - s.fiftyTwoWeekLow) * 100).toFixed(1) + '%'
      : 'N/A';
    var relVol = (s.volume && s.avgVolume) ? (s.volume / s.avgVolume).toFixed(2) + 'x' : 'N/A';
    var chgSign = (s.changePct||0) >= 0 ? '+' : '';
    var prompt = 'You are a professional Indian stock market analyst. Analyse this NSE-listed stock and write a concise research note.\\n\\n'
      + 'STOCK: ' + s.fullName + ' (' + s.ticker + ') | NSE India | Watchlist: ' + s.watchlist + '\\n\\n'
      + 'PRICE DATA:\\n'
      + '- Current: \u20b9' + (s.price ? s.price.toFixed(2) : 'N/A') + ' | Day Change: ' + (s.changePct != null ? chgSign+s.changePct.toFixed(2)+'%' : 'N/A') + '\\n'
      + '- Day Range: \u20b9' + (s.dayLow ? s.dayLow.toFixed(2) : 'N/A') + ' \u2013 \u20b9' + (s.dayHigh ? s.dayHigh.toFixed(2) : 'N/A') + '\\n'
      + '- 3-Month Range: \u20b9' + (s.low3m||'N/A') + ' (low) \u2013 \u20b9' + (s.high3m||'N/A') + ' (high) | Current position: ' + (s.pctInRange != null ? s.pctInRange.toFixed(1)+'% above 3M low' : 'N/A') + '\\n'
      + '- 52-Week Range: \u20b9' + (s.fiftyTwoWeekLow||'N/A') + ' (low) \u2013 \u20b9' + (s.fiftyTwoWeekHigh||'N/A') + ' (high) | Position: ' + pos52w + ' above 52W low\\n'
      + '- Volume: ' + (s.volume ? fmtVol(s.volume) : 'N/A') + ' | 3M Avg: ' + (s.avgVolume ? fmtVol(s.avgVolume) : 'N/A') + ' | Relative Volume: ' + relVol + '\\n'
      + '- Market Cap: ' + fmtLakh(s.marketCap) + '\\n\\n'
      + 'TICKERTAPE SCORECARD (vs sector peers):\\n'
      + '- Performance (price return): ' + (s.perfTag||'N/A') + ' \u2014 ' + (s.perfDesc||'') + '\\n'
      + '- Growth (revenue/earnings): ' + (s.growthTag||'N/A') + '\\n'
      + '- Profitability (margins/ROE): ' + (s.profitTag||'N/A') + '\\n'
      + '- Valuation (P/E, P/B vs peers): ' + (s.valTag||'N/A') + '\\n\\n'
      + 'Write a concise research note in this EXACT format (2\u20133 sentences per section, use \u20b9 for prices):\\n\\n'
      + '**TECHNICAL OUTLOOK**\\n'
      + 'Discuss price trend, key support/resistance from 3M and 52W data, volume signal, momentum.\\n\\n'
      + '**FUNDAMENTAL VIEW**\\n'
      + 'Discuss business quality, growth trajectory, profitability, and valuation based on scorecard.\\n\\n'
      + '**ANALYST PERSPECTIVE**\\n'
      + 'What a buy-side analyst would say about near-term (3\u20136 months) and medium-term (1\u20132 year) prospects.\\n\\n'
      + '**KEY RISKS**\\n'
      + 'Top 2 company/sector-specific risks to monitor.\\n\\n'
      + '**KEY OPPORTUNITY**\\n'
      + 'Main upside catalyst or re-rating opportunity.\\n\\n'
      + '**VERDICT**: [BULLISH / NEUTRAL / BEARISH] \u2014 [one clear sentence reason]';
    fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + encodeURIComponent(apiKey), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        contents: [{parts: [{text: prompt}]}],
        generationConfig: {temperature: 0.65, maxOutputTokens: 1024}
      })
    })
    .then(function(resp) {
      if (!resp.ok) return resp.json().then(function(e){ throw new Error(e.error && e.error.message ? e.error.message : 'API error ' + resp.status); });
      return resp.json();
    })
    .then(function(data) {
      var text = data.candidates && data.candidates[0] && data.candidates[0].content
        && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
        && data.candidates[0].content.parts[0].text;
      if (!text) throw new Error('Empty response from Gemini');
      box.className = 'dr-ai-box';
      box.innerHTML = formatGeminiResponse(text);
    })
    .catch(function(err) {
      box.className = 'dr-ai-box';
      box.innerHTML = '<span style="color:var(--t2)">Could not generate AI analysis.</span>';
      errEl.style.display = 'block';
      errEl.textContent = '\u26a0\ufe0f ' + err.message;
    });
  }

  function formatGeminiResponse(text) {
    return text
      .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--ac);display:block;margin-top:12px;margin-bottom:4px">$1</strong>')
      .replace(/\\n\\n/g, '</p><p style="margin:4px 0">')
      .replace(/\\n/g, '<br>')
      .replace(/^/, '<p style="margin:0">')
      .replace(/$/, '</p>');
  }
})();
</script>
</body>
</html>`;
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const PORT = 3000;
const WATCHLIST_PATH = path.join(__dirname, 'my-watchlists.json');
const TICKER_URLS_PATH = path.join(__dirname, 'ticker-urls.json');

// ── Cache ────────────────────────────────────────────────────────────
let stockCache = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 60 seconds

// ── Load static data ─────────────────────────────────────────────────
function loadStaticData() {
  const watchlists = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
  const tickerUrls = JSON.parse(fs.readFileSync(TICKER_URLS_PATH, 'utf8'));
  const stocks = [];
  const seen = new Set();

  for (const wl of watchlists) {
    for (const [period, pData] of Object.entries(wl.periods || {})) {
      if (period !== '3M') continue;
      for (const s of pData.stocks || []) {
        const parts = (s.name || '').split('\n');
        const fullName = parts[0] || '';
        const ticker = (parts[1] || '').trim();
        if (!ticker || seen.has(ticker)) continue;
        seen.add(ticker);

        const parsePrice = v => parseFloat(String(v || '').replace(/[₹,]/g, ''));
        const low3m = parsePrice(s.cells[3]);
        const high3m = parsePrice(s.cells[4]);

        stocks.push({
          ticker,
          fullName,
          watchlist: wl.name.replace(/^Equity Watchlist\s*/, '') || 'Main',
          stockUrl: s.stockUrl || tickerUrls[ticker] || '',
          low3m: isNaN(low3m) ? null : low3m,
          high3m: isNaN(high3m) ? null : high3m,
        });
      }
    }
  }
  return stocks;
}

function extractSid(url) {
  const match = (url || '').match(/-([A-Z0-9_]+)$/);
  return match ? match[1] : null;
}

// ── Fetch Tickertape scorecards ──────────────────────────────────────
function fetchScorecard(sid) {
  return new Promise(resolve => {
    if (!sid) return resolve(null);
    const url = `https://analyze.api.tickertape.in/stocks/scorecard/${sid}`;
    https.get(url, { timeout: 8000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success && json.data) {
            const result = {};
            for (const d of json.data) {
              result[d.name] = { tag: d.tag, desc: d.description, score: d.score?.value ?? null, rank: d.rank, peers: d.peers };
            }
            resolve(result);
          } else resolve(null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ── Fetch Yahoo Finance quotes ───────────────────────────────────────
async function fetchYahooQuotes(tickers) {
  const results = {};
  const batchSize = 15;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const promises = batch.map(async t => {
      try {
        const q = await yahooFinance.quote(t + '.NS');
        return {
          ticker: t,
          price: q.regularMarketPrice,
          change: q.regularMarketChange,
          changePct: q.regularMarketChangePercent,
          dayHigh: q.regularMarketDayHigh,
          dayLow: q.regularMarketDayLow,
          prevClose: q.regularMarketPreviousClose,
          open: q.regularMarketOpen,
          volume: q.regularMarketVolume,
          marketCap: q.marketCap,
          fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: q.fiftyTwoWeekLow,
          avgVolume: q.averageDailyVolume3Month,
        };
      } catch {
        return { ticker: t, price: null };
      }
    });
    const batch_results = await Promise.all(promises);
    for (const r of batch_results) results[r.ticker] = r;
  }
  return results;
}

// ── Build full stock data ────────────────────────────────────────────
async function buildStockData() {
  if (stockCache && Date.now() - cacheTime < CACHE_TTL) return stockCache;

  console.log(`[${new Date().toLocaleTimeString()}] Refreshing stock data...`);
  const stocks = loadStaticData();

  // Fetch scorecards in parallel batches
  const scorecardPromises = [];
  for (let i = 0; i < stocks.length; i += 8) {
    const batch = stocks.slice(i, i + 8);
    scorecardPromises.push(
      Promise.all(batch.map(s => fetchScorecard(extractSid(s.stockUrl)).then(sc => ({ ticker: s.ticker, sc }))))
    );
  }
  const scorecardBatches = await Promise.all(scorecardPromises);
  const scorecards = {};
  for (const batch of scorecardBatches) {
    for (const { ticker, sc } of batch) scorecards[ticker] = sc;
  }

  // Fetch Yahoo quotes
  const quotes = await fetchYahooQuotes(stocks.map(s => s.ticker));

  // Merge
  const merged = stocks.map(s => {
    const q = quotes[s.ticker] || {};
    const sc = scorecards[s.ticker] || {};
    const range3m = (s.high3m && s.low3m) ? s.high3m - s.low3m : null;
    const pctInRange = (q.price && range3m && range3m > 0) ? ((q.price - s.low3m) / range3m * 100) : null;
    return { ...s, ...q, scorecard: sc, range3m, pctInRange };
  });

  stockCache = merged;
  cacheTime = Date.now();
  console.log(`  Done. ${merged.filter(s => s.price).length}/${merged.length} prices loaded.`);
  return merged;
}

// ── HTTP Server ──────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/stocks') {
    try {
      const data = await buildStockData();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ stocks: data, updatedAt: new Date().toISOString() }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (req.url === '/api/refresh') {
    stockCache = null;
    cacheTime = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
  }
});

server.listen(PORT, () => {
  console.log(`\n  Dashboard running at http://localhost:${PORT}\n`);
});

// ── Dashboard HTML ───────────────────────────────────────────────────
function getDashboardHtml() {
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
.status .dot{width:8px;height:8px;border-radius:50%;background:var(--gn);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.btn{padding:6px 14px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--t2);cursor:pointer;font-size:.8rem;font-family:inherit;transition:all .2s}
.btn:hover{color:var(--tx);border-color:var(--ac);background:var(--s3)}
.btn.active{background:var(--ac);color:var(--bg);border-color:var(--ac);font-weight:600}
.btn.refresh{border-color:var(--ac);color:var(--ac)}
.btn.refresh:hover{background:var(--ac);color:var(--bg)}
.stats-bar{display:flex;gap:12px;padding:14px 24px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap}
.stat-card{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 16px;min-width:120px}
.stat-card .label{font-size:.7rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.stat-card .value{font-size:1.3rem;font-weight:700}
.stat-card .value.green{color:var(--gn)}
.stat-card .value.red{color:var(--rd)}
.stat-card .value.accent{color:var(--ac)}
.controls{display:flex;gap:8px;padding:14px 24px;flex-wrap:wrap;align-items:center}
.controls .label{font-size:.75rem;color:var(--t2);margin-right:4px}
.search{padding:7px 12px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.85rem;font-family:inherit;width:200px;outline:none;transition:border .2s}
.search:focus{border-color:var(--ac)}
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
.range-bar .fill{height:100%;border-radius:3px;position:absolute;left:0;top:0;transition:width .3s}
.range-pct{font-size:.75rem;margin-left:6px;font-weight:600}
.vol{color:var(--t2);font-size:.78rem}
.mcap{color:var(--t2);font-size:.78rem}
.wl-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.68rem;background:var(--s3);color:var(--t2);border:1px solid var(--bd);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.loading{text-align:center;padding:60px;color:var(--t2);font-size:1rem}
.loading .spinner{width:32px;height:32px;border:3px solid var(--s3);border-top-color:var(--ac);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 12px}
@keyframes spin{to{transform:rotate(360deg)}}
.footer{text-align:center;padding:16px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd)}
</style>
</head>
<body>

<div class="header">
  <h1><span>Stock</span> Dashboard</h1>
  <div class="header-right">
    <div class="status"><div class="dot"></div><span id="status-text">Loading...</span></div>
    <button class="btn refresh" onclick="refreshData()">Refresh</button>
  </div>
</div>

<div class="stats-bar" id="stats-bar"></div>

<div class="controls" id="controls">
  <span class="label">Filter:</span>
  <button class="btn filter-btn active" data-filter="all">All</button>
  <button class="btn filter-btn" data-filter="creamy">Creamy Layer</button>
  <span class="label" style="margin-left:12px">Watchlist:</span>
  <select id="wl-filter" class="search" style="width:160px"></select>
  <input type="text" class="search" id="search" placeholder="Search ticker or name..." style="margin-left:auto">
</div>

<div class="table-container">
  <div class="loading" id="loading"><div class="spinner"></div>Fetching live data...</div>
  <table id="stock-table" style="display:none">
    <thead><tr id="table-head"></tr></thead>
    <tbody id="table-body"></tbody>
  </table>
</div>

<div class="footer" id="footer"></div>

<script>
let allStocks = [];
let sortCol = 'pctInRange';
let sortAsc = true;
let currentFilter = 'all';
let currentWl = 'all';
let searchTerm = '';
let autoRefreshTimer = null;

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
  const tr = document.getElementById('table-head');
  tr.innerHTML = COLS.map(c =>
    '<th style="width:'+c.w+'" data-col="'+c.key+'" class="'+(sortCol===c.key?'sorted':'')+'" onclick="doSort(\\''+c.key+'\\','+!!c.num+')">'+c.label+'<span class="arrow">'+(sortCol===c.key?(sortAsc?'▲':'▼'):'⇅')+'</span></th>'
  ).join('');
}

function fmt(n, d) { return n == null ? '—' : Number(n).toFixed(d ?? 2); }
function fmtLakh(n) {
  if (n == null) return '—';
  if (n >= 1e12) return (n/1e12).toFixed(1)+'T';
  if (n >= 1e7) return (n/1e7).toFixed(0)+'Cr';
  if (n >= 1e5) return (n/1e5).toFixed(1)+'L';
  return n.toLocaleString('en-IN');
}
function fmtVol(n) {
  if (n == null) return '—';
  if (n >= 1e7) return (n/1e7).toFixed(1)+'Cr';
  if (n >= 1e5) return (n/1e5).toFixed(1)+'L';
  if (n >= 1e3) return (n/1e3).toFixed(0)+'K';
  return n.toString();
}

function tagHtml(tag) {
  if (!tag) return '<span class="tag" style="opacity:.3">—</span>';
  const cls = tag === 'High' ? 'tag-high' : tag === 'Avg' ? 'tag-avg' : 'tag-low';
  return '<span class="tag '+cls+'">'+tag+'</span>';
}

function rangeBarHtml(pct) {
  if (pct == null) return '—';
  const clamped = Math.max(0, Math.min(100, pct));
  const color = pct <= 10 ? 'var(--rd)' : pct <= 30 ? 'var(--yw)' : pct <= 70 ? 'var(--ac)' : 'var(--gn)';
  const pctCls = pct <= 10 ? 'neg' : pct >= 70 ? 'pos' : '';
  return '<span class="range-bar"><span class="fill" style="width:'+clamped+'%;background:'+color+'"></span></span><span class="range-pct '+pctCls+'">'+pct.toFixed(1)+'%</span>';
}

function renderTable() {
  let filtered = allStocks.filter(s => {
    if (currentFilter === 'creamy' && s.perfTag !== 'High') return false;
    if (currentWl !== 'all' && s.watchlist !== currentWl) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      if (!s.ticker.toLowerCase().includes(q) && !s.fullName.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (va == null) va = sortAsc ? Infinity : -Infinity;
    if (vb == null) vb = sortAsc ? Infinity : -Infinity;
    if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return sortAsc ? va - vb : vb - va;
  });

  const tbody = document.getElementById('table-body');
  tbody.innerHTML = filtered.map((s, i) => {
    const chgCls = (s.changePct||0) >= 0 ? 'pos' : 'neg';
    const chgSign = (s.changePct||0) >= 0 ? '+' : '';
    const isCreamy = s.perfTag === 'High';
    return '<tr>'
      + '<td style="color:var(--t3)">'+(i+1)+'</td>'
      + '<td class="stock-name"><a href="'+s.stockUrl+'" target="_blank">'+s.fullName+'</a><br><span class="ticker">'+s.ticker+(isCreamy?' <span class="tag tag-creamy">CREAMY</span>':'')+'</span></td>'
      + '<td><span class="wl-badge" title="'+s.watchlist+'">'+s.watchlist+'</span></td>'
      + '<td style="font-weight:600">'+(s.price?'₹'+fmt(s.price):'—')+'</td>'
      + '<td class="'+chgCls+'">'+(s.changePct!=null?chgSign+fmt(s.changePct,2)+'%':'—')+'</td>'
      + '<td>'+rangeBarHtml(s.pctInRange)+'</td>'
      + '<td style="color:var(--t2)">'+(s.low3m?'₹'+fmt(s.low3m):'—')+'</td>'
      + '<td style="color:var(--t2)">'+(s.high3m?'₹'+fmt(s.high3m):'—')+'</td>'
      + '<td>'+tagHtml(s.perfTag)+'</td>'
      + '<td>'+tagHtml(s.growthTag)+'</td>'
      + '<td>'+tagHtml(s.profitTag)+'</td>'
      + '<td>'+tagHtml(s.valTag)+'</td>'
      + '<td class="vol">'+fmtVol(s.volume)+'</td>'
      + '<td class="mcap">'+fmtLakh(s.marketCap)+'</td>'
      + '<td style="color:var(--t2)">'+(s.fiftyTwoWeekLow?'₹'+fmt(s.fiftyTwoWeekLow):'—')+'</td>'
      + '<td style="color:var(--t2)">'+(s.fiftyTwoWeekHigh?'₹'+fmt(s.fiftyTwoWeekHigh):'—')+'</td>'
      + '</tr>';
  }).join('');

  buildHead();
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
  const sel = document.getElementById('wl-filter');
  sel.innerHTML = '<option value="all">All Watchlists</option>' + wls.map(w => '<option value="'+w+'">'+w+'</option>').join('');
}

async function loadData() {
  try {
    const resp = await fetch('/api/stocks');
    const data = await resp.json();
    allStocks = data.stocks.map(s => ({
      ...s,
      perfTag: s.scorecard?.Performance?.tag || null,
      growthTag: s.scorecard?.Growth?.tag || null,
      profitTag: s.scorecard?.Profitability?.tag || null,
      valTag: s.scorecard?.Valuation?.tag || null,
      perfDesc: s.scorecard?.Performance?.desc || '',
    }));

    document.getElementById('loading').style.display = 'none';
    document.getElementById('stock-table').style.display = 'table';

    renderStats();
    populateWlFilter();
    renderTable();

    const t = new Date(data.updatedAt);
    document.getElementById('status-text').textContent = 'Updated ' + t.toLocaleTimeString('en-IN');
    document.getElementById('footer').textContent = 'Last refresh: ' + t.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST — Auto-refreshes every 60s';
  } catch (err) {
    document.getElementById('loading').innerHTML = '<div style="color:var(--rd)">Error loading data: ' + err.message + '</div>';
  }
}

async function refreshData() {
  document.getElementById('status-text').textContent = 'Refreshing...';
  await fetch('/api/refresh');
  await loadData();
}

function doSort(col, isNum) {
  if (sortCol === col) { sortAsc = !sortAsc; }
  else { sortCol = col; sortAsc = isNum ? true : true; }
  renderTable();
}

// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderTable();
  });
});

document.getElementById('wl-filter').addEventListener('change', e => {
  currentWl = e.target.value;
  renderTable();
});

document.getElementById('search').addEventListener('input', e => {
  searchTerm = e.target.value;
  renderTable();
});

// Initial load + auto refresh
loadData();
autoRefreshTimer = setInterval(loadData, 60000);
</script>
</body>
</html>`;
}


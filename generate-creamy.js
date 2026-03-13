const https = require('https');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'docs', 'creamy.html');
const CONCURRENCY = 50;

function apiPost(url, body) {
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

function apiGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse error')); } });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchAllStocks() {
  const PAGE = 1000;
  const allStocks = [];
  const fields = [
    'ticker', 'name', 'sector', 'mrktCapf', 'lastPrice',
    '52wpct', '26wpct', '4wpct', 'pr1w', 'pr1d',
    'roe', 'pftMrg', 'aopm', 'rvng', 'epsg', 'ebitg',
    'apef', 'pbr', 'divDps',
    'acVol', '52whd', '52wld'
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
      allStocks.push({
        sid: item.sid,
        ticker: item.stock?.info?.ticker || '',
        name: item.stock?.info?.name || '',
        sector: item.stock?.advancedRatios?.sector || item.stock?.info?.sector || '',
        slug: item.stock?.slug || '',
        marketCap: item.stock?.advancedRatios?.mrktCapf || null,
        price: item.stock?.advancedRatios?.lastPrice || null,
        ret1Y: item.stock?.advancedRatios?.['52wpct'] || null,
        ret6M: item.stock?.advancedRatios?.['26wpct'] || null,
        ret1M: item.stock?.advancedRatios?.['4wpct'] || null,
        ret1W: item.stock?.advancedRatios?.pr1w || null,
        ret1D: item.stock?.advancedRatios?.pr1d || null,
        roe: item.stock?.advancedRatios?.roe || null,
        npm: item.stock?.advancedRatios?.pftMrg || null,
        ebitdaMargin: item.stock?.advancedRatios?.aopm || null,
        revGrowth: item.stock?.advancedRatios?.rvng || null,
        epsGrowth: item.stock?.advancedRatios?.epsg || null,
        ebitdaGrowth: item.stock?.advancedRatios?.ebitg || null,
        pe: item.stock?.advancedRatios?.apef || null,
        pb: item.stock?.advancedRatios?.pbr || null,
        divYield: item.stock?.advancedRatios?.divDps || null,
        volume: item.stock?.advancedRatios?.acVol || null,
        awayFrom52WH: item.stock?.advancedRatios?.['52whd'] || null,
        awayFrom52WL: item.stock?.advancedRatios?.['52wld'] || null,
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

function buildHtml(stocks, updatedAt) {
  const dataJson = JSON.stringify({ stocks, updatedAt });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Creamy Layer Stocks - India</title>
<style>
:root{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#a855f7;--tx:#e8e8f0;--t2:#8888a0;--t3:#5a5a70;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7;--tl:#06b6d4}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);overflow-x:hidden}
.header{background:linear-gradient(135deg,#1a1028,#12121a);border-bottom:1px solid var(--bd);padding:18px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.3rem;font-weight:700;background:linear-gradient(90deg,var(--pp),var(--tl));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .subtitle{font-size:.75rem;color:var(--t2);margin-top:2px}
.header-right{display:flex;align-items:center;gap:12px}
.status{font-size:.72rem;color:var(--t2)}
.back-link{color:var(--t2);text-decoration:none;font-size:.8rem;padding:6px 12px;border:1px solid var(--bd);border-radius:6px;transition:all .2s}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
.stats-bar{display:flex;gap:12px;padding:14px 24px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap}
.stat-card{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 16px;min-width:130px}
.stat-card .label{font-size:.68rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.stat-card .value{font-size:1.3rem;font-weight:700}
.stat-card .value.purple{color:var(--pp)}
.stat-card .value.green{color:var(--gn)}
.stat-card .value.red{color:var(--rd)}
.stat-card .value.blue{color:var(--bl)}
.stat-card .value.teal{color:var(--tl)}
.controls{display:flex;gap:8px;padding:14px 24px;flex-wrap:wrap;align-items:center}
.controls .label{font-size:.75rem;color:var(--t2);margin-right:4px}
.btn{padding:6px 14px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--t2);cursor:pointer;font-size:.8rem;font-family:inherit;transition:all .2s}
.btn:hover{color:var(--tx);border-color:var(--ac);background:var(--s3)}
.btn.active{background:var(--ac);color:#fff;border-color:var(--ac);font-weight:600}
.search{padding:7px 12px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.85rem;font-family:inherit;width:220px;outline:none;transition:border .2s}
.search:focus{border-color:var(--ac)}
select.search{cursor:pointer}
.table-container{padding:0 24px 24px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.8rem}
thead{position:sticky;top:0;z-index:10}
th{background:var(--s1);color:var(--ac);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;padding:10px 10px;text-align:left;border-bottom:2px solid var(--bd);cursor:pointer;white-space:nowrap;user-select:none;transition:color .2s}
th:hover{color:var(--tx)}
th .arrow{margin-left:4px;font-size:.6rem;opacity:.5}
th.sorted .arrow{opacity:1;color:var(--ac)}
td{padding:8px 10px;border-bottom:1px solid rgba(42,42,56,.4);white-space:nowrap;transition:background .15s}
tr:hover td{background:rgba(168,85,247,.04)}
.stock-name{max-width:220px;overflow:hidden;text-overflow:ellipsis}
.stock-name a{color:var(--tx);text-decoration:none;font-weight:500;transition:color .2s}
.stock-name a:hover{color:var(--ac)}
.stock-name .ticker{color:var(--t2);font-size:.7rem;font-weight:400}
.stock-name .sector{color:var(--t3);font-size:.65rem}
.pos{color:var(--gn)}.neg{color:var(--rd)}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.tag-high{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.2)}
.tag-avg{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.2)}
.tag-low{background:rgba(239,68,68,.1);color:var(--rd);border:1px solid rgba(239,68,68,.2)}
.tag-creamy{background:rgba(168,85,247,.18);color:var(--pp);border:1px solid rgba(168,85,247,.35);font-weight:700;font-size:.72rem;padding:3px 10px}
.score-bar{display:inline-flex;gap:3px;align-items:center}
.score-pip{width:8px;height:8px;border-radius:2px;display:inline-block}
.mcap-label{font-size:.65rem;padding:2px 6px;border-radius:3px;font-weight:600}
.mcap-large{background:rgba(59,130,246,.12);color:var(--bl);border:1px solid rgba(59,130,246,.2)}
.mcap-mid{background:rgba(168,85,247,.12);color:var(--pp);border:1px solid rgba(168,85,247,.2)}
.mcap-small{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.2)}
.footer{text-align:center;padding:16px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd)}

#cards-container{display:none;padding:0 12px 24px}
.stock-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:10px}
.stock-card .card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.stock-card .card-name{font-weight:600;font-size:.88rem;line-height:1.3}
.stock-card .card-name a{color:var(--tx);text-decoration:none}
.stock-card .card-ticker{color:var(--t2);font-size:.7rem;margin-top:2px}
.stock-card .card-price{text-align:right}
.stock-card .card-price .price{font-size:1.05rem;font-weight:700}
.stock-card .card-price .change{font-size:.78rem;font-weight:600}
.stock-card .card-row{display:flex;justify-content:space-between;padding:4px 0;border-top:1px solid rgba(42,42,56,.35);font-size:.76rem}
.stock-card .card-label{color:var(--t2)}
.stock-card .card-val{font-weight:500}
.stock-card .card-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid rgba(42,42,56,.4)}
.sort-select{display:none}

@media(max-width:768px){
  .header{padding:12px 14px}
  .header h1{font-size:1.05rem}
  .header .subtitle{font-size:.65rem}
  .stats-bar{padding:10px 12px;gap:6px}
  .stat-card{min-width:0;flex:1 1 calc(33.3% - 6px);padding:8px 10px}
  .stat-card .label{font-size:.58rem}
  .stat-card .value{font-size:1rem}
  .controls{padding:10px 12px;gap:6px}
  .controls .label{display:none}
  .search{width:100%;font-size:16px}
  select.search{width:100%}
  .table-container{display:none}
  #cards-container{display:block}
  .sort-select{display:block;width:100%;margin-top:4px}
  .back-link{font-size:.7rem;padding:4px 8px}
  .footer{font-size:.62rem;padding:12px}
}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>Creamy Layer Stocks</h1>
    <div class="subtitle">All Indian stocks classified as "Creamy Layer" (top performers) by Tickertape</div>
  </div>
  <div class="header-right">
    <div class="status" id="status-text"></div>
    <a href="index.html" class="back-link">My Watchlist</a>
  </div>
</div>

<div class="stats-bar" id="stats-bar"></div>

<div class="controls">
  <span class="label">Filter:</span>
  <button class="btn filter-btn active" data-filter="all">All Creamy</button>
  <button class="btn filter-btn" data-filter="allHigh">All 4 High</button>
  <button class="btn filter-btn" data-filter="3high">3+ High</button>
  <button class="btn filter-btn" data-filter="large">Largecap</button>
  <button class="btn filter-btn" data-filter="mid">Midcap</button>
  <button class="btn filter-btn" data-filter="small">Smallcap</button>
  <select id="sector-filter" class="search" style="width:180px"></select>
  <input type="text" class="search" id="search" placeholder="Search ticker, name or sector..." style="margin-left:auto">
  <select id="sort-select" class="search sort-select">
    <option value="scoreTotal:desc">Sort: Total Score (best)</option>
    <option value="marketCap:desc">Sort: Market Cap</option>
    <option value="ret1Y:desc">Sort: 1Y Return (best)</option>
    <option value="ret1Y:asc">Sort: 1Y Return (worst)</option>
    <option value="roe:desc">Sort: ROE (highest)</option>
    <option value="pe:asc">Sort: PE Ratio (lowest)</option>
    <option value="name:asc">Sort: Name A-Z</option>
  </select>
</div>

<div class="table-container">
  <table><thead><tr id="table-head"></tr></thead><tbody id="table-body"></tbody></table>
</div>
<div id="cards-container"></div>
<div class="footer" id="footer"></div>

<script>
const RAW = ${dataJson};
const allStocks = RAW.stocks;

let sortCol = 'scoreTotal', sortAsc = false, currentFilter = 'all', currentSector = 'all', searchTerm = '';

const COLS = [
  {key:'rank',label:'#',w:'36px'},
  {key:'name',label:'Stock',w:'220px'},
  {key:'sector',label:'Sector',w:'140px'},
  {key:'mcapLabel',label:'Cap',w:'70px'},
  {key:'price',label:'Price',w:'80px',num:true},
  {key:'ret1D',label:'1D',w:'65px',num:true},
  {key:'ret1W',label:'1W',w:'65px',num:true},
  {key:'ret1M',label:'1M',w:'65px',num:true},
  {key:'ret1Y',label:'1Y',w:'70px',num:true},
  {key:'perfTag',label:'Perf',w:'70px'},
  {key:'growthTag',label:'Growth',w:'70px'},
  {key:'profitTag',label:'Profit',w:'70px'},
  {key:'valTag',label:'Valuation',w:'80px'},
  {key:'scoreTotal',label:'Score',w:'60px',num:true},
  {key:'roe',label:'ROE',w:'65px',num:true},
  {key:'npm',label:'NPM',w:'65px',num:true},
  {key:'pe',label:'PE',w:'65px',num:true},
  {key:'pb',label:'PB',w:'60px',num:true},
  {key:'marketCap',label:'Mkt Cap',w:'90px',num:true},
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

function getFiltered(){
  return allStocks.filter(s=>{
    if(currentFilter==='allHigh'&&s.scoreTotal<4)return false;
    if(currentFilter==='3high'&&s.scoreTotal<3)return false;
    if(currentFilter==='large'&&s.mcapLabel!=='Large')return false;
    if(currentFilter==='mid'&&s.mcapLabel!=='Mid')return false;
    if(currentFilter==='small'&&s.mcapLabel!=='Small')return false;
    if(currentSector!=='all'&&s.sector!==currentSector)return false;
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
     +'<td class="stock-name"><a href="'+s.url+'" target="_blank">'+s.name+'</a><br><span class="ticker">'+s.ticker+' <span class="tag tag-creamy">CREAMY</span></span></td>'
     +'<td><span class="sector">'+s.sector+'</span></td>'
     +'<td>'+mcapHtml(s.mcapLabel)+'</td>'
     +'<td style="font-weight:600">'+(s.price?'\\u20B9'+fmt(s.price):'\\u2014')+'</td>'
     +'<td>'+retHtml(s.ret1D)+'</td>'
     +'<td>'+retHtml(s.ret1W)+'</td>'
     +'<td>'+retHtml(s.ret1M)+'</td>'
     +'<td>'+retHtml(s.ret1Y)+'</td>'
     +'<td>'+tagHtml(s.perfTag)+'</td>'
     +'<td>'+tagHtml(s.growthTag)+'</td>'
     +'<td>'+tagHtml(s.profitTag)+'</td>'
     +'<td>'+tagHtml(s.valTag)+'</td>'
     +'<td>'+scoreHtml(s.scoreTotal)+'</td>'
     +'<td>'+(s.roe!=null?'<span class="'+(s.roe>=15?'pos':s.roe>=0?'':'neg')+'">'+fmt(s.roe,1)+'%</span>':'\\u2014')+'</td>'
     +'<td>'+(s.npm!=null?'<span class="'+(s.npm>=10?'pos':s.npm>=0?'':'neg')+'">'+fmt(s.npm,1)+'%</span>':'\\u2014')+'</td>'
     +'<td style="color:var(--t2)">'+(s.pe!=null?fmt(s.pe,1):'\\u2014')+'</td>'
     +'<td style="color:var(--t2)">'+(s.pb!=null?fmt(s.pb,1):'\\u2014')+'</td>'
     +'<td style="color:var(--t2)">'+fmtCr(s.marketCap)+'</td>'
     +'</tr>';
  }).join('');
  buildHead();

  document.getElementById('cards-container').innerHTML=filtered.map(s=>{
    return '<div class="stock-card">'
     +'<div class="card-header">'
     +'<div><div class="card-name"><a href="'+s.url+'" target="_blank">'+s.name+'</a></div>'
     +'<div class="card-ticker">'+s.ticker+' '+mcapHtml(s.mcapLabel)+' <span style="color:var(--t3);font-size:.62rem">'+s.sector+'</span></div></div>'
     +'<div class="card-price"><div class="price">'+(s.price?'\\u20B9'+fmt(s.price):'\\u2014')+'</div>'
     +'<div class="change '+(s.ret1D>=0?'pos':'neg')+'">'+(s.ret1D!=null?(s.ret1D>=0?'+':'')+fmt(s.ret1D,1)+'%':'')+'</div></div>'
     +'</div>'
     +'<div class="card-row"><span class="card-label">1Y Return</span><span class="card-val">'+retHtml(s.ret1Y)+'</span></div>'
     +'<div class="card-row"><span class="card-label">6M Return</span><span class="card-val">'+retHtml(s.ret6M)+'</span></div>'
     +'<div class="card-row"><span class="card-label">ROE</span><span class="card-val">'+(s.roe!=null?fmt(s.roe,1)+'%':'\\u2014')+'</span></div>'
     +'<div class="card-row"><span class="card-label">Net Profit Margin</span><span class="card-val">'+(s.npm!=null?fmt(s.npm,1)+'%':'\\u2014')+'</span></div>'
     +'<div class="card-row"><span class="card-label">PE / PB</span><span class="card-val">'+(s.pe!=null?fmt(s.pe,1):'\\u2014')+' / '+(s.pb!=null?fmt(s.pb,1):'\\u2014')+'</span></div>'
     +'<div class="card-row"><span class="card-label">Market Cap</span><span class="card-val">'+fmtCr(s.marketCap)+'</span></div>'
     +'<div class="card-row"><span class="card-label">Score</span><span class="card-val">'+scoreHtml(s.scoreTotal)+'</span></div>'
     +'<div class="card-tags">'
     +'<span class="tag tag-creamy">CREAMY</span>'
     +tagHtml(s.growthTag)+tagHtml(s.profitTag)+tagHtml(s.valTag)
     +'</div></div>';
  }).join('');

  document.getElementById('footer').textContent='Showing '+filtered.length+' of '+allStocks.length+' creamy layer stocks';
}

function renderStats(){
  const total=allStocks.length;
  const all4=allStocks.filter(s=>s.scoreTotal===4).length;
  const h3=allStocks.filter(s=>s.scoreTotal>=3).length;
  const large=allStocks.filter(s=>s.mcapLabel==='Large').length;
  const mid=allStocks.filter(s=>s.mcapLabel==='Mid').length;
  const small=allStocks.filter(s=>s.mcapLabel==='Small').length;
  const avgROE=allStocks.filter(s=>s.roe!=null);
  const roeAvg=avgROE.length?avgROE.reduce((a,s)=>a+s.roe,0)/avgROE.length:0;

  document.getElementById('stats-bar').innerHTML=[
    {l:'Total Creamy',v:total,c:'purple'},
    {l:'All 4 High',v:all4,c:'green'},
    {l:'3+ High',v:h3,c:'teal'},
    {l:'Largecap',v:large,c:'blue'},
    {l:'Midcap',v:mid,c:'purple'},
    {l:'Smallcap',v:small,c:'red'},
    {l:'Avg ROE',v:roeAvg.toFixed(1)+'%',c:'green'},
  ].map(s=>'<div class="stat-card"><div class="label">'+s.l+'</div><div class="value '+s.c+'">'+s.v+'</div></div>').join('');
}

function populateSectors(){
  const sectors=[...new Set(allStocks.map(s=>s.sector))].filter(Boolean).sort();
  document.getElementById('sector-filter').innerHTML='<option value="all">All Sectors ('+sectors.length+')</option>'+sectors.map(s=>{
    const c=allStocks.filter(x=>x.sector===s).length;
    return'<option value="'+s+'">'+s+' ('+c+')</option>';
  }).join('');
}

function doSort(col,isNum){
  if(sortCol===col)sortAsc=!sortAsc;
  else{sortCol=col;sortAsc=isNum?false:true;}
  renderTable();
}

document.querySelectorAll('.filter-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter=btn.dataset.filter;
    renderTable();
  });
});
document.getElementById('sector-filter').addEventListener('change',e=>{currentSector=e.target.value;renderTable();});
document.getElementById('search').addEventListener('input',e=>{searchTerm=e.target.value;renderTable();});
document.getElementById('sort-select').addEventListener('change',e=>{
  const[col,dir]=e.target.value.split(':');
  sortCol=col;sortAsc=dir==='asc';
  renderTable();
});

const t=new Date(RAW.updatedAt);
document.getElementById('status-text').textContent='Updated: '+t.toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' IST';
renderStats();populateSectors();renderTable();
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
      revGrowth: s.revGrowth, epsGrowth: s.epsGrowth,
      pe: s.pe, pb: s.pb, divYield: s.divYield,
      perfTag, growthTag, profitTag, valTag, scoreTotal,
    });
  }

  creamyStocks.sort((a, b) => b.scoreTotal - a.scoreTotal || (b.marketCap || 0) - (a.marketCap || 0));

  console.log(`  Found ${creamyStocks.length} creamy layer stocks out of ${stocks.length} total`);
  const all4 = creamyStocks.filter(s => s.scoreTotal === 4).length;
  const h3 = creamyStocks.filter(s => s.scoreTotal >= 3).length;
  console.log(`  All 4 High: ${all4} | 3+ High: ${h3}`);

  const large = creamyStocks.filter(s => s.mcapLabel === 'Large');
  const mid = creamyStocks.filter(s => s.mcapLabel === 'Mid');
  const small = creamyStocks.filter(s => s.mcapLabel === 'Small');
  console.log(`  Largecap: ${large.length} | Midcap: ${mid.length} | Smallcap: ${small.length}`);

  console.log('\nStep 4: Generating HTML dashboard...');
  const docsDir = path.join(__dirname, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);

  const updatedAt = new Date().toISOString();
  fs.writeFileSync(OUTPUT_PATH, buildHtml(creamyStocks, updatedAt), 'utf8');
  console.log(`  Saved to ${OUTPUT_PATH}`);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });

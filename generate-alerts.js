'use strict';
const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const alertSystem = require('./alert-system');

const USER_ALERTS_PATH = path.join(__dirname, 'user-alerts.json');
const WATCHLIST_PATH   = path.join(__dirname, 'my-watchlists.json');
const TICKER_URLS_PATH = path.join(__dirname, 'ticker-urls.json');
const OUTPUT_PATH      = path.join(__dirname, 'docs', 'alerts.html');

// Load watchlist metadata (3M low/high, stockUrl) keyed by ticker
function loadWatchlistMeta() {
  const meta = {};
  try {
    const watchlists = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    const tickerUrls = JSON.parse(fs.readFileSync(TICKER_URLS_PATH, 'utf8'));
    for (const wl of watchlists) {
      const data3m = wl.periods?.['3M'];
      if (!data3m) continue;
      for (const s of data3m.stocks || []) {
        const parts = (s.name || '').split('\n');
        const ticker = (parts[1] || '').trim();
        if (!ticker || meta[ticker]) continue;
        const p = v => parseFloat(String(v || '').replace(/[₹,]/g, ''));
        meta[ticker] = {
          fullName: parts[0] || ticker,
          watchlist: wl.name.replace(/^Equity Watchlist\s*/, '') || 'Main',
          stockUrl: s.stockUrl || tickerUrls[ticker] || '',
          low3m: p(s.cells[3]),
          high3m: p(s.cells[4]),
        };
      }
    }
  } catch {}
  return meta;
}

async function fetchPrices(tickers) {
  const results = {};
  for (let i = 0; i < tickers.length; i += 10) {
    const batch = tickers.slice(i, i + 10);
    const res = await Promise.all(batch.map(async t => {
      try {
        const q = await yahooFinance.quote(t + '.NS');
        return { ticker: t, price: q.regularMarketPrice, changePct: q.regularMarketChangePercent };
      } catch { return { ticker: t, price: null, changePct: null }; }
    }));
    for (const r of res) results[r.ticker] = r;
  }
  return results;
}

async function main() {
  const userAlerts = fs.existsSync(USER_ALERTS_PATH)
    ? JSON.parse(fs.readFileSync(USER_ALERTS_PATH, 'utf8')) : {};
  const tickers = Object.keys(userAlerts);
  const meta    = loadWatchlistMeta();

  console.log(`Fetching live prices for ${tickers.length} alerted stocks...`);
  const prices = tickers.length ? await fetchPrices(tickers) : {};

  // Build enriched alert list
  const stocks = tickers.map(ticker => {
    const al = userAlerts[ticker];
    const m  = meta[ticker] || {};
    const pq = prices[ticker] || {};
    const price = pq.price ?? null;
    const aboveHit = al.above != null && price != null && price >= al.above;
    const belowHit = al.below != null && price != null && price <= al.below;
    return {
      ticker,
      name:      al.name || m.fullName || ticker,
      fullName:  m.fullName || al.name || ticker,
      watchlist: m.watchlist || '—',
      stockUrl:  m.stockUrl || '',
      low3m:     isNaN(m.low3m) ? null : m.low3m,
      high3m:    isNaN(m.high3m) ? null : m.high3m,
      price,
      changePct: pq.changePct ?? null,
      above: al.above ?? null,
      below: al.below ?? null,
      aboveHit,
      belowHit,
      triggered: aboveHit || belowHit,
    };
  });

  // Sort: triggered first, then by ticker alpha
  stocks.sort((a, b) => {
    if (a.triggered !== b.triggered) return a.triggered ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });

  const triggeredCount = stocks.filter(s => s.triggered).length;
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const dataJson = JSON.stringify({ stocks, updatedAt: new Date().toISOString() });

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Price Alerts — Stock Dashboard</title>
<script>(function(){var s=localStorage.getItem('creamy-theme');var p=s||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',p)})();<\/script>
<style>
:root{--bg:#0c0c10;--s1:#0f0f15;--s2:#14141c;--s3:#1a1a26;--tx:#e4e4ea;--t2:#9898b0;--t3:#6060780;--bd:#2a2a38;--ac:#00d4aa;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--pp:#a78bfa;--or:#f97316}
html[data-theme="light"]{--bg:#f4f5f7;--s1:#ffffff;--s2:#ffffff;--s3:#f0f0f5;--tx:#111118;--t2:#505068;--t3:#8888a0;--bd:#dcdce8;--ac:#009980;--gn:#16a34a;--rd:#dc2626;--yw:#ca8a04;--pp:#7c3aed}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);min-height:100vh;font-size:14px}

.header{display:flex;justify-content:space-between;align-items:center;padding:14px 28px;border-bottom:1px solid var(--bd);background:var(--s1);position:sticky;top:0;z-index:100}
.header h1{font-size:1.1rem;font-weight:700;color:var(--tx)}
.header h1 span{color:var(--ac)}
.header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.nav-link{color:var(--t2);text-decoration:none;font-size:.8rem;padding:6px 12px;border:1px solid var(--bd);border-radius:6px;transition:all .2s;white-space:nowrap}
.nav-link:hover{color:var(--ac);border-color:var(--ac)}
.nav-link.active{color:var(--ac);border-color:var(--ac);background:rgba(0,212,170,.06)}
.theme-btn{background:none;border:1px solid var(--bd);border-radius:6px;padding:5px 10px;cursor:pointer;color:var(--t2);font-size:.8rem;transition:all .2s}
.theme-btn:hover{color:var(--ac);border-color:var(--ac)}

.page-hero{padding:24px 28px 16px;border-bottom:1px solid var(--bd)}
.page-hero h2{font-size:1.4rem;font-weight:700;color:var(--tx);margin-bottom:4px}
.page-hero p{color:var(--t2);font-size:.85rem}
.hero-meta{display:flex;gap:16px;margin-top:12px;flex-wrap:wrap}
.hero-stat{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 16px;text-align:center;min-width:90px}
.hero-stat .hs-val{font-size:1.4rem;font-weight:700}
.hero-stat .hs-lbl{font-size:.68rem;color:var(--t2);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}

.content{padding:20px 28px}
.section-title{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ac);font-weight:700;margin-bottom:12px}

/* Alert cards grid */
.alerts-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.alert-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:16px;transition:border-color .2s}
.alert-card:hover{border-color:var(--ac)}
.alert-card.is-triggered{border-color:rgba(239,68,68,.5);background:rgba(239,68,68,.03)}
.alert-card.hit-above{border-color:rgba(34,197,94,.5);background:rgba(34,197,94,.03)}

.ac-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
.ac-name{font-weight:600;font-size:.9rem;line-height:1.3}
.ac-name a{color:var(--tx);text-decoration:none}
.ac-name a:hover{color:var(--ac)}
.ac-ticker{color:var(--t2);font-size:.72rem;margin-top:2px}
.ac-ticker .wl-badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:.65rem;background:var(--s3);color:var(--t2);border:1px solid var(--bd);margin-left:4px}

.ac-price-block{text-align:right;flex-shrink:0}
.ac-price{font-size:1.1rem;font-weight:700}
.ac-change{font-size:.75rem;font-weight:600;margin-top:2px}
.pos{color:var(--gn)}
.neg{color:var(--rd)}

.ac-targets{display:flex;flex-direction:column;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--bd)}
.ac-target{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-radius:7px;font-size:.82rem;background:var(--s3)}
.ac-target.hit{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25)}
.ac-target.hit.above-hit{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25)}
.ac-target-label{color:var(--t2)}
.ac-target-val{font-weight:700}
.ac-target.hit .ac-target-val{color:var(--rd)}
.ac-target.hit.above-hit .ac-target-val{color:var(--gn)}
.ac-hit-badge{display:inline-block;background:var(--rd);color:#fff;font-size:.62rem;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:6px;vertical-align:middle;letter-spacing:.04em;text-transform:uppercase}
.ac-hit-badge.above{background:var(--gn)}

.ac-range{margin-top:10px;padding-top:10px;border-top:1px solid var(--bd)}
.ac-range-row{display:flex;justify-content:space-between;font-size:.72rem;color:var(--t2);margin-bottom:5px}
.range-bar{width:100%;height:6px;background:var(--s3);border-radius:3px;position:relative;display:block}
.range-bar .fill{height:100%;border-radius:3px;position:absolute;left:0;top:0}
.range-bar .marker{position:absolute;top:-3px;width:2px;height:12px;border-radius:1px}

.ac-actions{display:flex;gap:6px;margin-top:12px;padding-top:10px;border-top:1px solid var(--bd)}
.ac-edit-btn{flex:1;padding:7px 0;border:1px solid var(--bd);border-radius:6px;background:transparent;color:var(--t2);cursor:pointer;font-size:.78rem;font-family:inherit;transition:all .2s}
.ac-edit-btn:hover{border-color:var(--ac);color:var(--ac)}
.ac-del-btn{padding:7px 12px;border:1px solid rgba(239,68,68,.3);border-radius:6px;background:transparent;color:var(--rd);cursor:pointer;font-size:.78rem;font-family:inherit;transition:all .2s}
.ac-del-btn:hover{background:rgba(239,68,68,.1)}

.empty-state{text-align:center;padding:60px 20px;color:var(--t2)}
.empty-state .es-icon{font-size:2.5rem;margin-bottom:12px}
.empty-state h3{font-size:1rem;font-weight:600;color:var(--tx);margin-bottom:6px}
.empty-state p{font-size:.82rem;line-height:1.6}

.footer{text-align:center;padding:16px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd)}

${alertSystem.css}
/* override modal width on this page */
#ap-modal{width:290px}

@media(max-width:768px){
  .header{padding:12px 14px}
  .page-hero{padding:16px 14px 12px}
  .content{padding:14px}
  .alerts-grid{grid-template-columns:1fr}
  #pat-setup-bar{margin:8px 14px;flex-wrap:wrap}
}
</style>
</head>
<body>

<div class="header">
  <h1><span>&#x1F514;</span> Price Alerts</h1>
  <div class="header-right">
    <a href="index.html" class="nav-link">Dashboard</a>
    <a href="creamy.html" class="nav-link">Creamy Layer</a>
    <a href="breakout.html" class="nav-link">Breakout Scanner</a>
    <button class="theme-btn" id="theme-btn">&#x263D; Theme</button>
  </div>
</div>

${alertSystem.bannerHtml}
${alertSystem.modalHtml}

<div class="page-hero">
  <h2>Your Price Alerts</h2>
  <p>Set above/below price targets on any stock. Alerts are stored in GitHub and checked every 10&nbsp;min during market hours.</p>
  <div class="hero-meta">
    <div class="hero-stat">
      <div class="hs-val" id="stat-total">${tickers.length}</div>
      <div class="hs-lbl">Configured</div>
    </div>
    <div class="hero-stat">
      <div class="hs-val" style="color:var(--rd)" id="stat-triggered">${triggeredCount}</div>
      <div class="hs-lbl">Triggered</div>
    </div>
    <div class="hero-stat">
      <div class="hs-val" style="color:var(--t2)">${tickers.length - triggeredCount}</div>
      <div class="hs-lbl">Watching</div>
    </div>
    <div style="margin-left:auto;align-self:center;font-size:.72rem;color:var(--t2)">Updated: ${now} IST</div>
  </div>
</div>

<div class="content">
  <div id="alerts-container"></div>
</div>

<div class="footer">
  Alerts are auto-emailed during market hours (Mon–Fri, 9:15 AM–3:30 PM IST) when thresholds are crossed &nbsp;·&nbsp;
  <a href="index.html" style="color:var(--ac);text-decoration:none">Dashboard</a>
</div>

<script>
var PAGE_DATA = ${dataJson};
window._GH_ALERTS_REPO = 'amitiyer99/watchlist-app';

function fmt2(n){ return n==null?'—':'₹'+Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtPct(n){ if(n==null)return ''; return (n>=0?'+':'')+n.toFixed(2)+'%'; }

function renderCards(){
  var alerts = window._GA || {};
  var tickers = Object.keys(alerts);

  // Merge build-time data with runtime _GA (in case user added/removed since last build)
  var byTicker = {};
  PAGE_DATA.stocks.forEach(function(s){ byTicker[s.ticker]=s; });

  if(!tickers.length){
    document.getElementById('alerts-container').innerHTML =
      '<div class="empty-state"><div class="es-icon">&#x1F514;</div><h3>No alerts configured</h3><p>Go to the <a href="index.html" style="color:var(--ac)">Dashboard</a>, click the &#x1F514; bell icon on any stock, and set an above/below price target.</p></div>';
    return;
  }

  // Sort: triggered first
  tickers.sort(function(a,b){
    var at=alerts[a],bt=alerts[b];
    var sa=byTicker[a]||{};var sb=byTicker[b]||{};
    var ap=sa.price,bp=sb.price;
    var aTrig=((at.above!=null&&ap!=null&&ap>=at.above)||(at.below!=null&&ap!=null&&ap<=at.below));
    var bTrig=((bt.above!=null&&bp!=null&&bp>=bt.above)||(bt.below!=null&&bp!=null&&bp<=bt.below));
    if(aTrig!==bTrig) return aTrig?-1:1;
    return a.localeCompare(b);
  });

  var triggered=0;
  var cards = tickers.map(function(ticker){
    var al = alerts[ticker];
    var s  = byTicker[ticker] || { ticker:ticker, name:al.name||ticker, fullName:al.name||ticker, watchlist:'—', stockUrl:'', price:null, changePct:null, low3m:null, high3m:null };
    var price = s.price;
    var aboveHit = al.above!=null && price!=null && price>=al.above;
    var belowHit = al.below!=null && price!=null && price<=al.below;
    var isTrig = aboveHit||belowHit;
    if(isTrig) triggered++;

    var cardClass = 'alert-card'+(isTrig ? (aboveHit?' hit-above':' is-triggered') : '');
    var priceHtml = price!=null
      ? '<div class="ac-price '+(isTrig?(aboveHit?'pos':'neg'):'')+'">'+fmt2(price)+'</div>'
        +'<div class="ac-change '+(s.changePct>=0?'pos':'neg')+'">'+fmtPct(s.changePct)+'</div>'
      : '<div class="ac-price" style="color:var(--t2)">—</div>';

    var targetRows = '';
    if(al.above!=null){
      var hit=aboveHit;
      targetRows += '<div class="ac-target'+(hit?' hit above-hit':'')+'"><span class="ac-target-label">&#x25B2; Alert above</span><span class="ac-target-val">'+fmt2(al.above)+(hit?'<span class="ac-hit-badge above">HIT</span>':'')+'</span></div>';
    }
    if(al.below!=null){
      var hit2=belowHit;
      targetRows += '<div class="ac-target'+(hit2?' hit':'')+'"><span class="ac-target-label">&#x25BC; Alert below</span><span class="ac-target-val">'+fmt2(al.below)+(hit2?'<span class="ac-hit-badge">HIT</span>':'')+'</span></div>';
    }

    var rangeHtml = '';
    if(s.low3m!=null && s.high3m!=null && s.high3m>s.low3m && price!=null){
      var rng = s.high3m - s.low3m;
      var pct = Math.max(0,Math.min(100,(price-s.low3m)/rng*100));
      var color = pct<=10?'var(--rd)':pct<=30?'var(--yw)':pct<=70?'var(--ac)':'var(--gn)';
      // marker positions for above/below targets
      var abovePct = al.above!=null ? Math.max(0,Math.min(100,(al.above-s.low3m)/rng*100)) : null;
      var belowPct = al.below!=null ? Math.max(0,Math.min(100,(al.below-s.low3m)/rng*100)) : null;
      rangeHtml = '<div class="ac-range">'
        +'<div class="ac-range-row"><span>3M Low: '+fmt2(s.low3m)+'</span><span>3M High: '+fmt2(s.high3m)+'</span></div>'
        +'<div class="range-bar">'
        +'<div class="fill" style="width:'+pct.toFixed(1)+'%;background:'+color+'"></div>'
        +(abovePct!=null?'<div class="marker" style="left:'+abovePct.toFixed(1)+'%;background:var(--gn)" title="Above target"></div>':'')
        +(belowPct!=null?'<div class="marker" style="left:'+belowPct.toFixed(1)+'%;background:var(--rd)" title="Below target"></div>':'')
        +'</div></div>';
    }

    var nameHtml = s.stockUrl
      ? '<a href="'+s.stockUrl+'" target="_blank">'+s.fullName+'</a>'
      : s.fullName;

    return '<div class="'+cardClass+'" id="ac-'+ticker+'">'
      +'<div class="ac-header">'
      +  '<div><div class="ac-name">'+nameHtml+'</div>'
      +  '<div class="ac-ticker">'+ticker+'<span class="wl-badge">'+s.watchlist+'</span></div></div>'
      +  '<div class="ac-price-block">'+priceHtml+'</div>'
      +'</div>'
      +'<div class="ac-targets">'+targetRows+'</div>'
      +rangeHtml
      +'<div class="ac-actions">'
      +'<button class="ac-edit-btn alert-btn" data-alert-ticker="'+ticker+'" data-alert-price="'+(price||0)+'" data-alert-name="'+(s.fullName||ticker).replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'">&#x270F; Edit Alert</button>'
      +'<button class="ac-del-btn" onclick="deleteAlert(\''+ticker+'\')">&#x1F5D1; Delete</button>'
      +'</div>'
      +'</div>';
  }).join('');

  document.getElementById('alerts-container').innerHTML =
    '<div class="section-title" style="margin-bottom:8px">&#x1F514; '+tickers.length+' alert'+(tickers.length>1?'s':'')+' &nbsp;·&nbsp; <span style="color:'+(triggered?'var(--rd)':'var(--gn)')+'">'+triggered+' triggered</span></div>'
    +'<div class="alerts-grid">'+cards+'</div>';

  // update hero stats
  document.getElementById('stat-total').textContent = tickers.length;
  document.getElementById('stat-triggered').textContent = triggered;
}

function deleteAlert(ticker){
  if(!confirm('Remove alert for '+ticker+'?')) return;
  var a = JSON.parse(JSON.stringify(window._GA||{}));
  delete a[ticker];
  // saveAlerts is injected by alert-system.js via window — call it
  if(window._saveAlerts) window._saveAlerts(a, function(){ renderCards(); });
}

window.onAlertChange = function(){ renderCards(); };

window._GH_ALERTS_REPO = 'amitiyer99/watchlist-app';
${alertSystem.js}
// expose saveAlerts for deleteAlert button (alert-system sets window._saveAlerts itself)
// theme toggle
(function(){
  var btn=document.getElementById('theme-btn');
  function applyTheme(t){ document.documentElement.setAttribute('data-theme',t); localStorage.setItem('creamy-theme',t); }
  btn.onclick=function(){
    applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');
  };
})();

// Initial render with build-time data; re-renders again after GitHub fetch completes
PAGE_DATA.stocks.forEach(function(s){ window._GA = window._GA||{}; if(!window._GA[s.ticker] && (s.above!=null||s.below!=null)) window._GA[s.ticker]={above:s.above,below:s.below,name:s.name}; });
renderCards();
</script>
</body>
</html>`;

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  console.log(`  Saved to ${OUTPUT_PATH}`);
  console.log(`  ${tickers.length} alerts, ${triggeredCount} triggered`);
}

main().catch(e => { console.error(e); process.exit(1); });

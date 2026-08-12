'use strict';

// ── Marquee Investors page ────────────────────────────────────────────────────
// Renders docs/investors.html from docs/investors-tickers.json (produced by
// fetch-investors.js). Stocks ranked by how many of India's superstar investors
// currently hold them (>1% stake), with each investor's stake % and an add/trim
// arrow, plus which of our own screeners also flag the name. A stock held by
// several marquee investors — especially freshly added — is a high-conviction
// "smart money is here" signal.

const { HUB_BACK_LINK } = require('./lib/hub-nav');
const stockActions = require('./lib/stock-actions');
const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');
const { fmtPrice, esc } = require('./lib/format');
const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'docs', 'investors.html');

function loadJson(rel, fb = null) { try { return JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8')); } catch { return fb; } }

// Sector / price / mcap + which screeners flag each ticker, from existing sidecars.
function buildEnrichment() {
  const info = new Map(); // ticker -> {sector, price, marketCap}
  const screeners = new Map(); // ticker -> Set(screenerLabel)
  const SIDE = [
    ['breakout2-data.json', '📈 Breakout'], ['apex-tickers.json', '🔮 APEX'],
    ['creamy-tickers.json', '🍦 Creamy'], ['multibagger-tickers.json', '🏆 Multibagger'],
    ['indianresearch-tickers.json', '🇮🇳 Research'], ['screenerin-tickers.json', '📊 Screener.in'],
  ];
  for (const [file, label] of SIDE) {
    const raw = loadJson('docs/' + file);
    const arr = Array.isArray(raw) ? raw : (raw && (raw.rows || raw.stocks)) || [];
    for (const r of arr) {
      const t = (r.ticker || r.t || '').toUpperCase();
      if (!t) continue;
      if (!info.has(t)) info.set(t, {});
      const rec = info.get(t);
      if (r.sector && !rec.sector) rec.sector = r.sector;
      if (r.price != null && rec.price == null) rec.price = r.price;
      if (r.marketCap != null && rec.marketCap == null) rec.marketCap = r.marketCap;
      if (!screeners.has(t)) screeners.set(t, new Set());
      screeners.get(t).add(label);
    }
  }
  return { info, screeners };
}

const trendMark = t => t === 'ADDED' ? '<span style="color:#22c55e">▲ added</span>'
  : t === 'NEW' ? '<span style="color:#0ea5e9">★ new</span>'
  : t === 'TRIMMED' ? '<span style="color:#ef4444">▼ trimmed</span>'
  : '<span style="color:#94a3b8">— held</span>';

function fmtCr(v) { return typeof v === 'number' ? '₹' + Math.round(v).toLocaleString('en-IN') + ' Cr' : '—'; }

// ── 🧠 modal data panel ───────────────────────────────────────────────────────
// Leads the brain modal with WHO owns it, how much, and how fresh the disclosure is —
// the whole point of this page — before the AI commentary.
function investorPanel(s, en, scr) {
  const metrics = [
    { label: 'Marquee Holders', val: String(s.count), sub: s.count >= 3 ? 'strong cluster' : 'investors on file', cls: s.count >= 2 ? 'pos' : '' },
    { label: 'Combined Stake', val: s.totalPct + '%', sub: 'of equity' },
    { label: 'Added Latest Qtr', val: String(s.adds || 0), sub: 'added or newly entered', cls: s.adds ? 'pos' : '' },
    { label: 'Latest Disclosure', val: s.mostRecentQuarter || '—', sub: 'shareholding as of' },
    { label: 'Last Bulk/Block Buy', val: s.lastBuyDate || '—', sub: 'freshest open-market buy' },
    { label: 'Price', val: en.price != null ? fmtPrice(en.price) : '—', sub: en.marketCap != null ? fmtCr(en.marketCap) : (en.sector || '') },
  ];
  // Each investor as its own metric: stake plus the direction they moved it.
  const holders = (s.investors || []).map(iv => ({
    label: iv.name.split(' (')[0],
    val: iv.pct + '%',
    sub: iv.trend === 'ADDED' ? '▲ added' : iv.trend === 'NEW' ? '★ new entry' : iv.trend === 'TRIMMED' ? '▼ trimmed' : 'unchanged',
    cls: (iv.trend === 'ADDED' || iv.trend === 'NEW') ? 'pos' : iv.trend === 'TRIMMED' ? 'neg' : '',
  }));
  const signals = [];
  if (s.count >= 3) signals.push({ tone: 'bull', icon: '▲', text: s.count + ' marquee investors hold this simultaneously — rare clustering' });
  if (s.adds) signals.push({ tone: 'bull', icon: '▲', text: s.adds + ' of them added or newly entered in the latest disclosed quarter' });
  const trims = (s.investors || []).filter(iv => iv.trend === 'TRIMMED').length;
  if (trims) signals.push({ tone: 'bear', icon: '▼', text: trims + ' investor(s) trimmed their stake in the latest quarter' });
  // Don't call a 2022 deal "recent" — grade the signal by how old the buy actually is.
  if (s.lastBuyDate) {
    const ageD = Math.round((Date.now() - new Date(s.lastBuyDate + 'T00:00:00').getTime()) / 864e5);
    if (ageD <= 180) signals.push({ tone: 'bull', icon: '🛒', text: 'Fresh disclosed bulk/block buy on ' + s.lastBuyDate + ' (' + ageD + ' days ago)' });
    else signals.push({ tone: 'neut', icon: '🛒', text: 'Last disclosed bulk/block buy was ' + s.lastBuyDate + ' — about ' + Math.round(ageD / 30) + ' months ago, so the position is held rather than being added to on the open market' });
  }
  if (!s.adds && !trims) signals.push({ tone: 'neut', icon: '◆', text: 'Stakes unchanged last quarter — holding, not accumulating' });
  if (scr && scr.size) signals.push({ tone: 'bull', icon: '✓', text: 'Independently flagged by: ' + [...scr].join(', ') });
  return [
    { title: '🏆 Marquee Ownership', metrics },
    ...(holders.length ? [{ title: '👤 Individual Stakes', metrics: holders }] : []),
    ...(signals.length ? [{ title: '📉 Signals', signals }] : []),
  ];
}

function buildHtml(rows, meta, generatedAt) {
  const genTime = new Date(generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const { info, screeners } = buildEnrichment();
  const { loadLivePrices, reconcile } = require('./lib/live-prices');
  const { prices: livePrices } = loadLivePrices();
  const tickerUrls = loadJson('ticker-urls.json', {}) || {};
  const tracked = (meta.investors || []).length;

  const rowHtml = rows.map((s, i) => {
    const en = info.get(s.ticker) || {};
    const lp = livePrices[s.ticker];              // live price, reconciled vs sidecar (rejects bad/split data)
    en.price = reconcile(en.price, lp && lp.p != null ? lp.p : null);
    const invChips = s.investors.map(iv => {
      const tip = `${iv.name} holds ${iv.pct}% — ${iv.trend.toLowerCase()}`
        + (iv.latestQuarter ? ` · as of ${iv.latestQuarter}` : '')
        + (iv.sinceQuarter && iv.sinceQuarter !== iv.latestQuarter ? ` · held since ${iv.sinceQuarter}` : '')
        + (iv.lastBuyDate ? ` · last bulk/block buy ${iv.lastBuyDate}` : '');
      return `<span class="inv tip" tabindex="0" data-tip="${esc(tip)}">${esc(iv.name.split(' (')[0])} <b>${iv.pct}%</b> ${iv.trend === 'ADDED' ? '▲' : iv.trend === 'NEW' ? '★' : iv.trend === 'TRIMMED' ? '▼' : ''}</span>`;
    }).join('');
    // Recency cell: most recent disclosure quarter + freshest bulk/block buy date.
    const recency = `<div class="asof">${esc(s.mostRecentQuarter || '—')}</div>` + (s.lastBuyDate ? `<div class="buy tip" tabindex="0" data-tip="Most recent disclosed bulk/block BUY by any of these investors">🛒 ${esc(s.lastBuyDate)}</div>` : '');
    const scr = screeners.get(s.ticker);
    const scrChips = scr ? [...scr].map(l => `<span class="scr">${esc(l)}</span>`).join('') : '';
    // Tickertape needs its full name-SYMBOL slug (bare ticker 404s). Use the known
    // mapping when we have it; otherwise link to the Screener.in company page, which
    // always resolves since every ticker here IS a Screener company slug.
    const url = tickerUrls[s.ticker] || `https://www.screener.in/company/${esc(s.ticker)}/`;
    const cntColour = s.count >= 3 ? '#a855f7' : s.count === 2 ? '#22c55e' : '#94a3b8';
    return `<tr data-count="${s.count}" data-adds="${s.adds}" data-recency="${s.recencyOrd || 0}" data-buy="${s.lastBuyDate || ''}">
      <td class="num dim">${i + 1}</td>
      <td><span class="cnt" style="color:${cntColour}">${s.count}</span>${s.adds ? `<span class="adds tip" tabindex="0" data-tip="${s.adds} of them added or newly entered in the latest quarter">+${s.adds}▲</span>` : ''}</td>
      <td>
        <a class="stock-link" href="${url}" target="_blank" rel="noopener">${esc(s.name)}</a>
        ${s.slugIsCode ? '' : stockActions.buttonsHtml({ ticker: s.ticker, name: s.name, price: en.price || 0, panel: investorPanel(s, en, scr) })}
        <div class="sub">${esc(s.ticker)}${en.sector ? ' · ' + esc(en.sector) : ''}</div>
        ${scrChips ? `<div class="scr-row">${scrChips}</div>` : ''}
      </td>
      <td class="recency">${recency}</td>
      <td class="num" data-live-px="${esc(s.ticker)}">${en.price != null ? fmtPrice(en.price) : '—'}</td>
      <td class="num">${en.marketCap != null ? fmtCr(en.marketCap) : '—'}</td>
      <td class="num">${s.totalPct}%</td>
      <td class="invs">${invChips}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Marquee Investors · Superstar Holdings</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--s1:#0f0f17;--s2:#13131e;--tx:#e2e8f0;--t2:#94a3b8;--t3:#64748b;--ac:#a855f7;--bd:rgba(168,85,247,.18)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);line-height:1.5;min-height:100vh}
.header{background:rgba(10,10,15,.92);border-bottom:1px solid var(--bd);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.15rem}.header .sub{color:var(--t3);font-size:.8rem}
.back-link{font-size:.8rem;text-decoration:none;border:1px solid;border-radius:8px;padding:6px 12px}
.wrap{max-width:1150px;margin:0 auto;padding:18px 14px 60px}
.bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.tab{cursor:pointer;border:1px solid var(--bd);background:var(--s1);color:var(--t2);border-radius:8px;padding:6px 12px;font-size:.8rem;font-weight:600;font-family:inherit}
.tab.active{color:var(--tx);box-shadow:0 0 0 1px var(--ac) inset}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{color:var(--t3);text-align:left;font-size:.7rem;text-transform:uppercase;padding:8px 10px;border-bottom:1px solid var(--bd);position:sticky;top:64px;background:var(--bg)}
td{padding:10px;border-bottom:1px solid rgba(148,163,184,.08);vertical-align:top}
.num{text-align:right}th.num{text-align:right}.dim{color:var(--t3)}
.stock-link{color:var(--tx);text-decoration:none;font-weight:600}.stock-link:hover{color:var(--ac)}
.sub{color:var(--t3);font-size:.75rem;margin-top:2px}
.cnt{font-size:1.2rem;font-weight:800}
.adds{font-size:.68rem;color:#22c55e;margin-left:5px}
.scr-row{margin-top:5px;display:flex;flex-wrap:wrap;gap:3px}
.scr{font-size:.62rem;padding:1px 6px;border-radius:8px;background:rgba(148,163,184,.12);color:var(--t2)}
.recency{font-size:.75rem;color:var(--t2);white-space:nowrap}
.recency .asof{font-weight:600;color:var(--tx)}
.recency .buy{color:#22c55e;margin-top:2px}
.invs{max-width:380px}
.inv{display:inline-block;font-size:.68rem;padding:2px 7px;margin:2px;border-radius:10px;background:rgba(168,85,247,.1);color:#d8b4fe;border:1px solid rgba(168,85,247,.25)}
.inv b{color:#fff;font-weight:700}
.footer{color:var(--t3);font-size:.75rem;text-align:center;margin-top:30px}
${TOOLTIP_CSS}
${stockActions.css}
</style></head><body>
<div class="header"><div><h1>⭐ Marquee Investors</h1><div class="sub">Stocks held by India's superstar investors · ${tracked} tracked</div></div>${HUB_BACK_LINK}</div>
<div class="wrap">
${legendHtml('How this works (click to expand)', [
  { title: 'The signal', bodyHtml: `<p>These are the current >1% holdings of ${tracked} of India's best-known investors (Jhunjhunwala, Kacholia, Damani, Dolly Khanna, Kedia, Mukul Agrawal and more), read from their Screener.in shareholding disclosures. A stock held by <b>several</b> of them, or one just <b>added ▲ / newly entered ★</b> in the latest quarter, is where smart money is concentrating.</p>` },
  { title: 'Reading a row', bodyHtml: '<p>The number is how many marquee investors hold it; <b>+N▲</b> flags how many added recently. Each purple chip shows an investor, their stake %, and ▲ added / ★ new / ▼ trimmed. Chips under the name show which of your own screeners also flag it.</p>' },
  { title: 'Caveat', bodyHtml: '<p>Shareholding disclosures are quarterly and lag real trades by weeks; a big investor holding a stock is not itself a buy signal, entry or target. Micro-caps held by superstars can be illiquid and volatile. Always do your own research. Not investment advice.</p>' },
])}
<div class="bar">
  <button class="tab active" onclick="ft('all',this)">All (${rows.length})</button>
  <button class="tab" onclick="ft('multi',this)">Held by 2+ (${rows.filter(r => r.count >= 2).length})</button>
  <button class="tab" onclick="ft('adds',this)">Recently added (${rows.filter(r => r.adds > 0).length})</button>
  <button class="tab" onclick="ft('bought',this)">Recent bulk/block buy (${rows.filter(r => r.lastBuyDate).length})</button>
  <button class="tab" onclick="ft('recent',this)">Sort by recency</button>
</div>
<table><thead><tr>
  <th class="num">#</th><th># Investors</th><th>Stock</th>
  <th class="tip" tabindex="0" data-tip="Most recent quarter any of these investors is on record holding it, and 🛒 the freshest disclosed bulk/block BUY date.">Recent</th>
  <th class="num">Price</th><th class="num">Mkt Cap</th>
  <th class="num tip" tabindex="0" data-tip="Sum of all marquee investors' stakes in this stock.">Total stake</th>
  <th>Who holds it (stake % · ▲added ★new ▼trimmed · hover for dates)</th>
</tr></thead><tbody id="tb">${rowHtml}</tbody></table>
${stockActions.bannerHtml}${stockActions.modalHtml}${stockActions.researchModalHtml}
<div class="footer">⭐ Marquee Investors · from Screener.in shareholder disclosures · Generated ${genTime} IST<br><strong>Not investment advice. Do your own research.</strong></div>
</div>
<script>${stockActions.setupScript}</script>
<script>${stockActions.js}</script>
<script>
function ft(mode, btn){
  document.querySelectorAll('.tab').forEach(function(b){b.classList.toggle('active', b===btn);});
  var tb=document.getElementById('tb');
  var trs=Array.from(tb.querySelectorAll('tr'));
  if(mode==='recent'){
    // sort rows by most-recent disclosure quarter, then by last buy date, desc
    trs.sort(function(a,b){
      var d=(+b.dataset.recency)-(+a.dataset.recency);
      if(d) return d;
      return (b.dataset.buy||'').localeCompare(a.dataset.buy||'');
    });
    trs.forEach(function(tr){tr.style.display='';tb.appendChild(tr);});
    return;
  }
  trs.forEach(function(tr){
    var c=+tr.dataset.count, a=+tr.dataset.adds, buy=tr.dataset.buy;
    var show = mode==='all' || (mode==='multi'&&c>=2) || (mode==='adds'&&a>0) || (mode==='bought'&&buy);
    tr.style.display = show ? '' : 'none';
  });
}
</script>
</body></html>`;
}

function main() {
  console.log('⭐  Marquee Investors page');
  const data = loadJson('docs/investors-tickers.json', null);
  if (!data || !Array.isArray(data.rows)) {
    console.warn('  No docs/investors-tickers.json yet — run fetch-investors first. Skipping.');
    return;
  }
  const html = buildHtml(data.rows, data, data.updatedAt ? Date.parse(data.updatedAt) : Date.now());
  if (!fs.existsSync(path.join(__dirname, 'docs'))) fs.mkdirSync(path.join(__dirname, 'docs'));
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  console.log(`  ✅  ${data.rows.length} stocks → ${OUTPUT_PATH}`);
}

if (require.main === module) main();
module.exports = { main };

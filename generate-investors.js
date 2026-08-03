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

function buildHtml(rows, meta, generatedAt) {
  const genTime = new Date(generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const { info, screeners } = buildEnrichment();
  const tracked = (meta.investors || []).length;

  const rowHtml = rows.map((s, i) => {
    const en = info.get(s.ticker) || {};
    const invChips = s.investors.map(iv =>
      `<span class="inv tip" tabindex="0" data-tip="${esc(iv.name)} holds ${iv.pct}% — ${iv.trend.toLowerCase()}">${esc(iv.name.split(' (')[0])} <b>${iv.pct}%</b> ${iv.trend === 'ADDED' ? '▲' : iv.trend === 'NEW' ? '★' : iv.trend === 'TRIMMED' ? '▼' : ''}</span>`
    ).join('');
    const scr = screeners.get(s.ticker);
    const scrChips = scr ? [...scr].map(l => `<span class="scr">${esc(l)}</span>`).join('') : '';
    const url = `https://www.tickertape.in/stocks/${esc(s.ticker)}`;
    const cntColour = s.count >= 3 ? '#a855f7' : s.count === 2 ? '#22c55e' : '#94a3b8';
    return `<tr data-count="${s.count}" data-adds="${s.adds}">
      <td class="num dim">${i + 1}</td>
      <td><span class="cnt" style="color:${cntColour}">${s.count}</span>${s.adds ? `<span class="adds tip" tabindex="0" data-tip="${s.adds} of them added or newly entered in the latest quarter">+${s.adds}▲</span>` : ''}</td>
      <td>
        <a class="stock-link" href="${url}" target="_blank" rel="noopener">${esc(s.name)}</a>
        ${s.slugIsCode ? '' : stockActions.buttonsHtml({ ticker: s.ticker, name: s.name, price: en.price || 0 })}
        <div class="sub">${esc(s.ticker)}${en.sector ? ' · ' + esc(en.sector) : ''}</div>
        ${scrChips ? `<div class="scr-row">${scrChips}</div>` : ''}
      </td>
      <td class="num">${en.price != null ? fmtPrice(en.price) : '—'}</td>
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
.invs{max-width:420px}
.inv{display:inline-block;font-size:.68rem;padding:2px 7px;margin:2px;border-radius:10px;background:rgba(168,85,247,.1);color:#d8b4fe;border:1px solid rgba(168,85,247,.25)}
.inv b{color:#fff;font-weight:700}
.footer{color:var(--t3);font-size:.75rem;text-align:center;margin-top:30px}
${TOOLTIP_CSS}
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
</div>
<table><thead><tr>
  <th class="num">#</th><th># Investors</th><th>Stock</th><th class="num">Price</th><th class="num">Mkt Cap</th>
  <th class="num tip" tabindex="0" data-tip="Sum of all marquee investors' stakes in this stock.">Total stake</th>
  <th>Who holds it (stake % · ▲added ★new ▼trimmed)</th>
</tr></thead><tbody id="tb">${rowHtml}</tbody></table>
${stockActions.bannerHtml}${stockActions.modalHtml}${stockActions.researchModalHtml}
<div class="footer">⭐ Marquee Investors · from Screener.in shareholder disclosures · Generated ${genTime} IST<br><strong>Not investment advice. Do your own research.</strong></div>
</div>
<script>
function ft(mode, btn){
  document.querySelectorAll('.tab').forEach(function(b){b.classList.toggle('active', b===btn);});
  document.querySelectorAll('#tb tr').forEach(function(tr){
    var c=+tr.dataset.count, a=+tr.dataset.adds;
    var show = mode==='all' || (mode==='multi'&&c>=2) || (mode==='adds'&&a>0);
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

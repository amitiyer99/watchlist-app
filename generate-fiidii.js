'use strict';

// Institutional Confluence page — stocks where FIIs and/or DIIs bought via NSE
// bulk/block deals in the last 90 days, tiered (BOTH > FII > DII), joined to the
// existing trend signals, with a market-flow backdrop and a per-stock Deep
// Research button pre-loaded with a catalyst prompt.
//
// Data (all NSE, cited on the page):
//   - docs/deals.json     (per-stock bulk/block deals; fetch-nse-deals.js)
//   - docs/fii-dii.json    (market-level daily FII/DII net flows; fetch-fii-dii.js)
//   - docs/breakout2-data.json, docs/apex-tickers.json, docs/triggers.json  (trend join)
// Output: docs/fiidii.html

const fs   = require('fs');
const path = require('path');
const { HUB_BACK_LINK } = require('./lib/hub-nav');
const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');
const { esc } = require('./lib/format');
const stockActions = require('./lib/stock-actions');
const { loadDeals } = require('./lib/smartmoney');
const { aggregate } = require('./lib/institutions');

const DOCS = path.join(__dirname, 'docs');
const OUT  = path.join(DOCS, 'fiidii.html');
const WINDOW_DAYS = 90;   // institutional accumulation plays out over a quarter

function readJson(p, fb = null) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fb; } catch { return fb; }
}
const crFmt = v => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 }) + ' Cr';

function loadWatchlistTickers() {
  try {
    const arr = readJson(path.join(__dirname, 'my-watchlists.json'), []) || [];
    const out = new Set();
    for (const wl of arr) {
      const data = wl.periods && (wl.periods['3M'] || wl.periods['1M'] || wl.periods['1Y']);
      if (!data || !Array.isArray(data.stocks)) continue;
      for (const s of data.stocks) { const t = (s.name || '').split('\n')[1]; if (t) out.add(t); }
    }
    return out;
  } catch { return new Set(); }
}

// Per-stock catalyst prompt that pre-fills the Deep Research modal.
function catalystPrompt(row, name) {
  const fii = row.fiiNames.slice(0, 3).join(', ') || 'none detected';
  const dii = row.diiNames.slice(0, 3).join(', ') || 'none detected';
  return `Act as an expert Indian stock market analyst. For ${name} (${row.symbol}) on the NSE: over the last ${WINDOW_DAYS} days our bulk/block-deal scan flagged institutional BUYING (${row.tier} — FII buyers: ${fii}; DII buyers: ${dii}). `
    + `1) Verify from the latest news and NSE/BSE disclosures whether FIIs and/or DIIs have genuinely increased holdings. `
    + `2) State the current technical and fundamental trend (e.g. bullish breakout, consolidation). `
    + `3) Identify the primary catalyst (earnings, sector tailwind, order win, management change, etc.). `
    + `Use only factually verified data from the last ${WINDOW_DAYS} days and explicitly cite your sources.`;
}

function marketBackdrop(fiidii) {
  const rows = (fiidii && Array.isArray(fiidii.rows)) ? fiidii.rows : [];
  const byDate = new Map();
  for (const r of rows) {
    if (!r || !r.date) continue;
    const d = byDate.get(r.date) || { date: r.date };
    if (r.category === 'FII') d.fii = r.netValue;
    if (r.category === 'DII') d.dii = r.netValue;
    byDate.set(r.date, d);
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
}

function main() {
  console.log('Building FII/DII institutional confluence page...');
  const deals = loadDeals();
  const dealsUpdated = deals && deals.updatedAt;
  const agg = aggregate(deals, { days: WINDOW_DAYS });

  const b2   = readJson(path.join(DOCS, 'breakout2-data.json'), []) || [];
  const apex = readJson(path.join(DOCS, 'apex-tickers.json'), []) || [];
  const trig = readJson(path.join(DOCS, 'triggers.json'), { triggers: [] }) || { triggers: [] };
  const urls = readJson(path.join(__dirname, 'ticker-urls.json'), {}) || {};
  const fiidii = readJson(path.join(DOCS, 'fii-dii.json'), { rows: [] }) || { rows: [] };
  const watch = loadWatchlistTickers();

  const b2Map   = new Map(b2.map(r => [r.ticker, r]));
  const apexMap = new Map(apex.map(r => [r.ticker, r]));
  const trigSet = new Set((trig.triggers || []).map(t => t.ticker));

  const rows = agg.map(a => {
    const b = b2Map.get(a.symbol) || {};
    const ax = apexMap.get(a.symbol) || {};
    const name = b.name || ax.name || a.symbol;
    return {
      ...a, name,
      sector: b.sector || ax.sector || null,
      url: urls[a.symbol] || ax.url || null,
      price: b.price ?? null,
      b2score: b.score ?? null,
      stage2: !!b.stage2, vcpPass: !!b.vcpPass,
      apexAction: ax.action || null,
      triggered: trigSet.has(a.symbol),
      inWatch: watch.has(a.symbol),
    };
  });

  const counts = {
    both: rows.filter(r => r.tier === 'BOTH').length,
    fii:  rows.filter(r => r.tier === 'FII').length,
    dii:  rows.filter(r => r.tier === 'DII').length,
  };
  const backdrop = marketBackdrop(fiidii);
  const generatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  fs.writeFileSync(OUT, buildHtml({ rows, counts, backdrop, generatedAt, dealsUpdated, fiidiiUpdated: fiidii.updatedAt }));
  console.log(`  ${rows.length} stocks (BOTH:${counts.both} FII:${counts.fii} DII:${counts.dii}) → ${OUT}`);
}

function tierBadge(t) {
  if (t === 'BOTH') return `<span class="tier tier-both tip" tabindex="0" data-tip="Both FIIs and DIIs bought via disclosed bulk/block deals in the last ${WINDOW_DAYS} days — the strongest institutional-confluence signal.">FII + DII</span>`;
  if (t === 'FII')  return '<span class="tier tier-fii tip" tabindex="0" data-tip="Foreign institutional buying detected (no domestic-institution deal in the window).">FII</span>';
  return '<span class="tier tier-dii tip" tabindex="0" data-tip="Domestic institutional buying detected (no foreign-institution deal in the window).">DII</span>';
}

function trendCell(r) {
  const bits = [];
  if (r.b2score != null) bits.push(`<span class="chip">B2 ${Math.round(r.b2score)}</span>`);
  if (r.stage2 && r.vcpPass) bits.push('<span class="chip chip-ok">Stage-2 VCP</span>');
  else if (r.stage2) bits.push('<span class="chip">Stage-2</span>');
  if (r.apexAction === 'BUY') bits.push('<span class="chip chip-buy">APEX BUY</span>');
  if (r.triggered) bits.push('<span class="chip chip-trig">🎯 Triggered</span>');
  return bits.join(' ') || '<span class="dim">—</span>';
}

function buildHtml({ rows, counts, backdrop, generatedAt, dealsUpdated, fiidiiUpdated }) {
  const rowsHtml = rows.map(r => {
    const ttUrl = r.url || `https://www.tickertape.in/stocks/${(r.name || r.symbol).toLowerCase().replace(/\s+ltd$/, '').replace(/\s+/g, '-')}-${r.symbol}`;
    const buyers = [
      ...r.fiiNames.map(n => `<span class="buyer buyer-fii tip" tabindex="0" data-tip="Classified FII / foreign portfolio investor">${esc(n)}</span>`),
      ...r.diiNames.map(n => `<span class="buyer buyer-dii tip" tabindex="0" data-tip="Classified DII / domestic institution">${esc(n)}</span>`),
    ].join(' ') || '<span class="dim">—</span>';
    return `<tr>
      <td>
        <div class="name-row">
          <a class="tk" href="${esc(ttUrl)}" target="_blank" rel="noopener">${esc(r.name)}</a>
          ${stockActions.buttonsHtml({ ticker: r.symbol, name: r.name, price: r.price || 0, prompt: catalystPrompt(r, r.name) })}
        </div>
        <div class="sub">${esc(r.symbol)}${r.sector ? ' · ' + esc(r.sector) : ''}${r.inWatch ? ' · <span class="wl">★ WL</span>' : ''}</div>
      </td>
      <td>${tierBadge(r.tier)}</td>
      <td class="buyers">${buyers}</td>
      <td class="num">${crFmt(r.totalValueCr)}<div class="sub">${r.fiiBuys}F · ${r.diiBuys}D deals</div></td>
      <td class="num">${r.price != null ? '₹' + Number(r.price).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}</td>
      <td class="trend">${trendCell(r)}</td>
    </tr>`;
  }).join('');

  const backdropHtml = backdrop.length ? backdrop.map(d => {
    const f = d.fii, di = d.dii;
    const cls = v => v == null ? '' : (v >= 0 ? 'pos' : 'neg');
    const fmt = v => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    return `<div class="bd"><div class="bd-d">${esc(d.date)}</div><div class="bd-v ${cls(f)}">FII ${fmt(f)}</div><div class="bd-v ${cls(di)}">DII ${fmt(di)}</div></div>`;
  }).join('') : '<div class="dim" style="padding:8px 0">No recent FII/DII flow data.</div>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Institutional Confluence — FII / DII Buying</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0c0c10;--s1:#12121a;--s2:#181822;--s3:#22222e;--bd:#2a2a38;--tx:#e4e4ea;--t2:#9a9aa6;--t3:#6a6a82;--ac:#00d4aa;--gn:#22c55e;--rd:#ef4444;--am:#f59e0b;--bl:#60a5fa;--vi:#a855f7}
*{box-sizing:border-box}body{background:var(--bg);color:var(--tx);font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;font-size:14px}
.header{background:var(--s1);border-bottom:1px solid var(--bd);padding:16px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.header h1{margin:0;font-size:1.2rem}.header .sub{color:var(--t2);font-size:.78rem}
.nav a{color:var(--t2);text-decoration:none;font-size:.78rem;padding:4px 10px;border:1px solid var(--bd);border-radius:6px;margin-left:6px}
.nav a:hover{color:var(--tx);background:var(--s2)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:14px 24px;background:var(--s1);border-bottom:1px solid var(--bd)}
.stat{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 12px}.stat .v{font-size:1.3rem;font-weight:700}.stat .l{color:var(--t2);font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.backdrop{display:flex;gap:8px;padding:12px 24px;background:var(--bg);border-bottom:1px solid var(--bd);overflow-x:auto;align-items:center}
.backdrop .lbl{color:var(--t3);font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;margin-right:4px;white-space:nowrap}
.bd{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:6px 10px;min-width:120px}
.bd-d{color:var(--t2);font-size:.68rem}.bd-v{font-size:.8rem;font-weight:600;font-variant-numeric:tabular-nums}
.pos{color:var(--gn)}.neg{color:var(--rd)}
table{width:100%;border-collapse:collapse}thead{background:var(--s1);position:sticky;top:0;z-index:2}
th{text-align:left;padding:10px 12px;font-size:.7rem;color:#7dd3fc;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--bd)}
td{padding:12px;border-bottom:1px solid var(--bd);vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums}
.name-row{display:flex;align-items:center;flex-wrap:wrap;gap:2px}
.tk{color:var(--tx);font-weight:700;text-decoration:none}.tk:hover{color:var(--ac)}
.sub{color:var(--t2);font-size:.72rem;margin-top:2px}.dim{color:var(--t3)}.wl{color:var(--am)}
.tier{display:inline-block;font-size:.68rem;font-weight:800;padding:3px 8px;border-radius:5px;letter-spacing:.03em;white-space:nowrap}
.tier-both{background:rgba(0,212,170,.16);color:#5eead4;border:1px solid rgba(0,212,170,.5)}
.tier-fii{background:rgba(96,165,250,.16);color:#93c5fd;border:1px solid rgba(96,165,250,.45)}
.tier-dii{background:rgba(168,85,247,.16);color:#c4b5fd;border:1px solid rgba(168,85,247,.45)}
.buyers{max-width:280px}.buyer{display:inline-block;font-size:.65rem;padding:1px 6px;border-radius:4px;margin:1px 2px 1px 0;white-space:nowrap}
.buyer-fii{background:rgba(96,165,250,.14);color:#93c5fd}.buyer-dii{background:rgba(168,85,247,.14);color:#c4b5fd}
.trend .chip,.chip{display:inline-block;font-size:.64rem;font-weight:700;padding:1px 6px;border-radius:4px;margin:1px 2px 1px 0;background:var(--s3);color:var(--t2)}
.chip-ok{background:rgba(34,197,94,.16);color:#4ade80}.chip-buy{background:rgba(34,197,94,.16);color:#22c55e}.chip-trig{background:rgba(245,158,11,.16);color:#fbbf24}
tbody tr:nth-child(even){background:rgba(255,255,255,.015)}tbody tr:hover{background:rgba(125,211,252,.05)}
.footer{padding:16px 24px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd);line-height:1.7}
.empty{padding:48px 24px;text-align:center;color:var(--t2)}
${stockActions.css}
${TOOLTIP_CSS}
</style></head><body>
<div class="header">
  <div><h1>🏦 Institutional Confluence <span class="sub">FII / DII buying · last ${WINDOW_DAYS}d · ${esc(generatedAt)} IST</span></h1></div>
  <div class="nav">${HUB_BACK_LINK}<a href="index.html">Dashboard</a><a href="triggers.html">Triggers</a><a href="confluence.html">Confluence</a></div>
</div>
${legendHtml('How to read this page — sources, tiers & caveats (tap to expand)', [
  { title: 'What this shows', bodyHtml: `<p>Stocks where <b>institutions bought</b> via NSE-disclosed <b>bulk & block deals</b> in the last ${WINDOW_DAYS} days. Buyers are classified <b>FII</b> (foreign) or <b>DII</b> (domestic) from the disclosed client name. <span class="tier tier-both">FII + DII</span> = both bought (strongest signal), then <span class="tier tier-fii">FII</span> / <span class="tier tier-dii">DII</span> single-side.</p>` },
  { title: 'The catalyst', bodyHtml: `<p>Click the &#x1F9E0; on any stock for on-demand <b>Deep Research</b> — it pre-loads a prompt asking an LLM to verify the FII/DII holding change, the trend, and the primary catalyst, with sources. Uses your own API key, in your browser.</p>` },
  { title: 'Honest caveats', bodyHtml: `<p>Bulk/block deals capture only <b>large disclosed transactions</b> (&gt;0.5% of equity), not routine accumulation — a high-signal <i>subset</i>, not full holdings. FII/DII tagging is a <b>name heuristic</b> (unmatched buyers are ignored). The authoritative "increased holdings" is the quarterly shareholding filing (4×/year). Not investment advice.</p>` },
])}
<div class="backdrop"><span class="lbl">Market flows (₹ Cr net)</span>${backdropHtml}</div>
<div class="stats">
  <div class="stat"><div class="v" style="color:#5eead4">${counts.both}</div><div class="l">FII + DII (both)</div></div>
  <div class="stat"><div class="v" style="color:#93c5fd">${counts.fii}</div><div class="l">FII only</div></div>
  <div class="stat"><div class="v" style="color:#c4b5fd">${counts.dii}</div><div class="l">DII only</div></div>
  <div class="stat"><div class="v">${counts.both + counts.fii + counts.dii}</div><div class="l">Total names</div></div>
</div>
${rows.length ? `<table><thead><tr>
  <th>Stock</th><th>Institutions</th><th>Buyers (${WINDOW_DAYS}d)</th>
  <th class="num"><span class="tip" tabindex="0" data-tip="Total ₹ value of disclosed institutional BUY deals in the window; F/D = FII/DII deal counts.">Buy value</span></th>
  <th class="num">Price</th><th>Trend</th>
</tr></thead><tbody>${rowsHtml}</tbody></table>`
  : `<div class="empty">No FII/DII bulk/block buying detected in the last ${WINDOW_DAYS} days. Institutional deals are lumpy — check back after active sessions.</div>`}
<div class="footer">
  Sources: NSE bulk &amp; block deal disclosures${dealsUpdated ? ` (updated ${esc(new Date(dealsUpdated).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))} IST)` : ''} · NSE FII/DII cash-market flows${fiidiiUpdated ? ` (updated ${esc(new Date(fiidiiUpdated).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))} IST)` : ''}.
  <br>FII/DII attribution is heuristic from disclosed client names. Bulk/block deals are a subset of institutional activity. Not investment advice — verify via each company's shareholding filings before acting.
</div>
${stockActions.bannerHtml}
${stockActions.modalHtml}
${stockActions.researchModalHtml}
<script>${stockActions.setupScript}</script>
<script>${stockActions.js}</script>
</body></html>`;
}

if (require.main === module) main();
module.exports = { main };

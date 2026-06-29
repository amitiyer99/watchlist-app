'use strict';

// Best Picks — the leading page. Blends every screener + engineered features into
// a regime- and macro-aware master conviction score, with per-horizon Top-N lists,
// calibrated win-probability, Tickertape links, and the shared brain/alert icons.

const fs   = require('fs');
const path = require('path');

const { HUB_BACK_LINK } = require('./lib/hub-nav');
const stockActions = require('./lib/stock-actions');
const { buildFeatureMatrix } = require('./lib/features');
const { scoreUniverse } = require('./lib/master-score');
const { BLOCKS } = require('./lib/feature-registry');
const { loadRegime } = require('./lib/regime');
const { loadMacro } = require('./lib/macro');
const { planTrade, suggestSizePct } = require('./lib/signals');
const { appendOutcomes, loadOutcomes, todayIST } = require('./lib/outcomes');

let renderStatsSection = () => '';
let renderWeightsSection = () => '';
let renderFeatureLabSection = () => '';
try {
  const ss = require('./lib/stats-section');
  renderStatsSection = ss.renderStatsSection || renderStatsSection;
  renderWeightsSection = ss.renderWeightsSection || renderWeightsSection;
  renderFeatureLabSection = ss.renderFeatureLabSection || renderFeatureLabSection;
} catch { /* optional */ }

const OUTPUT_PATH  = path.join(__dirname, 'docs', 'bestpicks.html');
const SIDECAR_PATH = path.join(__dirname, 'docs', 'bestpicks-tickers.json');
const FHIST_PATH   = path.join(__dirname, 'feature-history.jsonl');

const esc = stockActions.esc;
const fmtPrice = v => typeof v === 'number' ? '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
const fmtCr = v => typeof v === 'number' ? '₹' + Math.round(v).toLocaleString('en-IN') + ' Cr' : '—';

const SCREENER_LABEL = { apex: 'APEX', breakout2: 'Breakout', creamy: 'Creamy', multibagger: 'MBF', indianresearch: 'IR', rocket: 'Rocket' };
const BLOCK_LABEL = { momentum: 'Mom', technical: 'Tech', quality: 'Qual', value: 'Val', conviction: 'Conv' };

function convColour(v) {
  if (v >= 75) return '#a855f7';
  if (v >= 60) return '#22c55e';
  if (v >= 45) return '#eab308';
  if (v >= 30) return '#f59e0b';
  return '#94a3b8';
}
function zColour(z) { return z == null ? '#6a6a82' : z > 0.5 ? '#22c55e' : z < -0.5 ? '#ef4444' : '#9ca3af'; }

function signalType(master) {
  return master >= 80 ? 'BESTPICK_ELITE' : master >= 65 ? 'BESTPICK_STRONG' : master >= 50 ? 'BESTPICK_MODERATE' : 'BESTPICK_WATCH';
}

function tradePlan(rec, regime) {
  const price = rec.price;
  const pivot = rec.raw && rec.raw.pivot;
  const atrPct = rec.raw && rec.raw.atrPct;
  if (price == null || pivot == null) return null;
  const atr14 = (atrPct != null) ? (atrPct / 100) * price : null;
  const plan = planTrade({ entry: price, pivot, atr14, regime });
  if (!plan) return null;
  plan.sizePct = suggestSizePct({ entry: plan.entry, stop: plan.stop });
  return plan;
}

function buildRows(list, regime, tickerUrls) {
  return list.map((s, i) => {
    const url = s.url || (tickerUrls && tickerUrls[s.ticker]) || `https://www.tickertape.in/stocks/${esc(s.ticker)}`;
    const cc = convColour(s.master);
    const blockChips = BLOCKS.map(b => {
      const z = s.blockZ[b];
      return `<span class="bchip" style="color:${zColour(z)}" title="${BLOCK_LABEL[b]} z-score">${BLOCK_LABEL[b]} ${z > 0 ? '+' : ''}${z}</span>`;
    }).join('');
    const scr = (s.screeners || []).map(id => `<span class="scr">${SCREENER_LABEL[id] || id}</span>`).join('');
    const why = (s.why || []).map(w => `<span class="why" style="border-color:${zColour(w.z)}55;color:${zColour(w.z)}" title="${esc(w.label)} (z ${w.z})">${esc(w.label)}</span>`).join('');
    const plan = s._plan;
    const planHtml = plan
      ? `<div class="plan"><span title="Entry">E ${fmtPrice(plan.entry)}</span><span title="Stop" class="stop">S ${fmtPrice(plan.stop)}</span><span title="Target" class="tgt">T ${fmtPrice(plan.target)}</span><span title="Risk:Reward">${plan.rr}R</span>${plan.sizePct ? `<span title="Suggested size %">${plan.sizePct}%</span>` : ''}</div>`
      : '<div class="plan dim">—</div>';
    const prob = Math.round((s.winProb || 0) * 100);
    return `<tr>
      <td class="num dim">${i + 1}</td>
      <td>
        <div class="name-row">
          <a class="stock-link" href="${url}" target="_blank" rel="noopener">${esc(s.name)}</a>
          ${stockActions.buttonsHtml({ ticker: s.ticker, name: s.name, price: s.price || 0 })}
        </div>
        <div class="ticker-sub">${esc(s.ticker)}${s.sector ? ' · ' + esc(s.sector) : ''}</div>
        <div class="scr-row">${scr}</div>
      </td>
      <td class="num">${fmtPrice(s.price)}</td>
      <td class="num dim">${s.marketCap ? fmtCr(s.marketCap) : '—'}</td>
      <td class="conv-cell">
        <div class="conv-bar-wrap"><div class="conv-bar" style="width:${s.master}%;background:${cc}"></div></div>
        <div class="conv-nums"><span style="color:${cc};font-weight:800">${s.master}</span><span class="dim">/100</span></div>
      </td>
      <td class="num"><span class="prob" title="Calibrated probability of beating Nifty over ~20 trading days">${prob}%</span></td>
      <td class="blocks">${blockChips}</td>
      <td class="drivers">${why || '<span class="dim">—</span>'}</td>
      <td class="planwrap">${planHtml}</td>
    </tr>`;
  }).join('');
}

function tabTable(id, list, regime, tickerUrls, hidden) {
  return `<div id="tab-${id}"${hidden ? ' class="hidden"' : ''}>
    <div class="ctrl"><input type="text" class="search" id="search-${id}" placeholder="Search ticker / name / sector…" oninput="filt('${id}')"><span class="note" id="note-${id}">${list.length} stocks</span></div>
    <div class="twrap"><table id="tbl-${id}">
      <thead><tr>
        <th class="num">#</th><th>Stock</th><th class="num">Price</th><th class="num">Mkt Cap</th>
        <th class="num">Master</th><th class="num">Win&nbsp;Prob</th><th>Factor z-scores</th><th>Top Drivers</th><th>Trade Plan</th>
      </tr></thead>
      <tbody id="tb-${id}">${buildRows(list, regime, tickerUrls)}</tbody>
    </table></div>
  </div>`;
}

function buildHtml({ overall, swing, positional, long, lowrisk }, ctx, regime, macro, tickerUrls) {
  const genTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const regimeLabel = regime && regime.isBearMarket ? '🐻 Bear' : '🐂 Bull';
  const macroBadge = macro && macro.available
    ? `Risk-On ${macro.riskOn}/100 · ${esc(macro.regime)}${macro.reasons && macro.reasons.length ? ' · ' + esc(macro.reasons.slice(0, 3).join(' · ')) : ''}`
    : 'macro unavailable (neutral)';

  const navLinks = [
    ['confluence.html', '⚡ Confluence'], ['apex.html', '🔮 APEX'], ['breakout2.html', '⚡ Breakout'],
    ['triggers.html', '🎯 Triggers'], ['debate.html', '🗣️ Debate'], ['prediction.html', '🔭 Prediction'],
    ['sectors.html', '📊 Sectors'], ['index.html', '⭐ Watchlist'],
  ].map(([h, l]) => `<a class="back-link" href="${h}">${l}</a>`).join('') + HUB_BACK_LINK;

  const statsHtml = renderStatsSection({ title: 'Screener Track Record (20-day forward return vs Nifty)' }) || '';
  const featureLabHtml = renderFeatureLabSection ? (renderFeatureLabSection() || '') : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Best Picks · Master Signal</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--s1:#0f0f17;--s2:#13131e;--s3:#1a1a28;--tx:#e2e8f0;--t2:#94a3b8;--t3:#64748b;--ac:#a855f7;--bd:rgba(168,85,247,.18);--row:rgba(168,85,247,.06)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);line-height:1.5}
.header{background:rgba(10,10,15,.92);border-bottom:1px solid var(--bd);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);flex-wrap:wrap}
.header h1{font-size:1.3rem;font-weight:800;background:linear-gradient(135deg,#c084fc,#a855f7,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{font-size:.72rem;color:var(--t2);margin-top:3px}
.header-right{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.back-link{padding:5px 9px;border-radius:6px;border:1px solid var(--bd);color:var(--t2);text-decoration:none;font-size:.72rem;white-space:nowrap}
.back-link:hover{color:var(--tx);border-color:var(--ac)}
.context{display:flex;gap:18px;flex-wrap:wrap;align-items:center;padding:12px 24px;background:var(--s1);border-bottom:1px solid var(--bd);font-size:.8rem}
.context b{color:var(--ac)}
.ctx-pill{padding:4px 10px;border:1px solid var(--bd);border-radius:20px;color:var(--t2)}
.tabs{display:flex;gap:6px;padding:14px 24px 0;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap}
.tab-btn{padding:9px 16px;border:1px solid var(--bd);border-bottom:none;border-radius:8px 8px 0 0;background:var(--s2);color:var(--t2);cursor:pointer;font-size:.82rem;font-family:inherit;font-weight:600}
.tab-btn.active{background:var(--bg);color:var(--tx);border-bottom:1px solid var(--bg)}
.ctrl{display:flex;gap:10px;align-items:center;padding:10px 24px;background:var(--bg)}
.search{padding:7px 12px;border-radius:7px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.85rem;outline:none;width:240px}
.note{font-size:.75rem;color:var(--t2);margin-left:auto}
.twrap{overflow:auto;padding:0 24px 30px}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:.84rem}
th{background:var(--s1);color:var(--ac);font-weight:700;font-size:.68rem;text-transform:uppercase;letter-spacing:.04em;padding:11px 12px;text-align:left;border-bottom:2px solid var(--bd);position:sticky;top:0;white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:middle}
tr:hover td{background:var(--row)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.dim{color:var(--t3)}
.name-row{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
.stock-link{color:var(--tx);text-decoration:none;font-weight:600}
.stock-link:hover{color:var(--ac)}
.ticker-sub{color:var(--t2);font-size:.71rem;margin-top:1px}
.scr-row{margin-top:3px;display:flex;gap:3px;flex-wrap:wrap}
.scr{font-size:.6rem;font-weight:700;padding:1px 5px;border-radius:4px;background:var(--s3);color:var(--t2)}
.conv-cell{min-width:120px}
.conv-bar-wrap{height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden}
.conv-bar{height:100%;border-radius:3px}
.conv-nums{margin-top:3px;font-size:.85rem;display:flex;gap:2px;justify-content:flex-end;align-items:baseline}
.prob{font-weight:700}
.blocks{white-space:nowrap}
.bchip{display:inline-block;font-size:.66rem;font-weight:700;padding:1px 5px;margin:1px;border-radius:4px;background:var(--s3);font-variant-numeric:tabular-nums}
.drivers{white-space:normal;min-width:170px}
.why{display:inline-block;font-size:.62rem;font-weight:600;padding:1px 6px;margin:1px;border-radius:4px;border:1px solid}
.plan{display:flex;gap:7px;flex-wrap:wrap;font-size:.72rem;font-variant-numeric:tabular-nums;color:var(--t2)}
.plan .stop{color:#ef4444}.plan .tgt{color:#22c55e}
.planwrap{min-width:170px}
.hidden{display:none!important}
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.73rem;border-top:1px solid var(--bd);line-height:1.8}
.panels{padding:6px 24px}
@media(max-width:768px){.header{padding:12px 14px}.context,.tabs,.ctrl,.twrap,.panels{padding-left:12px;padding-right:12px}td,th{padding:8px 9px;font-size:.78rem}}
${stockActions.css}
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>🏆 Best Picks · Master Signal</h1>
    <div class="subtitle">Self-improving, macro-aware blend of every screener &nbsp;·&nbsp; <span style="color:var(--ac)">Generated ${genTime} IST</span></div>
  </div>
  <div class="header-right">${navLinks}</div>
</div>

<div class="context">
  <span class="ctx-pill">Market: <b>${regimeLabel}</b></span>
  <span class="ctx-pill">Macro: <b>${macroBadge}</b></span>
  <span class="ctx-pill">Tilt: <b>${esc(ctx.tilt)}</b></span>
  <span class="ctx-pill">Risk scale: <b>${ctx.riskScale}×</b></span>
  <span class="ctx-pill">${overall.length} ranked</span>
</div>

<div class="tabs">
  <button class="tab-btn active" id="tb-btn-overall" onclick="tab('overall')">🏆 Best Overall <span>${overall.length}</span></button>
  <button class="tab-btn" id="tb-btn-swing" onclick="tab('swing')">⚡ Swing <span>${swing.length}</span></button>
  <button class="tab-btn" id="tb-btn-positional" onclick="tab('positional')">📈 Positional <span>${positional.length}</span></button>
  <button class="tab-btn" id="tb-btn-long" onclick="tab('long')">💎 Long-term <span>${long.length}</span></button>
  <button class="tab-btn" id="tb-btn-lowrisk" onclick="tab('lowrisk')">🛡️ Low-risk <span>${lowrisk.length}</span></button>
</div>

${tabTable('overall', overall, regime, tickerUrls, false)}
${tabTable('swing', swing, regime, tickerUrls, true)}
${tabTable('positional', positional, regime, tickerUrls, true)}
${tabTable('long', long, regime, tickerUrls, true)}
${tabTable('lowrisk', lowrisk, regime, tickerUrls, true)}

<div class="panels">
  ${featureLabHtml}
  ${statsHtml}
</div>

${stockActions.bannerHtml}
${stockActions.modalHtml}
${stockActions.researchModalHtml}

<div class="footer">
  🏆 Best Picks · Master Signal &nbsp;·&nbsp; Conviction blends Momentum / Technical / Quality / Value / Conviction, regime- and macro-weighted, win-probability calibrated on realized outcomes.<br>
  <strong>Not investment advice. Do your own research.</strong>
</div>

<script>
function tab(id){
  ['overall','swing','positional','long','lowrisk'].forEach(function(t){
    document.getElementById('tab-'+t).classList.toggle('hidden',t!==id);
    document.getElementById('tb-btn-'+t).classList.toggle('active',t===id);
  });
}
function filt(id){
  var q=(document.getElementById('search-'+id).value||'').toLowerCase();
  var rows=document.getElementById('tb-'+id).querySelectorAll('tr');var v=0;
  rows.forEach(function(r){var m=!q||r.textContent.toLowerCase().includes(q);r.style.display=m?'':'none';if(m)v++;});
  var n=document.getElementById('note-'+id);if(n)n.textContent=v+' stock'+(v!==1?'s':'');
}
<\/script>
<script>${stockActions.setupScript}</script>
<script>${stockActions.js}</script>
</body>
</html>`;
}

function main() {
  console.log('🏆 Best Picks — building master signal');
  const regime = loadRegime();
  const macro = loadMacro();
  const outcomes = loadOutcomes();

  const { stocks } = buildFeatureMatrix();
  console.log(`  Universe: ${stocks.length} tickers`);
  const ctx = scoreUniverse(stocks, { regime, macro, outcomes });

  // attach trade plans
  for (const s of stocks) s._plan = tradePlan(s, regime);

  const byMaster = h => stocks.slice().sort((a, b) => (b.conviction[h] || 0) - (a.conviction[h] || 0));
  const overall = stocks.slice().sort((a, b) => b.master - a.master).slice(0, 150);
  const swing = byMaster('swing').slice(0, 80);
  const positional = byMaster('positional').slice(0, 80);
  const long = byMaster('long').slice(0, 80);
  const lowrisk = stocks.slice()
    .filter(s => s.raw && s.raw.atrPct != null && s.raw.atrPct <= 4)
    .sort((a, b) => b.conviction.positional - a.conviction.positional).slice(0, 80);

  const tuPath = path.join(__dirname, 'ticker-urls.json');
  const tickerUrls = fs.existsSync(tuPath) ? JSON.parse(fs.readFileSync(tuPath, 'utf8')) : {};

  if (!fs.existsSync(path.join(__dirname, 'docs'))) fs.mkdirSync(path.join(__dirname, 'docs'));
  fs.writeFileSync(OUTPUT_PATH, buildHtml({ overall, swing, positional, long, lowrisk }, ctx, regime, macro, tickerUrls), 'utf8');
  console.log(`  ✅ Wrote ${OUTPUT_PATH}`);

  // Sidecar
  const sidecar = overall.map(s => ({
    ticker: s.ticker, name: s.name, sector: s.sector, price: s.price, marketCap: s.marketCap, url: s.url || null,
    master: s.master, winProb: s.winProb, conviction: s.conviction, blockZ: s.blockZ,
    screeners: s.screeners, why: (s.why || []).map(w => w.id),
  }));
  fs.writeFileSync(SIDECAR_PATH, JSON.stringify(sidecar), 'utf8');

  // Outcome ledger (top picks, master >= 50) + point-in-time feature history
  try {
    const date = todayIST();
    const actionable = stocks.filter(s => s.master >= 50).sort((a, b) => b.master - a.master).slice(0, 120);
    const rows = actionable.map(s => ({
      date, screener: 'bestpicks', signalType: signalType(s.master),
      ticker: s.ticker, name: s.name || s.ticker, sector: s.sector || null,
      entry: s.price || null,
      pivot: s._plan ? s._plan.entry : null,
      stop: s._plan ? s._plan.stop : null,
      target: s._plan ? s._plan.target : null,
      rr: s._plan ? s._plan.rr : null,
      sizePct: s._plan ? s._plan.sizePct : null,
      score: s.master,
      regime: regime.isBearMarket ? 'BEAR' : 'BULL',
      extras: { winProb: s.winProb, blockZ: s.blockZ, screeners: s.screeners, conviction: s.conviction },
    }));
    const lg = appendOutcomes(rows);
    console.log(`  Outcomes (bestpicks): +${lg.added} added (${lg.skipped} skipped, ${lg.total} total)`);

    // Idempotent: only append today's point-in-time snapshot once.
    let alreadyLogged = false;
    try { alreadyLogged = fs.existsSync(FHIST_PATH) && fs.readFileSync(FHIST_PATH, 'utf8').includes(`"date":"${date}"`); } catch { /* ignore */ }
    if (alreadyLogged) {
      console.log('  Feature history: today already logged — skipping append.');
    } else {
      const histLines = actionable.map(s => JSON.stringify({ date, ticker: s.ticker, master: s.master, winProb: s.winProb, feat: s.feat })).join('\n');
      if (histLines) fs.appendFileSync(FHIST_PATH, histLines + '\n');
      console.log(`  Feature history: +${actionable.length} rows -> feature-history.jsonl`);
    }
  } catch (e) {
    console.warn('  ledger/history append failed:', e.message);
  }
  console.log('Done.');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('bestpicks error:', e); process.exit(1); }
}
module.exports = { main };

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
const { planTrade, suggestSizePct, DEFAULTS: SIG_DEF } = require('./lib/signals');
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
const LIVE_PATH    = path.join(__dirname, 'docs', 'live-prices.json');

function loadLivePrices() {
  try {
    if (!fs.existsSync(LIVE_PATH)) return {};
    return JSON.parse(fs.readFileSync(LIVE_PATH, 'utf8')).prices || {};
  } catch { return {}; }
}

const esc = stockActions.esc;
const fmtPrice = v => typeof v === 'number' ? '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
const fmtCr = v => typeof v === 'number' ? '₹' + Math.round(v).toLocaleString('en-IN') + ' Cr' : '—';

const SCREENER_LABEL = { apex: 'APEX', breakout2: 'Breakout', creamy: 'Creamy', multibagger: 'MBF', indianresearch: 'IR', rocket: 'Rocket' };
const BLOCK_LABEL = { momentum: 'Mom', technical: 'Tech', quality: 'Qual', value: 'Val', conviction: 'Conv' };
const FALLBACK_STOP_PCT = 8; // when no ATR or pivot — stop ≈ 8% below entry

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
  const current = rec.price;
  if (current == null) return null;

  const pivot = rec.raw && rec.raw.pivot;
  const atrPct = rec.raw && rec.raw.atrPct;

  // ---- Breakout plan (Breakout2 pivot + ATR) ----
  if (pivot != null) {
    const atr14 = (atrPct != null) ? (atrPct / 100) * current : null;
    const entry = current >= pivot ? current : pivot;
    const plan = planTrade({ entry, pivot, atr14, regime });
    if (!plan) return null;
    plan.current = current;
    plan.pending = current < pivot;
    plan.sizePct = suggestSizePct({ entry: plan.entry, stop: plan.stop });
    plan.kind = 'breakout';
    return plan;
  }

  // ---- Fallback positional plan (no chart pivot) ----
  const stopPct = (atrPct != null && atrPct > 0)
    ? Math.min(Math.max(2 * atrPct, 5), 12)
    : FALLBACK_STOP_PCT;
  const entry = current;
  const stop = +(entry * (1 - stopPct / 100)).toFixed(2);
  if (stop <= 0 || stop >= entry) return null;
  const risk = entry - stop;
  const target = +(entry + SIG_DEF.targetRRMult * risk).toFixed(2);
  const rr = +((target - entry) / risk).toFixed(2);
  const riskPct = +((risk / entry) * 100).toFixed(2);
  return {
    current, entry, stop, target, rr, riskPct,
    sizePct: suggestSizePct({ entry, stop }),
    kind: 'fallback',
    pending: false,
    stopPct,
  };
}

function setupBadgeHtml(plan) {
  if (!plan) return '<span class="setup-badge setup-none" title="No trade plan available">No setup</span>';
  if (plan.kind === 'breakout' && plan.pending) {
    return '<span class="setup-badge setup-pending" title="Pivot defined — entry on breakout above pivot">⏳ Near pivot</span>';
  }
  if (plan.kind === 'breakout') {
    return '<span class="setup-badge setup-ready" title="Breakout trade plan — entry, stop, exit from pivot + ATR">✅ Breakout plan</span>';
  }
  return '<span class="setup-badge setup-fallback" title="Estimated plan from ATR or 8% stop — no chart pivot">📊 Positional plan</span>';
}

function planKindLabel(plan) {
  if (!plan) return '';
  if (plan.kind === 'breakout') return plan.pending ? 'Breakout · wait' : 'Breakout';
  return `Positional · est. ${plan.stopPct || FALLBACK_STOP_PCT}% stop`;
}

const TIMEFRAME = {
  swing:      { label: '~2–5 wks',  detail: '10–25 trading days' },
  positional: { label: '~4–10 wks', detail: '20–50 trading days' },
  long:       { label: '~3–6 mo',   detail: '60–120 trading days' },
};

function planTimeframe(plan, horizonKey) {
  if (plan.kind === 'breakout') return { label: '~2–5 wks', detail: '10–25 trading days (swing breakout)' };
  return TIMEFRAME[horizonKey] || TIMEFRAME.positional;
}

function planUpsideMetrics(plan) {
  const upsidePct = +(((plan.target - plan.entry) / plan.entry) * 100).toFixed(1);
  const fromNow = (plan.current != null && plan.current > 0)
    ? +(((plan.target - plan.current) / plan.current) * 100).toFixed(1)
    : upsidePct;
  return { upsidePct, fromNow };
}

function renderPlanHtml(plan, horizonKey) {
  if (!plan) return '<div class="plan dim">—</div>';
  const pending = plan.pending ? ' <span class="plan-hint">@ pivot</span>' : '';
  const kindLbl = planKindLabel(plan);
  const { upsidePct, fromNow } = planUpsideMetrics(plan);
  const tf = planTimeframe(plan, horizonKey || 'positional');
  const gainHint = (plan.pending && Math.abs(fromNow - upsidePct) > 0.05)
    ? ` <span class="plan-hint">(${fromNow > 0 ? '+' : ''}${fromNow}% from LTP)</span>`
    : '';
  return `<div class="plan-grid" data-plan-cell>
    <div class="plan-row"><span class="plan-lbl">Current</span><span class="plan-val now" data-plan-now>${fmtPrice(plan.current)}</span></div>
    <div class="plan-row"><span class="plan-lbl">Entry</span><span class="plan-val entry" data-plan-entry>${fmtPrice(plan.entry)}${pending}</span></div>
    <div class="plan-row"><span class="plan-lbl">Stop Loss</span><span class="plan-val stop" data-plan-stop>${fmtPrice(plan.stop)}</span></div>
    <div class="plan-row"><span class="plan-lbl">Exit</span><span class="plan-val exit" data-plan-exit>${fmtPrice(plan.target)}</span></div>
    <div class="plan-row plan-highlight" title="Expected move from entry to exit target">
      <span class="plan-lbl">Target gain</span>
      <span class="plan-val gain" data-plan-gain>+${upsidePct}%${gainHint}</span>
    </div>
    <div class="plan-row plan-highlight" title="${esc(tf.detail)}">
      <span class="plan-lbl">Timeframe</span>
      <span class="plan-val time" data-plan-time>${tf.label}</span>
    </div>
    <div class="plan-meta">${kindLbl} · ${plan.rr}R · ${plan.riskPct}% risk${plan.sizePct ? ' · ' + plan.sizePct + '% size' : ''}</div>
  </div>`;
}

function buildRows(list, regime, tickerUrls, probKey) {
  const probOf = s => {
    if (probKey && s.winProbByHorizon && s.winProbByHorizon[probKey] != null) return s.winProbByHorizon[probKey];
    return s.winProb || 0;
  };
  return list.map((s, i) => {
    const url = s.url || (tickerUrls && tickerUrls[s.ticker]) || `https://www.tickertape.in/stocks/${esc(s.ticker)}`;
    const masterVal = (probKey && s.conviction && s.conviction[probKey] != null) ? s.conviction[probKey] : s.master;
    const cc = convColour(masterVal);
    const blockChips = BLOCKS.map(b => {
      const z = s.blockZ[b];
      return `<span class="bchip" style="color:${zColour(z)}" title="${BLOCK_LABEL[b]} z-score">${BLOCK_LABEL[b]} ${z > 0 ? '+' : ''}${z}</span>`;
    }).join('');
    const scr = (s.screeners || []).map(id => `<span class="scr">${SCREENER_LABEL[id] || id}</span>`).join('');
    const why = (s.why || []).map(w => `<span class="why" style="border-color:${zColour(w.z)}55;color:${zColour(w.z)}" title="${esc(w.label)} (z ${w.z})">${esc(w.label)}</span>`).join('');
    const plan = s._plan;
    const planHtml = renderPlanHtml(plan, probKey);
    const prob = Math.round(probOf(s) * 100);
    const pivot = s.raw && s.raw.pivot;
    const atrPct = s.raw && s.raw.atrPct;
    let rowMeta = ` data-ticker="${esc(s.ticker)}" data-horizon="${esc(probKey || 'positional')}"`;
    if (pivot != null) {
      rowMeta += ` data-pivot="${pivot}" data-plan-kind="breakout"${atrPct != null ? ` data-atr-pct="${atrPct}"` : ''}`;
    } else if (plan && plan.kind === 'fallback') {
      rowMeta += ` data-fallback="1" data-plan-kind="fallback"${atrPct != null ? ` data-atr-pct="${atrPct}"` : ''}`;
    }
    return `<tr${rowMeta}>
      <td class="num dim">${i + 1}</td>
      <td>
        <div class="name-row">
          <a class="stock-link" href="${url}" target="_blank" rel="noopener">${esc(s.name)}</a>
          ${stockActions.buttonsHtml({ ticker: s.ticker, name: s.name, price: s.price || 0 })}
        </div>
        <div class="ticker-sub">${esc(s.ticker)}${s.sector ? ' · ' + esc(s.sector) : ''}</div>
        <div class="scr-row">${scr} ${setupBadgeHtml(plan)}</div>
      </td>
      <td class="num price-cell" data-price-cell>${fmtPrice(s.price)}</td>
      <td class="num dim">${s.marketCap ? fmtCr(s.marketCap) : '—'}</td>
      <td class="num"><span class="prob" title="Calibrated probability of beating Nifty over ~20 trading days">${prob}%</span></td>
      <td class="conv-cell">
        <div class="conv-bar-wrap"><div class="conv-bar" style="width:${masterVal}%;background:${cc}"></div></div>
        <div class="conv-nums"><span style="color:${cc};font-weight:800">${masterVal}</span><span class="dim">/100</span></div>
      </td>
      <td class="blocks">${blockChips}</td>
      <td class="drivers">${why || '<span class="dim">—</span>'}</td>
      <td class="planwrap">${planHtml}</td>
    </tr>`;
  }).join('');
}

function tabTable(id, list, regime, tickerUrls, hidden, probKey, rankHint) {
  const hint = rankHint || 'Stack rank — highest Win Prob first';
  return `<div id="tab-${id}"${hidden ? ' class="hidden"' : ''}>
    <div class="ctrl"><input type="text" class="search" id="search-${id}" placeholder="Search ticker / name / sector…" oninput="filt('${id}')"><span class="note" id="note-${id}">${list.length} stocks · ${hint}</span></div>
    <div class="twrap"><table id="tbl-${id}">
      <thead><tr>
        <th class="num" title="${hint}">#</th><th>Stock</th><th class="num">LTP</th><th class="num">Mkt Cap</th>
        <th class="num">Win&nbsp;Prob</th><th class="num">Master</th><th>Factor z-scores</th><th>Top Drivers</th><th>Trade Plan</th>
      </tr></thead>
      <tbody id="tb-${id}">${buildRows(list, regime, tickerUrls, probKey)}</tbody>
    </table></div>
  </div>`;
}

function buildHtml({ overall, actionable, swing, positional, long, lowrisk }, ctx, regime, macro, tickerUrls) {
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
.setup-badge{font-size:.58rem;font-weight:700;padding:1px 6px;border-radius:4px;border:1px solid;white-space:nowrap}
.setup-ready{color:#86efac;border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.1)}
.setup-pending{color:#fde68a;border-color:rgba(234,179,8,.35);background:rgba(234,179,8,.1)}
.setup-fallback{color:#93c5fd;border-color:rgba(96,165,250,.35);background:rgba(96,165,250,.1)}
.setup-none{color:var(--t3);border-color:rgba(100,116,139,.3);background:rgba(100,116,139,.08)}
.conv-cell{min-width:120px}
.conv-bar-wrap{height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden}
.conv-bar{height:100%;border-radius:3px}
.conv-nums{margin-top:3px;font-size:.85rem;display:flex;gap:2px;justify-content:flex-end;align-items:baseline}
.prob{font-weight:700}
.blocks{white-space:nowrap}
.bchip{display:inline-block;font-size:.66rem;font-weight:700;padding:1px 5px;margin:1px;border-radius:4px;background:var(--s3);font-variant-numeric:tabular-nums}
.drivers{white-space:normal;min-width:170px}
.why{display:inline-block;font-size:.62rem;font-weight:600;padding:1px 6px;margin:1px;border-radius:4px;border:1px solid}
.plan.dim{color:var(--t3);font-size:.75rem}
.plan-grid{display:grid;gap:3px;font-size:.72rem;font-variant-numeric:tabular-nums;min-width:185px}
.plan-row{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.plan-lbl{color:var(--t3);font-size:.65rem;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
.plan-val{font-weight:600;color:var(--tx)}
.plan-val.now{color:#60a5fa}
.plan-val.entry{color:#eab308}
.plan-val.stop{color:#ef4444}
.plan-val.exit{color:#22c55e}
.plan-hint{font-size:.6rem;font-weight:500;color:var(--t3)}
.plan-highlight{margin-top:1px;padding:3px 0;border-top:1px dashed rgba(255,255,255,.08)}
.plan-val.gain{color:#4ade80;font-weight:800;font-size:.78rem}
.plan-val.time{color:#c4b5fd;font-weight:700}
.plan-meta{margin-top:2px;font-size:.62rem;color:var(--t3)}
.planwrap{min-width:190px}
.price-cell.live-flash{color:#60a5fa}
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
    <div class="subtitle">Self-improving, macro-aware blend of every screener &nbsp;·&nbsp; <span style="color:var(--ac)">Generated ${genTime} IST</span><span id="live-price-ts" class="dim"></span></div>
  </div>
  <div class="header-right">${navLinks}</div>
</div>

<div class="context">
  <span class="ctx-pill">Market: <b>${regimeLabel}</b></span>
  <span class="ctx-pill">Macro: <b>${macroBadge}</b></span>
  <span class="ctx-pill">Tilt: <b>${esc(ctx.tilt)}</b></span>
  <span class="ctx-pill">Risk scale: <b>${ctx.riskScale}×</b></span>
  <span class="ctx-pill">Rank: <b>Win Prob ↓</b></span>
  <span class="ctx-pill">${overall.length} ranked</span>
</div>

<div class="tabs">
  <button class="tab-btn active" id="tb-btn-overall" onclick="tab('overall')">🏆 Best Overall <span>${overall.length}</span></button>
  <button class="tab-btn" id="tb-btn-actionable" onclick="tab('actionable')">🎯 Actionable <span>${actionable.length}</span></button>
  <button class="tab-btn" id="tb-btn-swing" onclick="tab('swing')">⚡ Swing <span>${swing.length}</span></button>
  <button class="tab-btn" id="tb-btn-positional" onclick="tab('positional')">📈 Positional <span>${positional.length}</span></button>
  <button class="tab-btn" id="tb-btn-long" onclick="tab('long')">💎 Long-term <span>${long.length}</span></button>
  <button class="tab-btn" id="tb-btn-lowrisk" onclick="tab('lowrisk')">🛡️ Low-risk <span>${lowrisk.length}</span></button>
</div>

${tabTable('overall', overall, regime, tickerUrls, false, 'positional')}
${tabTable('actionable', actionable, regime, tickerUrls, true, 'positional', 'Win Prob ↓ · trade plan required')}
${tabTable('swing', swing, regime, tickerUrls, true, 'swing')}
${tabTable('positional', positional, regime, tickerUrls, true, 'positional')}
${tabTable('long', long, regime, tickerUrls, true, 'long')}
${tabTable('lowrisk', lowrisk, regime, tickerUrls, true, 'positional')}

<div class="panels">
  ${featureLabHtml}
  ${statsHtml}
</div>

${stockActions.bannerHtml}
${stockActions.modalHtml}
${stockActions.researchModalHtml}

<div class="footer">
  🏆 Best Picks · Master Signal &nbsp;·&nbsp; Conviction blends Momentum / Technical / Quality / Value / Conviction, regime- and macro-weighted, win-probability calibrated on realized outcomes.<br>
  Trade plans: <b>Breakout</b> (pivot + ATR from Breakout2) or <b>Positional</b> (estimated stop from ATR / 8% when no pivot). Use the <b>Actionable</b> tab for highest Win Prob picks with a plan.<br>
  <strong>Not investment advice. Do your own research.</strong>
</div>

<script>
function tab(id){
  ['overall','actionable','swing','positional','long','lowrisk'].forEach(function(t){
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
var PLAN_CFG={stopAtrMult:${SIG_DEF.stopAtrMult},targetRRMult:${SIG_DEF.targetRRMult},fallbackStopPct:${FALLBACK_STOP_PCT}};
function fmtPx(v){return typeof v==='number'?'₹'+v.toLocaleString('en-IN',{maximumFractionDigits:2}):'—';}
function computePlan(current,pivot,atrPct){
  if(current==null||pivot==null)return null;
  var atrAbs=(atrPct!=null&&atrPct>0)?(atrPct/100)*current:current*0.04;
  var entry=current>=pivot?current:pivot;
  var stop=+(pivot-PLAN_CFG.stopAtrMult*atrAbs).toFixed(2);
  if(stop<=0||stop>=entry)return null;
  var risk=entry-stop;
  var target=+(entry+PLAN_CFG.targetRRMult*risk).toFixed(2);
  var rr=+((target-entry)/risk).toFixed(2);
  var riskPct=+((risk/entry)*100).toFixed(2);
  return{current:current,entry:entry,stop:stop,target:target,rr:rr,riskPct:riskPct,pending:current<pivot,kind:'breakout'};
}
function computeFallbackPlan(current,atrPct){
  if(current==null)return null;
  var stopPct=(atrPct!=null&&atrPct>0)?Math.min(Math.max(2*atrPct,5),12):PLAN_CFG.fallbackStopPct;
  var entry=current;
  var stop=+(entry*(1-stopPct/100)).toFixed(2);
  if(stop<=0||stop>=entry)return null;
  var risk=entry-stop;
  var target=+(entry+PLAN_CFG.targetRRMult*risk).toFixed(2);
  var rr=+((target-entry)/risk).toFixed(2);
  return{current:current,entry:entry,stop:stop,target:target,rr:rr,riskPct:stopPct,pending:false,kind:'fallback',stopPct:stopPct};
}
function planKindLbl(plan){
  if(!plan)return'';
  if(plan.kind==='breakout')return plan.pending?'Breakout · wait':'Breakout';
  return 'Positional · est. '+(plan.stopPct||PLAN_CFG.fallbackStopPct)+'% stop';
}
var TF_MAP={swing:{label:'~2–5 wks',detail:'10–25 trading days'},positional:{label:'~4–10 wks',detail:'20–50 trading days'},long:{label:'~3–6 mo',detail:'60–120 trading days'}};
function planTf(plan,horizon){
  if(plan&&plan.kind==='breakout')return{label:'~2–5 wks',detail:'10–25 trading days (swing breakout)'};
  return TF_MAP[horizon]||TF_MAP.positional;
}
function renderPlanEl(el,plan,horizon){
  if(!plan){el.innerHTML='<div class="plan dim">—</div>';return;}
  var hint=plan.pending?' <span class="plan-hint">@ pivot</span>':'';
  var upside=+(((plan.target-plan.entry)/plan.entry)*100).toFixed(1);
  var fromNow=(plan.current!=null&&plan.current>0)?+(((plan.target-plan.current)/plan.current)*100).toFixed(1):upside;
  var gainHint=(plan.pending&&Math.abs(fromNow-upside)>0.05)?' <span class="plan-hint">('+(fromNow>0?'+':'')+fromNow+'% from LTP)</span>':'';
  var tf=planTf(plan,horizon||'positional');
  el.innerHTML='<div class="plan-grid" data-plan-cell>'
    +'<div class="plan-row"><span class="plan-lbl">Current</span><span class="plan-val now" data-plan-now>'+fmtPx(plan.current)+'</span></div>'
    +'<div class="plan-row"><span class="plan-lbl">Entry</span><span class="plan-val entry" data-plan-entry>'+fmtPx(plan.entry)+hint+'</span></div>'
    +'<div class="plan-row"><span class="plan-lbl">Stop Loss</span><span class="plan-val stop" data-plan-stop>'+fmtPx(plan.stop)+'</span></div>'
    +'<div class="plan-row"><span class="plan-lbl">Exit</span><span class="plan-val exit" data-plan-exit>'+fmtPx(plan.target)+'</span></div>'
    +'<div class="plan-row plan-highlight" title="Expected move from entry to exit target"><span class="plan-lbl">Target gain</span><span class="plan-val gain" data-plan-gain">+'+upside+'%'+gainHint+'</span></div>'
    +'<div class="plan-row plan-highlight" title="'+tf.detail+'"><span class="plan-lbl">Timeframe</span><span class="plan-val time" data-plan-time>'+tf.label+'</span></div>'
    +'<div class="plan-meta">'+planKindLbl(plan)+' · '+plan.rr+'R · '+plan.riskPct+'% risk</div></div>';
}
function refreshLivePrices(){
  fetch('./live-prices.json?_='+Date.now())
    .then(function(r){return r.ok?r.json():null;})
    .then(function(lp){
      if(!lp||!lp.prices)return;
      var n=0;
      document.querySelectorAll('tr[data-ticker]').forEach(function(row){
        var d=lp.prices[row.getAttribute('data-ticker')];
        if(!d||d.p==null)return;
        var pc=row.querySelector('[data-price-cell]');
        if(pc){pc.textContent=fmtPx(d.p);pc.classList.add('live-flash');}
        var planWrap=row.querySelector('.planwrap');
        var atrPct=parseFloat(row.getAttribute('data-atr-pct'));
        var plan=null;
        if(row.getAttribute('data-fallback')==='1'){
          plan=computeFallbackPlan(d.p,isNaN(atrPct)?null:atrPct);
        }else{
          var pivot=parseFloat(row.getAttribute('data-pivot'));
          if(!isNaN(pivot))plan=computePlan(d.p,pivot,isNaN(atrPct)?null:atrPct);
        }
        if(planWrap&&plan)renderPlanEl(planWrap,plan,row.getAttribute('data-horizon'));
        row.querySelectorAll('[data-alert-price]').forEach(function(b){b.setAttribute('data-alert-price',d.p);});
        row.querySelectorAll('[data-r-price]').forEach(function(b){b.setAttribute('data-r-price',d.p);});
        n++;
      });
      var tsEl=document.getElementById('live-price-ts');
      if(tsEl&&lp.ts)tsEl.textContent=' · Live '+new Date(lp.ts).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'})+' IST';
      if(n&&tsEl)tsEl.style.color='#60a5fa';
    }).catch(function(){});
}
setTimeout(refreshLivePrices,800);
setInterval(refreshLivePrices,5*60*1000);
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

  // Overlay live LTP for display + trade plans (scores use EOD snapshot from sidecars).
  const livePrices = loadLivePrices();
  let liveN = 0;
  for (const s of stocks) {
    const live = livePrices[s.ticker];
    if (live && typeof live.p === 'number') { s.price = live.p; liveN++; }
  }
  if (liveN) console.log(`  Live prices: ${liveN} tickers from live-prices.json`);

  // attach trade plans
  for (const s of stocks) s._plan = tradePlan(s, regime);

  const byWinProb = (h) => stocks.slice().sort((a, b) => {
    const pa = (a.winProbByHorizon && a.winProbByHorizon[h]) ?? a.winProb ?? 0;
    const pb = (b.winProbByHorizon && b.winProbByHorizon[h]) ?? b.winProb ?? 0;
    return (pb - pa) || ((b.conviction[h] || 0) - (a.conviction[h] || 0)) || (b.master - a.master);
  });
  const overall = byWinProb('positional').slice(0, 150);
  const actionable = byWinProb('positional').filter(s => s._plan != null).slice(0, 80);
  const swing = byWinProb('swing').slice(0, 80);
  const positional = byWinProb('positional').slice(0, 80);
  const long = byWinProb('long').slice(0, 80);
  const lowrisk = stocks.slice()
    .filter(s => s.raw && s.raw.atrPct != null && s.raw.atrPct <= 4)
    .sort((a, b) => (b.winProb || 0) - (a.winProb || 0) || (b.conviction.positional - a.conviction.positional))
    .slice(0, 80);

  const tuPath = path.join(__dirname, 'ticker-urls.json');
  const tickerUrls = fs.existsSync(tuPath) ? JSON.parse(fs.readFileSync(tuPath, 'utf8')) : {};

  if (!fs.existsSync(path.join(__dirname, 'docs'))) fs.mkdirSync(path.join(__dirname, 'docs'));
  fs.writeFileSync(OUTPUT_PATH, buildHtml({ overall, actionable, swing, positional, long, lowrisk }, ctx, regime, macro, tickerUrls), 'utf8');
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
      extras: { winProb: s.winProb, blockZ: s.blockZ, screeners: s.screeners, conviction: s.conviction, planKind: s._plan ? s._plan.kind : null },
    }));
    const lg = appendOutcomes(rows);
    console.log(`  Outcomes (bestpicks): +${lg.added} added (${lg.skipped} skipped, ${lg.total} total)`);

    // Idempotent: only append today's point-in-time snapshot once.
    let alreadyLogged = false;
    try { alreadyLogged = fs.existsSync(FHIST_PATH) && fs.readFileSync(FHIST_PATH, 'utf8').includes(`"date":"${date}"`); } catch { /* ignore */ }
    if (alreadyLogged) {
      console.log('  Feature history: today already logged — skipping append.');
    } else {
      // HOLDOUT SLICE: also log a random sample of NON-picked stocks. Feature ICs
      // estimated only on the model's own selections are range-restricted (a feature
      // that drives selection has its variance truncated => attenuated IC => wrong
      // demotion). Logging rejected names lets feature-lab measure real edge.
      // Seeded by date so same-day reruns pick the same holdout.
      const pickedSet = new Set(actionable.map(s => s.ticker));
      const rejected = stocks.filter(s => !pickedSet.has(s.ticker) && s.feat);
      let seed = 0; for (const ch of date) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
      const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const shuffled = rejected.slice().sort(() => rand() - 0.5);
      const holdout = shuffled.slice(0, Math.min(40, shuffled.length));

      const histLines = [
        ...actionable.map(s => JSON.stringify({ date, ticker: s.ticker, master: s.master, winProb: s.winProb, picked: true, feat: s.feat })),
        ...holdout.map(s => JSON.stringify({ date, ticker: s.ticker, master: s.master, winProb: s.winProb, picked: false, feat: s.feat })),
      ].join('\n');
      if (histLines) fs.appendFileSync(FHIST_PATH, histLines + '\n');
      console.log(`  Feature history: +${actionable.length} picked +${holdout.length} holdout -> feature-history.jsonl`);

      // Holdout outcomes must also be labeled — log them to the ledger under a
      // dedicated screener name so validate-screeners fills their forward returns
      // but no live weight ever trains on "bestpicks" rows it didn't pick.
      const holdoutRows = holdout.map(s => ({
        date, screener: 'bestpicks-holdout', signalType: 'HOLDOUT',
        ticker: s.ticker, name: s.name || s.ticker, sector: s.sector || null,
        entry: s.price || null, score: s.master,
        regime: regime.isBearMarket ? 'BEAR' : 'BULL',
      }));
      const hg = appendOutcomes(holdoutRows);
      console.log(`  Outcomes (holdout): +${hg.added} added`);
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

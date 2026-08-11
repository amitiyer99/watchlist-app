'use strict';

const { HUB_BACK_LINK } = require('./lib/hub-nav');
const stockActions = require('./lib/stock-actions');
const { getMult } = require('./lib/weights');
const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');
const { loadDeals } = require('./lib/smartmoney');
const { aggregate: aggregateInst } = require('./lib/institutions');
const { loadLivePrices } = require('./lib/live-prices');
const EX_MOD = require('./lib/exchange');
const EXT = require('./lib/extension');
const fs   = require('fs');
const path = require('path');

// Institutional (FII/DII) overlay window — match the FII/DII page (90d quarter).
const INST_WINDOW_DAYS = 90;
// Moderate, bounded USS boost when smart money is also accumulating the name.
// BOTH (FII + DII buying) outranks a single-side buy; clamped so it nudges, not dominates.
const INST_USS_BONUS = { BOTH: 8, FII: 4, DII: 4 };

// Map confluence source ids -> outcome-ledger screener keys (only these have stats).
const SRC_STATS_KEY = { breakout: 'breakout2', apex: 'apex' };

const OUTPUT_PATH = path.join(__dirname, 'docs', 'confluence.html');

// ── Screener registry ─────────────────────────────────────────────────────────
// Confluence now reads `breakout2-data.json` (full NSE top-800 universe, RS percentile,
// pivot/ATR/breakoutValid/volSurge) instead of the v1 watchlist-only sidecar. Falls back
// to breakout-tickers.json if the gen2 sidecar is missing so old deploys keep working.
const SCREENERS = [
  { id: 'indianresearch', label: '🇮🇳 India Research', colour: '#f97316', bg: 'rgba(249,115,22,.15)', file: 'indianresearch-tickers.json', minScore: 0 },
  { id: 'apex',           label: '🔮 APEX Scout',      colour: '#6366f1', bg: 'rgba(99,102,241,.15)',  file: 'apex-tickers.json',          minScore: 0 },
  { id: 'creamy',         label: '🍦 Creamy Layer',    colour: '#22c55e', bg: 'rgba(34,197,94,.15)',   file: 'creamy-tickers.json',        minScore: 0 },
  { id: 'breakout',       label: '📈 Breakout GEN2',   colour: '#06b6d4', bg: 'rgba(6,182,212,.15)',   file: 'breakout2-data.json',        fallback: 'breakout-tickers.json', minScore: 40 },
  { id: 'multibagger',    label: '🏆 Multibagger',     colour: '#f59e0b', bg: 'rgba(245,158,11,.15)',  file: 'multibagger-tickers.json',   minScore: 40 },
  { id: 'rocket',         label: '🚀 Rocket',           colour: '#a855f7', bg: 'rgba(168,85,247,.15)',  file: 'rocket-tickers.json',        minScore: 40 },
  { id: 'screenerin',     label: '📊 Screener.in',      colour: '#0ea5e9', bg: 'rgba(14,165,233,.15)',  file: 'screenerin-tickers.json',    minScore: 0 },
  { id: 'marquee',        label: '⭐ Marquee',          colour: '#ec4899', bg: 'rgba(236,72,153,.15)',  file: 'investors-tickers.json',     minScore: 0 },
];
const N_SCREENERS = SCREENERS.length;

function convictionTier(n) {
  if (n >= 6) return { label: '🏆 Perfect',     cls: 'cv5', colour: '#a855f7' };
  if (n >= 5) return { label: '🔥 Exceptional', cls: 'cv5', colour: '#ef4444' };
  if (n >= 4) return { label: '⚡ Strong',       cls: 'cv4', colour: '#f59e0b' };
  if (n >= 3) return { label: '📌 Noteworthy',  cls: 'cv3', colour: '#22c55e' };
  if (n >= 2) return { label: '👀 On Radar',     cls: 'cv2', colour: '#94a3b8' };
  return             { label: '🔍 Watching',     cls: 'cv1', colour: '#64748b' };
}

function convictionTierTip(n, total) {
  const T = total || 6;
  if (n >= 6) return `${n} of ${T} screeners independently flagged this stock — the strongest possible overlap signal.`;
  if (n >= 5) return `5 of ${T} screeners agree — extremely rare alignment across technical, fundamental and momentum methods.`;
  if (n >= 4) return `4 of ${T} screeners agree — high-conviction overlap, worth prioritising.`;
  if (n >= 3) return `3 of ${T} screeners agree — meaningful overlap, worth a closer look.`;
  if (n >= 2) return `2 of ${T} screeners agree — early signal, on the radar but not yet strong.`;
  return `Only 1 of ${T} screeners flagged this — lowest conviction tier, shown for visibility only.`;
}

const { esc, fmtPct: fmtPctBase, fmtPrice: fmtPriceBase } = require('./lib/format');
function fmt2(v) { return typeof v === 'number' ? v.toFixed(2) : '—'; }
// confluence shows percentages without a leading '+' and prices with variable decimals
const fmtPct = v => fmtPctBase(v, 1, { sign: false });
function fmtCr(v) { return typeof v === 'number' ? '₹' + Math.round(v).toLocaleString('en-IN') + ' Cr' : '—'; }
const fmtPrice = v => fmtPriceBase(v, { min: 0 });

// ── Load sidecars ─────────────────────────────────────────────────────────────
function loadSidecar(screener) {
  const candidates = [screener.file, screener.fallback].filter(Boolean);
  for (const name of candidates) {
    const fp = path.join(__dirname, 'docs', name);
    if (!fs.existsSync(fp)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (name !== screener.file) console.log(`  ↪  ${screener.label} fell back to ${name}`);
      // Most sidecars are bare arrays; some (e.g. screenerin) wrap rows in an object.
      return Array.isArray(data) ? data : (data.rows || data.stocks || []);
    } catch (e) { console.log(`  ⚠  Bad JSON: ${name}`); }
  }
  console.log(`  ⚠  Missing sidecar for ${screener.label} (looked for ${candidates.join(', ')})`);
  return [];
}

// ── Build ticker map ──────────────────────────────────────────────────────────
function buildMap(screenerData) {
  const map = new Map(); // ticker → merged record
  for (const [idx, screener] of SCREENERS.entries()) {
    const stocks = screenerData[idx];
    for (const s of stocks) {
      const t = (s.ticker || '').trim().toUpperCase();
      if (!t) continue;
      if (!map.has(t)) {
        map.set(t, {
          ticker: t,
          name: s.name || t,
          sector: s.sector || '',
          price: s.price,
          marketCap: s.marketCap,
          screeners: [],
        });
      }
      const rec = map.get(t);
      // prefer richer name/sector from non-breakout sources
      if (screener.id !== 'breakout' && s.name) rec.name = s.name;
      if (screener.id !== 'breakout' && s.sector) rec.sector = s.sector;
      if (s.price != null) rec.price = s.price;
      if (s.marketCap != null) rec.marketCap = s.marketCap;
      if (s.url) rec.url = s.url; // first non-empty url wins
      // carry screener.in fields onto the stock so buildExtra can render metrics
      if (screener.id === 'screenerin') { rec.screens = s.screens; rec.screenCount = s.screenCount; rec.metrics = s.metrics; rec.fundamental = true; }
      rec.screeners.push({ id: screener.id, label: screener.label, colour: screener.colour, bg: screener.bg, score: s.score, extra: buildExtra(screener.id, s),
        convergence: s.convergence, action: s.action, vcpPass: s.vcpPass, stage2: s.stage2, promoterHolding: s.promoterHolding,
        screens: s.screens, screenCount: s.screenCount, metrics: s.metrics });
    }
  }
  return map;
}

function buildExtra(id, s) {
  if (id === 'indianresearch') return `ROE ${fmtPct(s.roe)} · EPS5Y ${fmtPct(s.epsGrowth5Y)} · D/E ${fmt2(s.debtEquity)}`;
  if (id === 'apex')           return `${s.tier || ''} · ${s.action || ''} ${s.convergence ? '· ✨ Convergence' : ''}`.replace(/^·\s*/,'').replace(/\s*·\s*$/,'');
  if (id === 'creamy')         return `Score ${s.score || 0}/100`;
  if (id === 'breakout')       return `${s.tag || ''} ${s.vcpPass ? '· VCP✓' : ''} ${s.stage2 ? '· Stage2✓' : ''}`.trim();
  if (id === 'multibagger')    return (s.badges && s.badges.length
                                          ? s.badges.slice(0,2).map(b => typeof b === 'string' ? b : `${b.icon || ''} ${b.label || ''}`.trim()).join(' · ')
                                          : `MBF ${s.score || 0}`);
  if (id === 'rocket')         return `${s.tier || ''} · RS ${s.rsRating || '—'} ${s.stage2 ? '· Stage2✓' : ''}`.replace(/^·\s*/,'').trim();
  if (id === 'screenerin') {
    const m = s.metrics || {};
    const bits = [];
    if (s.screenCount) bits.push(`In ${s.screenCount} of your screen(s): ${(s.screens || []).join(', ')}`);
    if (m.roce != null) bits.push(`ROCE ${fmt2(m.roce)}%`);
    if (m.pe != null) bits.push(`P/E ${fmt2(m.pe)}`);
    if (m.salesGrowth != null) bits.push(`Sales gr ${fmt2(m.salesGrowth)}%`);
    if (m.debtEquity != null) bits.push(`D/E ${fmt2(m.debtEquity)}`);
    return bits.join(' · ') || 'Screener.in';
  }
  if (id === 'marquee') {
    const names = (s.investors || []).map(i => `${i.name.split(' (')[0]} ${i.pct}%${i.trend === 'ADDED' ? '▲' : i.trend === 'NEW' ? '★' : ''}`);
    return `${s.count || 0} marquee investor(s)${s.adds ? ` · ${s.adds} added` : ''}: ${names.join(', ')}`;
  }
  return '';
}

// ── USS (Unified Signal Score) ───────────────────────────────────────────────
// Each screener score is converted to a percentile rank within its own universe,
// then averaged and multiplied by a conviction bonus for appearing in multiple screeners.
// Formula: USS = (avg_adjusted_pct × conviction_bonus) / 320 × 100  (0–100)
const CONVICTION_BONUS = [1.0, 1.4, 1.9, 2.5, 3.2, 4.0]; // index = screenerCount - 1
const USS_MAX_RAW = 400; // 100 × max_bonus(4.0)

function ussColour(v) {
  if (v >= 70) return '#a855f7';
  if (v >= 50) return '#ef4444';
  if (v >= 35) return '#f59e0b';
  if (v >= 20) return '#22c55e';
  return '#94a3b8';
}

function computeUSS(stocks, screenerData) {
  // Step 1: build percentile lookup per screener (sort asc → rank / (n-1) * 100)
  const pctMaps = {};
  for (const [idx, screener] of SCREENERS.entries()) {
    const sorted = screenerData[idx].slice().sort((a, b) => (a.score || 0) - (b.score || 0));
    const n = sorted.length;
    const m = new Map();
    sorted.forEach((s, i) => {
      const t = (s.ticker || '').trim().toUpperCase();
      const pct = n > 1 ? (i / (n - 1)) * 100 : 100;
      if (!m.has(t) || m.get(t) < pct) m.set(t, pct);
    });
    pctMaps[screener.id] = m;
  }
  // Step 2: attach pct/adjPct/pctBonus to each screener entry, then compute USS.
  // Adaptive layer: each source screener's contribution is weighted by its realized
  // reliability multiplier (from lib/weights), so screeners that actually worked pull
  // USS up; the whole score is then scaled by confluence's own edge. All clamped.
  const convMult = getMult('confluence', '*', 1);
  const extMap = EXT.loadPivotExtensionMap();   // ticker -> % above pivot (from breakout2)
  for (const s of stocks) {
    let totalAdj = 0, weightSum = 0;
    for (const sc of s.screeners) {
      const rawPct = pctMaps[sc.id] ? (pctMaps[sc.id].get(s.ticker) || 0) : 0;
      let bonus = 0;
      if (sc.id === 'apex'           && sc.convergence)                 bonus += 5;
      if (sc.id === 'apex'           && sc.action === 'BUY')            bonus += 3;
      if (sc.id === 'breakout'       && sc.vcpPass && sc.stage2)        bonus += 5;
      if (sc.id === 'indianresearch' && (sc.promoterHolding || 0) > 65) bonus += 3;
      sc.pct      = Math.round(rawPct);
      sc.adjPct   = Math.min(100, Math.round(rawPct + bonus));
      sc.pctBonus = bonus;
      const srcMult = getMult(SRC_STATS_KEY[sc.id] || sc.id, '*', 1);
      sc.relWeight  = +srcMult.toFixed(3);
      totalAdj     += sc.adjPct * srcMult;
      weightSum    += srcMult;
    }
    const n      = s.screeners.length;
    const avgAdj = weightSum > 0 ? totalAdj / weightSum : 0;
    const raw    = avgAdj * CONVICTION_BONUS[Math.min(n - 1, 5)] * convMult;
    const base   = Math.min(100, Math.round(raw / USS_MAX_RAW * 100));
    // Institutional overlay: if FIIs/DIIs are also buying (bulk/block deals), add a
    // moderate bounded bonus — smart-money confirmation on top of screener overlap.
    const instBonus = s.inst ? (INST_USS_BONUS[s.inst.tier] || 0) : 0;
    s.ussBase     = base;
    s.ussInstBonus = instBonus;
    // Over-extension penalty (validated pivot measure from breakout2 — see
    // lib/extension.js). score-lab showed USS carried NO ordering power (rank-corr
    // -0.085 => FLAT) while extension decayed alpha monotonically, so docking chased
    // names is the first change with an evidential basis behind it.
    const extPen = EXT.penaltyForTicker(s.ticker, extMap);
    s.ussExtPenalty = extPen;
    s.uss         = Math.max(0, Math.min(100, base + instBonus - extPen));
  }
}

// ── HTML builder ──────────────────────────────────────────────────────────────
function buildHtml(stocks, stats, generatedAt, tickerUrls) {
  const genTime = new Date(generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const { renderStatsSection } = require('./lib/stats-section');
  const screenerStatsHtml = renderStatsSection({ title: 'Screener Track Record (20-day forward return vs Nifty)' });

  // Filter tabs: All / 3+ / 4+ / 5 / microcap-only
  const allStocks  = stocks;
  const multi      = stocks.filter(s => s.screeners.length >= 2);
  const strong     = stocks.filter(s => s.screeners.length >= 3);
  const elite      = stocks.filter(s => s.screeners.length >= 4);
  // Microcap lane: mcap < 500 Cr, kept separate so it doesn't dilute the USS distribution
  // (microcap volatility skews percentile ranks for large-cap names).
  const microcap   = stocks.filter(s => s.marketCap != null && s.marketCap < 500);
  // Institutional lane: names where FIIs/DIIs are also buying (bulk/block deals).
  const inst       = stocks.filter(s => s.inst);

  const rows = (arr) => arr.map((s, i) => {
    const tier = convictionTier(s.screeners.length);
    const tierTip = convictionTierTip(s.screeners.length, N_SCREENERS);
    let chips = s.screeners.map(sc => {
      const tt = (sc.pct != null ? sc.pct : 0) + 'th percentile within ' + sc.label.replace(/^\S+\s/,'') + "'s own universe" + (sc.pctBonus ? ' (+' + sc.pctBonus + ' bonus for extra confirming signals → ' + sc.adjPct + ')' : '') + ' · ' + sc.extra;
      return `<span class="chip tip" tabindex="0" data-screener="${sc.id}" style="background:${sc.bg};color:${sc.colour};border-color:${sc.colour}33" data-tip="${esc(tt)}">${esc(sc.label)}<span class="chip-score">${sc.score != null ? Math.round(sc.score) : ''}</span></span>`;
    }).join('');
    // Institutional (FII/DII) chip — smart-money buying from bulk/block deals.
    if (s.inst) {
      const iv = s.inst;
      const label = iv.tier === 'BOTH' ? 'FII+DII' : iv.tier;
      const names = [...(iv.fiiNames || []), ...(iv.diiNames || [])].slice(0, 4).join(', ');
      const itt = `Institutional buying (last ${INST_WINDOW_DAYS}d): ${iv.tier === 'BOTH' ? 'both FIIs and DIIs' : iv.tier + 's'} accumulated via bulk/block deals`
        + ` · ₹${iv.totalValueCr}Cr across ${iv.fiiBuys + iv.diiBuys} deal(s)`
        + (iv.fiiBuys ? ` · FII ₹${iv.fiiValueCr}Cr` : '') + (iv.diiBuys ? ` · DII ₹${iv.diiValueCr}Cr` : '')
        + (names ? ` · ${names}` : '') + ` · +${INST_USS_BONUS[iv.tier] || 0} Signal Score`;
      chips += `<span class="chip inst-chip tip" tabindex="0" data-inst="1" style="background:rgba(20,184,166,.15);color:#14b8a6;border-color:#14b8a666" data-tip="${esc(itt)}">🏦 ${esc(label)}<span class="chip-score">₹${Math.round(iv.totalValueCr)}Cr</span></span>`;
    }
    const stockUrl = s.url || (tickerUrls && tickerUrls[s.ticker]) || `https://www.tickertape.in/stocks/${esc(s.ticker)}`;
    const uc  = ussColour(s.uss || 0);
    const utt = 'Signal Score: ' + (s.uss || 0) + '/100 — percentile rank of each screener\'s score, averaged and boosted for appearing in more screeners. ' + s.screeners.map(function(sc) {
      return sc.label + ': ' + (sc.pct || 0) + 'th pct' + (sc.pctBonus ? ' +' + sc.pctBonus + '→' + sc.adjPct : '');
    }).join(' | ') + (s.ussInstBonus ? ' | 🏦 +' + s.ussInstBonus + ' institutional (' + s.inst.tier + ' buying)' : '');
    return `<tr>
      <td class="num dim">${i + 1}</td>
      <td>
        <div class="stock-cell">
          <div>
            <span class="name-row">
              <a class="stock-link" href="${esc(stockUrl)}" target="_blank" rel="noopener">${esc(s.name)}</a>
              ${stockActions.buttonsHtml({ ticker: s.ticker, name: s.name, price: s.price || 0 })}
            </span>
            <div class="ticker-sub">${esc(s.ticker)}${s.sector ? ' · ' + esc(s.sector) : ''}</div>
          </div>
        </div>
      </td>
      <td class="num">${fmtPrice(s.price)}</td>
      <td class="num">${s.marketCap ? fmtCr(s.marketCap) : '—'}</td>
      <td class="uss-cell" data-sort="${s.uss || 0}">
        <div class="uss-bar-wrap"><div class="uss-bar" style="width:${s.uss || 0}%;background:${uc}"></div></div>
        <div class="uss-nums"><span class="uss-val tip" tabindex="0" data-tip="${esc(utt)}" style="color:${uc}">${s.uss || 0}</span><span class="uss-max">/100</span></div>
        <div class="uss-cv"><span class="cv-badge tip ${tier.cls}" tabindex="0" data-tip="${esc(tierTip)}" style="color:${tier.colour};border-color:${tier.colour}44">${esc(tier.label)}</span><span class="cv-count">${s.screeners.length}/${N_SCREENERS}</span></div>
      </td>
      <td class="chips-cell">${chips}</td>
    </tr>`;
  }).join('');

  const tabSection = (id, label, arr, active) => `
  <button class="tab-btn${active ? ' active' : ''}" id="tab-btn-${id}" onclick="switchTab('${id}')">${esc(label)} <span class="tab-count" id="cnt-${id}">${arr.length}</span></button>`;

  const tableSection = (id, arr, hidden) => `
<div id="tab-${id}"${hidden ? ' class="hidden"' : ''}>
  <div class="controls-bar">
    <input type="text" class="search-box" id="search-${id}" placeholder="Search ticker, name or sector…" oninput="filterTable('${id}')">
    <div class="filter-chips">
      <button class="fc-btn fc-all active" data-tab="${id}" onclick="clearScreeners('${id}')">All</button>
      ${SCREENERS.map(sc => `<button class="fc-btn" data-screener="${sc.id}" data-tab="${id}" onclick="toggleScreener('${id}','${sc.id}')" style="background:${sc.bg};color:${sc.colour};border-color:${sc.colour}44">${esc(sc.label)}</button>`).join('')}
    </div>
    <span class="ctrl-note" id="note-${id}">${arr.length} stocks</span>
  </div>
  <div class="table-wrap" id="wrap-${id}">
    <table id="tbl-${id}">
      <thead><tr>
        <th class="num" onclick="sortTable('${id}',0,true)"># <span class="arr">↕</span></th>
        <th onclick="sortTable('${id}',1,false)"><span class="tip" tabindex="0" data-tip="Ticker, company name and sector.">Stock</span> <span class="arr">↕</span></th>
        <th class="num" onclick="sortTable('${id}',2,true)"><span class="tip" tabindex="0" data-tip="Latest price from the live feed (live-prices.json), refreshed each market-refresh; falls back to the screener sidecar price if a ticker isn't in the feed.">Price</span> <span class="arr">↕</span></th>
        <th class="num" onclick="sortTable('${id}',3,true)"><span class="tip" tabindex="0" data-tip="Market capitalisation in ₹ Crore. Stocks under ₹500 Cr are broken out into the separate Microcap tab since their volatility skews percentile ranks for large-caps.">Market Cap</span> <span class="arr">↕</span></th>
        <th class="num sorted" onclick="sortTable('${id}',4,true)"><span class="tip" tabindex="0" data-tip="0-100: each screener's score is converted to a percentile within its own universe, averaged (weighted by each screener's realized reliability), then multiplied by a bonus for appearing in more screeners at once.">Signal Score</span> <span class="arr">↓</span></th>
        <th><span class="tip" tabindex="0" data-tip="One chip per screener that flagged this stock. Hover a chip for its percentile rank and underlying metrics.">Screener Signals</span></th>
      </tr></thead>
      <tbody id="tbody-${id}">${rows(arr)}</tbody>
    </table>
  </div>
</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal Confluence · Multi-Screener Overlay</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100vh;overflow-x:hidden}
:root{
  --bg:#0a0a0f;--s1:#0f0f17;--s2:#13131e;--s3:#1a1a28;
  --tx:#e2e8f0;--t2:#94a3b8;--t3:#64748b;
  --ac:#8b5cf6;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;
  --bd:rgba(139,92,246,.18);--hdr-bg:rgba(10,10,15,.92);
  --row-hover:rgba(139,92,246,.07);--card-border:rgba(255,255,255,.06);
  --h-hdr:84px;--h-tabs:49px;--h-ctrl:60px;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);line-height:1.5;min-height:100vh}
/* ── Header ── */
.header{background:var(--hdr-bg);border-bottom:1px solid var(--bd);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.25rem;font-weight:800;background:linear-gradient(135deg,#a78bfa,#8b5cf6,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.subtitle{font-size:.72rem;color:var(--t2);margin-top:3px}
.header-right{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}
.back-link{padding:5px 10px;border-radius:6px;border:1px solid var(--bd);color:var(--t2);text-decoration:none;font-size:.74rem;font-weight:500;transition:all .2s;white-space:nowrap}
.back-link:hover{color:var(--tx);border-color:var(--ac);background:rgba(139,92,246,.1)}
/* ── Stats bar ── */
.stats-bar{display:flex;align-items:center;padding:14px 24px;background:var(--s1);border-bottom:1px solid var(--bd);gap:0;overflow-x:auto;flex-wrap:wrap}
.stat-item{display:flex;flex-direction:column;align-items:center;padding:8px 20px;border-right:1px solid var(--bd);min-width:100px}
.stat-item:last-child{border-right:none}
.stat-val{font-size:1.5rem;font-weight:800;color:var(--ac)}
.stat-lbl{font-size:.68rem;color:var(--t2);text-align:center;margin-top:2px}
/* ── Screener legend ── */
.legend{display:flex;gap:8px;padding:10px 24px;background:var(--s2);border-bottom:1px solid var(--bd);flex-wrap:wrap;align-items:center}
.legend-lbl{font-size:.68rem;color:var(--t3);margin-right:4px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.legend-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:5px;font-size:.68rem;font-weight:600;border:1px solid}
/* ── Tabs ── */
.tabs{display:flex;gap:6px;padding:14px 24px 0;background:var(--s1);border-bottom:1px solid var(--bd);position:sticky;top:var(--h-hdr);z-index:90}
.tab-btn{padding:9px 18px;border:1px solid var(--bd);border-bottom:none;border-radius:8px 8px 0 0;background:var(--s2);color:var(--t2);cursor:pointer;font-size:.84rem;font-family:inherit;font-weight:500;transition:all .2s;margin-bottom:-1px;display:flex;align-items:center;gap:6px}
.tab-btn.active{background:var(--bg);color:var(--tx);border-color:var(--bd);border-bottom:1px solid var(--bg);font-weight:700}
.tab-count{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;border-radius:10px;font-size:.68rem;font-weight:700;padding:0 6px;background:var(--s3);color:var(--t2)}
.tab-btn.active .tab-count{background:var(--ac);color:#fff}
/* ── Controls bar ── */
.controls-bar{display:flex;gap:8px;padding:10px 24px;background:var(--bg);border-bottom:1px solid var(--bd);align-items:center;flex-wrap:wrap;position:sticky;top:calc(var(--h-hdr) + var(--h-tabs));z-index:80}
.search-box{padding:7px 12px;border-radius:7px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.85rem;font-family:inherit;outline:none;width:200px;transition:border .2s}
.search-box:focus{border-color:var(--ac)}
.filter-chips{display:flex;gap:5px;flex-wrap:wrap}
.fc-btn{cursor:pointer;user-select:none;display:inline-flex;align-items:center;padding:3px 9px;border-radius:5px;font-size:.67rem;font-weight:600;border:1px solid;transition:opacity .2s,box-shadow .2s;opacity:.4;font-family:inherit}
.fc-btn.active{opacity:1;box-shadow:0 0 0 1px currentColor inset}
.fc-all{background:var(--s3);color:var(--t2);border-color:var(--card-border)}
.ctrl-note{font-size:.75rem;color:var(--t2);margin-left:auto;white-space:nowrap}
/* ── Table ── */
.table-wrap{overflow:auto;box-sizing:border-box;padding:0 24px 32px}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:.84rem}
thead{position:sticky;top:0;z-index:10}
th{background:var(--s1);color:var(--ac);font-weight:700;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;padding:12px 14px;text-align:left;border-bottom:2px solid var(--bd);cursor:pointer;white-space:nowrap;user-select:none;box-shadow:0 2px 4px rgba(0,0,0,.15)}
th:hover{color:var(--tx)}
th .arr{margin-left:3px;opacity:.4;font-size:.6rem}
th.sorted .arr{opacity:1}
td{padding:10px 14px;border-bottom:1px solid var(--card-border);white-space:nowrap;vertical-align:middle}
tr:hover td{background:var(--row-hover)}
.stock-cell{display:flex;align-items:flex-start;gap:8px}
.name-row{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px}
.stock-actions{display:inline-flex;align-items:center;gap:2px;margin-left:4px;flex-shrink:0}
.stock-link{color:var(--tx);text-decoration:none;font-weight:600;font-size:.87rem;display:block}
.stock-link:hover{color:var(--ac)}
.ticker-sub{color:var(--t2);font-size:.71rem;margin-top:1px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.dim{color:var(--t3)}
.chips-cell{white-space:normal;min-width:280px}
.chip{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border-radius:5px;font-size:.67rem;font-weight:600;border:1px solid;margin:2px 3px 2px 0;cursor:default;white-space:nowrap}
.chip-score{opacity:.7;font-weight:400;font-size:.62rem}
.cv-badge{display:inline-flex;align-items:center;padding:3px 7px;border-radius:5px;font-size:.68rem;font-weight:700;border:1px solid;margin-right:5px}
.cv-count{font-size:.72rem;color:var(--t2);font-variant-numeric:tabular-nums}
.cv5{background:rgba(168,85,247,.1)}
.cv4{background:rgba(239,68,68,.1)}
.cv3{background:rgba(245,158,11,.1)}
.cv2{background:rgba(34,197,94,.1)}
.cv1{background:rgba(148,163,184,.08)}
/* ── USS Score bar ── */
.uss-cell{text-align:right;min-width:130px;vertical-align:middle}
.uss-bar-wrap{height:5px;background:rgba(255,255,255,.08);border-radius:3px;margin-bottom:4px;overflow:hidden}
.uss-bar{height:100%;border-radius:3px}
.uss-nums{display:flex;align-items:baseline;justify-content:flex-end;gap:2px}
.uss-val{font-size:.9rem;font-weight:800;font-variant-numeric:tabular-nums}
.uss-max{font-size:.67rem;color:var(--t3)}
.uss-cv{margin-top:3px;display:flex;align-items:center;justify-content:flex-end;gap:4px}
.hidden{display:none!important}
/* ── Footer ── */
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.73rem;border-top:1px solid var(--bd);line-height:1.9}
@media(max-width:768px){
  .header{padding:12px 14px}.header h1{font-size:1rem}
  .header-right{gap:4px}
  .back-link{font-size:.67rem;padding:4px 7px}
  .stats-bar{padding:10px 14px}
  .legend,.tabs,.controls-bar{padding-left:14px;padding-right:14px}
  .table-wrap{padding:0 8px 16px}
  td,th{padding:8px 10px;font-size:.78rem}
}
${stockActions.css}
.name-row{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
${TOOLTIP_CSS}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>⚡ Signal Confluence · Multi-Screener Overlay</h1>
    <div class="subtitle">Stocks independently identified by multiple algorithms &nbsp;·&nbsp; <span style="color:var(--ac)">Generated: ${genTime} IST</span></div>
  </div>
  <div class="header-right">
    <button class="theme-toggle" id="theme-toggle" title="Toggle theme" style="background:none;border:1px solid var(--bd);border-radius:6px;padding:5px 8px;cursor:pointer;color:var(--t2);font-size:.8rem" onclick="toggleTheme()">☀️</button>
    <a href="bestpicks.html"        class="back-link" style="color:#c084fc;border-color:rgba(192,132,252,.55);font-weight:700">🏆 Best Picks</a>
    <a href="alerts.html"           class="back-link" style="color:#eab308;border-color:rgba(234,179,8,.4)">🔔 Alerts</a>
    <a href="multibagger.html"      class="back-link" style="color:#f59e0b;border-color:rgba(245,158,11,.4)">🏆 Multibagger</a>
    <a href="breakout2.html"        class="back-link" style="color:#06b6d4;border-color:rgba(6,182,212,.4)">⚡ Breakout GEN2</a>
    <a href="apex.html"             class="back-link" style="color:#6366f1;border-color:rgba(99,102,241,.4)">🔮 APEX</a>
    <a href="creamy.html"           class="back-link">Creamy Layer</a>
    <a href="indian-research.html"  class="back-link" style="color:#f97316;border-color:rgba(249,115,22,.4)">🇮🇳 India Research</a>
    <a href="trades.html"           class="back-link" style="color:#22c55e;border-color:rgba(34,197,94,.4)">📈 Trades</a>
    <a href="sectors.html"          class="back-link" style="color:#f97316;border-color:rgba(249,115,22,.4)">📊 Sectors</a>
    <a href="rocket.html"           class="back-link" style="color:#a855f7;border-color:rgba(168,85,247,.4)">🚀 Rocket</a>
    ${HUB_BACK_LINK}
    <a href="index.html"              class="back-link">My Watchlist</a>
  </div>
</div>

${legendHtml('How to read this page (tap to expand)', [
  { title: 'What this page is', bodyHtml: '<p>Confluence is a <b>research/overlap page</b>: it shows stocks that multiple independent screeners (technical, fundamental, momentum) each flagged on their own. It is not the actionable buy-timing page — for a right-time entry with a defined stop/target, see <a href="triggers.html" style="color:#a78bfa">Triggers</a> instead.</p>' },
  { title: 'How the Signal Score works', bodyHtml: '<p>Each screener\'s raw score is converted to a <b>percentile rank</b> within its own universe (so a 60 on a lenient screener and a 60 on a strict one aren\'t treated the same). Percentiles are averaged — weighted by each screener\'s realized reliability — then multiplied by a <b>conviction bonus</b> that grows with how many screeners agree (1.0× for 1 screener up to 4.0× for all 6). The result is scaled 0-100.</p>' },
  { title: 'Screener glossary', bodyHtml: '<p><span class="legend-chip" style="background:rgba(249,115,22,.15);color:#f97316">🇮🇳 India Research</span> quality+growth+catalyst funnel &nbsp; <span class="legend-chip" style="background:rgba(99,102,241,.15);color:#6366f1">🔮 APEX Scout</span> fundamental tier/action screen &nbsp; <span class="legend-chip" style="background:rgba(34,197,94,.15);color:#22c55e">🍦 Creamy Layer</span> Tickertape High-Performance + growth composite &nbsp; <span class="legend-chip" style="background:rgba(6,182,212,.15);color:#06b6d4">📈 Breakout GEN2</span> Minervini VCP/Stage-2 technical setup &nbsp; <span class="legend-chip" style="background:rgba(245,158,11,.15);color:#f59e0b">🏆 Multibagger</span> long-term compounder traits &nbsp; <span class="legend-chip" style="background:rgba(168,85,247,.15);color:#a855f7">🚀 Rocket</span> aggressive momentum scan &nbsp; <span class="legend-chip" style="background:rgba(14,165,233,.15);color:#0ea5e9">📊 Screener.in</span> your own hand-built fundamental screens (ROCE, growth, debt) imported from Screener.in Premium &nbsp; <span class="legend-chip" style="background:rgba(236,72,153,.15);color:#ec4899">⭐ Marquee</span> currently held by India\'s superstar investors (Jhunjhunwala, Kacholia, Damani…); score rises with the number of them holding it.</p>' },
  { title: 'Institutional overlay', bodyHtml: '<p><span class="legend-chip" style="background:rgba(20,184,166,.15);color:#14b8a6">🏦 FII+DII</span> means foreign <i>and</i> domestic institutions were seen <b>buying</b> the stock in NSE bulk/block deals over the last 90 days (single-side chips show just FII or just DII). This adds a small, bounded boost to the Signal Score (+8 for both, +4 for one side) — smart-money confirmation on top of screener overlap, not a standalone signal. See the FII/DII page for the full deal-level breakdown.</p>' },
  { title: 'Caveats', bodyHtml: '<p>A high Signal Score means several <i>independent</i> methods agree — it is not itself a buy signal, entry price, stop or target. The 2+/3+/4+ tabs simply require that many screeners to have flagged the stock; always click through and verify before acting. Not investment advice.</p>' },
])}

<div class="stats-bar">
  <div class="stat-item"><div class="stat-val">${allStocks.length}</div><div class="stat-lbl">Total Stocks<br>Across All Screeners</div></div>
  <div class="stat-item"><div class="stat-val" style="color:#22c55e">${multi.length}</div><div class="stat-lbl">In 2+ Screeners<br>📌 Noteworthy+</div></div>
  <div class="stat-item"><div class="stat-val" style="color:#f59e0b">${strong.length}</div><div class="stat-lbl">In 3+ Screeners<br>⚡ Strong+</div></div>
  <div class="stat-item"><div class="stat-val" style="color:#ef4444">${elite.length}</div><div class="stat-lbl">In 4+ Screeners<br>🔥 Exceptional+</div></div>
  <div class="stat-item"><div class="stat-val" style="color:#a855f7">${stocks.filter(s=>s.screeners.length>=5).length}</div><div class="stat-lbl">In All 5 Screeners<br>🏆 Perfect</div></div>
  <div class="stat-item"><div class="stat-val" style="color:#14b8a6">${inst.length}</div><div class="stat-lbl">Institutional Buying<br>🏦 FII / DII</div></div>
  <div class="stat-item"><div class="stat-val" style="color:#06b6d4">${microcap.length}</div><div class="stat-lbl">Microcap (&lt;500 Cr)<br>🔬 New lane</div></div>
</div>

<div class="legend">
  <span class="legend-lbl">Screeners:</span>
  ${SCREENERS.map(sc => `<span class="legend-chip" style="background:${sc.bg};color:${sc.colour};border-color:${sc.colour}44">${esc(sc.label)}</span>`).join('')}
</div>

${screenerStatsHtml}

<div class="tabs">
  ${tabSection('all', '🌐 All Stocks', allStocks, true)}
  ${tabSection('multi', '📌 2+ Screeners', multi, false)}
  ${tabSection('strong', '⚡ 3+ Screeners', strong, false)}
  ${tabSection('elite', '🔥 4-6 Screeners', elite, false)}
  ${tabSection('inst', '🏦 Institutional Buying', inst, false)}
  ${tabSection('microcap', '🔬 Microcap (<500 Cr)', microcap, false)}
</div>

${tableSection('all', allStocks, false)}
${tableSection('multi', multi, true)}
${tableSection('strong', strong, true)}
${tableSection('elite', elite, true)}
${tableSection('inst', inst, true)}
${tableSection('microcap', microcap, true)}

${stockActions.bannerHtml}
${stockActions.modalHtml}
${stockActions.researchModalHtml}

<div class="footer">
  &#x26A1; Signal Confluence &middot; Multi-Screener Overlay &nbsp;&middot;&nbsp;
  Generated: ${genTime} IST &nbsp;&middot;&nbsp;
  Data: India Research &middot; APEX Scout &middot; Creamy Layer &middot; VCP Breakout &middot; Multibagger &nbsp;&middot;&nbsp;
  <strong>Not investment advice. Do your own research.</strong>
</div>

<script>
var ACTIVE_TAB = 'all';
function switchTab(tab) {
  ['all','multi','strong','elite','inst','microcap'].forEach(function(t) {
    document.getElementById('tab-' + t).classList.toggle('hidden', t !== tab);
    document.getElementById('tab-btn-' + t).classList.toggle('active', t === tab);
  });
  ACTIVE_TAB = tab;
  setOffsets();
}

// ── Sticky offsets ────────────────────────────────────────────────────────────
function setOffsets() {
  var hdr   = document.querySelector('.header');
  var stats = document.querySelector('.stats-bar');
  var lgnd  = document.querySelector('.legend');
  var tabs  = document.querySelector('.tabs');
  var ctrl  = null;
  document.querySelectorAll('.controls-bar').forEach(function(c) {
    if (!c.closest('[class*="hidden"]') && c.offsetParent !== null) ctrl = c;
  });
  var hH = hdr   ? hdr.offsetHeight   : 84;
  var sH = stats ? stats.offsetHeight : 0;
  var lH = lgnd  ? lgnd.offsetHeight  : 0;
  var tH = tabs  ? tabs.offsetHeight  : 49;
  var cH = ctrl  ? ctrl.offsetHeight  : 60;
  var total = hH + sH + lH + tH + cH;
  var twH = (window.innerHeight - total) + 'px';
  document.querySelectorAll('.table-wrap').forEach(function(tw) { tw.style.height = twH; });
}
setOffsets();
requestAnimationFrame(function() { requestAnimationFrame(setOffsets); });
window.addEventListener('load', setOffsets);
window.addEventListener('resize', setOffsets);
if (window.ResizeObserver) { var _ro = new ResizeObserver(setOffsets); var _hh = document.querySelector('.header'); if (_hh) _ro.observe(_hh); }

// ── Search ────────────────────────────────────────────────────────────────────
function filterTable(tab) {
  applyFilters(tab);
}
// Per-tab set of "active" screener ids. Empty set = no screener filter (show all).
var SCREENER_FILTER = {};

// Click a screener button: first click (from "all") isolates it; further clicks
// add/remove it (OR). Emptying the set returns to "show all". This makes each
// button visibly do something even though most stocks sit in several screeners.
function toggleScreener(tab, id) {
  var set = SCREENER_FILTER[tab] || (SCREENER_FILTER[tab] = {});
  if (set[id]) { delete set[id]; } else { set[id] = true; }
  syncScreenerButtons(tab);
  applyFilters(tab);
}
function clearScreeners(tab) {
  SCREENER_FILTER[tab] = {};
  syncScreenerButtons(tab);
  applyFilters(tab);
}
function syncScreenerButtons(tab) {
  var set = SCREENER_FILTER[tab] || {};
  var active = Object.keys(set);
  document.querySelectorAll('.fc-btn[data-screener][data-tab="' + tab + '"]').forEach(function(b) {
    b.classList.toggle('active', !!set[b.dataset.screener]);
  });
  var allBtn = document.querySelector('.fc-all[data-tab="' + tab + '"]');
  if (allBtn) allBtn.classList.toggle('active', active.length === 0); // "All" lit when no filter
}
function applyFilters(tab) {
  var q = ((document.getElementById('search-' + tab) || {}).value || '').toLowerCase();
  var set = SCREENER_FILTER[tab] || {};
  var active = Object.keys(set);
  var rows = document.getElementById('tbody-' + tab).querySelectorAll('tr');
  var vis = 0;
  rows.forEach(function(row) {
    var textMatch = !q || row.textContent.toLowerCase().includes(q);
    // Match by each chip's data-screener id (ignores 🏦 institutional / 📊 badges,
    // which carry no id). Empty active set = no screener filter.
    var screenerMatch = active.length === 0 || Array.from(row.querySelectorAll('.chip[data-screener]')).some(function(c) {
      return set[c.dataset.screener];
    });
    var show = textMatch && screenerMatch;
    row.style.display = show ? '' : 'none';
    if (show) vis++;
  });
  var note = document.getElementById('note-' + tab);
  if (note) note.textContent = vis + ' stock' + (vis !== 1 ? 's' : '');
}

// ── Sort ──────────────────────────────────────────────────────────────────────
var sortState = { all: { col: 4, asc: false }, multi: { col: 4, asc: false }, strong: { col: 4, asc: false }, elite: { col: 4, asc: false } };
function sortTable(tab, col, numeric) {
  var ss = sortState[tab];
  if (ss.col === col) ss.asc = !ss.asc; else { ss.col = col; ss.asc = col !== 4; }
  var tbody = document.getElementById('tbody-' + tab);
  var rows = Array.from(tbody.querySelectorAll('tr'));
  rows.sort(function(a, b) {
    if (col === 4 && numeric) {
      var ua = parseInt((a.cells[4] && a.cells[4].dataset.sort) || '0', 10);
      var ub = parseInt((b.cells[4] && b.cells[4].dataset.sort) || '0', 10);
      return ss.asc ? ua - ub : ub - ua;
    }
    var av = a.cells[col] ? a.cells[col].textContent.trim() : '';
    var bv = b.cells[col] ? b.cells[col].textContent.trim() : '';
    if (numeric) {
      var an = parseFloat(av.replace(/[^0-9.\-]/g, '')) || 0;
      var bn = parseFloat(bv.replace(/[^0-9.\-]/g, '')) || 0;
      return ss.asc ? an - bn : bn - an;
    }
    return ss.asc ? av.localeCompare(bv) : bv.localeCompare(av);
  });
  rows.forEach(function(r) { tbody.appendChild(r); });
  var ths = document.getElementById('tbl-' + tab).querySelectorAll('th');
  ths.forEach(function(th, i) { th.classList.toggle('sorted', i === col); });
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function toggleTheme() {
  var r = document.documentElement;
  var isDark = getComputedStyle(r).getPropertyValue('--bg').trim() === '#0a0a0f';
  if (isDark) {
    r.style.setProperty('--bg','#f8fafc');r.style.setProperty('--s1','#f1f5f9');r.style.setProperty('--s2','#e2e8f0');r.style.setProperty('--s3','#cbd5e1');
    r.style.setProperty('--tx','#0f172a');r.style.setProperty('--t2','#475569');r.style.setProperty('--t3','#64748b');
    r.style.setProperty('--bd','rgba(139,92,246,.25)');r.style.setProperty('--hdr-bg','rgba(248,250,252,.95)');r.style.setProperty('--row-hover','rgba(139,92,246,.06)');
    document.getElementById('theme-toggle').textContent='\uD83C\uDF19';
  } else {
    r.style.setProperty('--bg','#0a0a0f');r.style.setProperty('--s1','#0f0f17');r.style.setProperty('--s2','#13131e');r.style.setProperty('--s3','#1a1a28');
    r.style.setProperty('--tx','#e2e8f0');r.style.setProperty('--t2','#94a3b8');r.style.setProperty('--t3','#64748b');
    r.style.setProperty('--bd','rgba(139,92,246,.18)');r.style.setProperty('--hdr-bg','rgba(10,10,15,.92)');r.style.setProperty('--row-hover','rgba(139,92,246,.07)');
    document.getElementById('theme-toggle').textContent='\u2600\uFE0F';
  }
}
<\/script>
<script>${stockActions.setupScript}</script>
<script>${stockActions.js}</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('⚡  Signal Confluence · Multi-Screener Overlay');
  console.log('────────────────────────────────────────────────\n');

  console.log(`[1/3] Loading sidecar JSONs from ${N_SCREENERS} screeners…`);
  const screenerData = SCREENERS.map(loadSidecar);
  SCREENERS.forEach((sc, i) => console.log(`  ${sc.label}: ${screenerData[i].length} stocks`));

  console.log('\n[2/3] Building ticker map & cross-referencing…');
  const map = buildMap(screenerData);
  const stocks = Array.from(map.values());

  // Institutional overlay: attach FII/DII bulk/block-deal buying to each stock.
  try {
    const instRows = aggregateInst(loadDeals(), { days: INST_WINDOW_DAYS });
    const instMap = new Map(instRows.map(r => [r.symbol.trim().toUpperCase(), r]));
    let matched = 0;
    for (const s of stocks) { const iv = instMap.get(s.ticker); if (iv) { s.inst = iv; matched++; } }
    console.log(`  Institutional overlay: ${instRows.length} names with FII/DII buying (last ${INST_WINDOW_DAYS}d), ${matched} matched onto confluence stocks`);
  } catch (e) { console.log(`  ⚠  Institutional overlay skipped: ${e.message}`); }

  // Overlay the live price feed so the Price column shows the latest price, not the
  // EOD-ish price each screener sidecar baked in. Reconciled: a >30% gap between the
  // live (Yahoo) and sidecar (Tickertape) price signals bad/split data, so we keep the
  // stable sidecar value rather than show an obviously-wrong number.
  try {
    const n = require('./lib/live-prices').overlayLivePrices(stocks);
    console.log(`  Live price overlay: refreshed ${n}/${stocks.length} prices (reconciled vs sidecar)`);
  } catch (e) { console.log(`  ⚠  live price overlay skipped: ${e.message}`); }

  console.log('  Computing USS (Unified Signal Score) via percentile ranking…');
  computeUSS(stocks, screenerData);

  // Sort: conviction count desc, then USS desc
  stocks.sort((a, b) => {
    if (b.screeners.length !== a.screeners.length) return b.screeners.length - a.screeners.length;
    return b.uss - a.uss;
  });

  const stats = {
    total: stocks.length,
    multi: stocks.filter(s => s.screeners.length >= 2).length,
    strong: stocks.filter(s => s.screeners.length >= 3).length,
    elite: stocks.filter(s => s.screeners.length >= 4).length,
    perfect: stocks.filter(s => s.screeners.length >= 5).length,
  };

  console.log(`\n  Total unique tickers : ${stats.total}`);
  console.log(`  2+ screeners (📌)    : ${stats.multi}`);
  console.log(`  3+ screeners (⚡)    : ${stats.strong}`);
  console.log(`  4+ screeners (🔥)    : ${stats.elite}`);
  console.log(`  5+ screeners (🏆)   : ${stats.perfect}`);

  console.log('\n[3/3] Generating HTML…');
  if (!fs.existsSync(path.join(__dirname, 'docs'))) fs.mkdirSync(path.join(__dirname, 'docs'));
  const tuPath = path.join(__dirname, 'ticker-urls.json');
  const tickerUrls = fs.existsSync(tuPath) ? JSON.parse(fs.readFileSync(tuPath, 'utf8')) : {};
  const html = buildHtml(stocks, stats, Date.now(), tickerUrls);
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  console.log(`\n  ✅  Written: ${OUTPUT_PATH}\n`);

  // Phase 2 — append high-conviction confluence rows (USS≥60 OR ≥3 screeners) to outcome ledger
  try {
    const { appendOutcomes, todayIST } = require('./lib/outcomes');
    const { loadRegime } = require('./lib/regime');
    const regime = loadRegime();
    const date = todayIST();
    const actionable = stocks.filter(s => (s.uss != null && s.uss >= 60) || s.screeners.length >= 3);
    const rows = actionable.map(s => ({
      date,
      screener: 'confluence',
      signalType: 'CONFLUENCE_USS' + (s.screeners.length >= 5 ? '_PERFECT' : s.screeners.length >= 4 ? '_ELITE' : s.screeners.length >= 3 ? '_STRONG' : '_MULTI'),
      ticker: s.ticker,
      name: s.name || s.ticker,
      sector: s.sector || null,
      entry: s.price || null,
      pivot: null,
      stop: null,
      target: null,
      rr: null,
      sizePct: null,
      score: s.uss || 0,
      regime: regime.isBearMarket ? 'BEAR' : 'BULL',
      extras: { screenerCount: s.screeners.length, screeners: s.screeners.map(x => x.key || x.label || x) },
    }));
    const lg = appendOutcomes(rows);
    console.log(`  Outcomes (confluence): +${lg.added} added (${lg.skipped} dupes/skipped, ${lg.total} total)`);
  } catch (e) {
    console.warn('  Outcome ledger append failed:', e.message);
  }
  console.log('\nDone.\n');
}

main().catch(err => { console.error('\nFatal:', err); process.exit(1); });

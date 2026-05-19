'use strict';
const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'docs', 'confluence.html');

// ── Screener registry ─────────────────────────────────────────────────────────
const SCREENERS = [
  { id: 'indianresearch', label: '🇮🇳 India Research', colour: '#f97316', bg: 'rgba(249,115,22,.15)', file: 'indianresearch-tickers.json', minScore: 0 },
  { id: 'apex',           label: '🔮 APEX Scout',      colour: '#6366f1', bg: 'rgba(99,102,241,.15)',  file: 'apex-tickers.json',          minScore: 0 },
  { id: 'creamy',         label: '🍦 Creamy Layer',    colour: '#22c55e', bg: 'rgba(34,197,94,.15)',   file: 'creamy-tickers.json',        minScore: 0 },
  { id: 'breakout',       label: '📈 VCP Breakout',    colour: '#3b82f6', bg: 'rgba(59,130,246,.15)',  file: 'breakout-tickers.json',      minScore: 40 },
  { id: 'multibagger',    label: '🏆 Multibagger',     colour: '#f59e0b', bg: 'rgba(245,158,11,.15)',  file: 'multibagger-tickers.json',   minScore: 40 },
  { id: 'rocket',         label: '🚀 Rocket',           colour: '#a855f7', bg: 'rgba(168,85,247,.15)',  file: 'rocket-tickers.json',        minScore: 40 },
];

function convictionTier(n) {
  if (n >= 6) return { label: '🏆 Perfect',     cls: 'cv5', colour: '#a855f7' };
  if (n >= 5) return { label: '🔥 Exceptional', cls: 'cv5', colour: '#ef4444' };
  if (n >= 4) return { label: '⚡ Strong',       cls: 'cv4', colour: '#f59e0b' };
  if (n >= 3) return { label: '📌 Noteworthy',  cls: 'cv3', colour: '#22c55e' };
  if (n >= 2) return { label: '👀 On Radar',     cls: 'cv2', colour: '#94a3b8' };
  return             { label: '🔍 Watching',     cls: 'cv1', colour: '#64748b' };
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt2(v) { return typeof v === 'number' ? v.toFixed(2) : '—'; }
function fmtPct(v) { return typeof v === 'number' ? v.toFixed(1) + '%' : '—'; }
function fmtCr(v) { return typeof v === 'number' ? '₹' + Math.round(v).toLocaleString('en-IN') + ' Cr' : '—'; }
function fmtPrice(v) { return typeof v === 'number' ? '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'; }

// ── Load sidecars ─────────────────────────────────────────────────────────────
function loadSidecar(screener) {
  const fp = path.join(__dirname, 'docs', screener.file);
  if (!fs.existsSync(fp)) { console.log(`  ⚠  Missing sidecar: ${screener.file} (run respective generator first)`); return []; }
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { console.log(`  ⚠  Bad JSON: ${screener.file}`); return []; }
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
      rec.screeners.push({ id: screener.id, label: screener.label, colour: screener.colour, bg: screener.bg, score: s.score, extra: buildExtra(screener.id, s),
        convergence: s.convergence, action: s.action, vcpPass: s.vcpPass, stage2: s.stage2, promoterHolding: s.promoterHolding });
    }
  }
  return map;
}

function buildExtra(id, s) {
  if (id === 'indianresearch') return `ROE ${fmtPct(s.roe)} · EPS5Y ${fmtPct(s.epsGrowth5Y)} · D/E ${fmt2(s.debtEquity)}`;
  if (id === 'apex')           return `${s.tier || ''} · ${s.action || ''} ${s.convergence ? '· ✨ Convergence' : ''}`.replace(/^·\s*/,'').replace(/\s*·\s*$/,'');
  if (id === 'creamy')         return `Score ${s.score || 0}/100`;
  if (id === 'breakout')       return `${s.tag || ''} ${s.vcpPass ? '· VCP✓' : ''} ${s.stage2 ? '· Stage2✓' : ''}`.trim();
  if (id === 'multibagger')    return (s.badges && s.badges.length ? s.badges.slice(0,2).join(' ') : `MBF ${s.score || 0}`);
  if (id === 'rocket')         return `${s.tier || ''} · RS ${s.rsRating || '—'} ${s.stage2 ? '· Stage2✓' : ''}`.replace(/^·\s*/,'').trim();
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
  // Step 2: attach pct/adjPct/pctBonus to each screener entry, then compute USS
  for (const s of stocks) {
    let totalAdj = 0;
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
      totalAdj   += sc.adjPct;
    }
    const n      = s.screeners.length;
    const avgAdj = totalAdj / n;
    const raw    = avgAdj * CONVICTION_BONUS[Math.min(n - 1, 5)];
    s.uss        = Math.round(raw / USS_MAX_RAW * 100);
  }
}

// ── HTML builder ──────────────────────────────────────────────────────────────
function buildHtml(stocks, stats, generatedAt, tickerUrls) {
  const genTime = new Date(generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  // Filter tabs: All / 3+ / 4+ / 5
  const allStocks  = stocks;
  const multi      = stocks.filter(s => s.screeners.length >= 2);
  const strong     = stocks.filter(s => s.screeners.length >= 3);
  const elite      = stocks.filter(s => s.screeners.length >= 4);

  const rows = (arr) => arr.map((s, i) => {
    const tier = convictionTier(s.screeners.length);
    const chips = s.screeners.map(sc => {
      const tt = (sc.pct != null ? sc.pct : 0) + 'th pct' + (sc.pctBonus ? ' (+' + sc.pctBonus + ' bonus → ' + sc.adjPct + ')' : '') + ' · ' + sc.extra;
      return `<span class="chip" style="background:${sc.bg};color:${sc.colour};border-color:${sc.colour}33" title="${esc(tt)}">${esc(sc.label)}<span class="chip-score">${sc.score != null ? Math.round(sc.score) : ''}</span></span>`;
    }).join('');
    const stockUrl = s.url || (tickerUrls && tickerUrls[s.ticker]) || `https://www.tickertape.in/stocks/${esc(s.ticker)}`;
    const uc  = ussColour(s.uss || 0);
    const utt = 'Signal Score: ' + (s.uss || 0) + '/100 · ' + s.screeners.map(function(sc) {
      return sc.label + ': ' + (sc.pct || 0) + 'th pct' + (sc.pctBonus ? ' +' + sc.pctBonus + '→' + sc.adjPct : '');
    }).join(' | ');
    return `<tr>
      <td class="num dim">${i + 1}</td>
      <td>
        <div class="stock-cell">
          <div>
            <a class="stock-link" href="${stockUrl}" target="_blank" rel="noopener">${esc(s.name)}</a>
            <div class="ticker-sub">${esc(s.ticker)}${s.sector ? ' · ' + esc(s.sector) : ''}</div>
          </div>
        </div>
      </td>
      <td class="num">${fmtPrice(s.price)}</td>
      <td class="num">${s.marketCap ? fmtCr(s.marketCap) : '—'}</td>
      <td class="uss-cell" data-sort="${s.uss || 0}" title="${esc(utt)}">
        <div class="uss-bar-wrap"><div class="uss-bar" style="width:${s.uss || 0}%;background:${uc}"></div></div>
        <div class="uss-nums"><span class="uss-val" style="color:${uc}">${s.uss || 0}</span><span class="uss-max">/100</span></div>
        <div class="uss-cv"><span class="cv-badge ${tier.cls}" style="color:${tier.colour};border-color:${tier.colour}44">${esc(tier.label)}</span><span class="cv-count">${s.screeners.length}/6</span></div>
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
      ${SCREENERS.map(sc => `<label class="fc-label"><input type="checkbox" class="fc-check" data-screener="${sc.id}" data-tab="${id}" onchange="applyFilters('${id}')" checked><span class="fc-chip" style="background:${sc.bg};color:${sc.colour};border-color:${sc.colour}44">${esc(sc.label)}</span></label>`).join('')}
    </div>
    <span class="ctrl-note" id="note-${id}">${arr.length} stocks</span>
  </div>
  <div class="table-wrap" id="wrap-${id}">
    <table id="tbl-${id}">
      <thead><tr>
        <th class="num" onclick="sortTable('${id}',0,true)"># <span class="arr">↕</span></th>
        <th onclick="sortTable('${id}',1,false)">Stock <span class="arr">↕</span></th>
        <th class="num" onclick="sortTable('${id}',2,true)">Price <span class="arr">↕</span></th>
        <th class="num" onclick="sortTable('${id}',3,true)">Market Cap <span class="arr">↕</span></th>
        <th class="num sorted" onclick="sortTable('${id}',4,true)">Signal Score <span class="arr">↓</span></th>
        <th>Screener Signals</th>
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
.fc-label{cursor:pointer;user-select:none}
.fc-check{display:none}
.fc-chip{display:inline-flex;align-items:center;padding:3px 8px;border-radius:5px;font-size:.67rem;font-weight:600;border:1px solid;transition:opacity .2s}
.fc-check:not(:checked) ~ .fc-chip{opacity:.3}
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
/* ── Alert + Research buttons ── */
.alert-btn,.research-btn{background:none;border:1px solid var(--bd);border-radius:5px;cursor:pointer;padding:3px 6px;font-size:.75rem;color:var(--t3);transition:all .15s;flex-shrink:0;margin-top:4px;line-height:1;margin-right:3px}
.alert-btn:hover{color:var(--yw);border-color:var(--yw)}
.research-btn:hover{color:var(--gn);border-color:var(--gn)}
.alert-btn.has-alert{color:var(--yw);border-color:var(--yw);background:rgba(234,179,8,.1)}
.alert-btn.triggered{color:var(--rd);border-color:var(--rd);background:rgba(239,68,68,.12);animation:alertPulse 1.5s ease-in-out infinite}
.alert-triggered-row td{background:rgba(239,68,68,.04)!important}
@keyframes alertPulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.4)}50%{box-shadow:0 0 0 5px rgba(239,68,68,0)}}
#ap-modal{display:none;position:fixed;z-index:9999;background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:20px;width:270px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
#ap-x{position:absolute;top:12px;right:12px;background:none;border:none;color:var(--t3);font-size:1.1rem;cursor:pointer;line-height:1}
.ap-modal-title{font-size:.95rem;font-weight:700;margin-bottom:2px;padding-right:24px}
.ap-modal-sub{font-size:.72rem;color:var(--t2);margin-bottom:12px}
.ap-label{display:block;font-size:.72rem;color:var(--t2);margin-bottom:4px;margin-top:10px}
#ap-above,#ap-below{width:100%;background:var(--s3);border:1px solid var(--bd);border-radius:7px;padding:7px 10px;color:var(--tx);font-size:.84rem;outline:none}
#ap-above:focus,#ap-below:focus{border-color:var(--ac)}
.ap-actions{display:flex;gap:8px;margin-top:14px}
.ap-save-btn,.ap-clear-btn{flex:1;padding:8px;border-radius:7px;border:none;cursor:pointer;font-size:.8rem;font-weight:600}
.ap-save-btn{background:var(--ac);color:#fff}
.ap-clear-btn{background:var(--s3);color:var(--t2);border:1px solid var(--bd)}
.ap-save-btn:hover{opacity:.88}.ap-clear-btn:hover{color:var(--tx)}
.ap-gh-section{margin-top:14px;border-top:1px solid var(--bd);padding-top:10px}
.ap-gh-toggle{font-size:.72rem;color:var(--t2);cursor:pointer;user-select:none;display:flex;align-items:center;gap:5px}
.ap-gh-toggle:hover{color:var(--tx)}
.ap-gh-body{margin-top:8px}
.ap-gh-status{font-size:.7rem;margin-top:6px}
.ap-gh-status.ok{color:var(--gn)}.ap-gh-status.err{color:var(--rd)}
.ap-gh-note{font-size:.64rem;color:var(--t3);margin-top:6px;line-height:1.5}
.ap-gh-note a{color:var(--ac)}
.alert-bar{display:none;position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9990;background:rgba(239,68,68,.95);color:#fff;padding:10px 16px;border-radius:10px;font-size:.8rem;font-weight:600;box-shadow:0 4px 20px rgba(239,68,68,.4);max-width:90vw;width:max-content;align-items:center;gap:10px}
.alert-bar-body{flex:1}
.alert-bar-close{background:none;border:none;color:rgba(255,255,255,.7);font-size:1rem;cursor:pointer;line-height:1;padding:0 4px}
#pat-setup-bar{display:none;position:fixed;bottom:0;left:0;right:0;z-index:9980;background:var(--s2);border-top:1px solid var(--bd);padding:10px 16px;font-size:.78rem;color:var(--t2);align-items:center;gap:8px}
#pat-bar-input{flex:1;max-width:340px;background:var(--s3);border:1px solid var(--bd);border-radius:6px;padding:6px 10px;color:var(--tx);font-size:.78rem;outline:none}
#pat-bar-input:focus{border-color:var(--ac)}
#pat-setup-bar button.connect{background:var(--ac);color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:.78rem;font-weight:600;cursor:pointer}
#pat-setup-bar button.dismiss{background:none;border:none;color:var(--t3);font-size:1rem;cursor:pointer;padding:0 4px;line-height:1}
#dr-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:10000;overflow-y:auto;padding:20px}
#dr-modal{background:var(--s2);border:1px solid var(--bd);border-radius:14px;max-width:640px;margin:20px auto;padding:0;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.7)}
.dr-header{display:flex;justify-content:space-between;align-items:flex-start;padding:18px 20px 14px;border-bottom:1px solid var(--bd)}
.dr-title{font-size:1.05rem;font-weight:700}
.dr-subtitle{font-size:.72rem;color:var(--t2);margin-top:3px}
#dr-close{background:none;border:none;color:var(--t3);font-size:1.2rem;cursor:pointer;padding:2px;line-height:1;flex-shrink:0}
#dr-content{padding:16px 20px}
.dr-section{margin-bottom:18px}
.dr-section-title{font-size:.62rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ac);font-weight:700;margin-bottom:10px}
.dr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:4px}
.dr-metric{background:var(--s3);border:1px solid var(--bd);border-radius:8px;padding:10px 12px;text-align:center}
.dm-label{font-size:.6rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
.dm-val{font-size:.92rem;font-weight:700}.dm-val.pos{color:var(--gn)}.dm-val.neg{color:var(--rd)}
.dm-sub{font-size:.6rem;color:var(--t3);margin-top:2px}
.dr-signal{display:flex;gap:8px;align-items:flex-start;padding:7px 10px;border-radius:7px;font-size:.78rem;margin-bottom:5px}
.dr-signal.bull{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2)}
.dr-signal.bear{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2)}
.dr-signal.neut{background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.15)}
.ds-icon{font-size:.85rem;flex-shrink:0;margin-top:1px;color:var(--gn)}
.dr-signal.bear .ds-icon{color:var(--rd)}.dr-signal.neut .ds-icon{color:var(--t2)}
.dr-ai-box{background:var(--s3);border:1px solid var(--bd);border-radius:8px;padding:14px;font-size:.79rem;line-height:1.6;color:var(--tx);min-height:60px;margin-bottom:10px;white-space:pre-wrap}
.dr-ai-box.loading{color:var(--t2);font-style:italic}
.dr-ai-error{font-size:.72rem;color:var(--rd);margin-bottom:8px;padding:6px 10px;background:rgba(239,68,68,.08);border-radius:6px}
.dr-ai-key-row{display:flex;gap:6px;margin-top:8px}
.dr-ai-key-input{flex:1;background:var(--s3);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;color:var(--tx);font-size:.78rem;outline:none}
.dr-ai-key-input:focus{border-color:var(--ac)}
.dr-ai-key-btn{background:var(--ac);color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:.78rem;font-weight:600;cursor:pointer;white-space:nowrap}
.dr-ai-key-btn:hover{opacity:.85}
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
    <a href="alerts.html"           class="back-link" style="color:#eab308;border-color:rgba(234,179,8,.4)">🔔 Alerts</a>
    <a href="potential.html"        class="back-link" style="color:#a855f7;border-color:rgba(168,85,247,.4)">🌟 Potential</a>
    <a href="multibagger.html"      class="back-link" style="color:#f59e0b;border-color:rgba(245,158,11,.4)">🏆 Multibagger</a>
    <a href="breakout2.html"        class="back-link" style="color:#06b6d4;border-color:rgba(6,182,212,.4)">⚡ Breakout GEN2</a>
    <a href="breakout.html"         class="back-link">Breakout VCP</a>
    <a href="apex.html"             class="back-link" style="color:#6366f1;border-color:rgba(99,102,241,.4)">🔮 APEX</a>
    <a href="creamy.html"           class="back-link">Creamy Layer</a>
    <a href="indian-research.html"  class="back-link" style="color:#f97316;border-color:rgba(249,115,22,.4)">🇮🇳 India Research</a>
    <a href="trades.html"           class="back-link" style="color:#22c55e;border-color:rgba(34,197,94,.4)">📈 Trades</a>
    <a href="sectors.html"          class="back-link" style="color:#f97316;border-color:rgba(249,115,22,.4)">📊 Sectors</a>
    <a href="rocket.html"           class="back-link" style="color:#a855f7;border-color:rgba(168,85,247,.4)">🚀 Rocket</a>
    <a href="index.html"            class="back-link">My Watchlist</a>
  </div>
</div>

<div class="stats-bar">
  <div class="stat-item"><div class="stat-val">${allStocks.length}</div><div class="stat-lbl">Total Stocks<br>Across All Screeners</div></div>
  <div class="stat-item"><div class="stat-val" style="color:#22c55e">${multi.length}</div><div class="stat-lbl">In 2+ Screeners<br>📌 Noteworthy+</div></div>
  <div class="stat-item"><div class="stat-val" style="color:#f59e0b">${strong.length}</div><div class="stat-lbl">In 3+ Screeners<br>⚡ Strong+</div></div>
  <div class="stat-item"><div class="stat-val" style="color:#ef4444">${elite.length}</div><div class="stat-lbl">In 4+ Screeners<br>🔥 Exceptional+</div></div>
  <div class="stat-item"><div class="stat-val" style="color:#a855f7">${stocks.filter(s=>s.screeners.length>=5).length}</div><div class="stat-lbl">In All 5 Screeners<br>🏆 Perfect</div></div>
</div>

<div class="legend">
  <span class="legend-lbl">Screeners:</span>
  ${SCREENERS.map(sc => `<span class="legend-chip" style="background:${sc.bg};color:${sc.colour};border-color:${sc.colour}44">${esc(sc.label)}</span>`).join('')}
</div>

<div class="tabs">
  ${tabSection('all', '🌐 All Stocks', allStocks, true)}
  ${tabSection('multi', '📌 2+ Screeners', multi, false)}
  ${tabSection('strong', '⚡ 3+ Screeners', strong, false)}
  ${tabSection('elite', '🔥 4-6 Screeners', elite, false)}
</div>

${tableSection('all', allStocks, false)}
${tableSection('multi', multi, true)}
${tableSection('strong', strong, true)}
${tableSection('elite', elite, true)}

<div id="alert-bar" class="alert-bar">
  <span style="font-size:1rem;flex-shrink:0">&#x1F514;</span>
  <div class="alert-bar-body" id="alert-bar-body"></div>
  <button class="alert-bar-close" onclick="document.getElementById('alert-bar').style.display='none'" title="Dismiss">&#x2715;</button>
</div>
<div id="pat-setup-bar">
  <span style="flex-shrink:0">&#x1F511;</span>
  <span style="flex-shrink:0;white-space:nowrap">GitHub PAT for alerts:</span>
  <input id="pat-bar-input" type="password" placeholder="ghp_... (repo Contents R+W)" autocomplete="off">
  <button class="connect" id="pat-bar-save">Connect</button>
  <button class="dismiss" id="pat-bar-close" title="Dismiss">&#x2715;</button>
</div>
<div id="ap-modal">
  <button id="ap-x">&#x2715;</button>
  <div class="ap-modal-title" id="ap-title">Set Price Alert</div>
  <div class="ap-modal-sub" id="ap-sub"></div>
  <label class="ap-label" for="ap-above">&#x1F514; Alert when price goes ABOVE &#x20B9;</label>
  <input type="number" id="ap-above" placeholder="e.g. 1500" min="0" step="0.5">
  <label class="ap-label" for="ap-below">&#x1F514; Alert when price goes BELOW &#x20B9;</label>
  <input type="number" id="ap-below" placeholder="e.g. 1200" min="0" step="0.5">
  <div class="ap-actions">
    <button class="ap-save-btn" id="ap-save">Save Alert</button>
    <button class="ap-clear-btn" id="ap-clear">Clear</button>
  </div>
  <div class="ap-gh-section">
    <div class="ap-gh-toggle" id="ap-gh-toggle">&#x2699;&#xFE0F; GitHub sync <span id="ap-gh-arrow">&#x25B8;</span></div>
    <div class="ap-gh-body" id="ap-gh-body" style="display:none">
      <label class="ap-label" for="ap-pat-input">Personal Access Token</label>
      <input type="password" id="ap-pat-input" placeholder="ghp_..." autocomplete="off">
      <button class="ap-save-btn" id="ap-pat-save" style="margin-top:8px;width:100%">Save PAT</button>
      <div id="ap-gh-status" class="ap-gh-status"></div>
      <p class="ap-gh-note">Create at <a href="https://github.com/settings/tokens" target="_blank">github.com/settings/tokens</a> &rarr; Fine-grained &rarr; Contents: Read+Write. Alerts save to user-alerts.json.</p>
    </div>
  </div>
</div>
<div id="dr-overlay">
  <div id="dr-modal">
    <div class="dr-header">
      <div><div class="dr-title" id="dr-title">Deep Research</div><div class="dr-subtitle" id="dr-subtitle"></div></div>
      <button id="dr-close">&#x2715;</button>
    </div>
    <div id="dr-content"></div>
  </div>
</div>

<div class="footer">
  &#x26A1; Signal Confluence &middot; Multi-Screener Overlay &nbsp;&middot;&nbsp;
  Generated: ${genTime} IST &nbsp;&middot;&nbsp;
  Data: India Research &middot; APEX Scout &middot; Creamy Layer &middot; VCP Breakout &middot; Multibagger &nbsp;&middot;&nbsp;
  <strong>Not investment advice. Do your own research.</strong>
</div>

<script>
var ACTIVE_TAB = 'all';
function switchTab(tab) {
  ['all','multi','strong','elite'].forEach(function(t) {
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
function applyFilters(tab) {
  var q = ((document.getElementById('search-' + tab) || {}).value || '').toLowerCase();
  var checked = Array.from(document.querySelectorAll('.fc-check[data-tab="' + tab + '"]:checked')).map(function(el) { return el.dataset.screener; });
  var rows = document.getElementById('tbody-' + tab).querySelectorAll('tr');
  var vis = 0;
  rows.forEach(function(row) {
    var textMatch = !q || row.textContent.toLowerCase().includes(q);
    // check if row has at least one chip matching checked screeners
    var chips = row.querySelectorAll('.chip');
    var screenerMatch = checked.length === 0;
    chips.forEach(function(chip) {
      var title = chip.getAttribute('title') || '';
      checked.forEach(function(sc) { if (chip.textContent.includes(sc) || chip.style.cssText.includes(sc)) screenerMatch = true; });
    });
    // simpler: check by chip colour data attribute
    screenerMatch = Array.from(chips).some(function(chip) {
      return checked.some(function(sc) {
        var label = SCREENER_MAP[sc] || '';
        return chip.textContent.trim().startsWith(label.slice(0, 5));
      });
    }) || checked.length === 5;
    var show = textMatch && screenerMatch;
    row.style.display = show ? '' : 'none';
    if (show) vis++;
  });
  var note = document.getElementById('note-' + tab);
  if (note) note.textContent = vis + ' stock' + (vis !== 1 ? 's' : '');
}
var SCREENER_MAP = { indianresearch: '🇮🇳', apex: '🔮', creamy: '🍦', breakout: '📈', multibagger: '🏆' };

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

// ─────── Inject Alert + Brain buttons ─────────────────────────────────────────
(function() {
  function injectButtons() {
    document.querySelectorAll('tbody tr').forEach(function(row) {
      if (row.querySelector('.alert-btn')) return;
      var tickerSub = row.querySelector('.ticker-sub');
      if (!tickerSub) return;
      var parts = tickerSub.textContent.split('\u00b7');
      var ticker = parts[0].trim(); if (!ticker) return;
      var priceCell = row.cells && row.cells[2];
      var price = priceCell ? parseFloat(priceCell.textContent.replace(/[\u20b9,\s]/g, '')) || 0 : 0;
      var nameEl = row.querySelector('.stock-link');
      var name = nameEl ? nameEl.textContent.trim() : ticker;
      var stockCell = row.querySelector('.stock-cell'); if (!stockCell) return;
      var innerDiv = stockCell.querySelector('div'); if (!innerDiv) return;
      var aBtn = document.createElement('button');
      aBtn.className = 'alert-btn'; aBtn.innerHTML = '\uD83D\uDD14';
      aBtn.title = 'Set price alert';
      aBtn.dataset.alertTicker = ticker; aBtn.dataset.alertPrice = price; aBtn.dataset.alertName = name;
      innerDiv.appendChild(aBtn);
      var bBtn = document.createElement('button');
      bBtn.className = 'research-btn'; bBtn.innerHTML = '\uD83E\uDDE0';
      bBtn.title = 'AI Deep Research';
      bBtn.dataset.rTicker = ticker; bBtn.dataset.rName = name;
      bBtn.dataset.rPrice = price; bBtn.dataset.rSector = parts.length > 1 ? parts[1].trim() : '';
      innerDiv.appendChild(bBtn);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButtons);
  else injectButtons();
  document.addEventListener('click', function(e) {
    if (e.target.closest('.tab-btn')) setTimeout(injectButtons, 50);
  });
})();

window._GH_ALERTS_REPO = 'amitiyer99/watchlist-app';

// ─────── Price Alert System ───────────────────────────────────────────────────
(function(){
  var _GH = window._GH_ALERTS_REPO || '';
  var _GH_FILE = 'user-alerts.json';
  var _SHA = null;
  window._GA = {};
  function pat(){ return localStorage.getItem('gh_alerts_pat')||''; }
  function setPat(v){ if(v)localStorage.setItem('gh_alerts_pat',v);else localStorage.removeItem('gh_alerts_pat'); }
  function showPatBar(msg){ var b=document.getElementById('pat-setup-bar');if(!b)return;b.style.display='flex';var inp=document.getElementById('pat-bar-input');if(inp&&msg)inp.placeholder=msg; }
  function hidePatBar(){ var b=document.getElementById('pat-setup-bar');if(b)b.style.display='none'; }
  function ghStatus(msg,type){ var el=document.getElementById('ap-gh-status');if(!el)return;el.textContent=msg;el.className='ap-gh-status '+(type||''); }
  function fetchAlerts(cb){var p=pat();if(!p){showPatBar();if(cb)cb(false);return;}fetch('https://api.github.com/repos/'+_GH+'/contents/'+_GH_FILE+'?t='+Date.now(),{headers:{'Authorization':'token '+p,'Accept':'application/vnd.github.v3+json'}}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(res){if(!res.ok)throw new Error(res.j.message||'HTTP error');_SHA=res.j.sha;try{window._GA=JSON.parse(atob(res.j.content.replace(/\n/g,'')));}catch(e){window._GA={};}hidePatBar();refreshA();if(window.onAlertChange)window.onAlertChange();if(cb)cb(true);}).catch(function(e){if(/401|403|Bad cred/i.test(e.message)){setPat('');showPatBar('Invalid PAT');}if(cb)cb(false);});}
  function saveAlerts(a,cb){var p=pat();if(!p){showPatBar();if(cb)cb(false);return;}var content=btoa(unescape(encodeURIComponent(JSON.stringify(a,null,2))));ghStatus('Saving\u2026','');function doSave(sha){var bodyObj={message:'chore: update price alerts [skip ci]',content:content};if(sha)bodyObj.sha=sha;return fetch('https://api.github.com/repos/'+_GH+'/contents/'+_GH_FILE,{method:'PUT',headers:{'Authorization':'token '+p,'Content-Type':'application/json','Accept':'application/vnd.github.v3+json'},body:JSON.stringify(bodyObj)});}var savePromise=_SHA?doSave(_SHA):fetch('https://api.github.com/repos/'+_GH+'/contents/'+_GH_FILE+'?t='+Date.now(),{headers:{'Authorization':'token '+p,'Accept':'application/vnd.github.v3+json'}}).then(function(r){return r.ok?r.json().then(function(j){_SHA=j.sha||null;return doSave(_SHA);}):doSave(null);}).catch(function(){return doSave(null);});savePromise.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(res){if(!res.ok)throw new Error(res.j.message||'HTTP error');_SHA=res.j.content.sha;window._GA=a;refreshA();if(window.onAlertChange)window.onAlertChange();ghStatus('\u2713 Saved to GitHub','ok');setTimeout(function(){ghStatus('','');},3000);if(cb)cb(true);}).catch(function(e){if(/401|403|Bad cred/i.test(e.message)){setPat('');showPatBar('PAT rejected');}ghStatus('\u274C Save failed: '+e.message,'err');if(cb)cb(false);});}
  var modal=document.getElementById('ap-modal');var curT='',curN='',curP=0;
  document.addEventListener('click',function(e){if(modal&&modal.style.display==='block'&&!modal.contains(e.target)&&!e.target.closest('.alert-btn'))modal.style.display='none';},true);
  document.addEventListener('click',function(e){
    var btn=e.target.closest('.alert-btn');if(!btn)return;e.stopPropagation();
    curT=btn.dataset.alertTicker||'';curN=btn.dataset.alertName||curT;curP=parseFloat(btn.dataset.alertPrice)||0;
    document.getElementById('ap-title').textContent=curN+' ('+curT+')';
    document.getElementById('ap-sub').textContent='Last price: \u20B9'+curP.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
    var a=(window._GA[curT])||{};document.getElementById('ap-above').value=a.above||'';document.getElementById('ap-below').value=a.below||'';
    var r=btn.getBoundingClientRect();var topPos=r.bottom+6;if(topPos+340>window.innerHeight)topPos=Math.max(8,r.top-346);
    modal.style.top=topPos+'px';modal.style.left=Math.max(8,Math.min(r.left,window.innerWidth-280))+'px';modal.style.display='block';ghStatus('','');
  });
  document.getElementById('ap-x').onclick=function(){modal.style.display='none';};
  document.getElementById('ap-save').onclick=function(){var a=JSON.parse(JSON.stringify(window._GA));var above=parseFloat(document.getElementById('ap-above').value)||null;var below=parseFloat(document.getElementById('ap-below').value)||null;if(above||below){a[curT]={above:above,below:below,name:curN};}else{delete a[curT];}modal.style.display='none';saveAlerts(a);};
  document.getElementById('ap-clear').onclick=function(){var a=JSON.parse(JSON.stringify(window._GA));delete a[curT];modal.style.display='none';saveAlerts(a);};
  var ghToggle=document.getElementById('ap-gh-toggle');
  if(ghToggle){ghToggle.onclick=function(){var body=document.getElementById('ap-gh-body');var arrow=document.getElementById('ap-gh-arrow');if(body.style.display==='none'){body.style.display='block';if(arrow)arrow.textContent='\u25BE';var pi=document.getElementById('ap-pat-input');if(pi)pi.value=pat();}else{body.style.display='none';if(arrow)arrow.textContent='\u25B8';}};}
  var patSave=document.getElementById('ap-pat-save');
  if(patSave){patSave.onclick=function(){var v=(document.getElementById('ap-pat-input').value||'').trim();if(!v)return;setPat(v);ghStatus('Connecting\u2026','');fetchAlerts(function(ok){ghStatus(ok?'\u2713 Connected':('\u274C Failed'),ok?'ok':'err');});};}
  var patBarSave=document.getElementById('pat-bar-save');
  if(patBarSave){patBarSave.onclick=function(){var v=(document.getElementById('pat-bar-input').value||'').trim();if(!v)return;setPat(v);fetchAlerts();};}
  var patBarClose=document.getElementById('pat-bar-close');
  if(patBarClose){patBarClose.onclick=function(){hidePatBar();};}
  function refreshA(){var a=window._GA;var triggeredMap={};document.querySelectorAll('.alert-btn').forEach(function(btn){var t=btn.dataset.alertTicker||'';var p=parseFloat(btn.dataset.alertPrice)||0;var n=btn.dataset.alertName||t;var al=a[t];btn.classList.remove('has-alert','triggered');var row=btn.closest('tr');if(row)row.classList.remove('alert-triggered-row');if(!al||(!al.above&&!al.below)){btn.title='Set price alert';return;}btn.classList.add('has-alert');btn.title='Alert: '+(al.above?'\u25b2\u20B9'+al.above:'')+(al.above&&al.below?' / ':'')+(al.below?'\u25bc\u20B9'+al.below:'');var msgs=[];if(al.above&&p>=al.above)msgs.push('\u20B9'+p.toFixed(2)+' \u2265 target \u20B9'+al.above);if(al.below&&p<=al.below)msgs.push('\u20B9'+p.toFixed(2)+' \u2264 target \u20B9'+al.below);if(msgs.length){btn.classList.add('triggered');if(row)row.classList.add('alert-triggered-row');if(!triggeredMap[t])triggeredMap[t]='<strong>'+n+'</strong>: '+msgs.join(' & ');}});var triggered=Object.values(triggeredMap);var bar=document.getElementById('alert-bar');var body=document.getElementById('alert-bar-body');if(!bar||!body)return;if(triggered.length){body.innerHTML='\uD83D\uDD14 '+triggered.length+' price alert'+(triggered.length>1?'s':'')+' triggered \u2014 '+triggered.join(' \u00B7 ');bar.style.display='flex';}else{bar.style.display='none';}}
  refreshA();
  window._saveAlerts=saveAlerts;
  if(!pat())showPatBar();
  fetchAlerts();
})();

// ─────── Deep Research AI ─────────────────────────────────────────────────────
(function(){
  var DR_PROV_KEY='dr_provider';
  var DR_PROVIDERS={groq:{label:'Groq (Llama/Mixtral) \u2605',keyName:'dr_groq_key',keyPlaceholder:'Paste Groq API key',keyLink:'https://console.groq.com/keys',keyLinkLabel:'console.groq.com',models:[{id:'llama-3.3-70b-versatile',label:'Llama 3.3 70B'},{id:'llama3-8b-8192',label:'Llama 3 8B'},{id:'mixtral-8x7b-32768',label:'Mixtral 8x7B'}]},openrouter:{label:'OpenRouter',keyName:'dr_openrouter_key',keyPlaceholder:'Paste OpenRouter API key',keyLink:'https://openrouter.ai/keys',keyLinkLabel:'openrouter.ai',models:[{id:'meta-llama/llama-3.1-8b-instruct:free',label:'Llama 3.1 8B (free)'},{id:'mistralai/mistral-7b-instruct:free',label:'Mistral 7B (free)'}]},gemini:{label:'Google Gemini',keyName:'dr_gemini_key',keyPlaceholder:'Paste Gemini API key',keyLink:'https://aistudio.google.com/app/apikey',keyLinkLabel:'aistudio.google.com',models:[{id:'gemini-2.0-flash-lite',label:'Gemini 2.0 Flash Lite'},{id:'gemini-2.0-flash',label:'Gemini 2.0 Flash'},{id:'gemini-1.5-flash-8b',label:'Gemini 1.5 Flash 8B'}]}};
  var drCur=null;
  document.addEventListener('click',function(e){
    var btn=e.target.closest('.research-btn');if(!btn)return;e.stopPropagation();
    var ticker=btn.dataset.rTicker;var name=btn.dataset.rName||ticker;
    var price=parseFloat(btn.dataset.rPrice)||0;var sector=btn.dataset.rSector||'';
    var row=btn.closest('tr');
    var chips=row?Array.from(row.querySelectorAll('.chip')).map(function(c){return c.firstChild?c.firstChild.textContent.trim():'';}).filter(Boolean):[];
    var ussEl=row&&row.querySelector('.uss-val');var uss=ussEl?parseInt(ussEl.textContent)||0:0;
    drCur={ticker:ticker,name:name,price:price,sector:sector,screeners:chips,uss:uss};
    document.getElementById('dr-title').textContent=name;
    document.getElementById('dr-subtitle').textContent=ticker+' \u00b7 '+(sector||'NSE India')+' \u00b7 Signal Score: '+uss+'/100';
    document.getElementById('dr-content').innerHTML=buildDrContent(drCur);
    document.getElementById('dr-overlay').style.display='block';document.body.style.overflow='hidden';
    var sp=localStorage.getItem(DR_PROV_KEY)||'groq';var psel=document.getElementById('dr-provider-select');if(psel)psel.value=sp;
    drChangeProvider();
    var sprov=DR_PROVIDERS[sp];var key=sprov?localStorage.getItem(sprov.keyName):null;
    if(key){var inp=document.getElementById('dr-key-input');if(inp)inp.value='\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';var msel=document.getElementById('dr-model-select');runAIAnalysis(drCur,key,sp,msel?msel.value:null);}
  });
  document.getElementById('dr-close').addEventListener('click',closeDr);
  document.getElementById('dr-overlay').addEventListener('click',function(e){if(e.target===document.getElementById('dr-overlay'))closeDr();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&document.getElementById('dr-overlay').style.display==='block')closeDr();});
  function closeDr(){document.getElementById('dr-overlay').style.display='none';document.body.style.overflow='';}
  window.drRunWithKey=function(){var inp=document.getElementById('dr-key-input');if(!inp)return;var psel=document.getElementById('dr-provider-select');var pid=(psel&&psel.value)||localStorage.getItem(DR_PROV_KEY)||'groq';var prov=DR_PROVIDERS[pid]||DR_PROVIDERS.groq;var typedKey=inp.value.trim().replace(/[^ -~]/g,'');var key=typedKey||localStorage.getItem(prov.keyName)||'';if(!key){inp.focus();return;}localStorage.setItem(DR_PROV_KEY,pid);localStorage.setItem(prov.keyName,key);inp.value='\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';var msel=document.getElementById('dr-model-select');var model=msel?msel.value:prov.models[0].id;if(drCur)runAIAnalysis(drCur,key,pid,model);};
  window.drChangeProvider=function(){var psel=document.getElementById('dr-provider-select');var msel=document.getElementById('dr-model-select');var inp=document.getElementById('dr-key-input');var link=document.getElementById('dr-key-link');if(!psel)return;var prov=DR_PROVIDERS[psel.value];if(!prov)return;if(msel){msel.innerHTML=prov.models.map(function(m){return'<option value="'+m.id+'">'+m.label+'</option>';}).join('');var sm=localStorage.getItem('dr_model.'+psel.value);if(sm)msel.value=sm;}var sk=localStorage.getItem(prov.keyName);if(inp){inp.value=sk?'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022':'';inp.placeholder=prov.keyPlaceholder;}if(link){link.href=prov.keyLink;link.textContent=prov.keyLinkLabel;}};
  function dm(lbl,val,sub,cls){return'<div class="dr-metric"><div class="dm-label">'+lbl+'</div><div class="dm-val'+(cls?' '+cls:'')+'">'+(val||'\u2014')+'</div>'+(sub?'<div class="dm-sub">'+sub+'</div>':'')+'</div>';}
  function buildDrContent(s){
    var signals=[];
    s.screeners.forEach(function(sc){
      if(sc.indexOf('India')>=0)signals.push({type:'bull',icon:'\u25b2',text:'Passed India Research fundamental screener \u2014 quality + growth criteria met.'});
      if(sc.indexOf('APEX')>=0)signals.push({type:'bull',icon:'\u25b2',text:'APEX Scout identified \u2014 strong convergence of momentum and fundamental signals.'});
      if(sc.indexOf('Creamy')>=0||sc.indexOf('\uD83C\uDF66')>=0)signals.push({type:'bull',icon:'\u25b2',text:'Creamy Layer \u2014 top-tier quality score across multiple ranking dimensions.'});
      if(sc.indexOf('VCP')>=0||sc.indexOf('Breakout')>=0)signals.push({type:'bull',icon:'\u25b2',text:'VCP Breakout pattern detected \u2014 Minervini Stage 2 setup with volume dry-up.'});
      if(sc.indexOf('Multibagger')>=0||sc.indexOf('\uD83C\uDFC6')>=0)signals.push({type:'bull',icon:'\u25b2',text:'Multibagger screener \u2014 high growth potential, strong earnings trajectory.'});
    });
    if(!signals.length)signals.push({type:'neut',icon:'\u25c6',text:'Identified by '+s.screeners.length+' independent screener(s) with Signal Score '+s.uss+'/100.'});
    var html='<div class="dr-section"><div class="dr-section-title">\uD83C\uDF0D Signal Overview</div><div class="dr-grid">'
      +dm('Ticker',s.ticker,'NSE India','')
      +dm('Price',s.price?'\u20B9'+Number(s.price).toLocaleString('en-IN',{maximumFractionDigits:2}):'\u2014','','')
      +dm('Signal Score',s.uss+'/100','USS Rating',s.uss>=50?'pos':s.uss>=30?'':'neg')
      +dm('Conviction',s.screeners.length+'/5 Screeners','',s.screeners.length>=3?'pos':'')
      +'</div></div>';
    html+='<div class="dr-section"><div class="dr-section-title">\uD83C\uDFF7\uFE0F Screener Signals</div>';
    for(var i=0;i<signals.length;i++)html+='<div class="dr-signal '+signals[i].type+'"><span class="ds-icon">'+signals[i].icon+'</span><span>'+signals[i].text+'</span></div>';
    html+='</div>';
    html+='<div class="dr-section"><div class="dr-section-title">\uD83E\uDDE0 AI Deep Analysis</div>'
      +'<div id="dr-ai-box" class="dr-ai-box loading">Enter your API key to get AI-powered cross-screener analysis.</div>'
      +'<div id="dr-ai-error" class="dr-ai-error" style="display:none"></div>'
      +'<div style="margin-bottom:6px"><select id="dr-provider-select" onchange="drChangeProvider()" style="width:100%;background:var(--s3);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;font-size:.78rem;cursor:pointer">'
      +Object.keys(DR_PROVIDERS).map(function(k){return'<option value="'+k+'">'+DR_PROVIDERS[k].label+'</option>';}).join('')
      +'</select></div>'
      +'<div style="margin-bottom:6px"><select id="dr-model-select" style="width:100%;background:var(--s3);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;font-size:.78rem;cursor:pointer"></select></div>'
      +'<div class="dr-ai-key-row"><input type="password" class="dr-ai-key-input" id="dr-key-input" placeholder="Paste API key"><button class="dr-ai-key-btn" onclick="drRunWithKey()">Analyse \u2736</button></div>'
      +'<div style="font-size:.62rem;color:var(--t3);margin-top:5px">Get free key at <a id="dr-key-link" href="https://console.groq.com/keys" target="_blank" rel="noopener" style="color:var(--gn)">console.groq.com</a> \u00b7 Stored only in your browser</div>'
      +'</div>';
    return html;
  }
  function runAIAnalysis(s,apiKey,provId,model){
    var prov=DR_PROVIDERS[provId]||DR_PROVIDERS.groq;if(!model)model=prov.models[0].id;
    localStorage.setItem('dr_model.'+provId,model);
    var box=document.getElementById('dr-ai-box');var errEl=document.getElementById('dr-ai-error');
    if(!box)return;box.className='dr-ai-box loading';box.textContent='\u29D7 Analysing '+s.name+'\u2026';errEl.style.display='none';
    var prompt='You are a professional Indian stock market analyst. Analyse this NSE-listed stock identified by '+s.screeners.length+' out of 5 algorithmic screeners (Signal Score: '+s.uss+'/100).\n\n'
      +'STOCK: '+s.name+' ('+s.ticker+') | '+(s.sector||'NSE India')+'\n'
      +'Current Price: \u20B9'+(s.price?s.price.toFixed(2):'N/A')+' | Signal Score: '+s.uss+'/100\n'
      +'Screeners: '+s.screeners.join(', ')+'\n\n'
      +'**WHY MULTIPLE SCREENERS?**\nExplain what convergence across these screeners tells us.\n\n'
      +'**BUSINESS QUALITY**\nBusiness model, sector position, competitive moat.\n\n'
      +'**GROWTH THESIS**\nKey earnings growth drivers.\n\n'
      +'**KEY RISKS**\nTop 2-3 risks.\n\n'
      +'**CATALYST**\nNear-term triggers for stock re-rating.\n\n'
      +'**VERDICT**: [CONVICTION BUY / ACCUMULATE / WATCHLIST / AVOID] \u2014 [one sentence]';
    apiKey=String(apiKey).replace(/[^\x20-\x7E]/g,'');
    if(!apiKey){box.className='dr-ai-box';errEl.style.display='block';errEl.textContent='\u26A0\uFE0F API key is invalid.';return;}
    var fUrl,fBody,fH={'Content-Type':'application/json'};
    if(provId==='gemini'){fUrl='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(apiKey);fBody=JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.65,maxOutputTokens:1024}});}
    else if(provId==='openrouter'){fUrl='https://openrouter.ai/api/v1/chat/completions';fH['Authorization']='Bearer '+apiKey;fH['HTTP-Referer']='https://amitiyer99.github.io/watchlist-app/';fBody=JSON.stringify({model:model,messages:[{role:'user',content:prompt}],temperature:0.65,max_tokens:1024});}
    else{fUrl='https://api.groq.com/openai/v1/chat/completions';fH['Authorization']='Bearer '+apiKey;fBody=JSON.stringify({model:model,messages:[{role:'user',content:prompt}],temperature:0.65,max_tokens:1024});}
    fetch(fUrl,{method:'POST',headers:fH,body:fBody}).then(function(r){if(!r.ok)return r.json().then(function(e){throw new Error((e.error&&(e.error.message||JSON.stringify(e.error)))||'API error '+r.status);});return r.json();}).then(function(data){var text=provId==='gemini'?(data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts&&data.candidates[0].content.parts[0]&&data.candidates[0].content.parts[0].text):(data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content);if(!text)throw new Error('Empty response');box.className='dr-ai-box';box.innerHTML=text.replace(/\*\*([^*]+)\*\*/g,'<strong style="color:var(--gn);display:block;margin-top:12px;margin-bottom:4px">$1</strong>').replace(/\n\n/g,'</p><p style="margin:4px 0">').replace(/\n/g,'<br>').replace(/^/,'<p style="margin:0">').replace(/$/,'</p>');}).catch(function(err){box.className='dr-ai-box';box.innerHTML='<span style="opacity:.5">Could not generate analysis.</span>';errEl.style.display='block';errEl.textContent='\u26A0\uFE0F '+err.message;});
  }
})();
<\/script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('⚡  Signal Confluence · Multi-Screener Overlay');
  console.log('────────────────────────────────────────────────\n');

  console.log('[1/3] Loading sidecar JSONs from 5 screeners…');
  const screenerData = SCREENERS.map(loadSidecar);
  SCREENERS.forEach((sc, i) => console.log(`  ${sc.label}: ${screenerData[i].length} stocks`));

  console.log('\n[2/3] Building ticker map & cross-referencing…');
  const map = buildMap(screenerData);
  const stocks = Array.from(map.values());

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
  console.log(`  5/5 screeners (🏆)   : ${stats.perfect}`);

  console.log('\n[3/3] Generating HTML…');
  if (!fs.existsSync(path.join(__dirname, 'docs'))) fs.mkdirSync(path.join(__dirname, 'docs'));
  const tuPath = path.join(__dirname, 'ticker-urls.json');
  const tickerUrls = fs.existsSync(tuPath) ? JSON.parse(fs.readFileSync(tuPath, 'utf8')) : {};
  const html = buildHtml(stocks, stats, Date.now(), tickerUrls);
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  console.log(`\n  ✅  Written: ${OUTPUT_PATH}\n\nDone.\n`);
}

main().catch(err => { console.error('\nFatal:', err); process.exit(1); });

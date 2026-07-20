'use strict';

const { HUB_NAV_LINK } = require('./lib/hub-nav');
const stockActions = require('./lib/stock-actions');

// Right-Time Trigger Layer.
//
// Inputs:
//   - docs/regime.json          (bear/bull gate from lib/regime.js)
//   - docs/breakout2-data.json  (primary: pivot, atr14, volSurgeConfirmed, breakoutValid…)
//   - docs/apex-tickers.json    (APEX BUY/BUILD anchor + sector/name fallback)
//   - docs/live-prices.json     (intraday quote for live triggers)
//   - docs/multibagger-tickers.json (optional MBF score)
//   - docs/confluence-data.json / *-tickers.json (optional)
//   - ticker-urls.json          (URL lookup)
//
// Output:
//   - docs/triggers.json   (machine-readable trigger feed used by monitor.js + UIs)
//   - docs/triggers.html   (timestamped, sized, gated entries)
//   - screener-outcomes.json append (signalSource = 'triggers')

const fs   = require('fs');
const path = require('path');
const { loadRegime } = require('./lib/regime');
const { planTrade, suggestSizePct, DEFAULTS: SIG_DEF } = require('./lib/signals');
const { appendOutcomes, todayIST } = require('./lib/outcomes');
const { getMult } = require('./lib/weights');
const { loadEarnings, earningsWithin } = require('./lib/earnings');

const EARNINGS_BLACKOUT_DAYS = 5;   // no fresh entries within N days of results (gap risk)
const MIN_ADV20 = 2e7;              // ₹2 Cr/day median traded value — below this slippage eats the edge
const LIVE_STALE_HOURS = 3;         // live-prices.json older than this can't confirm a LIVE_BREAKOUT

// Reliability weights for the composite blend (neutral 1.0 until learned).
const W_BREAKOUT = getMult('breakout2', '*', 1);
const W_APEX     = getMult('apex', '*', 1);

const DOCS         = path.join(__dirname, 'docs');
const B2_PATH      = path.join(DOCS, 'breakout2-data.json');
const APEX_PATH    = path.join(DOCS, 'apex-tickers.json');
const LIVE_PATH    = path.join(DOCS, 'live-prices.json');
const MBF_PATH     = path.join(DOCS, 'multibagger-tickers.json');
const IR_PATH      = path.join(DOCS, 'indianresearch-tickers.json');
const CREAMY_PATH  = path.join(DOCS, 'creamy-tickers.json');
const ROCKET_PATH  = path.join(DOCS, 'rocket-tickers.json');
const TURL_PATH    = path.join(__dirname, 'ticker-urls.json');
const WL_PATH      = path.join(__dirname, 'my-watchlists.json');
const OUT_JSON     = path.join(DOCS, 'triggers.json');
const OUT_HTML     = path.join(DOCS, 'triggers.html');

function readJson(p, fallback = null) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback; }
  catch (e) { console.warn(`  could not read ${path.basename(p)}: ${e.message}`); return fallback; }
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtPrice = p => p == null ? '—' : '₹' + Number(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v, d = 1) => v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(d) + '%';

function loadWatchlistTickers() {
  try {
    if (!fs.existsSync(WL_PATH)) return new Set();
    const arr = JSON.parse(fs.readFileSync(WL_PATH, 'utf8'));
    const out = new Set();
    for (const wl of arr) {
      const data = wl.periods && (wl.periods['3M'] || wl.periods['1M'] || wl.periods['1Y']);
      if (!data || !Array.isArray(data.stocks)) continue;
      for (const s of data.stocks) {
        const parts = (s.name || '').split('\n');
        const t = parts[1];
        if (t) out.add(t);
      }
    }
    return out;
  } catch { return new Set(); }
}

function classifyTier(score) {
  if (score >= 90) return { tier: 'Elite',    cls: 'tier-elite' };
  if (score >= 75) return { tier: 'High',     cls: 'tier-high' };
  if (score >= 60) return { tier: 'Standard', cls: 'tier-mid' };
  return                  { tier: 'Watch',    cls: 'tier-low' };
}

// Build trigger rows from the breakout2 universe + cross-screener tags.
function buildTriggers({ b2, apex, mbf, ir, creamy, rocket, livePrices, liveFresh, earningsData, regime, urlMap, watchTickers }) {
  const apexMap   = new Map(apex.map(r => [r.ticker, r]));
  const mbfMap    = new Map(mbf.map(r  => [r.ticker, r]));
  const irMap     = new Map(ir.map(r   => [r.ticker, r]));
  const creamyMap = new Map(creamy.map(r => [r.ticker, r]));
  const rocketMap = new Map(rocket.map(r => [r.ticker, r]));

  const isBear = !!regime.isBearMarket;
  const minScore = isBear ? 70 : 55;

  const triggers = [];
  let skippedEarnings = 0, skippedIlliquid = 0, skippedExtended = 0;
  for (const r of b2) {
    if (r.score == null || r.score < minScore) continue;
    if (!r.stage2 || !r.vcpPass) continue;          // require Minervini setup
    if (r.breakoutFailed) continue;                  // never trigger on a failed break
    if (r.pivot == null || r.price == null) continue;

    // Liquidity floor: paper edge on illiquid names is fake — impact cost eats it.
    if (r.adv20 != null && r.adv20 < MIN_ADV20) { skippedIlliquid++; continue; }

    // Earnings blackout: no fresh entries right before results (binary gap risk).
    if (earningsData && earningsWithin(earningsData, r.ticker, EARNINGS_BLACKOUT_DAYS)) { skippedEarnings++; continue; }

    const live = livePrices[r.ticker] || null;
    const livePx = live && typeof live.p === 'number' ? live.p : null;
    const eod = r.price;
    // Entry priorities:
    //   1. Live trigger      → live close >= pivot AND live > prev close (intraday confirmation)
    //      — only when live-prices.json is fresh; a days-old quote must not "confirm" a breakout
    //   2. EOD valid breakout → r.breakoutValid (2-bar hold)
    //   3. Surge today        → r.volSurgeConfirmed (one-bar surge above pivot)
    let signalType = null, trigPx = null, basis = null;
    if (liveFresh && livePx != null && livePx >= r.pivot && (live.prev == null || livePx > live.prev)) {
      signalType = 'LIVE_BREAKOUT'; trigPx = livePx; basis = 'live';
    } else if (r.breakoutValid) {
      signalType = 'BREAKOUT_VALID'; trigPx = eod; basis = 'eod';
    } else if (r.volSurgeConfirmed) {
      signalType = 'VOL_SURGE'; trigPx = eod; basis = 'eod';
    } else {
      continue; // not yet triggered — still a setup
    }

    // Structural target: 52-week high when it sits meaningfully above the pivot,
    // else a measured move (pivot + 1× the base depth proxy). Gives planTrade a
    // real price objective so its R:R gate measures something.
    let structTarget = null;
    if (r.high52 != null && r.high52 > r.pivot * 1.03) structTarget = r.high52;

    const plan = planTrade({ entry: trigPx, pivot: r.pivot, atr14: r.atr14, regime, structTarget });
    if (!plan) continue;
    if (!plan.meetsRR) continue;                     // real filter when structTarget exists
    if (plan.tooExtended) { skippedExtended++; continue; } // don't chase entries far above pivot

    const sizePct = suggestSizePct({ entry: plan.entry, stop: plan.stop });

    // Confluence tags
    const apexRow = apexMap.get(r.ticker);
    const tags = [];
    if (apexRow) {
      if (apexRow.action === 'BUY')   tags.push({ k: 'APEX',  v: 'BUY',  cls: 'tag-buy' });
      else if (apexRow.action === 'BUILD') tags.push({ k: 'APEX', v: 'BUILD', cls: 'tag-build' });
    }
    if (mbfMap.has(r.ticker))    tags.push({ k: 'MBF',     v: '✓', cls: 'tag-mbf' });
    if (irMap.has(r.ticker))     tags.push({ k: 'IR',      v: '✓', cls: 'tag-ir' });
    if (creamyMap.has(r.ticker)) tags.push({ k: 'CREAMY',  v: '✓', cls: 'tag-creamy' });
    if (rocketMap.has(r.ticker)) tags.push({ k: 'ROCKET',  v: '✓', cls: 'tag-rocket' });
    if (watchTickers.has(r.ticker)) tags.push({ k: 'WL',   v: '★', cls: 'tag-wl' });

    const breakoutScore = r.score;
    const apexScore     = apexRow ? apexRow.score : null;
    const confluence    = tags.filter(t => ['APEX','MBF','IR','CREAMY','ROCKET'].includes(t.k)).length;

    // Composite conviction score (out of 100). Adaptive layer: the technical and
    // fundamental legs are weighted by each source screener's realized reliability,
    // then the whole score is scaled by this signal type's track record (e.g. live
    // breakouts have historically underperformed valid EOD breaks). All clamped 0.5-1.5.
    let conviction = breakoutScore * 0.5 * W_BREAKOUT;          // technical
    if (apexScore != null) conviction += apexScore * 0.3 * W_APEX; // fundamental
    conviction += confluence * 4;                  // overlap bonus (max +20)
    if (r.breakoutValid) conviction += 5;
    if (r.volSurgeConfirmed) conviction += 5;
    if (isBear) conviction -= 10;                  // global risk discount
    conviction *= getMult('triggers', signalType, 1);
    conviction = Math.max(0, Math.min(100, Math.round(conviction)));

    const tierInfo = classifyTier(conviction);

    triggers.push({
      ticker:    r.ticker,
      name:      r.name || (apexRow && apexRow.name) || r.ticker,
      sector:    r.sector || (apexRow && apexRow.sector) || null,
      url:       urlMap[r.ticker] || (apexRow && apexRow.url) || null,
      signalType,
      basis,
      conviction,
      tier:      tierInfo.tier,
      tierCls:   tierInfo.cls,
      breakoutScore,
      apexScore,
      apexAction: apexRow ? apexRow.action : null,
      rsRating:  r.rsRating ?? null,
      pivot:     r.pivot,
      eodPrice:  eod,
      livePrice: livePx,
      entry:     plan.entry,
      stop:      plan.stop,
      target:    plan.target,
      rr:        plan.rr,
      riskPct:   plan.riskPct,
      sizePct,
      atr14:     r.atr14,
      atrPct:    r.atrPct,
      pctBelowPivot: r.pctBelowPivot,
      volSurgeConfirmed: !!r.volSurgeConfirmed,
      volSurgePct: r.volSurgePct ?? null,
      breakoutValid: !!r.breakoutValid,
      stage2: !!r.stage2,
      vcpPass: !!r.vcpPass,
      inWatchlist: watchTickers.has(r.ticker),
      tags,
      confluence,
    });
  }

  triggers.sort((a, b) => b.conviction - a.conviction);
  if (skippedEarnings || skippedIlliquid || skippedExtended) {
    console.log(`  Gates: ${skippedEarnings} earnings-blackout, ${skippedIlliquid} illiquid (<₹${MIN_ADV20 / 1e7} Cr ADV), ${skippedExtended} too extended`);
  }
  return triggers;
}

// HTML rendering — small, mobile-friendly, dark theme matching the rest of the site.
function buildHtml({ triggers, regime, generatedAt }) {
  const isBear = regime.isBearMarket;
  const banner = isBear
    ? `<div class="regime-bar regime-bear">🐻 <b>BEAR REGIME</b> — Nifty ${regime.price?.toFixed(0)} below EMA26 ${regime.ema26} · 22D ${fmtPct(regime.ret22D)}. Triggers gated tighter (R:R ≥ ${SIG_DEF.minRRBear}, score ≥ 70).</div>`
    : `<div class="regime-bar regime-bull">🐂 <b>BULL REGIME</b> — Nifty ${regime.price?.toFixed(0)} vs EMA26 ${regime.ema26} · 22D ${fmtPct(regime.ret22D)}. Standard gates active.</div>`;

  const rowsHtml = triggers.map(t => {
    const tagsHtml = t.tags.map(g => `<span class="tag ${g.cls}">${esc(g.k)}${g.v ? ' ' + esc(g.v) : ''}</span>`).join('');
    const ttUrl = t.url || `https://www.tickertape.in/stocks/${(t.name || t.ticker).toLowerCase().replace(/\s+ltd$/, '').replace(/\s+/g, '-')}-${t.ticker}`;
    const sigBadge = t.signalType === 'LIVE_BREAKOUT'
      ? '<span class="sig sig-live">🟢 LIVE break</span>'
      : t.signalType === 'BREAKOUT_VALID'
        ? '<span class="sig sig-valid">✅ Valid EOD</span>'
        : '<span class="sig sig-surge">🌊 Surge</span>';
    return `<tr data-ticker="${esc(t.ticker.toLowerCase())}" data-name="${esc((t.name||'').toLowerCase())}" data-tier="${esc(t.tier)}" data-signal="${esc(t.signalType)}" data-wl="${t.inWatchlist?'1':'0'}">
      <td>
        <div class="stock">
          <div class="name-row">
            <a class="ticker" href="${esc(ttUrl)}" target="_blank" rel="noopener">${esc(t.name)}</a>
            ${stockActions.buttonsHtml({ ticker: t.ticker, name: t.name, price: t.entry || t.livePrice || t.eodPrice })}
          </div>
          <div class="sub">${esc(t.ticker)}${t.sector ? ' · '+esc(t.sector) : ''}${t.inWatchlist?' · <span class="wl">★ WL</span>':''}</div>
          <div class="tags">${sigBadge} ${tagsHtml}</div>
        </div>
      </td>
      <td class="num"><span class="conv ${t.tierCls}">${t.conviction}</span><div class="sub">${esc(t.tier)}</div></td>
      <td class="num">${fmtPrice(t.entry)}<div class="sub">live ${fmtPrice(t.livePrice ?? t.eodPrice)}</div></td>
      <td class="num">${fmtPrice(t.pivot)}<div class="sub">${t.pctBelowPivot != null && t.pctBelowPivot >= 0 ? fmtPct(-t.pctBelowPivot) : (t.pctBelowPivot != null ? fmtPct(-t.pctBelowPivot) : '—')}</div></td>
      <td class="num stop">${fmtPrice(t.stop)}<div class="sub">-${t.riskPct}%</div></td>
      <td class="num targ">${fmtPrice(t.target)}<div class="sub">R:R ${t.rr}</div></td>
      <td class="num">${t.sizePct != null ? t.sizePct + '%' : '—'}<div class="sub">of portfolio</div></td>
      <td class="num">${t.atr14 != null ? fmtPrice(t.atr14) : '—'}<div class="sub">${t.atrPct != null ? t.atrPct.toFixed(1) + '% atr' : ''}</div></td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Triggers — Right-Time Entry</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0c0c10;--s1:#12121a;--s2:#181822;--bd:#23232f;--t1:#e4e4ea;--t2:#9a9aa6;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--am:#f59e0b;--vi:#a855f7;--bl:#60a5fa}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--t1);font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:0;font-size:14px}
.header{background:var(--s1);border-bottom:1px solid var(--bd);padding:18px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.header h1{margin:0;font-size:1.2rem;display:flex;align-items:center;gap:10px}
.header .sub{color:var(--t2);font-size:.78rem}
.nav-links{display:flex;gap:8px;flex-wrap:wrap}
.nav-links a{color:var(--t2);text-decoration:none;font-size:.78rem;padding:4px 10px;border:1px solid var(--bd);border-radius:6px}
.nav-links a:hover{color:var(--t1);background:var(--s2)}
.regime-bar{padding:10px 24px;font-size:.85rem;border-bottom:1px solid var(--bd)}
.regime-bull{background:rgba(34,197,94,.08);color:#bbf7d0}
.regime-bear{background:rgba(239,68,68,.10);color:#fecaca}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;padding:14px 24px;background:var(--s1);border-bottom:1px solid var(--bd)}
.stat{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 12px}
.stat .v{font-size:1.3rem;font-weight:700}
.stat .l{color:var(--t2);font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.controls{padding:12px 24px;background:var(--bg);border-bottom:1px solid var(--bd);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.controls input{background:var(--s2);border:1px solid var(--bd);color:var(--t1);padding:8px 12px;border-radius:8px;font-size:.85rem;flex:1;min-width:200px}
.fbtn{background:var(--s2);border:1px solid var(--bd);color:var(--t1);padding:6px 12px;border-radius:8px;font-size:.78rem;cursor:pointer}
.fbtn.active{background:#0ea5e9;border-color:#0284c7;color:#fff}
.fbtn:hover{background:var(--s1)}
table{width:100%;border-collapse:collapse}
thead{background:var(--s1);position:sticky;top:0;z-index:2}
th{text-align:left;padding:10px 12px;font-size:.7rem;color:#7dd3fc;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--bd);font-weight:700}
td{padding:12px;border-bottom:1px solid var(--bd);vertical-align:top}
tr.hide{display:none}
.num{text-align:right;font-variant-numeric:tabular-nums}
.stop{color:#fca5a5}
.targ{color:#86efac}
.stock .ticker{color:var(--t1);font-weight:700;text-decoration:none;font-size:.95rem}
.stock .sub{color:var(--t2);font-size:.72rem;margin-top:2px}
.stock .tags{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px}
.wl{color:var(--am)}
.tag{display:inline-block;font-size:.65rem;font-weight:700;padding:1px 6px;border-radius:4px;letter-spacing:.04em;text-transform:uppercase}
.tag-buy{background:rgba(34,197,94,.18);color:#22c55e;border:1px solid rgba(34,197,94,.4)}
.tag-build{background:rgba(245,158,11,.18);color:#f59e0b;border:1px solid rgba(245,158,11,.4)}
.tag-mbf{background:rgba(96,165,250,.18);color:#60a5fa;border:1px solid rgba(96,165,250,.4)}
.tag-ir{background:rgba(168,85,247,.18);color:#c084fc;border:1px solid rgba(168,85,247,.4)}
.tag-creamy{background:rgba(236,72,153,.18);color:#f9a8d4;border:1px solid rgba(236,72,153,.4)}
.tag-rocket{background:rgba(239,68,68,.18);color:#fca5a5;border:1px solid rgba(239,68,68,.4)}
.tag-wl{background:rgba(245,158,11,.18);color:#fbbf24;border:1px solid rgba(245,158,11,.4)}
.sig{display:inline-block;font-size:.65rem;font-weight:700;padding:1px 8px;border-radius:4px;letter-spacing:.04em}
.sig-live{background:#15803d;color:#dcfce7}
.sig-valid{background:#0e7490;color:#cffafe}
.sig-surge{background:#7c2d12;color:#fed7aa}
.conv{display:inline-block;width:42px;text-align:center;padding:4px 0;border-radius:6px;font-weight:800;font-size:1rem}
.tier-elite{background:#7c2d12;color:#fbbf24;border:1px solid #f59e0b}
.tier-high{background:#0e7490;color:#7dd3fc;border:1px solid #06b6d4}
.tier-mid{background:#1e3a8a;color:#bfdbfe;border:1px solid #60a5fa}
.tier-low{background:#374151;color:#d1d5db;border:1px solid #6b7280}
.empty{padding:48px 24px;text-align:center;color:var(--t2)}
.footer{padding:16px 24px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd)}
@media (max-width:680px){
  th:nth-child(8),td:nth-child(8),th:nth-child(7),td:nth-child(7){display:none}
}
${stockActions.css}
</style></head>
<body>
<div class="header">
  <h1>🎯 Triggers <span class="sub">Right-Time Entry Layer · ${esc(generatedAt)} IST</span></h1>
  <div class="nav-links">
    ${HUB_NAV_LINK}
    <a href="index.html">Dashboard</a>
    <a href="confluence.html">Confluence</a>
    <a href="breakout2.html">Breakout</a>
    <a href="apex.html">APEX</a>
    <a href="debate.html">Debate</a>
    <a href="prediction.html">Prediction</a>
  </div>
</div>
${banner}
<div class="stats">
  <div class="stat"><div class="v">${triggers.length}</div><div class="l">Active triggers</div></div>
  <div class="stat"><div class="v">${triggers.filter(t=>t.signalType==='LIVE_BREAKOUT').length}</div><div class="l">Live breakouts</div></div>
  <div class="stat"><div class="v">${triggers.filter(t=>t.signalType==='BREAKOUT_VALID').length}</div><div class="l">Valid EOD</div></div>
  <div class="stat"><div class="v">${triggers.filter(t=>t.signalType==='VOL_SURGE').length}</div><div class="l">Vol surges</div></div>
  <div class="stat"><div class="v">${triggers.filter(t=>t.apexAction==='BUY').length}</div><div class="l">APEX BUY ∩</div></div>
  <div class="stat"><div class="v">${triggers.filter(t=>t.inWatchlist).length}</div><div class="l">In watchlist</div></div>
</div>
<div class="controls">
  <input id="q" placeholder="Search ticker or name…">
  <button class="fbtn active" data-f="all">All</button>
  <button class="fbtn" data-f="LIVE_BREAKOUT">🟢 Live</button>
  <button class="fbtn" data-f="BREAKOUT_VALID">✅ EOD Valid</button>
  <button class="fbtn" data-f="VOL_SURGE">🌊 Surge</button>
  <button class="fbtn" data-f="Elite">Elite tier</button>
  <button class="fbtn" data-f="High">High tier</button>
  <button class="fbtn" data-f="wl">★ My WL</button>
</div>
${triggers.length ? `<table>
  <thead><tr>
    <th>Stock & Signal</th>
    <th class="num">Conviction</th>
    <th class="num">Entry</th>
    <th class="num">Pivot</th>
    <th class="num">Stop</th>
    <th class="num">Target</th>
    <th class="num">Size%</th>
    <th class="num">ATR14</th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>` : `<div class="empty">No active triggers right now. Setups become triggers when the live or EOD price closes above pivot with volume confirmation. Check <a href="breakout2.html" style="color:#7dd3fc">breakout2.html</a> for setups still forming.</div>`}
<div class="footer">
  Entry = first confirmed close above pivot · Stop = pivot − ${SIG_DEF.stopAtrMult}×ATR(14) · Target = entry + ${SIG_DEF.targetRRMult}×(entry−stop) · Size% = risk budget ${SIG_DEF.riskBudgetPct}% ÷ stop loss% (capped at ${SIG_DEF.maxPctPerName}%/name). Bear regime tightens R:R floor to ${SIG_DEF.minRRBear} and suppresses score &lt; 70.
  <br>Not financial advice. Validate manually before placing orders.
</div>
${stockActions.bannerHtml}
${stockActions.modalHtml}
${stockActions.researchModalHtml}
<script>
${stockActions.setupScript}
${stockActions.js}
(function(){
  var q=document.getElementById('q');
  var rows=Array.from(document.querySelectorAll('tbody tr'));
  var activeF='all';
  function apply(){
    var term=(q.value||'').trim().toLowerCase();
    rows.forEach(function(r){
      var ok=true;
      if(activeF==='all'){} else if(activeF==='wl') ok = r.dataset.wl==='1';
      else if(activeF==='Elite'||activeF==='High') ok = r.dataset.tier===activeF;
      else ok = r.dataset.signal===activeF;
      if(ok && term){ ok = r.dataset.ticker.includes(term)||r.dataset.name.includes(term); }
      r.classList.toggle('hide', !ok);
    });
  }
  q && q.addEventListener('input', apply);
  document.querySelectorAll('.fbtn').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('.fbtn').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active'); activeF=b.dataset.f; apply();
    });
  });
})();
</script>
</body></html>`;
}

async function main() {
  console.log('Building triggers...');
  const regime = loadRegime();
  if (!regime.available) console.warn('  regime.json not available — FAIL-CLOSED: bear gates active');
  else if (regime.degraded) console.warn(`  regime.json ${regime.degradedReason} — keeping last known regime (${regime.isBearMarket ? 'BEAR' : 'BULL'})`);

  const b2Raw    = readJson(B2_PATH, []) || [];
  const apex     = readJson(APEX_PATH, []) || [];
  const mbf      = readJson(MBF_PATH, []) || [];
  const ir       = readJson(IR_PATH, []) || [];
  const creamy   = readJson(CREAMY_PATH, []) || [];
  const rocket   = readJson(ROCKET_PATH, []) || [];
  const liveRaw  = readJson(LIVE_PATH, { prices: {} }) || { prices: {} };
  const livePrices = liveRaw.prices || {};
  // Staleness check: a LIVE_BREAKOUT confirmed against a days-old quote is fiction.
  let liveFresh = false;
  const liveTs = liveRaw.ts || (liveRaw.generatedAt ? new Date(liveRaw.generatedAt).getTime() : null);
  if (liveTs) {
    const ageH = (Date.now() - liveTs) / 3.6e6;
    liveFresh = isFinite(ageH) && ageH <= LIVE_STALE_HOURS;
    if (!liveFresh) console.warn(`  live-prices.json is ${ageH.toFixed(1)}h old — LIVE_BREAKOUT confirmation disabled this run`);
  } else {
    console.warn('  live-prices.json has no timestamp — LIVE_BREAKOUT confirmation disabled this run');
  }
  const earningsData = loadEarnings();
  if (!earningsData) console.warn('  earnings-calendar.json not available — earnings blackout inactive');
  const urlMap = readJson(TURL_PATH, {}) || {};
  const watchTickers = loadWatchlistTickers();

  // Detect old (compact) breakout2 sidecars and warn so the operator knows to regen
  if (b2Raw.length && b2Raw[0].pivot === undefined) {
    console.warn('  breakout2-data.json missing pivot/atr14/breakoutValid fields — regenerate via `npm run breakout2` to populate. Skipping trigger build.');
    return { triggers: [], skipped: true };
  }

  const triggers = buildTriggers({
    b2: b2Raw, apex, mbf, ir, creamy, rocket, livePrices, liveFresh, earningsData,
    regime, urlMap, watchTickers,
  });

  // Persist machine-readable feed
  const payload = {
    generatedAt: new Date().toISOString(),
    regime: { isBearMarket: regime.isBearMarket, ema26: regime.ema26, price: regime.price, ret22D: regime.ret22D },
    counts: {
      total: triggers.length,
      live: triggers.filter(t => t.signalType === 'LIVE_BREAKOUT').length,
      valid: triggers.filter(t => t.signalType === 'BREAKOUT_VALID').length,
      surge: triggers.filter(t => t.signalType === 'VOL_SURGE').length,
    },
    triggers,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));

  // HTML
  const generatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  fs.writeFileSync(OUT_HTML, buildHtml({ triggers, regime, generatedAt }));

  // Append to outcome ledger (one row per trigger, deduped per day+ticker+signalType)
  const date = todayIST();
  const rows = triggers.map(t => ({
    date,
    screener: 'triggers',
    signalType: t.signalType,
    ticker: t.ticker,
    name: t.name,
    sector: t.sector,
    entry: t.entry,
    pivot: t.pivot,
    stop: t.stop,
    target: t.target,
    rr: t.rr,
    sizePct: t.sizePct,
    score: t.conviction,
    regime: regime.isBearMarket ? 'BEAR' : 'BULL',
    extras: {
      breakoutScore: t.breakoutScore,
      apexScore: t.apexScore,
      apexAction: t.apexAction,
      rsRating: t.rsRating,
      confluence: t.confluence,
      tier: t.tier,
      basis: t.basis,
    },
  }));
  const lg = appendOutcomes(rows);
  console.log(`  Outcomes: +${lg.added} added (${lg.skipped} dupes/skipped, ${lg.total} total)`);

  console.log(`Triggers: ${triggers.length} total | live:${payload.counts.live} eod-valid:${payload.counts.valid} surge:${payload.counts.surge}`);
  console.log(`Wrote ${OUT_JSON} and ${OUT_HTML}`);
  return payload;
}

if (require.main === module) main().catch(e => { console.error('Error:', e); process.exit(1); });
module.exports = { main };

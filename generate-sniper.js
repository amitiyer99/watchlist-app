'use strict';

// ── Sniper · The Only Trades Worth Taking ─────────────────────────────────────
// Philosophy: the OPPOSITE of confluence's breadth. Forward-tested outcome data
// (docs/screener-stats.json) shows exactly two signals with real positive alpha:
//   triggers/VOL_SURGE       72% hit, +3.98% median 20d alpha  (n=25)
//   triggers/BREAKOUT_VALID  58% hit, +1.70% median 20d alpha  (n=33)
// Everything else is noise or negative. So this page shows ONLY trigger rows
// carrying one of those two confirmations, gated by market regime and ranked
// with FII/DII institutional buying as the conviction kicker. Usually 0-5 names.
// An empty page is a feature: no qualifying setup = no trade today.
//
// Inputs (all read-only, produced by other generators):
//   docs/triggers.json        — trade plans w/ volSurgeConfirmed / breakoutValid
//   docs/regime.json          — bear-market gate (edge was negative in bear)
//   docs/deals.json           — FII/DII bulk/block buying (lib/institutions)
//   docs/screener-stats.json  — live proof panel (the page shows its own evidence)
// Output: docs/sniper.html + sniper outcomes appended to the forward ledger.

const { HUB_BACK_LINK } = require('./lib/hub-nav');
const stockActions = require('./lib/stock-actions');
const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');
const { fmtPrice, esc } = require('./lib/format');
const { loadDeals } = require('./lib/smartmoney');
const { aggregate: aggregateInst } = require('./lib/institutions');
const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'docs', 'sniper.html');
const INST_WINDOW_DAYS = 90;
const MAX_SHOTS = 5;

function loadJson(rel, fallback = null) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8')); }
  catch { return fallback; }
}

// ── Qualification ─────────────────────────────────────────────────────────────
// A trigger row qualifies as a "shot" only via the two proven confirmations.
function qualify(t) {
  if (t.volSurgeConfirmed) return { grade: 'A', label: 'VOL SURGE', why: 'Breakout confirmed on surging volume — the single best-performing signal in this system’s forward tests (72% hit rate, +3.98% median 20-day alpha vs Nifty).' };
  if (t.breakoutValid)     return { grade: 'B', label: 'VALID BREAKOUT', why: 'Price cleared the pivot with the breakout checklist fully valid (58% hit rate, +1.70% median 20-day alpha in forward tests).' };
  return null;
}

function rankKey(s) {
  // Grade first (A over B), then fundamentals-pass, then marquee-investor backing,
  // then institutional tier, then conviction. Fundamentals + superstar ownership on
  // top of a technical breakout is the strongest "quality stock that yields fast" setup.
  const g = s.grade === 'A' ? 0 : 1;
  const fund = s.fund ? 0 : 1;
  const mq = s.marquee ? 0 : 1;
  const it = s.inst ? (s.inst.tier === 'BOTH' ? 0 : 1) : 2;
  return g * 10000 + fund * 1000 + mq * 100 + it * 10 - Math.min(9, (s.conviction || 0) / 12);
}

// ── Stats proof panel ─────────────────────────────────────────────────────────
function proofRows(stats) {
  if (!stats || !Array.isArray(stats.stats)) return [];
  const want = [ ['triggers', 'VOL_SURGE'], ['triggers', 'BREAKOUT_VALID'], ['sniper', '*'] ];
  const out = [];
  for (const [scr, sig] of want) {
    const s = stats.stats.find(x => x.screener === scr && x.signalType === sig && x.horizon === '20d');
    if (s && s.count) out.push(s);
  }
  return out;
}

// ── HTML ──────────────────────────────────────────────────────────────────────
// ── 🧠 modal data panel ───────────────────────────────────────────────────────
// Sniper only lists proven setups, so the modal leads with the grade, the exact trade
// plan and the confirmations, then the AI view.
function sniperPanel(s, enterBy, eta) {
  const metrics = [
    { label: 'Grade', val: s.grade === 'A' ? 'A — ' + s.label : s.label, sub: 'proven-signal tier', cls: s.grade === 'A' ? 'pos' : '' },
    { label: 'RS Rating', val: s.rsRating != null ? String(s.rsRating) : '—', sub: 'relative strength', cls: (s.rsRating || 0) >= 80 ? 'pos' : '' },
    { label: 'Entry ≤', val: fmtPrice(s.entry) },
    { label: 'Stop', val: fmtPrice(s.stop), sub: s.riskPct != null ? '-' + s.riskPct + '%' : '', cls: 'neg' },
    { label: 'Target', val: fmtPrice(s.target), cls: 'pos' },
    { label: 'Reward : Risk', val: s.rr != null ? String(s.rr) : '—', cls: (s.rr || 0) >= 2 ? 'pos' : '' },
    { label: 'Position Size', val: s.sizePct != null ? s.sizePct + '%' : '—', sub: 'of portfolio' },
    { label: 'Enter By', val: enterBy || '—', sub: eta && eta !== '—' ? 'ETA ' + eta : '' },
  ];
  const signals = [];
  if (s.why) signals.push({ tone: 'bull', icon: '🎯', text: s.why });
  if (s.stage2) signals.push({ tone: 'bull', icon: '▲', text: 'Stage-2 uptrend confirmed' });
  if (s.vcpPass) signals.push({ tone: 'bull', icon: '▲', text: 'Volatility-contraction base (VCP) confirmed' });
  if (s.inst) signals.push({ tone: 'bull', icon: '🏦', text: (s.inst.tier === 'BOTH' ? 'FII + DII' : s.inst.tier) + ' bought ₹' + Math.round(s.inst.totalValueCr) + 'Cr via bulk/block deals' });
  if (s.marquee) signals.push({ tone: 'bull', icon: '🏆', text: s.marquee.count + ' marquee investor(s) hold this' + (s.marquee.adds ? ' · ' + s.marquee.adds + ' added recently' : '') });
  if (s.fund) signals.push({ tone: 'bull', icon: '📊', text: 'Clears your own fundamental screen(s): ' + (s.fund.screens || []).join(', ') });
  return [
    { title: '🎯 Setup & Trade Plan', metrics },
    ...(signals.length ? [{ title: '📉 Confirmations', signals }] : []),
  ];
}

function buildHtml({ shots, nearMisses, regime, proof, dealsAge, generatedAt }) {
  const genTime = new Date(generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const bear = !!(regime && regime.isBearMarket);

  const shotCard = (s, i) => {
    const gradeColour = s.grade === 'A' ? '#22c55e' : '#eab308';
    const inst = s.inst;
    const instBadge = inst
      ? `<span class="badge tip" tabindex="0" style="color:#14b8a6;border-color:#14b8a666;background:rgba(20,184,166,.12)" data-tip="Institutional buying (last ${INST_WINDOW_DAYS}d bulk/block deals): ₹${inst.totalValueCr}Cr · ${inst.tier === 'BOTH' ? 'both FIIs and DIIs' : inst.tier + ' only'}${[...(inst.fiiNames||[]),...(inst.diiNames||[])].slice(0,3).map(n=>' · '+n).join('')}">🏦 ${inst.tier === 'BOTH' ? 'FII+DII' : inst.tier} ₹${Math.round(inst.totalValueCr)}Cr</span>`
      : '';
    const fund = s.fund;
    const fundBadge = fund
      ? `<span class="badge tip" tabindex="0" style="color:#0ea5e9;border-color:#0ea5e966;background:rgba(14,165,233,.12)" data-tip="Also clears your Screener.in fundamental screen(s): ${esc((fund.screens || []).join(', '))}${fund.metrics && fund.metrics.roce != null ? ' · ROCE ' + fund.metrics.roce + '%' : ''}${fund.metrics && fund.metrics.debtEquity != null ? ' · D/E ' + fund.metrics.debtEquity : ''}. Technical breakout + your own quality filter = the strongest setup.">📊 Fundamentals ✓${fund.screenCount > 1 ? ' ×' + fund.screenCount : ''}</span>`
      : '';
    const mq = s.marquee;
    const mqBadge = mq
      ? `<span class="badge tip" tabindex="0" style="color:#ec4899;border-color:#ec489966;background:rgba(236,72,153,.12)" data-tip="Held by ${mq.count} marquee investor(s): ${esc((mq.investors || []).map(function(i){return i.name.split(' (')[0] + ' ' + i.pct + '%';}).join(', '))}${mq.adds ? ' · ' + mq.adds + ' added recently' : ''}. Superstar money is already in this name.">⭐ ${mq.count} Investor${mq.count > 1 ? 's' : ''}${mq.adds ? ' ▲' : ''}</span>`
      : '';
    const timing = s.timing || {};
    const enterBy = timing.enterBy ? new Date(timing.enterBy).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—';
    const eta = (timing.etaWeeksLow && timing.etaWeeksHigh) ? `${timing.etaWeeksLow}–${timing.etaWeeksHigh} wk` : '—';
    return `
  <div class="shot">
    <div class="shot-rank" style="color:${gradeColour}">#${i + 1}</div>
    <div class="shot-main">
      <div class="shot-head">
        <span class="grade tip" tabindex="0" style="color:${gradeColour};border-color:${gradeColour}66;background:${gradeColour}1a" data-tip="${esc(s.why)}">${s.grade === 'A' ? '🎯' : '✅'} ${esc(s.label)}</span>
        ${fundBadge}
        ${mqBadge}
        ${instBadge}
        ${s.stage2 ? '<span class="badge dim">Stage 2 ✓</span>' : ''}${s.vcpPass ? '<span class="badge dim">VCP ✓</span>' : ''}
        ${s.rsRating != null ? `<span class="badge dim">RS ${s.rsRating}</span>` : ''}
      </div>
      <div class="shot-name">
        <a class="stock-link" href="${esc(s.url || 'https://www.tickertape.in/stocks/' + s.ticker)}" target="_blank" rel="noopener">${esc(s.name)}</a>
        ${stockActions.buttonsHtml({ ticker: s.ticker, name: s.name, price: s.entry || 0, panel: sniperPanel(s, enterBy, eta) })}
        <span class="ticker-sub">${esc(s.ticker)}${s.sector ? ' · ' + esc(s.sector) : ''}</span>
      </div>
      <div class="plan">
        <div class="pv"><span class="pl">Entry ≤</span><span class="pn">${fmtPrice(s.entry)}</span></div>
        <div class="pv"><span class="pl">Now</span><span class="pn" data-live-px="${esc(s.ticker)}">${fmtPrice(s.entry)}</span></div>
        <div class="pv"><span class="pl">Stop</span><span class="pn" style="color:#ef4444">${fmtPrice(s.stop)}</span></div>
        <div class="pv"><span class="pl">Target</span><span class="pn" style="color:#22c55e">${fmtPrice(s.target)}</span></div>
        <div class="pv"><span class="pl">R:R</span><span class="pn">${s.rr != null ? s.rr : '—'}</span></div>
        <div class="pv"><span class="pl">Risk</span><span class="pn">${s.riskPct != null ? s.riskPct + '%' : '—'}</span></div>
        <div class="pv"><span class="pl">Size</span><span class="pn">${s.sizePct != null ? s.sizePct + '%' : '—'}</span></div>
        <div class="pv"><span class="pl">Enter by</span><span class="pn">${esc(enterBy)}</span></div>
        <div class="pv"><span class="pl">ETA</span><span class="pn">${esc(eta)}</span></div>
      </div>
    </div>
  </div>`;
  };

  const missRow = (t) => {
    const missing = [];
    if (!t.volSurgeConfirmed) missing.push(`volume surge (now ${t.volSurgePct != null ? t.volSurgePct + '% of the 1.5× bar' : 'unconfirmed'})`);
    if (!t.breakoutValid) missing.push('full breakout validity');
    return `<tr>
      <td><a class="stock-link" href="${esc(t.url || '#')}" target="_blank" rel="noopener">${esc(t.name)}</a> <span class="ticker-sub">${esc(t.ticker)}</span></td>
      <td class="num">${fmtPrice(t.entry)}</td>
      <td class="num">${fmtPrice(t.pivot)}</td>
      <td>${esc('Needs ' + missing.join(' + '))}</td>
    </tr>`;
  };

  const proofTable = proof.length ? `
<div class="proof">
  <div class="proof-title">Why only these signals? Live forward-test evidence (20-day horizon, non-overlapping episodes)</div>
  <table class="proof-tbl">
    <thead><tr><th>Signal</th><th class="num">n</th><th class="num">Hit rate</th><th class="num">Median alpha</th><th class="num">Median return</th><th class="num tip" tabindex="0" data-tip="Median trading days for winners to reach +5% from entry — appears once the nightly validator has accumulated speed data.">Days to +5%</th></tr></thead>
    <tbody>${proof.map(p => `<tr>
      <td>${esc(p.screener + ' / ' + p.signalType)}</td>
      <td class="num">${p.count}</td>
      <td class="num">${p.hitRate != null ? p.hitRate + '%' : '—'}</td>
      <td class="num" style="color:${(p.medianAlpha || 0) > 0 ? '#22c55e' : '#ef4444'}">${p.medianAlpha != null ? (p.medianAlpha > 0 ? '+' : '') + p.medianAlpha + '%' : '—'}</td>
      <td class="num">${p.medianRet != null ? (p.medianRet > 0 ? '+' : '') + p.medianRet + '%' : '—'}</td>
      <td class="num">${p.medianDaysTo5 != null ? p.medianDaysTo5 + 'd' : '—'}</td>
    </tr>`).join('')}</tbody>
  </table>
</div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sniper · The Only Trades Worth Taking</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--s1:#0f0f17;--s2:#13131e;--tx:#e2e8f0;--t2:#94a3b8;--t3:#64748b;--ac:#22c55e;--bd:rgba(34,197,94,.18)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);line-height:1.5;min-height:100vh}
.header{background:rgba(10,10,15,.92);border-bottom:1px solid var(--bd);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.15rem}.header .sub{color:var(--t3);font-size:.8rem}
.back-link{font-size:.8rem;text-decoration:none;border:1px solid;border-radius:8px;padding:6px 12px}
.wrap{max-width:980px;margin:0 auto;padding:20px 16px 60px}
.regime{border-radius:12px;padding:14px 18px;margin-bottom:18px;font-size:.9rem;border:1px solid}
.regime.ok{background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.3);color:#86efac}
.regime.bear{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.4);color:#fca5a5}
.shot{display:flex;gap:14px;background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:18px;margin-bottom:14px}
.shot-rank{font-size:1.6rem;font-weight:800;min-width:44px;text-align:center;padding-top:4px}
.shot-main{flex:1;min-width:0}
.shot-head{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center}
.grade{font-weight:700;font-size:.8rem;padding:3px 10px;border-radius:20px;border:1px solid}
.badge{font-size:.72rem;padding:2px 8px;border-radius:12px;border:1px solid rgba(148,163,184,.25);color:var(--t2)}
.badge.dim{color:var(--t3)}
.shot-name{font-size:1.05rem;font-weight:600;margin-bottom:10px}
.stock-link{color:var(--tx);text-decoration:none}.stock-link:hover{color:var(--ac)}
.ticker-sub{color:var(--t3);font-size:.78rem;font-weight:400;margin-left:6px}
.plan{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px}
.pv{background:var(--s2);border-radius:8px;padding:8px 10px;text-align:center}
.pl{display:block;color:var(--t3);font-size:.68rem;text-transform:uppercase;letter-spacing:.04em}
.pn{font-weight:700;font-size:.92rem}
.empty{background:var(--s1);border:1px dashed rgba(148,163,184,.3);border-radius:14px;padding:36px;text-align:center;color:var(--t2);margin-bottom:18px}
.empty .big{font-size:2rem;margin-bottom:8px}
h2{font-size:.95rem;color:var(--t2);margin:26px 0 10px;text-transform:uppercase;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{color:var(--t3);text-align:left;font-size:.72rem;text-transform:uppercase;padding:8px 10px;border-bottom:1px solid var(--bd)}
td{padding:9px 10px;border-bottom:1px solid rgba(148,163,184,.08)}
.num{text-align:right}
th.num{text-align:right}
.proof{background:var(--s1);border:1px solid rgba(148,163,184,.15);border-radius:12px;padding:16px;margin-top:26px}
.proof-title{font-size:.8rem;color:var(--t2);margin-bottom:10px}
.proof-tbl td,.proof-tbl th{padding:6px 10px}
.legend{background:var(--s1);border:1px solid rgba(148,163,184,.15);border-radius:12px;padding:12px 16px;margin-bottom:18px;font-size:.85rem;color:var(--t2)}
.legend summary{cursor:pointer;color:var(--tx);font-weight:600}
.legend h4{margin:10px 0 4px;color:var(--tx);font-size:.82rem}
.legend-chip{padding:2px 8px;border-radius:10px;font-size:.78rem}
.footer{color:var(--t3);font-size:.75rem;text-align:center;margin-top:34px}
${TOOLTIP_CSS}
${stockActions.css}
</style>
</head>
<body>
<div class="header">
  <div><h1>🎯 Sniper</h1><div class="sub">The only trades worth taking — max ${MAX_SHOTS}, usually fewer, often none</div></div>
  ${HUB_BACK_LINK}
</div>
<div class="wrap">

${bear
  ? `<div class="regime bear"><strong>🐻 Bear regime — stand down.</strong> Nifty is below its 26-week EMA. In backtests this system's breakout edge was <em>negative</em> in bear phases, so qualifying setups (if any) are listed for watching, not entering.</div>`
  : `<div class="regime ok"><strong>🟢 Regime clear.</strong> Nifty above its 26-week EMA — breakout setups are playable per the backtested rules.</div>`}

${legendHtml('How Sniper works (click to expand)', [
  { title: 'The idea', bodyHtml: '<p>Every other page in this system <i>widens</i> the funnel; Sniper inverts it. Out of ~15,000 forward-tracked signals, only two setups showed real positive alpha: a breakout confirmed by a <b>volume surge</b> (72% hit rate) and a fully <b>valid breakout</b> (58%). Sniper shows only trigger stocks carrying one of those two confirmations, ranked with FII/DII institutional buying as the kicker. No qualifying setup = an empty page = no trade today. That is the discipline.</p>' },
  { title: 'Grades', bodyHtml: '<p><span class="legend-chip" style="background:rgba(34,197,94,.15);color:#22c55e">🎯 VOL SURGE</span> grade-A: pivot break on ≥1.5× average volume. <span class="legend-chip" style="background:rgba(234,179,8,.15);color:#eab308">✅ VALID BREAKOUT</span> grade-B: full breakout checklist passed, volume not yet surging. <span class="legend-chip" style="background:rgba(14,165,233,.15);color:#0ea5e9">📊 Fundamentals ✓</span> also clears one of your own Screener.in quality screens — ranked <i>above</i> institutions, because a breakout in a fundamentally sound name is the "quality that yields fast" ideal. <span class="legend-chip" style="background:rgba(20,184,166,.15);color:#14b8a6">🏦 FII/DII</span> institutions bought this name in bulk/block deals within 90 days.</p>' },
  { title: 'Execution', bodyHtml: '<p>Each card is a complete plan: buy at or below <b>Entry</b>, hard stop at <b>Stop</b> (2×ATR), book at <b>Target</b> (1.5R), position size as shown. <b>Enter by</b> is the expiry — a breakout not entered within a week of triggering is a chase. Expect resolution in the ETA window; forward data says nothing here works in 5 days, so give it the full ~4 weeks unless stopped.</p>' },
  { title: 'Caveats', bodyHtml: '<p>Sample sizes behind the proof table are still small (n=25/33) and grow nightly. Sniper tracks its own forward outcomes as an independent screener, so this page will display its own live hit rate as evidence accumulates. Not investment advice.</p>' },
])}

${shots.length
  ? shots.map(shotCard).join('')
  : `<div class="empty"><div class="big">🚫🎯</div><strong>No shot today.</strong><br>No trigger stock currently has a volume-surge or fully-valid breakout confirmation.<br>The edge comes from waiting — check back after the next refresh.</div>`}

${nearMisses.length ? `
<h2>Near misses — watching, not shooting (${nearMisses.length})</h2>
<table>
  <thead><tr><th>Stock</th><th class="num">Price</th><th class="num">Pivot</th><th>What's missing</th></tr></thead>
  <tbody>${nearMisses.map(missRow).join('')}</tbody>
</table>` : ''}

${proofTable}

${stockActions.bannerHtml}
${stockActions.modalHtml}
${stockActions.researchModalHtml}
<script>${stockActions.setupScript}</script>
<script>${stockActions.js}</script>

<div class="footer">
  🎯 Sniper &middot; data-driven signal selection &middot; Generated: ${genTime} IST
  ${dealsAge != null ? `&middot; FII/DII deals data ${dealsAge}d old` : ''}<br>
  <strong>Not investment advice. Do your own research.</strong>
</div>
</div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log('🎯  Sniper · proven-signal shortlist');

  const trig = loadJson('docs/triggers.json', {});
  const triggers = Array.isArray(trig.triggers) ? trig.triggers : [];
  const regime = trig.regime || loadJson('docs/regime.json', null);
  const stats = loadJson('docs/screener-stats.json', null);
  console.log(`  ${triggers.length} trigger rows loaded · regime: ${regime && regime.isBearMarket ? 'BEAR' : 'OK'}`);

  // Institutional overlay
  let instMap = new Map(), dealsAge = null;
  try {
    const deals = loadDeals();
    if (deals && deals.updatedAt) dealsAge = Math.floor((Date.now() - new Date(deals.updatedAt)) / 864e5);
    instMap = new Map(aggregateInst(deals, { days: INST_WINDOW_DAYS }).map(r => [r.symbol.toUpperCase(), r]));
  } catch (e) { console.log(`  ⚠  institutional overlay skipped: ${e.message}`); }

  // Fundamental overlay: your own Screener.in screens (docs/screenerin-tickers.json)
  const fundSide = loadJson('docs/screenerin-tickers.json', null);
  const fundMap = new Map();
  if (fundSide && Array.isArray(fundSide.rows)) {
    for (const r of fundSide.rows) fundMap.set((r.ticker || '').toUpperCase(), r);
    console.log(`  Fundamental overlay: ${fundMap.size} stocks from ${fundSide.totalScreens || 0} Screener.in screen(s)`);
  }

  // Marquee overlay: superstar-investor holdings (docs/investors-tickers.json)
  const mqSide = loadJson('docs/investors-tickers.json', null);
  const mqMap = new Map();
  if (mqSide && Array.isArray(mqSide.rows)) {
    for (const r of mqSide.rows) mqMap.set((r.ticker || '').toUpperCase(), r);
    console.log(`  Marquee overlay: ${mqMap.size} stocks held by tracked superstar investors`);
  }

  const shots = [];
  const nearMisses = [];
  for (const t of triggers) {
    const q = qualify(t);
    if (q) {
      const key = (t.ticker || '').toUpperCase();
      const s = { ...t, ...q, inst: instMap.get(key) || null, fund: fundMap.get(key) || null, marquee: mqMap.get(key) || null };
      shots.push(s);
    } else if (t.signalType === 'LIVE_BREAKOUT') {
      nearMisses.push(t);
    }
  }
  shots.sort((a, b) => rankKey(a) - rankKey(b));
  const top = shots.slice(0, MAX_SHOTS);
  console.log(`  ${shots.length} qualifying shot(s) → showing ${top.length} · ${nearMisses.length} near-miss(es)`);

  const html = buildHtml({ shots: top, nearMisses, regime, proof: proofRows(stats), dealsAge, generatedAt: Date.now() });
  if (!fs.existsSync(path.join(__dirname, 'docs'))) fs.mkdirSync(path.join(__dirname, 'docs'));
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  console.log(`  ✅  Written: ${OUTPUT_PATH}`);

  // Forward ledger: sniper validates itself as an independent screener.
  // Bear-regime days emit nothing (the gate IS part of the strategy being tested).
  if (top.length && !(regime && regime.isBearMarket)) {
    try {
      const { appendOutcomes, todayIST } = require('./lib/outcomes');
      const date = todayIST();
      appendOutcomes(top.map(s => ({
        date,
        screener: 'sniper',
        signalType: s.grade === 'A' ? 'SNIPER_VOLSURGE' : 'SNIPER_VALID',
        ticker: s.ticker,
        name: s.name || s.ticker,
        sector: s.sector || null,
        entry: s.entry || null,
        pivot: s.pivot || null,
        stop: s.stop || null,
        target: s.target || null,
        rr: s.rr || null,
        sizePct: s.sizePct || null,
        score: s.conviction || null,
        regime: 'BULL',
        extras: { inst: s.inst ? s.inst.tier : null, instValueCr: s.inst ? s.inst.totalValueCr : null },
      })));
    } catch (e) { console.log(`  ⚠  outcome append skipped: ${e.message}`); }
  }
  console.log('Done.');
}

if (require.main === module) main();
module.exports = { main, qualify };

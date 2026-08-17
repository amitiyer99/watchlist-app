'use strict';

// ── Compounder cohort ─────────────────────────────────────────────────────────
// SELF-POPULATING long-horizon bucket. See lib/compounder-screen.js for the rules and the
// snapshot-as-thesis design. Nothing here is hand-maintained: the screen picks the cohort,
// snapshots each name's fundamentals on first appearance, and reports drift from that
// snapshot as the thesis-break signal.
//
// No price stops, no targets, no trailing exits — those belong to the Triggers page and
// would exit a 10x at ~1.5x. Price is shown as context only.
//
// Output: docs/compounders.html
//         docs/compounder-cohort.json   (cohort state — written by this script)
//         docs/compounder-log.jsonl     (quarterly snapshots, append-only)

const fs = require('fs');
const path = require('path');
const { HUB_BACK_LINK } = require('./lib/hub-nav');
const stockActions = require('./lib/stock-actions');
const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');
const { fmtPrice, esc } = require('./lib/format');
const { loadLivePrices } = require('./lib/live-prices');
const { buildCohort, saveCohort, RULES, DRIFT } = require('./lib/compounder-screen');

const OUT_HTML = path.join(__dirname, 'docs', 'compounders.html');
const LOG_PATH = path.join(__dirname, 'docs', 'compounder-log.jsonl');

function main() {
  const live = loadLivePrices();
  const { state, rows, added, dropped, eligibleCount } = buildCohort({ livePrices: live.prices });
  saveCohort(state);

  // One row per ticker per quarter — a long-horizon record, not a daily log.
  try {
    const q = `${new Date().getFullYear()}Q${Math.floor(new Date().getMonth() / 3) + 1}`;
    const seen = new Set();
    try {
      for (const line of fs.readFileSync(LOG_PATH, 'utf8').split('\n')) {
        if (line.trim()) { const j = JSON.parse(line); seen.add(j.quarter + '|' + j.ticker); }
      }
    } catch { /* first run */ }
    const add = rows.filter(r => !seen.has(q + '|' + r.ticker)).map(r => JSON.stringify({
      quarter: q, date: new Date().toISOString().slice(0, 10), ticker: r.ticker,
      price: r.price, entryPrice: r.entryPrice, mult: r.mult != null ? +r.mult.toFixed(2) : null,
      roe: r.now ? r.now.roe : null, debtEquity: r.now ? r.now.debtEquity : null,
      promoterHolding: r.now ? r.now.promoterHolding : null, flags: r.flags.length,
      stillQualifies: r.stillQualifies,
    }));
    if (add.length) { fs.appendFileSync(LOG_PATH, add.join('\n') + '\n'); console.log(`  Logged ${add.length} snapshot(s) for ${q}`); }
  } catch (e) { console.warn('  snapshot log failed:', e.message); }

  fs.writeFileSync(OUT_HTML, buildHtml(rows, { added, dropped, eligibleCount }), 'utf8');
  const flagged = rows.filter(r => r.flags.length).length;
  console.log(`Compounders: ${rows.length} in cohort (${eligibleCount} eligible) · +${added.length} new · ${dropped.length} left the screen · ${flagged} with drift → ${OUT_HTML}`);
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function metricRow(label, entryV, nowV, fmt = v => v, tip = '') {
  if (entryV == null && nowV == null) return '';
  const changed = entryV != null && nowV != null && Math.abs(nowV - entryV) > 0.001;
  const dir = changed ? (nowV > entryV ? 'up' : 'down') : '';
  return `<div class="m">
    <div class="ml${tip ? ' tip' : ''}"${tip ? ` tabindex="0" data-tip="${esc(tip)}"` : ''}>${label}</div>
    <div class="mv">${nowV != null ? fmt(nowV) : '—'}</div>
    <div class="me ${dir}">${entryV != null ? 'entry ' + fmt(entryV) : ''}</div>
  </div>`;
}

function card(r) {
  const state = r.flags.some(f => f.sev === 'bad') ? 'broken'
    : r.flags.length ? 'watch'
    : !r.stillQualifies ? 'left'
    : 'intact';
  const S = {
    intact: ['st-ok', '✓ thesis intact', 'Every entry metric still holds. The correct action is to do nothing.'],
    watch:  ['st-warn', '⚠ drifting', 'One or more entry metrics have deteriorated. Read the drift, look at the next results, decide deliberately.'],
    broken: ['st-bad', '✗ thesis broken', 'A hard break against the entry snapshot. This is the sell rule for this bucket — not a price move.'],
    left:   ['st-dim', '· left the screen', 'No longer passes the entry rules, but kept on the page: a cohort you can quietly edit teaches you nothing.'],
  }[state];

  const mult = r.mult != null ? r.mult.toFixed(2) + 'x' : '—';
  const multCls = r.mult == null ? '' : r.mult >= 2 ? 'pos' : r.mult < 0.7 ? 'neg' : '';
  const yrs = r.heldYears != null ? r.heldYears.toFixed(1) : '—';
  const cagr = (r.mult != null && r.heldYears >= 0.25) ? ((Math.pow(r.mult, 1 / r.heldYears) - 1) * 100) : null;

  return `<div class="pos ${S[0]}">
  <div class="pos-head">
    <div>
      <span class="name-row">
        <a class="tk" href="https://www.screener.in/company/${esc(r.ticker)}/" target="_blank" rel="noopener">${esc(r.name || r.ticker)}</a>
        ${stockActions.buttonsHtml({ ticker: r.ticker, name: r.name || r.ticker, price: r.price || 0, panel: panelFor(r) })}
      </span>
      <div class="sub">${esc(r.ticker)}${r.sector ? ' · ' + esc(r.sector) : ''} · in cohort since ${esc(r.addedOn)} (${yrs} yr)${r.mbfNow != null ? ' · MBF ' + r.mbfNow : ''}${r.hasQuarterly ? '' : ' · <span class="tip" tabindex="0" data-tip="No quarterly results linked for this ticker yet, so drift is judged on the annual metrics only. The earnings fetch adds cohort names over successive runs.">annual data only</span>'}</div>
    </div>
    <div class="pos-state tip" tabindex="0" data-tip="${esc(S[2])}">${S[1]}</div>
  </div>

  <div class="mgrid">
    <div class="m"><div class="ml">Since entry</div><div class="mv ${multCls}">${mult}</div><div class="me">${cagr != null ? cagr.toFixed(0) + '%/yr' : ''}</div></div>
    <div class="m"><div class="ml">Price</div><div class="mv" data-live-px="${esc(r.ticker)}">${fmtPrice(r.price)}</div><div class="me">entry ${fmtPrice(r.entryPrice)}</div></div>
    ${metricRow('ROE', r.entry.roe, r.now ? r.now.roe : null, v => v + '%', 'Return on equity — the engine of compounding. A sustained fall is the clearest thesis break there is.')}
    ${metricRow('D/E', r.entry.debtEquity, r.now ? r.now.debtEquity : null, v => v, 'Debt to equity. Growth bought with debt is a different, worse proposition than growth funded internally.')}
    ${metricRow('Promoter', r.entry.promoterHolding, r.now ? r.now.promoterHolding : null, v => v + '%', 'Promoter holding. The people who know the business best reducing their stake is the signal that most rewards paying attention.')}
    ${metricRow('EPS CAGR 5y', r.entry.epsGrowth5Y, r.now ? r.now.epsGrowth5Y : null, v => v + '%', 'Five-year earnings growth record. A 10x over 8 years needs about 33%/yr from earnings growth and re-rating combined.')}
  </div>

  <div class="thesis"><span class="lbl tip" tabindex="0" data-tip="Generated from the fundamentals at first appearance in the screen — no writing required. The snapshot IS the thesis, which is what makes the break checkable.">Thesis at entry</span> ${esc(r.thesis)}</div>
  ${r.flags.length ? `<div class="flags">${r.flags.map(f => `<div class="flag ${f.sev}">${esc(f.text)}</div>`).join('')}</div>` : ''}
  ${!r.stillQualifies && r.leftScreenOn ? `<div class="flag warn">Dropped out of the entry screen on ${esc(r.leftScreenOn)} — kept here so the record stays honest.</div>` : ''}
</div>`;
}

function panelFor(r) {
  const cagr = (r.mult != null && r.heldYears >= 0.25) ? ((Math.pow(r.mult, 1 / r.heldYears) - 1) * 100) : null;
  const metrics = [
    { label: 'Since entry', val: r.mult != null ? r.mult.toFixed(2) + 'x' : '—', sub: cagr != null ? cagr.toFixed(0) + '%/yr' : '', cls: (r.mult || 0) >= 2 ? 'pos' : '' },
    { label: 'In cohort since', val: r.addedOn, sub: r.heldYears.toFixed(1) + ' years' },
    { label: 'ROE', val: r.now && r.now.roe != null ? r.now.roe + '%' : '—', sub: r.entry.roe != null ? 'entry ' + r.entry.roe + '%' : '' },
    { label: 'D/E', val: r.now && r.now.debtEquity != null ? String(r.now.debtEquity) : '—', sub: r.entry.debtEquity != null ? 'entry ' + r.entry.debtEquity : '' },
    { label: 'Promoter', val: r.now && r.now.promoterHolding != null ? r.now.promoterHolding + '%' : '—', sub: r.entry.promoterHolding != null ? 'entry ' + r.entry.promoterHolding + '%' : '' },
    { label: 'EPS CAGR 5y', val: r.now && r.now.epsGrowth5Y != null ? r.now.epsGrowth5Y + '%' : '—', sub: 'need ~33%/yr for 10x in 8 years' },
  ];
  const signals = r.flags.map(f => ({ tone: f.sev === 'bad' ? 'bear' : 'neut', icon: f.sev === 'bad' ? '✗' : '⚠', text: f.text }));
  if (!r.flags.length) signals.push({ tone: 'bull', icon: '✓', text: 'No drift from the entry snapshot — thesis intact, do nothing' });
  signals.push({ tone: 'neut', icon: '◆', text: 'Long-horizon holding: price drawdowns are NOT a sell signal here. Only fundamental drift is.' });
  return [{ title: '🌱 Cohort Position', metrics }, { title: '📉 Thesis Health', signals }];
}

function buildHtml(rows, { added, dropped, eligibleCount }) {
  const live = rows.filter(r => r.stillQualifies);
  const intact = rows.filter(r => !r.flags.length && r.stillQualifies).length;
  const watch = rows.filter(r => r.flags.length && !r.flags.some(f => f.sev === 'bad')).length;
  const broken = rows.filter(r => r.flags.some(f => f.sev === 'bad')).length;
  const mults = rows.map(r => r.mult).filter(v => v != null).sort((a, b) => b - a);
  const equalWeight = live.length ? (100 / live.length).toFixed(1) : null;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Compounders — self-populating long-horizon cohort</title>
<style>
:root{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#22c55e;--tx:#e8e8f0;--t2:#9898b0;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--yw:#eab308}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx)}
.header{background:var(--s1);border-bottom:1px solid var(--bd);padding:18px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.header h1{font-size:1.3rem}.header h1 span{color:var(--ac)}
.header .sub{font-size:.76rem;color:var(--t2);margin-top:3px}
.back-link{color:var(--t2);text-decoration:none;font-size:.78rem;padding:5px 11px;border:1px solid var(--bd);border-radius:6px;margin-left:6px}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
main{max-width:1150px;margin:0 auto;padding:20px 18px 60px}
.warnbox{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.28);border-radius:10px;padding:14px 16px;font-size:.83rem;line-height:1.65;margin-bottom:16px}
.warnbox h3{font-size:.9rem;color:var(--ac);margin-bottom:6px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.stat{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:11px 15px;min-width:104px}
.stat .v{font-size:1.3rem;font-weight:700}.stat .l{font-size:.64rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.pos{background:var(--s1);border:1px solid var(--bd);border-left-width:3px;border-radius:10px;padding:14px 16px;margin-bottom:12px}
.pos.st-ok{border-left-color:var(--gn)}.pos.st-warn{border-left-color:var(--yw)}.pos.st-bad{border-left-color:var(--rd)}.pos.st-dim{border-left-color:var(--t3);opacity:.72}
.pos-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.tk{color:var(--tx);font-weight:700;font-size:1rem;text-decoration:none}.tk:hover{color:var(--ac)}
.name-row{display:inline-flex;align-items:center;gap:3px}
.sub{font-size:.71rem;color:var(--t3);margin-top:3px}
.pos-state{font-size:.71rem;font-weight:700;padding:3px 9px;border-radius:5px;white-space:nowrap;cursor:help}
.st-ok .pos-state{background:rgba(34,197,94,.12);color:var(--gn)}
.st-warn .pos-state{background:rgba(234,179,8,.12);color:var(--yw)}
.st-bad .pos-state{background:rgba(239,68,68,.12);color:var(--rd)}
.st-dim .pos-state{background:var(--s3);color:var(--t3)}
.mgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:7px;margin-top:11px}
.m{background:var(--s2);border-radius:7px;padding:7px 10px}
.ml{font-size:.6rem;color:var(--t3);text-transform:uppercase;letter-spacing:.04em}
.mv{font-size:.92rem;font-weight:600;margin-top:2px}
.mv.pos{color:var(--gn)}.mv.neg{color:var(--rd)}
.me{font-size:.6rem;color:var(--t3);margin-top:1px}
.me.up{color:#86efac}.me.down{color:#fca5a5}
.thesis{font-size:.8rem;color:var(--t2);line-height:1.55;margin-top:11px}
.lbl{font-size:.6rem;text-transform:uppercase;letter-spacing:.05em;color:var(--ac);font-weight:700;margin-right:6px;cursor:help}
.flags{margin-top:10px;display:flex;flex-direction:column;gap:5px}
.flag{font-size:.77rem;padding:7px 10px;border-radius:6px;line-height:1.45}
.flag.warn{background:rgba(234,179,8,.07);border:1px solid rgba(234,179,8,.25);color:#eab308}
.flag.bad{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.25);color:#f87171}
h2.sec{font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:var(--t2);margin:22px 0 10px;font-weight:700}
.footer{text-align:center;padding:22px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd);margin-top:26px}
${stockActions.css}
${TOOLTIP_CSS}
</style></head>
<body>
<div class="header">
  <div>
    <h1>🌱 <span>Compounders</span></h1>
    <div class="sub">Self-populating cohort · thesis = the fundamentals at entry · sold on drift, never on price · ${live.length} live of ${rows.length} tracked</div>
  </div>
  <div>
    <a href="multibagger.html" class="back-link">🏆 Multibagger</a>
    <a href="triggers.html" class="back-link">🎯 Triggers</a>
    <a href="playbook.html" class="back-link">📘 Playbook</a>
    ${HUB_BACK_LINK}
  </div>
</div>
<main>
  <div class="warnbox">
    <h3>How this page works — and why it has no stop losses</h3>
    The screen picks this cohort itself from your existing data: <b>ROE ≥ ${RULES.roeMin}%, D/E ≤ ${RULES.deMax}, promoter ≥ ${RULES.promoterMin}%,
    5-year EPS CAGR ≥ ${RULES.eps5yMin}%, market cap ₹${RULES.mcapMin}&ndash;${RULES.mcapMax.toLocaleString('en-IN')} Cr</b>, liquid enough to trade &mdash;
    ranked by MBF score, top ${RULES.cohortSize}. The first time a name qualifies its fundamentals are <b>snapshot</b>, and that snapshot <b>is</b> the thesis,
    so nothing needs writing. A thesis break is then measurable: ROE down ${DRIFT.roeDropPp}pp from entry, debt appearing, promoters selling ${DRIFT.promoterDropPp}pp,
    growth decaying, or a quarter of shrinking sales.<br><br>
    There are deliberately <b>no price stops, targets or trailing exits</b>. A stock that multiplies 10x draws down 30&ndash;50% more than once;
    the exit rules that make <a href="triggers.html" style="color:#7dd3fc">Triggers</a> work would take you out at about 1.5x every time.
    Price here is context, never a signal. <b>This is a research cohort, not a portfolio</b> &mdash; what you buy and how much is your decision.
  </div>

  <div class="stats">
    <div class="stat"><div class="v">${live.length}</div><div class="l tip" tabindex="0" data-tip="Cohort size ${RULES.cohortSize}, chosen from ${eligibleCount} eligible names. The power-law maths wants enough positions to catch the 1-2 that matter.">In cohort</div></div>
    <div class="stat"><div class="v" style="color:var(--gn)">${intact}</div><div class="l">Thesis intact</div></div>
    <div class="stat"><div class="v" style="color:var(--yw)">${watch}</div><div class="l">Drifting</div></div>
    <div class="stat"><div class="v" style="color:var(--rd)">${broken}</div><div class="l">Broken</div></div>
    <div class="stat"><div class="v">${mults.length ? mults[0].toFixed(1) + 'x' : '—'}</div><div class="l tip" tabindex="0" data-tip="Your best name. In a power-law cohort this one tends to dominate the total return.">Best</div></div>
    <div class="stat"><div class="v">${equalWeight ? equalWeight + '%' : '—'}</div><div class="l tip" tabindex="0" data-tip="Equal weight across the live cohort, as a starting frame only. Small equal starters are what make a 4-6 near-total-loss outcome survivable. Your sizing decision, not a recommendation.">Equal weight</div></div>
  </div>

  ${added.length ? `<h2 class="sec">🆕 Entered the cohort this run (${added.length})</h2>` : ''}
  ${added.length ? rows.filter(r => added.includes(r.ticker)).map(card).join('') : ''}

  <h2 class="sec">Cohort${added.length ? ' — all members' : ''}</h2>
  ${rows.length ? rows.filter(r => !added.includes(r.ticker)).map(card).join('') || '<div class="thesis">All members are new this run — listed above.</div>' : '<div class="thesis">No names currently pass the entry rules. That is a legitimate outcome; the screen will populate when one does.</div>'}

  ${legendHtml('The strategy behind this page (tap to expand)', [
    { title: 'The arithmetic', bodyHtml: '<p>A 10x over 8 years is <b>33% CAGR</b>, and it comes from earnings growth &times; re-rating. A company compounding EPS at 25% for 8 years grows earnings ~6x; if the P/E also expands 1.6&times; as the market notices, that is your 10x. Miss either leg and you get 3&ndash;4x.</p>' },
    { title: 'Why a cohort, not a few picks', bodyHtml: `<p>These portfolios follow a power law. Out of ~20 names held 7&ndash;10 years, typically 1&ndash;2 do 10x and carry the entire result, 3&ndash;5 do 2&ndash;4x, 8&ndash;10 go nowhere and 4&ndash;6 lose most of their value. You cannot know which in advance &mdash; hence ${RULES.cohortSize} names, each small enough that a total loss is survivable.</p>` },
    { title: 'The sell rule', bodyHtml: `<p>Drift from the entry snapshot, never a price move: ROE falling ${DRIFT.roeDropPp}pp below entry or under ${DRIFT.roeFloor}% outright, D/E rising ${DRIFT.dePp} above entry, promoter holding down ${DRIFT.promoterDropPp}pp, 5-year EPS CAGR decaying ${DRIFT.eps5yDropPp}pp, or a quarter of shrinking sales. A flag is a prompt to look, not an instruction to sell.</p>` },
    { title: 'What this page cannot tell you', bodyHtml: '<p>Whether the strategy works. Your outcome ledger measures 5- and 20-day horizons over about three months of history &mdash; it cannot evaluate a 5-year thesis, and no engineering fixes that. The quarterly snapshots in <code>docs/compounder-log.jsonl</code> exist so that in three years there is a real record rather than a recollection.</p><p>Note also that names dropping out of the screen are kept and marked, not deleted &mdash; a cohort you can quietly edit after the fact teaches you nothing.</p>' },
  ])}
</main>
<div class="footer">
  Compounders &middot; self-populating cohort &middot; no stops, no targets &mdash; fundamental drift only.<br>
  Not investment advice. This is a research cohort generated from public fundamentals; every buy, sell and sizing decision is yours.
</div>
${stockActions.bannerHtml}
${stockActions.modalHtml}
${stockActions.researchModalHtml}
<script>${stockActions.setupScript}
${stockActions.js}
<\/script>
</body></html>`;
}

if (require.main === module) main();
module.exports = { buildHtml };

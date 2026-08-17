'use strict';

// ── Compounder tracker ────────────────────────────────────────────────────────
// A LONG-HORIZON bucket, deliberately built on different principles from every other
// page here.
//
// Why it must be separate: this repo's exit engine (sell half at target, trail the rest on
// the 21-day EMA) is its best-validated component — backtested over 5,061 trades to beat a
// flat target exit by ~66% expectancy. It is also precisely what prevents a 10x. A stock
// that multiplies 10 times draws down 30-50% more than once and closes below its 21-EMA
// many times on the way. Applying those rules here would exit around 1.5x, every time.
//
// So this page has, by design:
//   • NO price stops, NO trailing exits, NO price targets
//   • the only sell rule is a BROKEN THESIS, judged on fundamentals over quarters
//   • progress measured in earnings, not in price
//
// Price appears only as context (multiple achieved, CAGR so far). It is never a signal.
//
// Input:  compounder-positions.json   (hand-maintained; a thesis is mandatory)
//         docs/earnings-quality.json  (13 quarters of sales/OPM/profit per ticker)
//         docs/live-prices.json       (current price, for the multiple)
// Output: docs/compounders.html
//         docs/compounder-log.jsonl   (append-only quarterly snapshots, so in 3 years you
//                                      have a real record instead of a recollection)

const fs = require('fs');
const path = require('path');
const { HUB_BACK_LINK } = require('./lib/hub-nav');
const stockActions = require('./lib/stock-actions');
const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');
const { fmtPrice, esc } = require('./lib/format');
const { loadLivePrices, livePriceOf, reconcile } = require('./lib/live-prices');

const POS_PATH  = path.join(__dirname, 'compounder-positions.json');
const EQ_PATH   = path.join(__dirname, 'docs', 'earnings-quality.json');
const OUT_HTML  = path.join(__dirname, 'docs', 'compounders.html');
const LOG_PATH  = path.join(__dirname, 'docs', 'compounder-log.jsonl');

// Thesis-break thresholds. Quarters, not days — a single soft quarter is noise.
const DECEL_QUARTERS   = 3;    // consecutive quarters of decelerating YoY growth
const OPM_DROP_PP      = 5;    // margin contraction vs the trailing-year average (pp)
const STALE_RESULT_DAYS = 150; // results older than this = we are flying blind

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

// ── Fundamental progress ──────────────────────────────────────────────────────
// YoY growth per quarter (vs the same quarter last year, so seasonality cancels).
function yoy(series) {
  const out = [];
  for (let i = 4; i < series.length; i++) {
    const now = series[i], then = series[i - 4];
    out.push(then && then > 0 ? +(((now / then) - 1) * 100).toFixed(1) : null);
  }
  return out;
}

function assess(row) {
  if (!row || !Array.isArray(row.sales) || row.sales.length < 6) return null;
  const salesYoY  = yoy(row.sales);
  const profitYoY = yoy(row.profit || []);
  const opm = row.opm || [];
  const lastOpm = opm.length ? opm[opm.length - 1] : null;
  const priorOpm = opm.length >= 5 ? +(opm.slice(-5, -1).reduce((a, b) => a + b, 0) / 4).toFixed(1) : null;

  // Deceleration = each of the last N YoY readings lower than the one before it. Requiring a
  // RUN rather than a single dip is the difference between a signal and quarterly noise.
  const recent = salesYoY.filter(v => v != null).slice(-(DECEL_QUARTERS + 1));
  let decel = recent.length === DECEL_QUARTERS + 1;
  for (let i = 1; i < recent.length && decel; i++) if (!(recent[i] < recent[i - 1])) decel = false;

  const flags = [];
  if (decel) flags.push({ sev: 'warn', text: `Sales growth decelerating ${DECEL_QUARTERS} quarters running (${recent.join('% → ')}%)` });
  if (lastOpm != null && priorOpm != null && (priorOpm - lastOpm) >= OPM_DROP_PP) {
    flags.push({ sev: 'warn', text: `Operating margin ${lastOpm}% vs ${priorOpm}% trailing-year average — ${(priorOpm - lastOpm).toFixed(1)}pp contraction` });
  }
  const lastProfit = (row.profit || []).slice(-1)[0];
  if (lastProfit != null && lastProfit < 0) flags.push({ sev: 'bad', text: 'Latest quarter posted a LOSS — the compounding thesis is on hold until this reverses' });
  const lastSalesYoY = salesYoY.filter(v => v != null).slice(-1)[0];
  if (lastSalesYoY != null && lastSalesYoY < 0) flags.push({ sev: 'bad', text: `Sales SHRANK ${Math.abs(lastSalesYoY)}% year-on-year` });

  // Stale results: we cannot judge a thesis we have no data for.
  if (row.refreshedAt) {
    const age = Math.round((Date.now() - new Date(row.refreshedAt + 'T00:00:00').getTime()) / 864e5);
    if (age > STALE_RESULT_DAYS) flags.push({ sev: 'warn', text: `Quarterly data last refreshed ${age} days ago — re-run the earnings fetch before judging this` });
  }

  return {
    salesYoY, profitYoY, opm, lastOpm, priorOpm,
    latestQuarter: row.latestQuarter || null,
    quarters: row.quarters || [],
    flags,
  };
}

// ── Position maths (context only, never a signal) ─────────────────────────────
function positionMaths(p, price) {
  const held = p.added ? Math.max(0, (Date.now() - new Date(p.added + 'T00:00:00').getTime()) / 864e5) : null;
  const years = held != null ? held / 365.25 : null;
  const mult = (price != null && p.entry > 0) ? price / p.entry : null;
  const cagr = (mult != null && years != null && years >= 0.25) ? (Math.pow(mult, 1 / years) - 1) * 100 : null;
  // What the remaining years have to deliver for a 5x / 10x by year 8 — the honest framing
  // of "am I on track", which a raw percentage gain never gives you.
  const need = (target) => {
    if (mult == null || years == null || years >= 8) return null;
    return (Math.pow(target / mult, 1 / (8 - years)) - 1) * 100;
  };
  return { held, years, mult, cagr, need5: need(5), need10: need(10) };
}

function main() {
  const cfg = readJson(POS_PATH, { positions: [] });
  const positions = Array.isArray(cfg.positions) ? cfg.positions : [];
  const eq = readJson(EQ_PATH, { rows: [] });
  const eqByTicker = new Map((eq.rows || []).map(r => [String(r.ticker).toUpperCase(), r]));
  const live = loadLivePrices();

  const rows = positions.map(p => {
    const t = String(p.ticker || '').toUpperCase();
    const livePx = livePriceOf(live.prices, t);
    const price = reconcile(p.entry, livePx);      // guards against a bad-data spike
    return {
      ...p, ticker: t,
      price, priceBasis: livePx != null ? 'live' : 'entry (no live quote for this ticker)',
      fundamentals: assess(eqByTicker.get(t)),
      maths: positionMaths(p, price),
    };
  });

  // Append a snapshot so progress is auditable years from now. Once per ticker per quarter —
  // this is a long-horizon record, not a daily log.
  try {
    const q = `${new Date().getFullYear()}Q${Math.floor(new Date().getMonth() / 3) + 1}`;
    const seen = new Set();
    try {
      for (const line of fs.readFileSync(LOG_PATH, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        seen.add(j.quarter + '|' + j.ticker);
      }
    } catch { /* first run */ }
    const add = rows
      .filter(r => !seen.has(q + '|' + r.ticker))
      .map(r => JSON.stringify({
        quarter: q, date: new Date().toISOString().slice(0, 10), ticker: r.ticker,
        price: r.price, entry: r.entry, mult: r.maths.mult != null ? +r.maths.mult.toFixed(2) : null,
        latestQuarter: r.fundamentals ? r.fundamentals.latestQuarter : null,
        salesYoY: r.fundamentals ? r.fundamentals.salesYoY.slice(-1)[0] : null,
        opm: r.fundamentals ? r.fundamentals.lastOpm : null,
        flags: r.fundamentals ? r.fundamentals.flags.length : null,
      }));
    if (add.length) fs.appendFileSync(LOG_PATH, add.join('\n') + '\n');
    if (add.length) console.log(`  Logged ${add.length} quarterly snapshot(s) for ${q}`);
  } catch (e) { console.warn('  snapshot log failed:', e.message); }

  fs.writeFileSync(OUT_HTML, buildHtml(rows, cfg), 'utf8');
  const flagged = rows.filter(r => r.fundamentals && r.fundamentals.flags.length).length;
  console.log(`Compounders: ${rows.length} position(s), ${flagged} with thesis-break flag(s) → ${OUT_HTML}`);
  if (!rows.length) console.log('  (add positions to compounder-positions.json — a written thesis is required)');
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function sparkline(vals, w = 120, h = 26) {
  const v = vals.filter(x => x != null);
  if (v.length < 2) return '';
  const min = Math.min(...v, 0), max = Math.max(...v, 0), span = (max - min) || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1)) * w},${h - ((x - min) / span) * h}`).join(' ');
  const zeroY = h - ((0 - min) / span) * h;
  const up = v[v.length - 1] >= v[0];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="vertical-align:middle">
    <line x1="0" y1="${zeroY}" x2="${w}" y2="${zeroY}" stroke="#3a3a48" stroke-width="1" stroke-dasharray="2,2"/>
    <polyline points="${pts}" fill="none" stroke="${up ? '#22c55e' : '#ef4444'}" stroke-width="1.6"/>
  </svg>`;
}

function positionCard(r) {
  const m = r.maths, f = r.fundamentals;
  const multTxt = m.mult != null ? m.mult.toFixed(2) + 'x' : '—';
  const multCls = m.mult == null ? 'dim' : m.mult >= 2 ? 'pos' : m.mult < 0.7 ? 'neg' : '';
  const yrs = m.years != null ? m.years.toFixed(1) : '—';
  const flags = f ? f.flags : [];
  const state = !f ? 'nodata' : flags.some(x => x.sev === 'bad') ? 'broken' : flags.length ? 'watch' : 'intact';
  const STATE = {
    intact:  ['st-ok',   '✓ thesis intact',    'No fundamental break detected. Do nothing — that is the strategy.'],
    watch:   ['st-warn', '⚠ review',           'One or more thesis checks are wobbling. Read the flags, look at the next quarter, decide deliberately.'],
    broken:  ['st-bad',  '✗ thesis broken',    'A hard break: losses or shrinking sales. This is the sell rule for this bucket — not a price move.'],
    nodata:  ['st-dim',  '· no quarterly data', 'No quarterly fundamentals linked for this ticker, so the thesis cannot be judged. Run the earnings fetch.'],
  }[state];

  const salesSpark = f ? sparkline(f.salesYoY) : '';
  const lastSales = f && f.salesYoY.filter(v => v != null).slice(-1)[0];
  const need = m.need10 != null
    ? `needs ${m.need10.toFixed(0)}%/yr for 10x by year 8 · ${m.need5 != null ? m.need5.toFixed(0) + '%/yr for 5x' : ''}`
    : '';

  return `<div class="pos ${STATE[0]}">
  <div class="pos-head">
    <div>
      <span class="name-row">
        <a class="tk" href="https://www.screener.in/company/${esc(r.ticker)}/" target="_blank" rel="noopener">${esc(r.ticker)}</a>
        ${stockActions.buttonsHtml({ ticker: r.ticker, name: r.ticker, price: r.price || 0, panel: compounderPanel(r) })}
      </span>
      <div class="sub">held ${yrs} yr${r.added ? ' · since ' + esc(r.added) : ''}${r.weightPct ? ' · ' + r.weightPct + '% of bucket' : ''}</div>
    </div>
    <div class="pos-state tip" tabindex="0" data-tip="${esc(STATE[2])}">${STATE[1]}</div>
  </div>

  <div class="pos-grid">
    <div class="cell"><div class="cl">Entry</div><div class="cv">${fmtPrice(r.entry)}</div></div>
    <div class="cell"><div class="cl">Now</div><div class="cv" data-live-px="${esc(r.ticker)}">${fmtPrice(r.price)}</div></div>
    <div class="cell"><div class="cl">Multiple</div><div class="cv ${multCls}">${multTxt}</div></div>
    <div class="cell"><div class="cl tip" tabindex="0" data-tip="Compound annual growth achieved so far. Shown only after 3 months — before that it is meaningless noise.">CAGR so far</div><div class="cv">${m.cagr != null ? m.cagr.toFixed(0) + '%' : '—'}</div></div>
  </div>
  ${need ? `<div class="need tip" tabindex="0" data-tip="A 10x over 8 years is 33%/yr. This is what the REMAINING years must deliver given where the position already is — the honest version of &quot;am I on track&quot;.">${esc(need)}</div>` : ''}

  ${r.thesis ? `<div class="thesis"><span class="lbl">Thesis</span> ${esc(r.thesis)}</div>` : '<div class="thesis missing">No thesis recorded — and the only sell rule here is a broken thesis, so this position cannot be managed. Add one.</div>'}
  ${r.runway ? `<div class="thesis"><span class="lbl">Reinvestment runway</span> ${esc(r.runway)}</div>` : ''}
  ${Array.isArray(r.mustStayTrue) && r.mustStayTrue.length ? `<div class="musts"><span class="lbl">Must stay true</span>${r.mustStayTrue.map(x => `<span class="must">${esc(x)}</span>`).join('')}</div>` : ''}

  ${f ? `<div class="fund">
    <div class="fund-row">
      <span class="lbl tip" tabindex="0" data-tip="Year-on-year sales growth per quarter, so seasonality cancels out. The trend matters far more than any single quarter.">Sales YoY</span>
      ${salesSpark}
      <b class="${lastSales != null && lastSales >= 0 ? 'pos' : 'neg'}">${lastSales != null ? (lastSales >= 0 ? '+' : '') + lastSales + '%' : '—'}</b>
      <span class="dim">latest ${esc(f.latestQuarter || '—')}</span>
    </div>
    <div class="fund-row">
      <span class="lbl tip" tabindex="0" data-tip="Operating margin now versus the trailing-year average. Sustained contraction usually means competition or loss of pricing power — a genuine thesis risk.">Op margin</span>
      <b>${f.lastOpm != null ? f.lastOpm + '%' : '—'}</b>
      <span class="dim">${f.priorOpm != null ? 'vs ' + f.priorOpm + '% trailing year' : ''}</span>
    </div>
  </div>` : ''}

  ${flags.length ? `<div class="flags">${flags.map(x => `<div class="flag ${x.sev}">${esc(x.text)}</div>`).join('')}</div>` : ''}
  ${r.notes ? `<div class="notes">${esc(r.notes)}</div>` : ''}
</div>`;
}

function compounderPanel(r) {
  const m = r.maths, f = r.fundamentals;
  const metrics = [
    { label: 'Multiple', val: m.mult != null ? m.mult.toFixed(2) + 'x' : '—', sub: m.years != null ? m.years.toFixed(1) + ' years held' : '', cls: (m.mult || 0) >= 2 ? 'pos' : '' },
    { label: 'CAGR so far', val: m.cagr != null ? m.cagr.toFixed(0) + '%' : '—', sub: '33%/yr = 10x in 8 years' },
    { label: 'Entry', val: fmtPrice(r.entry) },
    { label: 'Now', val: fmtPrice(r.price), sub: r.priceBasis },
    { label: 'Needed for 10x', val: m.need10 != null ? m.need10.toFixed(0) + '%/yr' : '—', sub: 'over the remaining years' },
    { label: 'Latest results', val: f && f.latestQuarter ? f.latestQuarter : '—', sub: f && f.lastOpm != null ? 'OPM ' + f.lastOpm + '%' : '' },
  ];
  const signals = (f ? f.flags : []).map(x => ({ tone: x.sev === 'bad' ? 'bear' : 'neut', icon: x.sev === 'bad' ? '✗' : '⚠', text: x.text }));
  if (f && !f.flags.length) signals.push({ tone: 'bull', icon: '✓', text: 'No fundamental break detected — the correct action is to do nothing' });
  signals.push({ tone: 'neut', icon: '◆', text: 'This is a long-horizon holding: price drawdowns are NOT a sell signal here. Only a broken thesis is.' });
  return [
    { title: '🌱 Compounder Position', metrics },
    { title: '📉 Thesis Health', signals },
  ];
}

function buildHtml(rows, cfg) {
  const intact = rows.filter(r => r.fundamentals && !r.fundamentals.flags.length).length;
  const watch  = rows.filter(r => r.fundamentals && r.fundamentals.flags.length && !r.fundamentals.flags.some(f => f.sev === 'bad')).length;
  const broken = rows.filter(r => r.fundamentals && r.fundamentals.flags.some(f => f.sev === 'bad')).length;
  const multiples = rows.map(r => r.maths.mult).filter(v => v != null).sort((a, b) => b - a);
  const best = multiples[0], median = multiples.length ? multiples[Math.floor(multiples.length / 2)] : null;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Compounders — long-horizon bucket</title>
<style>
:root{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#22c55e;--tx:#e8e8f0;--t2:#9898b0;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--yw:#eab308}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx)}
.header{background:var(--s1);border-bottom:1px solid var(--bd);padding:18px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.header h1{font-size:1.3rem}.header h1 span{color:var(--ac)}
.header .sub{font-size:.76rem;color:var(--t2);margin-top:3px}
.back-link{color:var(--t2);text-decoration:none;font-size:.78rem;padding:5px 11px;border:1px solid var(--bd);border-radius:6px;margin-left:6px}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
main{max-width:1100px;margin:0 auto;padding:20px 18px 60px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
.stat{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:11px 16px;min-width:110px}
.stat .v{font-size:1.35rem;font-weight:700}.stat .l{font-size:.66rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.pos{background:var(--s1);border:1px solid var(--bd);border-left-width:3px;border-radius:10px;padding:15px 17px;margin-bottom:13px}
.pos.st-ok{border-left-color:var(--gn)}.pos.st-warn{border-left-color:var(--yw)}.pos.st-bad{border-left-color:var(--rd)}.pos.st-dim{border-left-color:var(--t3)}
.pos-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.tk{color:var(--tx);font-weight:700;font-size:1.02rem;text-decoration:none}.tk:hover{color:var(--ac)}
.name-row{display:inline-flex;align-items:center;gap:3px}
.sub{font-size:.72rem;color:var(--t3);margin-top:3px}
.pos-state{font-size:.72rem;font-weight:700;padding:3px 9px;border-radius:5px;white-space:nowrap;cursor:help}
.st-ok .pos-state{background:rgba(34,197,94,.12);color:var(--gn)}
.st-warn .pos-state{background:rgba(234,179,8,.12);color:var(--yw)}
.st-bad .pos-state{background:rgba(239,68,68,.12);color:var(--rd)}
.st-dim .pos-state{background:var(--s3);color:var(--t3)}
.pos-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:12px 0 0}
.cell{background:var(--s2);border-radius:7px;padding:8px 11px}
.cl{font-size:.62rem;color:var(--t3);text-transform:uppercase;letter-spacing:.04em}
.cv{font-size:.95rem;font-weight:600;margin-top:2px}
.pos .pos,.pos .cv.pos{color:var(--gn)}.cv.neg{color:var(--rd)}.cv.dim{color:var(--t3)}
.need{font-size:.72rem;color:var(--t3);margin-top:8px;cursor:help}
.thesis{font-size:.82rem;color:var(--t2);line-height:1.55;margin-top:10px}
.thesis.missing{color:#fca5a5}
.lbl{font-size:.62rem;text-transform:uppercase;letter-spacing:.05em;color:var(--ac);font-weight:700;margin-right:6px}
.musts{margin-top:9px;display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.must{font-size:.7rem;background:var(--s3);border:1px solid var(--bd);border-radius:4px;padding:2px 8px;color:var(--t2)}
.fund{margin-top:12px;padding-top:11px;border-top:1px solid var(--bd);display:flex;flex-direction:column;gap:7px}
.fund-row{display:flex;align-items:center;gap:9px;font-size:.8rem;flex-wrap:wrap}
.dim{color:var(--t3);font-size:.72rem}
.pos-b b.pos,b.pos{color:var(--gn)}b.neg{color:var(--rd)}
.flags{margin-top:11px;display:flex;flex-direction:column;gap:5px}
.flag{font-size:.78rem;padding:7px 10px;border-radius:6px;line-height:1.45}
.flag.warn{background:rgba(234,179,8,.07);border:1px solid rgba(234,179,8,.25);color:#eab308}
.flag.bad{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.25);color:#f87171}
.notes{margin-top:10px;font-size:.76rem;color:var(--t3);font-style:italic}
.empty{background:var(--s1);border:1px dashed var(--bd);border-radius:10px;padding:26px;color:var(--t2);font-size:.86rem;line-height:1.7}
.empty code{background:var(--s3);padding:2px 6px;border-radius:4px;font-family:ui-monospace,Consolas,monospace}
.warnbox{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.28);border-radius:10px;padding:14px 16px;font-size:.83rem;line-height:1.65;margin-bottom:18px}
.warnbox h3{font-size:.9rem;color:var(--ac);margin-bottom:6px}
.footer{text-align:center;padding:22px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd);margin-top:26px}
${stockActions.css}
${TOOLTIP_CSS}
</style></head>
<body>
<div class="header">
  <div>
    <h1>🌱 <span>Compounders</span></h1>
    <div class="sub">Long-horizon bucket · sold on a broken thesis, never on a price move · ${rows.length} position(s)</div>
  </div>
  <div>
    <a href="triggers.html" class="back-link">🎯 Triggers</a>
    <a href="multibagger.html" class="back-link">🏆 Multibagger</a>
    <a href="playbook.html" class="back-link">📘 Playbook</a>
    ${HUB_BACK_LINK}
  </div>
</div>
<main>
  <div class="warnbox">
    <h3>Different rules apply on this page</h3>
    Everything else in this system optimises a 20-day horizon and exits on price — sell half at target, trail the rest on the 21-day EMA.
    That exit rule is the best-validated part of the system, and it is <b>exactly what prevents a 10x</b>: a stock that multiplies ten times
    will draw down 30&ndash;50% more than once and close below its 21-EMA many times along the way.
    So this bucket has no stops, no targets and no trailing exits. Progress is judged in <b>earnings over quarters</b>;
    price is shown only as context. The one sell rule is a <b>broken thesis</b>.
  </div>

  <div class="stats">
    <div class="stat"><div class="v">${rows.length}</div><div class="l tip" tabindex="0" data-tip="Target 15-25. The return of this kind of portfolio comes from 1-2 names and you cannot know which upfront, so too few positions means you probably miss it.">Positions</div></div>
    <div class="stat"><div class="v" style="color:var(--gn)">${intact}</div><div class="l">Thesis intact</div></div>
    <div class="stat"><div class="v" style="color:var(--yw)">${watch}</div><div class="l">Needs review</div></div>
    <div class="stat"><div class="v" style="color:var(--rd)">${broken}</div><div class="l">Thesis broken</div></div>
    <div class="stat"><div class="v">${best != null ? best.toFixed(1) + 'x' : '—'}</div><div class="l tip" tabindex="0" data-tip="Your best position. In a power-law portfolio this single name tends to dominate the total return.">Best</div></div>
    <div class="stat"><div class="v">${median != null ? median.toFixed(1) + 'x' : '—'}</div><div class="l tip" tabindex="0" data-tip="The median will look unimpressive even in a successful compounder portfolio — roughly half the names go nowhere. That is the expected shape, not a failure.">Median</div></div>
  </div>

  ${rows.length ? rows.map(positionCard).join('') : `<div class="empty">
    <b>No positions yet.</b><br><br>
    Add them to <code>compounder-positions.json</code>. A written <b>thesis</b> is required, not optional —
    since the only sell rule here is &ldquo;the thesis broke&rdquo;, a position without one cannot be managed at all.
    Each entry also wants <code>mustStayTrue</code> (the checks that define the thesis) and <code>runway</code>
    (what the company reinvests into — the factor most screens miss, and the difference between a 10x compounder
    and a high-return business that stalls).<br><br>
    Candidates come from the <a href="multibagger.html" style="color:#7dd3fc">Multibagger</a> page; the durability
    screens already filter for ROCE, low debt and promoter holding.
  </div>`}

  ${legendHtml('How to use this page (tap to expand)', [
    { title: 'The arithmetic', bodyHtml: '<p>A 10x over 8 years is <b>33% CAGR</b>, and it comes from two things multiplying: earnings growth &times; re-rating. A company compounding EPS at 25% for 8 years grows earnings ~6x; if the P/E also expands 1.6&times; as the market notices, that is your 10x. Miss either leg and you get 3&ndash;4x.</p>' },
    { title: 'Why so many positions', bodyHtml: '<p>These portfolios follow a power law. Out of ~20 names held 7&ndash;10 years, typically 1&ndash;2 do 10x and carry the whole result, 3&ndash;5 do 2&ndash;4x, 8&ndash;10 go nowhere, and 4&ndash;6 lose most of their value. You cannot know in advance which is which &mdash; so you need enough positions to catch one, each small enough that a total loss is survivable.</p>' },
    { title: 'The sell rule', bodyHtml: `<p>Thesis break, judged over quarters, never a price move. This page flags: sales growth decelerating ${DECEL_QUARTERS} quarters running, operating margin contracting ${OPM_DROP_PP}pp or more against the trailing year, a loss-making quarter, shrinking sales, or quarterly data older than ${STALE_RESULT_DAYS} days (you cannot judge a thesis you have no data for).</p><p>A flag is a prompt to look, not an instruction to sell. One soft quarter is noise; a run of them is information.</p>` },
    { title: 'What this page will not tell you', bodyHtml: '<p>Whether the strategy is working. The outcome ledger behind this system measures 5- and 20-day horizons and holds about three months of history &mdash; it cannot evaluate a 5-year thesis, and no amount of engineering changes that. The quarterly snapshots written to <code>docs/compounder-log.jsonl</code> exist so that in three years you have a real record instead of a recollection.</p>' },
  ])}
</main>
<div class="footer">
  Compounders &middot; long-horizon bucket &middot; no stops, no targets &mdash; thesis-break only.<br>
  Not investment advice. Position sizing and every buy or sell decision are yours; this page tracks what you told it and reports what the quarterly numbers say.
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
module.exports = { assess, positionMaths, yoy };

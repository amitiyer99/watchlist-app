'use strict';

// ── Breakout GEN2 score regression test ───────────────────────────────────────
// The score now has five independently-weighted blocks, three penalties, a bonus and a
// renormalisation step. That is too much arithmetic to verify by eye, and the generator
// itself can't be run without live Yahoo/Tickertape access — so this drives the real
// analyzeStock() over SYNTHETIC bars with known shapes and asserts the properties that
// must hold. Run: npm run test-b2   (exit code 1 on failure)
//
// It also guards the thing that would otherwise silently break: renormalising to 100
// means a learned weight change must NOT move a stock's score when every block weight
// moves together, and the 85/65/40 tag cutoffs must stay meaningful.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Pull analyzeStock (and its helpers) out of the generator without running main().
function loadAnalyzer() {
  const src = fs.readFileSync(path.join(__dirname, 'generate-breakout2.js'), 'utf8');
  const grab = (name, kind = 'function') => {
    const needle = kind === 'function' ? `function ${name}(` : `const ${name} =`;
    const i = src.indexOf(needle);
    if (i < 0) throw new Error(`${name} not found`);
    let d = 0, j = src.indexOf('{', i);
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (!d) { j = k + 1; break; } }
    }
    return src.slice(i, j);
  };
  const ctx = {
    require, console, module: {}, __dirname,
    SIGCFG: require('./lib/signal-config').resolve(),
    B2_MULT: 1,
    B2W: () => 1,                            // neutral weights unless a test overrides
    sma: (a, p) => a.length >= p ? a.slice(-p).reduce((x, y) => x + y, 0) / p : null,
    avg: a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null,
    atrWilder: null, computeRSValue: null,
  };
  vm.createContext(ctx);
  for (const fn of ['atrWilder', 'computeRSValue', 'analyzeStock']) vm.runInContext(grab(fn), ctx);
  return ctx;
}

// ── Synthetic bar builders ────────────────────────────────────────────────────
// 260 bars is enough for SMA200 + the 200-DMA-cross window.
function bars({ n = 260, start = 100, drift = 0.0015, noise = 0, vol = 100000, volEnd = null, tightenLast = 0, dipAt = null } = {}) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p = p * (1 + drift) + (noise ? Math.sin(i * 1.7) * noise : 0);
    if (dipAt && i >= dipAt[0] && i < dipAt[1]) p *= 0.998;
    const span = (tightenLast && i >= n - tightenLast) ? 0.002 : 0.02;   // tight right side
    const v = (volEnd != null && i === n - 1) ? volEnd
      : (tightenLast && i >= n - 5) ? vol * 0.5                          // dry-up into the base
      : vol;
    out.push({
      date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
      high: p * (1 + span), low: p * (1 - span), close: p, volume: v,
    });
  }
  return out;
}

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); };
const near = (a, b, tol = 0.51) => Math.abs(a - b) <= tol;

const ctx = loadAnalyzer();
const analyse = (b, opts = {}) => {
  if (opts.B2W) ctx.B2W = opts.B2W; else ctx.B2W = () => 1;
  ctx.B2_MULT = opts.B2_MULT != null ? opts.B2_MULT : 1;
  return ctx.analyzeStock(b, null);
};

// 1. A clean Stage-2 uptrend scores, and stays inside 0-100.
const up = analyse(bars({ drift: 0.0020, tightenLast: 12 }));
check('uptrend produces a score in 0-100', up.totalScore >= 0 && up.totalScore <= 100, `score=${up.totalScore}`);
check('uptrend passes the Stage-2 template', up.stage2Pass === true, `checks=${JSON.stringify(up.stageChecks)}`);

// 2. Renormalisation: scaling EVERY block weight equally must not change the score.
const allHigh = analyse(bars({ drift: 0.0020, tightenLast: 12 }), { B2W: () => 1.5 });
const allLow  = analyse(bars({ drift: 0.0020, tightenLast: 12 }), { B2W: () => 0.5 });
check('score is invariant when all block weights scale together (renormalised)',
  near(allHigh.totalScore, up.totalScore) && near(allLow.totalScore, up.totalScore),
  `neutral=${up.totalScore} all1.5=${allHigh.totalScore} all0.5=${allLow.totalScore}`);

// 3. Promoting ONE block must move the score in the direction of that block's points.
// The score is a weighted AVERAGE (renormalised to 100), so promoting one block raises a
// stock's score only if it earned a HIGHER fraction of that block than of the whole. This
// asserts that exact property rather than the naive "more weight = more points".
const MAXES = { stage: 34, vcp: 30, volDryUp: 22, atrTight: 12, accum: 8 };
const vcpHeavy = analyse(bars({ drift: 0.0020, tightenLast: 12 }), { B2W: id => id === 'vcp' ? 1.5 : 1 });
const overallFrac = Object.entries(up.blockPts).reduce((a, [k, v]) => a + v, 0)
  / Object.values(MAXES).reduce((a, b) => a + b, 0);
const vcpFrac = up.blockPts.vcp / MAXES.vcp;
check('promoting a block moves the score in the direction of that block\'s relative strength',
  vcpFrac >= overallFrac ? vcpHeavy.totalScore >= up.totalScore : vcpHeavy.totalScore <= up.totalScore,
  `vcpFrac=${vcpFrac.toFixed(2)} overallFrac=${overallFrac.toFixed(2)} neutral=${up.totalScore} vcp×1.5=${vcpHeavy.totalScore}`);

// 4. ATR tightness is actually scored (it used to be computed and thrown away).
const calm  = analyse(bars({ drift: 0.001, noise: 0 }));
check('tight-ATR name earns the new volatility block', calm.blockPts.atrTight > 0,
  `atrPct=${calm.atrPct} atrTight=${calm.blockPts.atrTight}`);

// 5. A failed breakout is penalised rather than scored at full marks.
//    Build a name that cleared its pivot and then fell back below it.
const failBars = bars({ drift: 0.0018, tightenLast: 10 });
const pk = failBars[failBars.length - 8].close * 1.10;
failBars[failBars.length - 4].close = pk; failBars[failBars.length - 4].high = pk * 1.01;
for (let i = failBars.length - 3; i < failBars.length; i++) {
  failBars[i].close = pk * 0.90; failBars[i].high = pk * 0.91; failBars[i].low = pk * 0.89;
}
const failed = analyse(failBars);
check('failed breakout is detected', failed.breakoutFailed === true, `pctBelowPivot=${failed.pctBelowPivot}`);
check('failed breakout carries a penalty', failed.failedPenalty === 12, `failedPenalty=${failed.failedPenalty}`);

// 6. 200-DMA: breakdown must dock, reclaim must add.
//    Reclaim = long downtrend then a sharp move back above the falling 200-DMA.
const rc = bars({ n: 260, drift: -0.0012 });
for (let i = rc.length - 4; i < rc.length; i++) {
  rc[i].close = rc[rc.length - 5].close * 1.35; rc[i].high = rc[i].close * 1.01; rc[i].low = rc[i].close * 0.99;
}
const reclaim = analyse(rc);
check('fresh 200-DMA reclaim is detected and rewarded',
  reclaim.dma200Cross === 'RECLAIM' && reclaim.dmaAdj === 4, `cross=${reclaim.dma200Cross} adj=${reclaim.dmaAdj}`);

const bd = bars({ n: 260, drift: 0.0015 });
for (let i = bd.length - 4; i < bd.length; i++) {
  bd[i].close = bd[bd.length - 5].close * 0.70; bd[i].high = bd[i].close * 1.01; bd[i].low = bd[i].close * 0.99;
}
const breakdown = analyse(bd);
check('fresh 200-DMA breakdown is detected and penalised',
  breakdown.dma200Cross === 'BREAKDOWN' && breakdown.dmaAdj === -10, `cross=${breakdown.dma200Cross} adj=${breakdown.dmaAdj}`);

// 7. Tag cutoffs still line up with the score (they are read off the same number).
const tagOf = s => s >= 85 ? 'prime' : s >= 65 ? 'developing' : s >= 40 ? 'partial' : 'notready';
check('tag matches its own score band', up.tagClass === tagOf(up.totalScore), `score=${up.totalScore} tag=${up.tagClass}`);

// 8. Every block the ledger will log must exist, or factor-lab silently measures nothing.
const wantBlocks = ['stage', 'vcp', 'volDryUp', 'atrTight', 'accum'];
check('all score blocks are exported for the ledger',
  wantBlocks.every(b => up.blockPts[b] != null), `blockPts=${JSON.stringify(up.blockPts)}`);

// ── Report ────────────────────────────────────────────────────────────────────
console.log('🧪 Breakout GEN2 score regression\n');
let bad = 0;
for (const r of results) {
  if (!r.pass) bad++;
  console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`);
  if (r.detail && !r.pass) console.log(`       ${r.detail}`);
  else if (r.detail) console.log(`       ${r.detail}`);
}
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);

'use strict';

// Walk-forward parameter optimiser for the breakout trigger rule.
//
// Grid-searches the tunable rule constants over ~3y of history, ranks each combo
// on a TRAIN window, then validates the top candidates on a held-out TEST window.
// A tuned value is written to screener-weights.json `.signals` ONLY if it beats the
// current default OUT-OF-SAMPLE by a margin with enough trades — otherwise the
// default is kept. Every override is clamped to lib/signal-config BANDS. This is
// the guard against optimising on noise / overfitting the 3y sample.
//
// It is NOT wired into the 10-min CI. Run it deliberately:
//   node optimize-signals.js               # optimise + write if a robust winner exists
//   node optimize-signals.js --dry-run     # compute + print, write nothing
//   node optimize-signals.js --max 120     # smaller universe (faster)
// Kill switch: DISABLE_ADAPTIVE_WEIGHTS=1 forces a dry run.

const fs   = require('fs');
const path = require('path');
const signalConfig = require('./lib/signal-config');
const core = require('./lib/backtest-core');
const weights = require('./lib/weights');
// NOTE: ./backtest (which pulls in yahoo-finance2) is require()d lazily inside
// main() so the pure exports below can be imported/tested without node_modules.

const REPORT_PATH = path.join(__dirname, 'docs', 'signal-optimizer-report.json');

// Grid of candidate values per tunable. Keep it deliberately coarse: a 3y/~195-name
// sample cannot support fine tuning without overfitting.
const GRID = {
  pivotLookback: [10, 20, 30, 40],
  stopAtrMult:   [1.5, 2.0, 2.5],
  targetRRMult:  [1.5, 2.0, 2.5],
  volMult:       [1.25, 1.5, 2.0],
  nearHighPct:   [0.70, 0.75, 0.80],
};

// Selection thresholds.
const MIN_TRAIN_TRADES = 40;   // combo must trade enough in-sample to be meaningful
const MIN_TEST_TRADES  = 20;   // ...and out-of-sample
const TEST_MARGIN_R    = 0.05; // winner must beat the default's TEST expectancy by >= this (R)
const TOP_K            = 12;   // how many train-ranked combos to validate on test

function parseArgs(argv) {
  const a = { max: 2000, dryRun: false, years: 8, universe: 'full' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--max' && argv[i + 1]) a.max = parseInt(argv[++i], 10) || a.max;
    else if (argv[i] === '--years' && argv[i + 1]) a.years = parseInt(argv[++i], 10) || a.years;
    else if (argv[i] === '--universe' && argv[i + 1]) a.universe = argv[++i];
    else if (argv[i] === '--quick') { a.universe = 'watchlist'; a.years = 3; a.max = 200; }
    else if (argv[i] === '--dry-run') a.dryRun = true;
  }
  return a;
}

// Cartesian product of the grid → array of override objects.
function expandGrid(grid) {
  const keys = Object.keys(grid);
  let combos = [{}];
  for (const k of keys) {
    const next = [];
    for (const c of combos) for (const v of grid[k]) next.push({ ...c, [k]: v });
    combos = next;
  }
  return combos;
}

// Confidence-shrunk, instability-penalised train score.
function trainScore(summary, byYear) {
  if (!summary || !summary.trades) return -Infinity;
  const conf = summary.trades / (summary.trades + 50);
  const years = Object.values(byYear || {});
  const negYears = years.filter(y => y.avgR != null && y.avgR < 0).length;
  const negFrac = years.length ? negYears / years.length : 0;
  return summary.expectancyR * conf - 0.15 * negFrac;
}

// PURE: evaluate every combo over the provided bars. Returns ranked results.
function evaluateCombos(barsByTicker, base, grid, splitDate) {
  const combos = expandGrid(grid);
  const results = [];
  for (const combo of combos) {
    const cfg = { ...base, ...combo };
    const trades = core.runUniverse(barsByTicker, cfg);
    const { train, test } = core.splitTrainTest(trades, splitDate);
    const byYear = core.byYear(trades);
    results.push({
      combo, cfg,
      train: core.summarize(train),
      test: core.summarize(test),
      overall: core.summarize(trades),
      score: trainScore(core.summarize(train), core.byYear(train)),
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// PURE: pick the out-of-sample winner vs the baseline (default cfg). Returns
// { winner, applied, reason }. `applied` = the override object to persist (only keys
// that differ from DEFAULTS, clamped), or null when the default should stand.
function selectWinner(results, baseline, opts = {}) {
  const minTrain = opts.minTrainTrades ?? MIN_TRAIN_TRADES;
  const minTest  = opts.minTestTrades ?? MIN_TEST_TRADES;
  const margin   = opts.testMargin ?? TEST_MARGIN_R;
  const topK     = opts.topK ?? TOP_K;

  const baseTestExp = (baseline && baseline.test && baseline.test.trades >= 1) ? baseline.test.expectancyR : null;

  const eligible = results
    .filter(r => r.train.trades >= minTrain)
    .slice(0, topK)
    .filter(r => r.test.trades >= minTest && r.test.expectancyR != null);

  // Best by TEST expectancy among the train-ranked, test-liquid candidates.
  eligible.sort((a, b) => b.test.expectancyR - a.test.expectancyR);
  const best = eligible[0];

  if (!best) return { winner: null, applied: null, reason: 'no candidate met min-trade thresholds in/out of sample' };
  if (baseTestExp == null) return { winner: best, applied: null, reason: 'baseline has too few test trades to compare — keeping defaults' };
  if (best.test.expectancyR < baseTestExp + margin) {
    return { winner: best, applied: null, reason: `best OOS expectancy ${best.test.expectancyR} did not beat default ${baseTestExp} by >=${margin}R — keeping defaults` };
  }

  // Build the override: only keys that actually changed, clamped to bands.
  const applied = {};
  for (const [k, v] of Object.entries(best.combo)) {
    const def = signalConfig.DEFAULTS[k];
    const cv = signalConfig.clamp(k, v);
    if (cv !== def) applied[k] = cv;
  }
  if (!Object.keys(applied).length) return { winner: best, applied: null, reason: 'winner equals defaults — nothing to write' };
  return { winner: best, applied, reason: `beats default OOS by ${(best.test.expectancyR - baseTestExp).toFixed(3)}R` };
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = args.dryRun || process.env.DISABLE_ADAPTIVE_WEIGHTS === '1';

  // Baseline = the resolved live/default config with grid keys forced to DEFAULTS
  // (so the comparison isn't contaminated by a previously-written override).
  const base = signalConfig.resolve();
  for (const k of Object.keys(GRID)) base[k] = signalConfig.DEFAULTS[k];

  const bt = require('./backtest');           // lazy: only now do we need yahoo
  let tickers = bt.loadUniverse(args.universe).slice(0, args.max);
  if (!tickers.length) { console.error('No universe.'); process.exit(1); }
  console.log(`Optimising over ${tickers.length} tickers (${args.universe}, ${args.years}y) × ${expandGrid(GRID).length} combos...`);

  const barsByTicker = await bt.loadAllBars(tickers, {
    minBars: base.warmupBars + 20, years: args.years,
    onProgress: (d, t) => process.stdout.write(`  bars: ${d}/${t}\r`),
  });
  console.log(`\n  ${barsByTicker.size} tickers with enough history`);

  const splitDate = core.defaultSplitDate();
  const results = evaluateCombos(barsByTicker, base, GRID, splitDate);

  // Baseline result = the default combo's row (all grid keys at DEFAULTS).
  const baseKey = JSON.stringify(Object.fromEntries(Object.keys(GRID).map(k => [k, signalConfig.DEFAULTS[k]])));
  const baseline = results.find(r => JSON.stringify(r.combo) === baseKey) || null;

  const { winner, applied, reason } = selectWinner(results, baseline);

  console.log(`\n=== Top ${Math.min(8, results.length)} by train score ===`);
  console.table(results.slice(0, 8).map(r => ({
    ...r.combo,
    trainR: r.train.expectancyR, trainN: r.train.trades,
    testR: r.test.expectancyR, testN: r.test.trades, score: +r.score.toFixed(3),
  })));
  if (baseline) console.log(`Default cfg → test expectancy ${baseline.test.expectancyR}R (n=${baseline.test.trades})`);
  console.log(`\nDecision: ${reason}`);

  const report = {
    generatedAt: new Date().toISOString(),
    splitDate, universeTested: barsByTicker.size,
    grid: GRID, baseline: baseline && { combo: baseline.combo, train: baseline.train, test: baseline.test },
    winner: winner && { combo: winner.combo, train: winner.train, test: winner.test },
    applied, reason, dryRun,
    top: results.slice(0, 12).map(r => ({ combo: r.combo, train: r.train, test: r.test, score: r.score })),
  };
  if (!fs.existsSync(path.dirname(REPORT_PATH))) fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Wrote ${REPORT_PATH}`);

  if (applied && !dryRun) {
    const ok = weights.mergeSignals(applied, {
      source: 'optimize-signals', generatedAt: new Date().toISOString(),
      splitDate, universeTested: barsByTicker.size,
      baselineTestR: baseline && baseline.test.expectancyR,
      winnerTestR: winner && winner.test.expectancyR,
      winnerTrainR: winner && winner.train.expectancyR, reason,
    });
    console.log(ok ? `✅ Wrote tuned constants to screener-weights.json .signals: ${JSON.stringify(applied)}`
                   : '⚠️ Write skipped (frozen or error).');
  } else if (applied && dryRun) {
    console.log(`(dry-run) Would write: ${JSON.stringify(applied)}`);
  } else {
    console.log('No override written — defaults stand.');
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { expandGrid, trainScore, evaluateCombos, selectWinner, GRID };

'use strict';

// ML-phase readiness check. Run `npm run readiness` any time.
// Reports whether the data foundation is ready for Stage 1 (train a
// gradient-boosted model on historical snapshots) and how the forward
// ledger / calibrator are maturing. See IMPROVEMENTS.md for the roadmap.

const fs   = require('fs');
const path = require('path');

const DATASET_SUMMARY = path.join(__dirname, 'docs', 'dataset-summary.json');
const DATASET_FILE    = path.join(__dirname, 'dataset.jsonl');
const OUTCOMES        = path.join(__dirname, 'screener-outcomes.json');
const FEATURE_REPORT  = path.join(__dirname, 'docs', 'feature-report.json');

// Thresholds
const T = {
  datasetRows: 100000,      // historical snapshots for GBT training
  datasetYears: 5,          // history span
  fwdEntryDates: 60,        // distinct matured 20d entry dates in the forward ledger
  calibN: 50, calibDates: 15, // calibrator gate (matches lib/master-score.js)
  holdoutRows: 400,         // matured holdout (non-picked) outcomes
};

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
const mark = ok => ok ? '✅' : '⬜';

function main() {
  console.log('=== ML-phase readiness ===\n');
  let stage1 = true, notes = [];

  // 1. Historical dataset
  const ds = readJson(DATASET_SUMMARY);
  const dsExists = ds && fs.existsSync(DATASET_FILE);
  let dsRowsOk = false, dsSpanOk = false;
  if (dsExists) {
    dsRowsOk = (ds.rows || 0) >= T.datasetRows;
    const from = ds.dateRange && ds.dateRange.from ? new Date(ds.dateRange.from) : null;
    const to   = ds.dateRange && ds.dateRange.to   ? new Date(ds.dateRange.to)   : null;
    const years = (from && to) ? (to - from) / (365.25 * 86400000) : 0;
    dsSpanOk = years >= T.datasetYears;
    console.log(`${mark(dsRowsOk)} Historical dataset rows: ${ds.rows} (need ${T.datasetRows})`);
    console.log(`${mark(dsSpanOk)} History span: ${years.toFixed(1)}y (need ${T.datasetYears}y) [${ds.dateRange.from} → ${ds.dateRange.to}]`);
  } else {
    console.log(`${mark(false)} Historical dataset: not built yet — run \`npm run dataset\` (one-time, ~30-60 min)`);
  }
  stage1 = dsExists && dsRowsOk && dsSpanOk;

  // 2. Forward ledger maturity (validates the model against live picks later)
  const oc = readJson(OUTCOMES);
  let fwdDates = 0, holdoutMatured = 0;
  if (oc && Array.isArray(oc.rows)) {
    const dates = new Set();
    for (const r of oc.rows) {
      const m20 = r.results && r.results['20d'];
      if (m20) {
        dates.add(r.date);
        if (r.screener === 'bestpicks-holdout') holdoutMatured++;
      }
    }
    fwdDates = dates.size;
  }
  console.log(`${mark(fwdDates >= T.fwdEntryDates)} Forward ledger: ${fwdDates} distinct matured entry dates (need ${T.fwdEntryDates})`);
  console.log(`${mark(holdoutMatured >= T.holdoutRows)} Matured holdout outcomes: ${holdoutMatured} (need ${T.holdoutRows}; logging started 2026-07-20)`);

  // 3. Calibrator
  let calibOk = false;
  if (oc && Array.isArray(oc.rows)) {
    let n = 0; const cd = new Set();
    for (const r of oc.rows) {
      if (r.screener !== 'bestpicks') continue;
      const res = r.results && r.results['20d'];
      if (res && res.beatNifty != null && r.score != null) { n++; cd.add(r.date); }
    }
    calibOk = n >= T.calibN && cd.size >= T.calibDates;
    console.log(`${mark(calibOk)} winProb calibrator: ${n} matured bestpicks points over ${cd.size} dates (need ${T.calibN}/${T.calibDates})`);
  }

  // 4. Feature lab
  const fr = readJson(FEATURE_REPORT);
  if (fr && fr.summary) {
    const { live = [], shadow = [], insufficient = [] } = fr.summary;
    console.log(`   Feature lab: ${live.length} LIVE / ${shadow.length} SHADOW / ${insufficient.length} INSUFFICIENT`);
  }

  console.log('');
  if (stage1) {
    console.log('🟢 READY for Stage 1: historical dataset is sufficient to train and');
    console.log('   walk-forward-test a gradient-boosted model. Next: build train-model pipeline.');
  } else {
    console.log('🟡 NOT READY for Stage 1 yet.');
    if (!dsExists) console.log('   → Run `npm run dataset` on this machine (needs internet; one-time).');
    else console.log('   → Dataset exists but below thresholds — rerun with --max 800 --years 8.');
  }
  console.log('   Forward-ledger targets mature on their own as the daily pipeline runs.');
}

main();

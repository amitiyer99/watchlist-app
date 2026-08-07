'use strict';

// ── Exit Lab ──────────────────────────────────────────────────────────────────
// Compares EXIT strategies over the full walk-forward backtest, holding the entry
// rule constant (the live breakout rule from lib/signal-config). The agent debate
// flagged the fixed 1.5R target as the system's biggest unrealized lever — momentum
// edges live in the tail winners a fixed target amputates. This measures it.
//
//   target : current live behaviour — hard stop / 1.5R target / 40-day time cap
//   ema10  : hard stop, then ride until first daily close below the 10-EMA
//   ema21  : hard stop, then ride until first daily close below the 21-EMA
//   half   : sell half at the 1.5R target, breakeven-stop + 21-EMA trail the rest
//
// Uses the local .backtest-cache bars (run `npm run backtest` first if missing).
// Usage: node exit-lab.js [--universe=full|watchlist] [--split=YYYY-MM-DD]

const fs = require('fs');
const path = require('path');
const { precompute, runTicker, summarize, byYear, splitTrainTest, defaultSplitDate } = require('./lib/backtest-core');
const SIGCFG = require('./lib/signal-config').resolve();

const CACHE_DIR = path.join(__dirname, '.backtest-cache');
const MODES = ['target', 'ema10', 'ema21', 'half'];

function loadBars() {
  if (!fs.existsSync(CACHE_DIR)) { console.error('No .backtest-cache — run `npm run backtest` once to populate it.'); process.exit(1); }
  const map = new Map();
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
      if (Array.isArray(d.bars) && d.bars.length > 300) map.set(d.ticker || f.replace(/\.json$/, ''), d.bars);
    } catch { /* skip bad file */ }
  }
  return map;
}

function cfgFor(mode) {
  return {
    pivotLookback: SIGCFG.pivotLookback, volLookback: SIGCFG.volLookback, volMult: SIGCFG.volMult,
    nearHighPct: SIGCFG.nearHighPct, highLookback: SIGCFG.highLookback,
    stopAtrMult: SIGCFG.stopAtrMult, targetRRMult: SIGCFG.targetRRMult,
    atrN: SIGCFG.atrN, warmupBars: SIGCFG.warmupBars,
    // Trails need room to let winners develop; the fixed-target keeps the live 40d cap.
    maxHoldDays: mode === 'target' ? SIGCFG.maxHoldDays : 120,
    runnerMaxHoldDays: 160,
    exitMode: mode,
  };
}

function fmtRow(name, s) {
  const f = v => v == null ? '—' : v;
  return [name.padEnd(8), String(f(s.trades)).padStart(6), String(f(s.winRate)).padStart(6), String(f(s.avgR)).padStart(7), String(f(s.medianR)).padStart(8), String(f(s.profitFactor)).padStart(5), String(f(s.avgHoldDays)).padStart(7)].join(' ');
}

function main() {
  const splitArg = (process.argv.find(a => a.startsWith('--split=')) || '').split('=')[1];
  const splitDate = splitArg || defaultSplitDate();

  console.log('🚪 Exit Lab — same entries, different exits');
  const barsByTicker = loadBars();
  console.log(`  Universe: ${barsByTicker.size} tickers from cache · split (train<): ${splitDate}\n`);

  const header = ['mode'.padEnd(8), 'trades'.padStart(6), 'win%'.padStart(6), 'avgR'.padStart(7), 'medR'.padStart(8), 'PF'.padStart(5), 'hold'.padStart(7)].join(' ');
  const results = {};

  for (const mode of MODES) {
    const cfg = cfgFor(mode);
    const trades = [];
    for (const [t, bars] of barsByTicker) {
      const ind = precompute(bars, cfg.atrN);
      trades.push(...runTicker(t, bars, ind, cfg));
    }
    results[mode] = { trades, all: summarize(trades), split: splitTrainTest(trades, splitDate), years: byYear(trades) };
  }

  console.log('── FULL PERIOD ──');
  console.log(header);
  for (const m of MODES) console.log(fmtRow(m, results[m].all));

  console.log('\n── OUT-OF-SAMPLE (entries after split) ──');
  console.log(header);
  for (const m of MODES) console.log(fmtRow(m, summarize(results[m].split.test)));

  console.log('\n── IN-SAMPLE (train) ──');
  console.log(header);
  for (const m of MODES) console.log(fmtRow(m, summarize(results[m].split.train)));

  console.log('\n── BY YEAR (avgR per mode) ──');
  const years = Object.keys(results.target.years).sort();
  console.log(['year'.padEnd(6), ...MODES.map(m => m.padStart(8))].join(' '));
  for (const y of years) {
    console.log([y.padEnd(6), ...MODES.map(m => String((results[m].years[y] || {}).avgR ?? '—').padStart(8))].join(' '));
  }

  // Tail capture: how much of the winners' potential does each mode keep?
  console.log('\n── TAIL CAPTURE (share of trades ≥2R / ≥3R / ≥5R) ──');
  for (const m of MODES) {
    const rs = results[m].trades.map(t => t.rMult);
    const pct = k => (rs.filter(r => r >= k).length / rs.length * 100).toFixed(1);
    console.log(`${m.padEnd(8)} ≥2R: ${pct(2)}%   ≥3R: ${pct(3)}%   ≥5R: ${pct(5)}%   maxR: ${Math.max(...rs).toFixed(1)}`);
  }

  console.log('\nNote: same entry rule & hard stop everywhere — differences are pure exit effect.');
  console.log('Fixed-target mode keeps the live 40-day cap; trail modes are allowed 120 days.');
}

main();

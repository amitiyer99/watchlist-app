'use strict';

// Historical backtester CLI for the breakout entry rule. The replay math lives in
// lib/backtest-core.js (pure, no network); this file only fetches bars and prints.
//
// PARITY: the core uses lib/signals.planTrade() + lib/signal-config, so it replays
// the SAME rule the live triggers use (stop = stopAtrMult×ATR, 1.5R target, and the
// over-extension skip — the old standalone version tested a 2R target production
// never used).
//
// SURVIVORSHIP CAVEAT: universe = today's breakout2-data.json tickers, so names
// delisted during the window are absent — biases absolute expectancy optimistically.
// Treat levels as an upper bound; the optimiser compares candidates to the default
// on the SAME sample, where survivorship largely cancels.
//
// Bars: yahoo-finance2, cached in .backtest-cache/<ticker>.json.
// Usage: node backtest.js [--max 200] [--tickers RELIANCE,TCS,...]
// Output: console tables + docs/backtest-report.json

const fs   = require('fs');
const path = require('path');
const { makeClient } = require('./lib/yahoo');
const signalConfig = require('./lib/signal-config');
const core = require('./lib/backtest-core');
const yf = makeClient();

const CACHE_DIR     = path.join(__dirname, '.backtest-cache');
const REPORT_PATH   = path.join(__dirname, 'docs', 'backtest-report.json');

// Universe presets. `full` = the ~800-name NSE list (broadest, best for robust
// tuning). `watchlist` = the smaller breakout2 scan set (fast iteration / --quick).
const UNIVERSE_PRESETS = {
  full:      { path: path.join(__dirname, 'docs', 'nse-tickers.json'),      key: 't' },
  watchlist: { path: path.join(__dirname, 'docs', 'breakout2-data.json'),   key: 'ticker' },
};
const DEFAULT_YEARS    = 8;    // deep history spans multiple regimes (2018, 2020 crash, 2022)
const DEFAULT_UNIVERSE = 'full';
const BATCH_SIZE       = 5;
const BATCH_PAUSE_MS   = 300;

function parseArgs(argv) {
  const args = { max: 2000, tickers: null, years: DEFAULT_YEARS, universe: DEFAULT_UNIVERSE };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--max' && argv[i + 1]) args.max = parseInt(argv[++i], 10) || args.max;
    else if (argv[i] === '--years' && argv[i + 1]) args.years = parseInt(argv[++i], 10) || args.years;
    else if (argv[i] === '--universe' && argv[i + 1]) args.universe = argv[++i];
    else if (argv[i] === '--quick') { args.universe = 'watchlist'; args.years = 3; args.max = 200; }
    else if (argv[i] === '--tickers' && argv[i + 1]) {
      args.tickers = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    }
  }
  return args;
}

// Load a de-duped ticker list from a preset ('full'|'watchlist') or a direct path.
function loadUniverse(source = DEFAULT_UNIVERSE) {
  const preset = UNIVERSE_PRESETS[source] || UNIVERSE_PRESETS[DEFAULT_UNIVERSE];
  try {
    const rows = JSON.parse(fs.readFileSync(preset.path, 'utf8'));
    if (!Array.isArray(rows)) return [];
    // Accept either {t} (nse-tickers) or {ticker} (breakout2) shapes.
    return [...new Set(rows.map(r => r[preset.key] || r.ticker || r.t).filter(Boolean))];
  } catch (e) {
    console.error(`Cannot read universe ${preset.path}: ${e.message}`);
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function cachePath(ticker) { return path.join(CACHE_DIR, `${ticker.replace(/[^A-Za-z0-9_-]/g, '_')}.json`); }

async function loadBars(ticker, years = DEFAULT_YEARS) {
  const cp = cachePath(ticker);
  try {
    if (fs.existsSync(cp)) {
      const cached = JSON.parse(fs.readFileSync(cp, 'utf8'));
      // Reuse cache only if it covers at least the requested span (else refetch deeper).
      if (cached && Array.isArray(cached.bars) && (cached.years || 0) >= years) return cached.bars;
    }
  } catch { /* refetch */ }

  const p2 = new Date();
  const p1 = new Date(Date.now() - Math.round(years * 365.25 + 60) * 86400000);
  let rows;
  try {
    rows = await yf.historical(ticker + '.NS', { period1: p1, period2: p2, interval: '1d' });
  } catch (e) { console.warn(`  history failed ${ticker}: ${e.message}`); return null; }
  if (!rows || !rows.length) return null;
  const bars = rows
    .filter(r => r.close != null && r.high != null && r.low != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(r => {
      const f = (r.adjClose != null && r.close) ? r.adjClose / r.close : 1;
      return {
        date: new Date(r.date).toISOString().slice(0, 10),
        open:  (r.open != null ? r.open : r.close) * f,
        high:  r.high * f, low: r.low * f,
        close: r.adjClose != null ? r.adjClose : r.close,
        volume: r.volume != null ? r.volume : 0,
      };
    });
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ ticker, fetchedAt: new Date().toISOString(), years, bars }));
  } catch (e) { console.warn(`  cache write failed ${ticker}: ${e.message}`); }
  return bars;
}

async function loadAllBars(tickers, { minBars = 272, years = DEFAULT_YEARS, onProgress } = {}) {
  const barsByTicker = new Map();
  for (let k = 0; k < tickers.length; k += BATCH_SIZE) {
    const chunk = tickers.slice(k, k + BATCH_SIZE);
    const results = await Promise.all(chunk.map(t => loadBars(t, years)));
    chunk.forEach((t, ix) => {
      const bars = results[ix];
      if (bars && bars.length >= minBars) barsByTicker.set(t, bars);
    });
    if (onProgress) onProgress(Math.min(k + BATCH_SIZE, tickers.length), tickers.length);
    if (k + BATCH_SIZE < tickers.length) await sleep(BATCH_PAUSE_MS);
  }
  return barsByTicker;
}

async function main() {
  const args = parseArgs(process.argv);
  let tickers = args.tickers && args.tickers.length ? args.tickers : loadUniverse(args.universe);
  if (!tickers.length) { console.error('No tickers to backtest.'); process.exit(1); }
  tickers = tickers.slice(0, args.max);

  const cfg = signalConfig.resolve();
  console.log(`Backtesting ${tickers.length} tickers (${args.universe}), ~${args.years}y daily bars`);
  console.log(`Config: pivot=${cfg.pivotLookback} volMult=${cfg.volMult} nearHigh=${cfg.nearHighPct} stop=${cfg.stopAtrMult}xATR target=${cfg.targetRRMult}R hold<=${cfg.maxHoldDays}d`);

  const barsByTicker = await loadAllBars(tickers, {
    minBars: cfg.warmupBars + 20, years: args.years,
    onProgress: (done, total) => process.stdout.write(`  bars: ${done}/${total}\r`),
  });
  console.log(`\n  ${barsByTicker.size}/${tickers.length} tickers have enough history`);

  const trades = core.runUniverse(barsByTicker, cfg);
  const splitDate = core.defaultSplitDate();
  const { train, test } = core.splitTrainTest(trades, splitDate);

  console.log('\n=== Overall (live-config rule) ===');
  console.table([core.summarize(trades)]);
  console.log(`\n=== Out-of-sample split at ${splitDate} ===`);
  console.table({ train: core.summarize(train), test: core.summarize(test) });
  console.log('\n=== By year ===');
  console.table(core.byYear(trades));

  const report = {
    generatedAt: new Date().toISOString(),
    config: cfg, splitDate,
    universe: { requested: tickers.length, tested: barsByTicker.size },
    overall: core.summarize(trades),
    train: core.summarize(train),
    test: core.summarize(test),
    byYear: core.byYear(trades),
    survivorshipNote: 'Universe = current breakout2-data.json tickers; delisted names absent (optimistic bias).',
    tradeCount: trades.length,
  };
  if (!fs.existsSync(path.dirname(REPORT_PATH))) fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Wrote ${REPORT_PATH}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { loadBars, loadAllBars, loadUniverse, ...core };

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

const UNIVERSE_PATH = path.join(__dirname, 'docs', 'breakout2-data.json');
const CACHE_DIR     = path.join(__dirname, '.backtest-cache');
const REPORT_PATH   = path.join(__dirname, 'docs', 'backtest-report.json');

const YEARS          = 3;
const BATCH_SIZE     = 5;
const BATCH_PAUSE_MS = 300;

function parseArgs(argv) {
  const args = { max: 200, tickers: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--max' && argv[i + 1]) args.max = parseInt(argv[++i], 10) || args.max;
    else if (argv[i] === '--tickers' && argv[i + 1]) {
      args.tickers = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    }
  }
  return args;
}

function loadUniverse() {
  try {
    const rows = JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8'));
    if (!Array.isArray(rows)) return [];
    return [...new Set(rows.map(r => r.ticker).filter(Boolean))];
  } catch (e) {
    console.error(`Cannot read universe ${UNIVERSE_PATH}: ${e.message}`);
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function cachePath(ticker) { return path.join(CACHE_DIR, `${ticker.replace(/[^A-Za-z0-9_-]/g, '_')}.json`); }

async function loadBars(ticker) {
  const cp = cachePath(ticker);
  try {
    if (fs.existsSync(cp)) {
      const cached = JSON.parse(fs.readFileSync(cp, 'utf8'));
      if (cached && Array.isArray(cached.bars)) return cached.bars;
    }
  } catch { /* refetch */ }

  const p2 = new Date();
  const p1 = new Date(Date.now() - Math.round(YEARS * 365.25 + 60) * 86400000);
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
    fs.writeFileSync(cp, JSON.stringify({ ticker, fetchedAt: new Date().toISOString(), bars }));
  } catch (e) { console.warn(`  cache write failed ${ticker}: ${e.message}`); }
  return bars;
}

async function loadAllBars(tickers, { minBars = 272, onProgress } = {}) {
  const barsByTicker = new Map();
  for (let k = 0; k < tickers.length; k += BATCH_SIZE) {
    const chunk = tickers.slice(k, k + BATCH_SIZE);
    const results = await Promise.all(chunk.map(t => loadBars(t)));
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
  let tickers = args.tickers && args.tickers.length ? args.tickers : loadUniverse();
  if (!tickers.length) { console.error('No tickers to backtest.'); process.exit(1); }
  tickers = tickers.slice(0, args.max);

  const cfg = signalConfig.resolve();
  console.log(`Backtesting ${tickers.length} tickers, ~${YEARS}y daily bars`);
  console.log(`Config: pivot=${cfg.pivotLookback} volMult=${cfg.volMult} nearHigh=${cfg.nearHighPct} stop=${cfg.stopAtrMult}xATR target=${cfg.targetRRMult}R hold<=${cfg.maxHoldDays}d`);

  const barsByTicker = await loadAllBars(tickers, {
    minBars: cfg.warmupBars + 20,
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

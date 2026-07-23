'use strict';

// Standalone historical backtester for the breakout entry rule, so threshold
// changes can be validated against ~3 years of history instead of waiting
// months for the forward ledger to mature.
//
// Replayed rule (walk-forward, only data up to day t is ever used):
//   - Stage 2 template: close > SMA50/150/200, SMA50 > SMA150 > SMA200,
//     SMA200 rising vs 20 bars ago, close within 25% of the 252-bar high.
//   - Base pivot = N-bar high excluding the current bar (N = 10 and 30 are
//     both run so today's pivot-lookback change is validated head-to-head).
//   - Entry when close crosses above the pivot with volume > 1.5x 50-bar avg.
//   - Stop = pivot - 2*ATR14 (Wilder). Exit at stop hit (low <= stop, gaps
//     fill at open), +2R target hit (high >= target), or 40 trading days.
//   - One position per ticker at a time.
//
// Bars come from yahoo-finance2 (already a dependency) and are cached in
// .backtest-cache/<ticker>.json so reruns are instant.
//
// Usage: node backtest.js [--max 200] [--tickers RELIANCE,TCS,...]
// Output: console tables + docs/backtest-report.json

const fs   = require('fs');
const path = require('path');
const { makeClient } = require('./lib/yahoo');
const yf = makeClient();

const UNIVERSE_PATH = path.join(__dirname, 'docs', 'breakout2-data.json');
const CACHE_DIR     = path.join(__dirname, '.backtest-cache');
const REPORT_PATH   = path.join(__dirname, 'docs', 'backtest-report.json');

const YEARS          = 3;      // history depth
const PIVOT_LOOKBACKS = [10, 30];
const VOL_LOOKBACK   = 50;     // bars for average volume
const VOL_MULT       = 1.5;    // breakout volume threshold
const ATR_N          = 14;
const STOP_ATR_MULT  = 2;
const TARGET_R       = 2;
const MAX_HOLD_DAYS  = 40;
const HIGH_LOOKBACK  = 252;    // 52-week high window
const NEAR_HIGH_PCT  = 0.75;   // within 25% of 252-bar high
const WARMUP_BARS    = 252;    // first tradeable index
const BATCH_SIZE     = 5;
const BATCH_PAUSE_MS = 300;

// ---------------------------------------------------------------- CLI args
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

// ---------------------------------------------------------------- bar loading
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cachePath(ticker) {
  return path.join(CACHE_DIR, `${ticker.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

async function loadBars(ticker) {
  const cp = cachePath(ticker);
  try {
    if (fs.existsSync(cp)) {
      const cached = JSON.parse(fs.readFileSync(cp, 'utf8'));
      if (cached && Array.isArray(cached.bars)) return cached.bars;
    }
  } catch { /* corrupt cache -> refetch */ }

  const p2 = new Date();
  const p1 = new Date(Date.now() - Math.round(YEARS * 365.25 + 60) * 86400000);
  let rows;
  try {
    rows = await yf.historical(ticker + '.NS', { period1: p1, period2: p2, interval: '1d' });
  } catch (e) {
    console.warn(`  history failed ${ticker}: ${e.message}`);
    return null;
  }
  if (!rows || !rows.length) return null;
  // Use adjClose and scale OHLC by the same factor so splits/bonuses inside the
  // window don't fabricate breakouts or blow up ATR.
  const bars = rows
    .filter(r => r.close != null && r.high != null && r.low != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(r => {
      const f = (r.adjClose != null && r.close) ? r.adjClose / r.close : 1;
      return {
        date: new Date(r.date).toISOString().slice(0, 10),
        open:  (r.open != null ? r.open : r.close) * f,
        high:  r.high * f,
        low:   r.low * f,
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

// ---------------------------------------------------------------- indicators
function prefixSum(vals) {
  const p = new Array(vals.length + 1).fill(0);
  for (let i = 0; i < vals.length; i++) p[i + 1] = p[i] + vals[i];
  return p;
}
function smaAt(prefix, i, n) {
  return (i + 1 >= n) ? (prefix[i + 1] - prefix[i + 1 - n]) / n : null;
}

function wilderAtr(bars, n) {
  const atr = new Array(bars.length).fill(null);
  if (bars.length <= n) return atr;
  const tr = i => Math.max(
    bars[i].high - bars[i].low,
    Math.abs(bars[i].high - bars[i - 1].close),
    Math.abs(bars[i].low - bars[i - 1].close)
  );
  let sum = 0;
  for (let i = 1; i <= n; i++) sum += tr(i);
  atr[n] = sum / n;
  for (let i = n + 1; i < bars.length; i++) atr[i] = (atr[i - 1] * (n - 1) + tr(i)) / n;
  return atr;
}

// Highest high over bars [i-n .. i-1] (excluding current bar).
function priorHigh(bars, i, n) {
  if (i < n) return null;
  let h = -Infinity;
  for (let j = i - n; j < i; j++) if (bars[j].high > h) h = bars[j].high;
  return h;
}
// Highest high over bars [i-n+1 .. i] (including current bar).
function rollingHigh(bars, i, n) {
  if (i + 1 < n) return null;
  let h = -Infinity;
  for (let j = i - n + 1; j <= i; j++) if (bars[j].high > h) h = bars[j].high;
  return h;
}

function precompute(bars) {
  const closes = bars.map(b => b.close);
  const vols   = bars.map(b => b.volume);
  return {
    pc: prefixSum(closes),
    pv: prefixSum(vols),
    atr: wilderAtr(bars, ATR_N),
  };
}

// ---------------------------------------------------------------- replay
function runTicker(ticker, bars, ind, pivotLookback) {
  const trades = [];
  let pos = null;

  for (let i = WARMUP_BARS; i < bars.length; i++) {
    const b = bars[i];

    if (pos) {
      const held = i - pos.entryIdx;
      let exit = null, reason = null;
      if (b.low <= pos.stop) {                       // stop first: conservative when both hit
        exit = Math.min(b.open, pos.stop); reason = 'stop';
      } else if (b.high >= pos.target) {
        exit = Math.max(b.open, pos.target); reason = 'target';
      } else if (held >= MAX_HOLD_DAYS) {
        exit = b.close; reason = 'time';
      }
      if (exit != null) {
        trades.push({
          ticker,
          entryDate: pos.entryDate, exitDate: b.date,
          entry: +pos.entry.toFixed(2), exit: +exit.toFixed(2),
          stop: +pos.stop.toFixed(2), target: +pos.target.toFixed(2),
          rMult: +((exit - pos.entry) / pos.r).toFixed(3),
          holdDays: held, reason,
        });
        pos = null;
      }
      continue;                                      // no same-day re-entry
    }

    // ---- entry evaluation at close of day i, using only data up to i ----
    const c = b.close;
    const s50  = smaAt(ind.pc, i, 50);
    const s150 = smaAt(ind.pc, i, 150);
    const s200 = smaAt(ind.pc, i, 200);
    const s200Prev = i >= 20 ? smaAt(ind.pc, i - 20, 200) : null;
    if (s50 == null || s150 == null || s200 == null || s200Prev == null) continue;

    const stage2 =
      c > s50 && c > s150 && c > s200 &&
      s50 > s150 && s150 > s200 &&
      s200 > s200Prev;
    if (!stage2) continue;

    const hi252 = rollingHigh(bars, i, HIGH_LOOKBACK);
    if (hi252 == null || c < NEAR_HIGH_PCT * hi252) continue;

    const pivot = priorHigh(bars, i, pivotLookback);
    if (pivot == null) continue;
    const crossed = c > pivot && bars[i - 1].close <= pivot;
    if (!crossed) continue;

    if (i < VOL_LOOKBACK) continue;
    const volAvg = (ind.pv[i] - ind.pv[i - VOL_LOOKBACK]) / VOL_LOOKBACK; // prior 50 bars, excl current
    if (!(volAvg > 0) || b.volume <= VOL_MULT * volAvg) continue;

    const atr = ind.atr[i];
    if (atr == null || !(atr > 0)) continue;
    const stop = pivot - STOP_ATR_MULT * atr;
    const r = c - stop;
    if (!(r > 0)) continue;

    pos = { entryIdx: i, entryDate: b.date, entry: c, stop, target: c + TARGET_R * r, r };
  }

  if (pos) {                                          // still open at end of data
    const last = bars[bars.length - 1];
    trades.push({
      ticker,
      entryDate: pos.entryDate, exitDate: last.date,
      entry: +pos.entry.toFixed(2), exit: +last.close.toFixed(2),
      stop: +pos.stop.toFixed(2), target: +pos.target.toFixed(2),
      rMult: +((last.close - pos.entry) / pos.r).toFixed(3),
      holdDays: bars.length - 1 - pos.entryIdx, reason: 'open',
    });
  }
  return trades;
}

// ---------------------------------------------------------------- statistics
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { trades: 0, winRate: null, avgR: null, medianR: null, profitFactor: null, avgHoldDays: null, expectancyR: null };
  const rs = trades.map(t => t.rMult);
  const wins = rs.filter(r => r > 0);
  const losses = rs.filter(r => r <= 0);
  const grossWin  = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const avgR = rs.reduce((a, b) => a + b, 0) / n;
  return {
    trades: n,
    winRate: +(wins.length / n * 100).toFixed(1),
    avgR: +avgR.toFixed(3),
    medianR: +median(rs).toFixed(3),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? Infinity : null),
    avgHoldDays: +(trades.reduce((a, t) => a + t.holdDays, 0) / n).toFixed(1),
    expectancyR: +avgR.toFixed(3),   // expectancy per trade, in R units
  };
}

function byYear(trades) {
  const groups = {};
  for (const t of trades) {
    const y = t.entryDate.slice(0, 4);
    (groups[y] = groups[y] || []).push(t);
  }
  const out = {};
  for (const y of Object.keys(groups).sort()) out[y] = summarize(groups[y]);
  return out;
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv);
  let tickers = args.tickers && args.tickers.length ? args.tickers : loadUniverse();
  if (!tickers.length) { console.error('No tickers to backtest.'); process.exit(1); }
  tickers = tickers.slice(0, args.max);
  console.log(`Backtesting ${tickers.length} tickers, ~${YEARS}y daily bars (pivot lookbacks: ${PIVOT_LOOKBACKS.join(' vs ')})`);

  const barsByTicker = new Map();
  for (let k = 0; k < tickers.length; k += BATCH_SIZE) {
    const chunk = tickers.slice(k, k + BATCH_SIZE);
    const results = await Promise.all(chunk.map(t => loadBars(t)));
    chunk.forEach((t, ix) => {
      const bars = results[ix];
      if (bars && bars.length >= WARMUP_BARS + 20) barsByTicker.set(t, bars);
    });
    process.stdout.write(`  bars: ${Math.min(k + BATCH_SIZE, tickers.length)}/${tickers.length}\r`);
    if (k + BATCH_SIZE < tickers.length) await sleep(BATCH_PAUSE_MS);
  }
  console.log(`\n  ${barsByTicker.size}/${tickers.length} tickers have enough history (>=${WARMUP_BARS + 20} bars)`);

  const variants = {};
  for (const lb of PIVOT_LOOKBACKS) {
    const all = [];
    for (const [t, bars] of barsByTicker) {
      const ind = precompute(bars);
      all.push(...runTicker(t, bars, ind, lb));
    }
    variants[`pivot${lb}`] = { pivotLookback: lb, summary: summarize(all), byYear: byYear(all), trades: all };
  }

  // ---- console report ----
  console.log('\n=== Pivot lookback comparison (10 vs 30 bars) ===');
  console.table(PIVOT_LOOKBACKS.map(lb => {
    const s = variants[`pivot${lb}`].summary;
    return {
      pivotLookback: lb, trades: s.trades, 'winRate%': s.winRate, avgR: s.avgR,
      medianR: s.medianR, profitFactor: s.profitFactor, avgHoldDays: s.avgHoldDays,
      expectancyR: s.expectancyR,
    };
  }));
  for (const lb of PIVOT_LOOKBACKS) {
    console.log(`--- By year (pivot ${lb}) ---`);
    const yr = variants[`pivot${lb}`].byYear;
    console.table(Object.entries(yr).map(([year, s]) => ({
      year, trades: s.trades, 'winRate%': s.winRate, avgR: s.avgR, profitFactor: s.profitFactor,
    })));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    params: {
      years: YEARS, pivotLookbacks: PIVOT_LOOKBACKS, volLookback: VOL_LOOKBACK, volMult: VOL_MULT,
      atrN: ATR_N, stopAtrMult: STOP_ATR_MULT, targetR: TARGET_R, maxHoldDays: MAX_HOLD_DAYS,
      nearHighPct: NEAR_HIGH_PCT, highLookback: HIGH_LOOKBACK,
    },
    universe: { requested: tickers.length, tested: barsByTicker.size },
    variants: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, {
      pivotLookback: v.pivotLookback, summary: v.summary, byYear: v.byYear,
      tradeCount: v.trades.length,
      trades: v.trades,
    }])),
  };
  if (!fs.existsSync(path.dirname(REPORT_PATH))) fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Wrote ${REPORT_PATH}`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { runTicker, summarize, wilderAtr };

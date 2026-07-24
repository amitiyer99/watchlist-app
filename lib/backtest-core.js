'use strict';

// Pure backtest replay + statistics — NO network/IO dependencies (no yahoo).
// Imported by backtest.js (the CLI that fetches bars) and optimize-signals.js
// (the parameter sweep), so both replay the identical rule and neither has to
// drag in the data-fetch library to run the math. Unit-testable in isolation.

const { planTrade } = require('./signals');

// Fixed Minervini Stage-2 template windows (not tuned).
const SMA_FAST = 50, SMA_MID = 150, SMA_SLOW = 200, SMA_SLOPE_LAG = 20;

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
function priorHigh(bars, i, n) {          // highest high over [i-n .. i-1]
  if (i < n) return null;
  let h = -Infinity;
  for (let j = i - n; j < i; j++) if (bars[j].high > h) h = bars[j].high;
  return h;
}
function rollingHigh(bars, i, n) {         // highest high over [i-n+1 .. i]
  if (i + 1 < n) return null;
  let h = -Infinity;
  for (let j = i - n + 1; j <= i; j++) if (bars[j].high > h) h = bars[j].high;
  return h;
}
function precompute(bars, atrN) {
  const closes = bars.map(b => b.close);
  const vols   = bars.map(b => b.volume);
  return { pc: prefixSum(closes), pv: prefixSum(vols), atr: wilderAtr(bars, atrN || 14) };
}

// Walk-forward replay of the breakout rule for one ticker.
// cfg: pivotLookback, volLookback, volMult, nearHighPct, highLookback,
//      stopAtrMult, targetRRMult, maxHoldDays, warmupBars.
function runTicker(ticker, bars, ind, cfg) {
  const trades = [];
  let pos = null;
  const warmup = cfg.warmupBars || 252;

  for (let i = warmup; i < bars.length; i++) {
    const b = bars[i];

    if (pos) {
      const held = i - pos.entryIdx;
      let exit = null, reason = null;
      if (b.low <= pos.stop) { exit = Math.min(b.open, pos.stop); reason = 'stop'; }
      else if (b.high >= pos.target) { exit = Math.max(b.open, pos.target); reason = 'target'; }
      else if (held >= cfg.maxHoldDays) { exit = b.close; reason = 'time'; }
      if (exit != null) {
        trades.push({
          ticker, entryDate: pos.entryDate, exitDate: b.date,
          entry: +pos.entry.toFixed(2), exit: +exit.toFixed(2),
          stop: +pos.stop.toFixed(2), target: +pos.target.toFixed(2),
          rMult: +((exit - pos.entry) / pos.r).toFixed(3), holdDays: held, reason,
        });
        pos = null;
      }
      continue;
    }

    const c = b.close;
    const s50  = smaAt(ind.pc, i, SMA_FAST);
    const s150 = smaAt(ind.pc, i, SMA_MID);
    const s200 = smaAt(ind.pc, i, SMA_SLOW);
    const s200Prev = i >= SMA_SLOPE_LAG ? smaAt(ind.pc, i - SMA_SLOPE_LAG, SMA_SLOW) : null;
    if (s50 == null || s150 == null || s200 == null || s200Prev == null) continue;

    const stage2 = c > s50 && c > s150 && c > s200 && s50 > s150 && s150 > s200 && s200 > s200Prev;
    if (!stage2) continue;

    const hiN = rollingHigh(bars, i, cfg.highLookback);
    if (hiN == null || c < cfg.nearHighPct * hiN) continue;

    const pivot = priorHigh(bars, i, cfg.pivotLookback);
    if (pivot == null) continue;
    if (!(c > pivot && bars[i - 1].close <= pivot)) continue;

    if (i < cfg.volLookback) continue;
    const volAvg = (ind.pv[i] - ind.pv[i - cfg.volLookback]) / cfg.volLookback;
    if (!(volAvg > 0) || b.volume <= cfg.volMult * volAvg) continue;

    const atr = ind.atr[i];
    if (atr == null || !(atr > 0)) continue;

    const plan = planTrade({
      entry: c, pivot, atr14: atr, regime: null,
      opts: { stopAtrMult: cfg.stopAtrMult, targetRRMult: cfg.targetRRMult },
    });
    if (!plan) continue;
    if (plan.tooExtended) continue; // live skips chased entries

    pos = { entryIdx: i, entryDate: b.date, entry: plan.entry, stop: plan.stop, target: plan.target, r: plan.riskPerUnit };
  }

  if (pos) {
    const last = bars[bars.length - 1];
    trades.push({
      ticker, entryDate: pos.entryDate, exitDate: last.date,
      entry: +pos.entry.toFixed(2), exit: +last.close.toFixed(2),
      stop: +pos.stop.toFixed(2), target: +pos.target.toFixed(2),
      rMult: +((last.close - pos.entry) / pos.r).toFixed(3),
      holdDays: bars.length - 1 - pos.entryIdx, reason: 'open',
    });
  }
  return trades;
}

function runUniverse(barsByTicker, cfg) {
  const all = [];
  for (const [t, bars] of barsByTicker) {
    const ind = precompute(bars, cfg.atrN);
    all.push(...runTicker(t, bars, ind, cfg));
  }
  return all;
}

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
    expectancyR: +avgR.toFixed(3),
  };
}
function byYear(trades) {
  const groups = {};
  for (const t of trades) { const y = t.entryDate.slice(0, 4); (groups[y] = groups[y] || []).push(t); }
  const out = {};
  for (const y of Object.keys(groups).sort()) out[y] = summarize(groups[y]);
  return out;
}
function splitTrainTest(trades, splitDate) {
  const train = [], test = [];
  for (const t of trades) (t.entryDate < splitDate ? train : test).push(t);
  return { train, test };
}
function defaultSplitDate() {
  return new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
}

module.exports = {
  prefixSum, smaAt, wilderAtr, priorHigh, rollingHigh, precompute,
  runTicker, runUniverse, summarize, byYear, splitTrainTest, defaultSplitDate,
};

'use strict';

// Entry / stop / target / sizing helpers shared by generate-triggers.js, monitor.js
// (exit engine), generate-apex.js (for BUY enrichment) and validate-screeners.js.
//
// Conventions:
//   - All prices are in INR (rupees).
//   - `riskBudgetPct` is the % of total portfolio equity you're willing to lose if the stop is hit.
//   - `maxPctPerName` caps single-name exposure even when the math allows more.
//   - Stop default = 2 × ATR(14) below pivot (Minervini/O'Neil standard).
//   - Target default = 1.5 × the (entry - stop) distance => baseline 1.5:1 R:R.

const { getSignalTuning } = require('./weights');

// stopAtrMult / targetRRMult are learned from the realized R-multiple distribution by
// learn-weights.js (kept inside a sane band there). They fall back to the hand-tuned
// values when no screener-weights.json exists, so behaviour is unchanged on a fresh clone.
const DEFAULTS = {
  riskBudgetPct: 1.0,
  maxPctPerName: 5.0,
  maxPctPerSector: 20.0,
  stopAtrMult: getSignalTuning('stopAtrMult', 2.0),
  targetRRMult: getSignalTuning('targetRRMult', 1.5),
  minRR: 1.2,
  minRRBear: 1.8,
};

function num(v) { return typeof v === 'number' && !isNaN(v) ? v : null; }

// pivot / entry / atr -> {entry, stop, target, rr, riskPct}
function planTrade({ entry, pivot, atr14, regime, opts = {} }) {
  const cfg = { ...DEFAULTS, ...opts };
  const e = num(entry);
  const p = num(pivot);
  const a = num(atr14);
  if (e == null || p == null) return null;

  const atrAbs = (a != null && a > 0) ? a : (e * 0.04); // 4% fallback when ATR missing
  const stop = +(p - cfg.stopAtrMult * atrAbs).toFixed(2);
  if (stop <= 0 || stop >= e) return null;
  const riskPerUnit = e - stop;
  const target = +(e + cfg.targetRRMult * riskPerUnit).toFixed(2);
  const rr = +((target - e) / riskPerUnit).toFixed(2);
  const riskPct = +((riskPerUnit / e) * 100).toFixed(2);

  const isBear = !!(regime && regime.isBearMarket);
  const meetsRR = rr >= (isBear ? cfg.minRRBear : cfg.minRR);

  return { entry: +e.toFixed(2), stop, target, rr, riskPct, riskPerUnit: +riskPerUnit.toFixed(2), atrUsed: +atrAbs.toFixed(2), meetsRR };
}

// Position size as % of portfolio: risk budget / per-unit-loss%.
function suggestSizePct({ entry, stop, opts = {} }) {
  const cfg = { ...DEFAULTS, ...opts };
  const e = num(entry); const s = num(stop);
  if (e == null || s == null || s >= e) return null;
  const lossPct = ((e - s) / e) * 100;
  if (lossPct <= 0) return null;
  let raw = cfg.riskBudgetPct / lossPct * 100;       // portfolio %
  if (raw > cfg.maxPctPerName) raw = cfg.maxPctPerName;
  return +raw.toFixed(2);
}

module.exports = { DEFAULTS, planTrade, suggestSizePct };

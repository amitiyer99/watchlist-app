'use strict';

const fs   = require('fs');
const path = require('path');

const REGIME_PATH = path.join(__dirname, '..', 'docs', 'regime.json');

function emaArr(vals, n) {
  const k = 2 / (n + 1);
  let e = vals[0];
  const out = [e];
  for (let i = 1; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function retPct(closes, n) {
  const len = closes.length;
  if (len <= n) return null;
  const b = closes[len - 1 - n];
  return b ? ((closes[len - 1] / b) - 1) * 100 : null;
}

// Bear-market gate (lifted from generate-prediction.js): price below 26-day EMA AND 22D return < -3%.
// Bull = anything else. Returns null fields when not enough data.
function computeMarketRegime(benchBars) {
  if (!benchBars || benchBars.length < 30) {
    return { isBearMarket: false, ema26: null, price: null, ret22D: null, ret10D: null };
  }
  const closes = benchBars.map(b => b.close);
  const ema26arr = emaArr(closes, 26);
  const ema26 = ema26arr[ema26arr.length - 1];
  const price = closes[closes.length - 1];
  const ret22D = retPct(closes, 22);
  const ret10D = retPct(closes, 10);
  const isBearMarket = price < ema26 && ret22D != null && ret22D < -3;
  return {
    isBearMarket,
    ema26: +ema26.toFixed(2),
    price,
    ret22D: ret22D != null ? +ret22D.toFixed(2) : null,
    ret10D: ret10D != null ? +ret10D.toFixed(2) : null,
  };
}

// Load the persisted regime snapshot. Returns a safe default (bull) when missing/stale so callers
// never crash; consumers can inspect `staleHours` to decide whether to trust it.
function loadRegime(maxAgeHours = 36) {
  try {
    if (!fs.existsSync(REGIME_PATH)) {
      return { isBearMarket: false, ema26: null, price: null, ret22D: null, ret10D: null, asOf: null, staleHours: null, available: false };
    }
    const raw = JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8'));
    const asOf = raw.asOf ? new Date(raw.asOf) : null;
    const staleHours = asOf ? (Date.now() - asOf.getTime()) / 3.6e6 : null;
    const usable = staleHours == null ? false : staleHours <= maxAgeHours;
    return {
      isBearMarket: !!raw.isBearMarket && usable,
      ema26: raw.ema26 ?? null,
      price: raw.price ?? null,
      ret22D: raw.ret22D ?? null,
      ret10D: raw.ret10D ?? null,
      asOf: raw.asOf ?? null,
      staleHours: staleHours != null ? +staleHours.toFixed(1) : null,
      available: true,
    };
  } catch (e) {
    return { isBearMarket: false, ema26: null, price: null, ret22D: null, ret10D: null, asOf: null, staleHours: null, available: false, error: e.message };
  }
}

function writeRegime(regime) {
  const dir = path.dirname(REGIME_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = { ...regime, asOf: new Date().toISOString() };
  fs.writeFileSync(REGIME_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

module.exports = { computeMarketRegime, loadRegime, writeRegime, REGIME_PATH };

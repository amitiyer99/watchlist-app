'use strict';

// Single source of truth for the breakout TRIGGER RULE constants.
//
// These values were previously hardcoded (and slightly diverging) across
// backtest.js, generate-breakout2.js and lib/signals.js. Centralising them here
// lets the historical optimiser (optimize-signals.js) tune them and have the
// change apply everywhere at once.
//
// Learned overrides live in screener-weights.json under `.signals` and overlay
// the defaults via getSignalTuning(). Missing => default, so a fresh clone (or
// DISABLE_ADAPTIVE_WEIGHTS=1) behaves exactly as before.
//
// Every tunable is hard-clamped to a sane BAND so a bad/overfit optimisation can
// never push a rule to an absurd value — the core safety guard, mirroring the
// [0.5,1.5] clamp on the score multipliers.

const { getSignalTuning } = require('./weights');

// Defaults MUST match the live production values so behaviour is unchanged until
// an override is deliberately written.
const DEFAULTS = {
  // setup detection (generate-breakout2.js today)
  pivotLookback: 30,    // base pivot = N-bar prior high (BASE_BARS)
  volLookback:   50,    // bars for average volume
  volMult:       1.5,   // breakout volume threshold (× 50-bar avg)
  nearHighPct:   0.75,  // must be within 25% of the 52-week high
  highLookback:  252,   // 52-week high window (bars)
  // trade plan (lib/signals.js today)
  stopAtrMult:   2.0,   // stop = pivot − mult × ATR(14)
  targetRRMult:  1.5,   // synthetic target = entry + mult × risk  (LIVE value; note backtest used 2.0)
  atrN:          14,
  // exit / replay
  maxHoldDays:   40,    // time-stop for the backtest replay
  warmupBars:    252,   // first tradeable bar (needs SMA200 + 52w high)
};

// [min, max] clamp band per tunable. Keys absent here are treated as fixed.
const BANDS = {
  pivotLookback: [10, 60],
  volLookback:   [20, 100],
  volMult:       [1.1, 3.0],
  nearHighPct:   [0.50, 0.95],
  highLookback:  [120, 300],
  stopAtrMult:   [1.0, 4.0],
  targetRRMult:  [1.0, 4.0],
  maxHoldDays:   [10, 120],
};

function clamp(key, v) {
  const b = BANDS[key];
  if (!b || typeof v !== 'number' || !isFinite(v)) return v;
  return Math.max(b[0], Math.min(b[1], v));
}

// Resolved value for one key = clamp(learned-or-default).
function get(key) {
  const def = DEFAULTS[key];
  const learned = getSignalTuning(key, def);
  return clamp(key, learned);
}

// Whole resolved config object.
function resolve() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = get(k);
  return out;
}

module.exports = { DEFAULTS, BANDS, clamp, get, resolve };

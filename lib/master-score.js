'use strict';

// Best Picks master score: blends z-scored features (from lib/features.js) into
// factor blocks, weights the blocks by regime + macro context, maps to a 0-100
// conviction, and calibrates an empirical "P(beat Nifty in 20d)". Produces
// per-horizon variants (swing / positional / long).
//
// Feature and block weights flow through lib/weights.js (namespace 'bestpicks'),
// so the gated learner (feature-lab + learn-weights) can promote/demote without
// touching this file. Everything degrades to a sensible default when no weights
// or macro exist yet.

const { REGISTRY, BLOCKS } = require('./feature-registry');
const { getMult } = require('./weights');
const macroLib = require('./macro');

// Base block weights (prior). Established factors start live at 1.0.
const BASE_BLOCK = { momentum: 1.0, technical: 1.0, quality: 1.0, value: 0.8, conviction: 0.9 };

// Horizon presets multiply the (regime-tilted) base block weights.
const HORIZON = {
  swing:      { momentum: 1.4, technical: 1.4, quality: 0.6, value: 0.4, conviction: 0.8 },
  positional: { momentum: 1.0, technical: 1.0, quality: 1.0, value: 1.0, conviction: 1.0 },
  long:       { momentum: 0.6, technical: 0.6, quality: 1.5, value: 1.4, conviction: 1.2 },
};

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function phi(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); } // standard-normal CDF
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Regime tilt applied to base block weights.
function regimeTilt(regime, macro) {
  const bear = !!(regime && regime.isBearMarket) || (macro && macro.regime === 'Risk-Off');
  const bull = !bear && (!macro || macro.regime === 'Risk-On' || macro.regime === 'Neutral');
  const w = { ...BASE_BLOCK };
  if (bear) { w.quality *= 1.3; w.value *= 1.3; w.momentum *= 0.7; w.technical *= 0.8; w.conviction *= 1.1; }
  else if (macro && macro.regime === 'Risk-On') { w.momentum *= 1.3; w.technical *= 1.2; w.quality *= 0.9; w.value *= 0.8; }
  return { weights: w, tiltLabel: bear ? 'Defensive (quality/value)' : (macro && macro.regime === 'Risk-On' ? 'Aggressive (momentum)' : 'Balanced') };
}

// feature weight = base prior (1, or 0 if registry shadow flag) x learned multiplier.
function featureWeight(F) {
  const base = F.shadow ? 0 : 1;
  return base * getMult('bestpicks', F.id, 1);
}
function blockWeight(block, horizonPreset, tiltWeights) {
  const learned = getMult('bestpicks', 'block:' + block, 1);
  return (tiltWeights[block] || 0) * (horizonPreset[block] || 1) * learned;
}

function computeBlockScores(rec) {
  // weighted mean of feature z within each block, using learned feature weights
  const blocks = {};
  const contrib = {}; // id -> weighted z contribution (for "why")
  for (const block of BLOCKS) blocks[block] = { sum: 0, wsum: 0 };
  for (const F of REGISTRY) {
    const z = rec.z ? rec.z[F.id] : null;
    if (z == null) continue;
    const fw = featureWeight(F);
    if (fw <= 0) continue;
    blocks[F.block].sum += z * fw;
    blocks[F.block].wsum += fw;
    contrib[F.id] = z * fw;
  }
  const blockZ = {};
  for (const block of BLOCKS) blockZ[block] = blocks[block].wsum > 0 ? blocks[block].sum / blocks[block].wsum : 0;
  return { blockZ, contrib };
}

function masterForHorizon(blockZ, horizonName, tilt) {
  const preset = HORIZON[horizonName] || HORIZON.positional;
  let sum = 0, wsum = 0;
  for (const block of BLOCKS) {
    const bw = blockWeight(block, preset, tilt.weights);
    sum += blockZ[block] * bw;
    wsum += bw;
  }
  return wsum > 0 ? sum / wsum : 0;
}

// Empirical calibration of conviction -> P(beat Nifty 20d). Uses matured bestpicks
// outcomes when available (>=50), else a monotone prior.
function buildCalibrator(outcomes) {
  const rows = (outcomes && Array.isArray(outcomes.rows)) ? outcomes.rows : [];
  const pts = [];
  for (const r of rows) {
    if (r.screener !== 'bestpicks') continue;
    const res = r.results && r.results['20d'];
    if (!res || res.beatNifty == null || r.score == null) continue;
    pts.push({ conv: r.score, beat: res.beatNifty ? 1 : 0 });
  }
  if (pts.length < 50) {
    return (conv) => clamp(0.5 + (conv - 50) / 250, 0.3, 0.82); // prior
  }
  // decile bins
  pts.sort((a, b) => a.conv - b.conv);
  const bins = 10, per = Math.ceil(pts.length / bins);
  const edges = [];
  for (let i = 0; i < bins; i++) {
    const slice = pts.slice(i * per, (i + 1) * per);
    if (!slice.length) continue;
    const lo = slice[0].conv, hi = slice[slice.length - 1].conv;
    const rate = slice.reduce((a, b) => a + b.beat, 0) / slice.length;
    edges.push({ lo, hi, rate });
  }
  return (conv) => {
    for (const e of edges) if (conv >= e.lo && conv <= e.hi) return clamp(e.rate, 0.15, 0.9);
    return clamp(0.5 + (conv - 50) / 250, 0.3, 0.82);
  };
}

// Main entry: annotate every stock with block scores, per-horizon conviction,
// calibrated probability, and top contributing features.
function scoreUniverse(stocks, { regime, macro, outcomes } = {}) {
  const mac = macro || macroLib.loadMacro();
  const tilt = regimeTilt(regime, mac);
  const riskScale = macroLib.riskScale(mac);
  const calibrate = buildCalibrator(outcomes);
  const byId = new Map(REGISTRY.map(f => [f.id, f]));

  for (const rec of stocks) {
    const { blockZ, contrib } = computeBlockScores(rec);
    rec.blockZ = {};
    for (const b of BLOCKS) rec.blockZ[b] = +blockZ[b].toFixed(3);

    const sTilt = macroLib.sectorTilt(mac, rec.sector);
    const conv = {};
    for (const h of Object.keys(HORIZON)) {
      let mz = masterForHorizon(blockZ, h, tilt);
      mz = mz * sTilt;                       // sector tilt nudges ranking
      let c = 100 * phi(mz);                 // 0-100
      c = clamp(c * riskScale, 0, 100);      // macro risk scaling
      conv[h] = Math.round(c);
    }
    rec.conviction = conv;          // {swing, positional, long}
    rec.master = conv.positional;   // headline
    rec.winProb = +calibrate(conv.positional).toFixed(2);

    // Top contributors (positive only) for the "why this pick" panel
    rec.why = Object.entries(contrib)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([id, v]) => ({ id, label: byId.get(id) ? byId.get(id).label : id, z: rec.z[id], block: byId.get(id) ? byId.get(id).block : null }));
  }

  return { stocks, tilt: tilt.tiltLabel, riskScale: +riskScale.toFixed(3), macro: mac };
}

module.exports = { scoreUniverse, regimeTilt, buildCalibrator, BASE_BLOCK, HORIZON };

'use strict';

// Shared adaptive-weights layer.
//
// `screener-weights.json` (repo root) is produced by learn-weights.js from the
// realized forward-return stats in docs/screener-stats.json. Every generator
// reads it at build time via getMult()/getSignalTuning() to refine its scoring
// based on what actually worked. The file is OPTIONAL: when missing (fresh
// clone, or after deletion to revert) every getter returns its neutral fallback
// so behaviour is identical to the pre-learning code.
//
// Schema:
//   {
//     generatedAt: ISO,
//     frozen: bool,                         // learner skips updates when true
//     config: {...},                        // learner guardrails (for transparency)
//     weights: {
//       confluence: { '*': 1.0, CONFLUENCE_USS_ELITE: 1.2, ... },
//       apex:       { '*': 1.0, APEX_BUY: 0.9, ... },
//       triggers:   { '*': 1.0, LIVE_BREAKOUT: 0.7, ... },
//       breakout2:  { '*': 1.0, ... },
//       debate:     { '*': 1.0, ... },
//       prediction: { rrg: .., analog: .., calibrated: true }  // managed by generate-prediction.js
//     },
//     signals: { stopAtrMult: 2.0, targetRRMult: 1.5 },         // managed by learner
//     provenance: { 'screener|signalType': { prev, next, edge, n, horizon, reason } },
//     history: [ { generatedAt, changes: [...] } ]
//   }

const fs   = require('fs');
const path = require('path');

const WEIGHTS_PATH = path.join(__dirname, '..', 'screener-weights.json');

// Clamp band shared with learn-weights.js. A learned multiplier can never push a
// constant beyond +/-50% of its hand-tuned value — the core overfitting guard.
const CLAMP_LO = 0.5;
const CLAMP_HI = 1.5;

// Env kill-switch: force every multiplier to neutral without deleting the file.
const DISABLED = process.env.DISABLE_ADAPTIVE_WEIGHTS === '1';

let _cache;
let _loaded = false;

function load() {
  if (_loaded) return _cache;
  _loaded = true;
  try {
    if (fs.existsSync(WEIGHTS_PATH)) {
      _cache = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
    } else {
      _cache = null;
    }
  } catch (e) {
    console.warn('weights load failed:', e.message);
    _cache = null;
  }
  return _cache;
}

function clampMult(v) {
  if (typeof v !== 'number' || !isFinite(v)) return 1;
  return Math.max(CLAMP_LO, Math.min(CLAMP_HI, v));
}

// Primary getter: multiplier for a (screener, signalType) bucket.
// Falls back to the screener's '*' bucket, then to `fallback` (default 1.0).
function getMult(screener, signalType = '*', fallback = 1) {
  if (DISABLED) return fallback;
  const data = load();
  const w = data && data.weights && data.weights[screener];
  if (!w) return fallback;
  let v = w[signalType];
  if (v == null) v = w['*'];
  if (v == null) return fallback;
  return clampMult(v);
}

// Whole namespace object (e.g. prediction sub-weights). Returns {} when absent.
function getNamespace(ns) {
  const data = load();
  return (data && data.weights && data.weights[ns]) || {};
}

// Sizing tunables consumed by lib/signals.js. Not clamped here (the learner is
// responsible for keeping these inside their own sane band).
function getSignalTuning(key, fallback) {
  if (DISABLED) return fallback;
  const data = load();
  const v = data && data.signals && data.signals[key];
  return (typeof v === 'number' && isFinite(v)) ? v : fallback;
}

// Merge/replace a namespace and persist. Used by generate-prediction.js to
// publish its internally-calibrated weights into the shared file so the
// transparency panel and tooling see every page's weights in one place.
function mergeNamespace(ns, obj) {
  let data;
  try {
    data = fs.existsSync(WEIGHTS_PATH) ? JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8')) : null;
  } catch { data = null; }
  if (!data || typeof data !== 'object') data = {};
  if (!data.weights) data.weights = {};
  data.weights[ns] = obj;
  data.generatedAt = data.generatedAt || new Date().toISOString();
  try {
    fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('weights mergeNamespace write failed:', e.message);
  }
  _loaded = false; // invalidate cache
}

module.exports = {
  WEIGHTS_PATH, CLAMP_LO, CLAMP_HI,
  load, clampMult, getMult, getNamespace, getSignalTuning, mergeNamespace,
};

'use strict';

// Self-learning weight calibrator.
//
// Reads the realized forward-return stats in docs/screener-stats.json (produced
// by validate-screeners.js) and turns each (screener, signalType) bucket's edge
// into a bounded weight multiplier that generators consume via lib/weights.js.
//
// Runs after validate-screeners.js in the daily pipeline. Generators pick up the
// new screener-weights.json on their NEXT run (intended ~1-day lag).
//
// Guardrails (the whole point — avoid overfitting on small / young samples):
//   - Primary metric: median alpha vs Nifty at 20 trading days.
//   - Falls back to a heavily-discounted 5-day signal until 20d cohorts mature.
//   - Minimum sample gate: below CONFIG.minSamples the target reverts to neutral 1.0.
//   - Confidence shrinkage: target = 1 + amp * tanh(edge/scale) * n/(n+k).
//   - Hard clamp to [0.5, 1.5] (shared with lib/weights.js).
//   - EMA smoothing vs the previous weights to prevent day-to-day whipsaw.
//   - Global freeze kill-switch + per-screener freeze list.
//   - Every change is logged with provenance + a rolling history for auditability.
//
// Usage:
//   node learn-weights.js            # compute and write screener-weights.json
//   node learn-weights.js --dry-run  # print the proposed table, write nothing

const fs   = require('fs');
const path = require('path');
const { WEIGHTS_PATH, CLAMP_LO, CLAMP_HI, clampMult } = require('./lib/weights');

const STATS_PATH = path.join(__dirname, 'docs', 'screener-stats.json');
const FEATURE_REPORT = path.join(__dirname, 'docs', 'feature-report.json');
let BP_REGISTRY = [];
try { BP_REGISTRY = require('./lib/feature-registry').REGISTRY; } catch { /* optional */ }

const CONFIG = {
  managedScreeners: ['confluence', 'apex', 'triggers', 'breakout2', 'debate'],
  primaryHorizon:  '20d',
  fallbackHorizon: '5d',
  minSamples:      40,     // below this a bucket stays neutral (1.0)
  amplitude:       0.5,    // max deviation from 1.0 before clamp (matches clamp band)
  edgeScale:       3,      // alpha %-points that map to tanh(1)
  shrinkK:         25,     // confidence half-saturation (n/(n+k))
  emaAlpha:        0.3,    // smoothing toward the new target
  fallbackDiscount: 0.5,   // extra confidence haircut when only 5d data exists
  // Sizing band for lib/signals.js (managed here, kept near hand-tuned defaults)
  targetRR:   { def: 1.5, lo: 1.2, hi: 2.0 },
  stopAtr:    { def: 2.0, lo: 1.5, hi: 2.5 },
  historyCap: 30,
  frozen:     process.env.LEARN_WEIGHTS_FROZEN === '1',
  freezeScreeners: [],
  // Best Picks feature gating (auto-promote/demote)
  bpFloor:   0.3,    // demote weight for features that fail the gate (SHADOW)
  bpAmp:     0.5,    // promotion amplitude for LIVE features
  bpIcScale: 0.08,   // IC that maps to tanh(1)
};

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function round3(v) { return Math.round(v * 1000) / 1000; }

function medianWeighted(pairs) {
  // pairs: [{ v, n }] — approximate weighted median by expanding on counts (cheap; counts are small)
  const vals = [];
  for (const p of pairs) {
    if (p.v == null) continue;
    const w = Math.max(1, Math.round(p.n || 1));
    for (let i = 0; i < w; i++) vals.push(p.v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const m = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
}

function loadStats() {
  if (!fs.existsSync(STATS_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')); }
  catch (e) { console.warn('stats parse failed:', e.message); return null; }
}

function loadPrev() {
  try {
    if (fs.existsSync(WEIGHTS_PATH)) return JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

// Map an edge (median alpha) + sample size to a smoothed, clamped target multiplier.
function edgeToTarget(edge, n, discount = 1) {
  if (edge == null || n == null || n < CONFIG.minSamples) return { target: 1, conf: 0 };
  const conf = (n / (n + CONFIG.shrinkK)) * discount;
  const raw  = 1 + CONFIG.amplitude * Math.tanh(edge / CONFIG.edgeScale) * conf;
  return { target: clampMult(raw), conf: round3(conf) };
}

function pickEdge(byKey, screener, signalType) {
  const pri = byKey.get(`${screener}|${signalType}|${CONFIG.primaryHorizon}`);
  if (pri && num(pri.medianAlpha) != null && (pri.count || 0) >= CONFIG.minSamples) {
    return { edge: pri.medianAlpha, n: pri.count, horizon: CONFIG.primaryHorizon, discount: 1 };
  }
  const fb = byKey.get(`${screener}|${signalType}|${CONFIG.fallbackHorizon}`);
  if (fb && num(fb.medianAlpha) != null && (fb.count || 0) >= CONFIG.minSamples) {
    return { edge: fb.medianAlpha, n: fb.count, horizon: CONFIG.fallbackHorizon, discount: CONFIG.fallbackDiscount };
  }
  return { edge: null, n: (pri && pri.count) || (fb && fb.count) || 0, horizon: 'none', discount: 0 };
}

function tuneSigning(stats, prevSignals) {
  // Use realized R-multiple distribution (medianR) from setup-style screeners to nudge
  // the target R:R toward what's actually achievable. Stop multiplier needs stop-hit
  // telemetry we don't yet log, so it stays at its default (written for transparency).
  const rPairs = [];
  for (const s of stats) {
    if (!['triggers', 'breakout2'].includes(s.screener)) continue;
    if (s.signalType !== '*') continue;
    if (s.horizon !== CONFIG.primaryHorizon && s.horizon !== CONFIG.fallbackHorizon) continue;
    if (num(s.medianR) != null) rPairs.push({ v: s.medianR, n: s.count });
  }
  const medR = medianWeighted(rPairs);
  const tDef = CONFIG.targetRR.def;
  let targetRR = tDef;
  if (medR != null) {
    // medR < 0 => targets rarely reached vs risk => make targets more achievable (lower RR).
    // medR > 0.5 => trades run => allow more ambitious targets (higher RR).
    const adj = Math.max(-1, Math.min(1, medR));        // -1..1
    const span = adj >= 0 ? (CONFIG.targetRR.hi - tDef) : (tDef - CONFIG.targetRR.lo);
    const rawTarget = tDef + adj * span;
    const prev = (prevSignals && num(prevSignals.targetRRMult)) != null ? prevSignals.targetRRMult : tDef;
    targetRR = round3(prev + CONFIG.emaAlpha * (rawTarget - prev));
    targetRR = Math.max(CONFIG.targetRR.lo, Math.min(CONFIG.targetRR.hi, targetRR));
  }
  return { stopAtrMult: CONFIG.stopAtr.def, targetRRMult: targetRR, basisMedianR: medR };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('Learning screener weights...');

  const stats = loadStats();
  if (!stats || !Array.isArray(stats.stats)) {
    console.log('  No screener-stats.json yet — nothing to learn. (Generators stay neutral.)');
    return;
  }

  const prev = loadPrev();
  const prevWeights = (prev && prev.weights) || {};
  const prevSignals = (prev && prev.signals) || {};

  if (prev && (prev.frozen || CONFIG.frozen)) {
    console.log('  FROZEN — weights left unchanged.');
    if (!dryRun) return;
  }

  const byKey = new Map();
  for (const s of stats.stats) byKey.set(`${s.screener}|${s.signalType}|${s.horizon}`, s);

  // Collect the signalTypes present per managed screener (always include '*').
  const typesByScreener = new Map();
  for (const sc of CONFIG.managedScreeners) typesByScreener.set(sc, new Set(['*']));
  for (const s of stats.stats) {
    if (typesByScreener.has(s.screener)) typesByScreener.get(s.screener).add(s.signalType);
  }

  const weights = {};
  const provenance = {};
  const changes = [];

  for (const screener of CONFIG.managedScreeners) {
    const frozenScreener = CONFIG.freezeScreeners.includes(screener);
    weights[screener] = {};
    for (const signalType of typesByScreener.get(screener)) {
      const prevMult = (prevWeights[screener] && num(prevWeights[screener][signalType])) != null
        ? prevWeights[screener][signalType] : 1;
      if (frozenScreener) { weights[screener][signalType] = round3(prevMult); continue; }

      const { edge, n, horizon, discount } = pickEdge(byKey, screener, signalType);
      const { target, conf } = edgeToTarget(edge, n, discount);
      const next = clampMult(round3(prevMult + CONFIG.emaAlpha * (target - prevMult)));
      weights[screener][signalType] = next;

      const reason = edge == null
        ? `insufficient data (n=${n} < ${CONFIG.minSamples}) -> neutral`
        : `alpha ${edge > 0 ? '+' : ''}${edge}% @${horizon}, n=${n}, conf=${conf}`;
      provenance[`${screener}|${signalType}`] = { prev: round3(prevMult), next, edge, n, horizon, reason };
      if (Math.abs(next - prevMult) >= 0.005) {
        changes.push({ key: `${screener}|${signalType}`, prev: round3(prevMult), next, edge, n, horizon });
      }
    }
  }

  // ---- Best Picks feature gating (auto-promote / auto-demote on drift) ----
  // Reads docs/feature-report.json (from feature-lab.js). Established features with
  // no data yet stay neutral (1.0) so the page works on day one; features that earn
  // validated edge are promoted, and ones that fail/decay are demoted - all EMA-smoothed
  // and clamped via the same guardrails.
  if (BP_REGISTRY.length) {
    let report = null;
    try { if (fs.existsSync(FEATURE_REPORT)) report = JSON.parse(fs.readFileSync(FEATURE_REPORT, 'utf8')); } catch { /* none */ }
    const prevBp = prevWeights.bestpicks || {};
    const bp = {};
    for (const F of BP_REGISTRY) {
      const prevMult = num(prevBp[F.id]) != null ? prevBp[F.id] : 1;
      const r = report && report.features ? report.features[F.id] : null;
      let target = 1, reason = 'no report -> neutral prior';
      if (r) {
        if (r.verdict === 'LIVE') {
          let t = 1 + CONFIG.bpAmp * Math.tanh((r.ic || 0) / CONFIG.bpIcScale);
          if (r.recentIC != null && r.recentIC < 0) t = 1 + (t - 1) * 0.4; // decaying edge -> dampen
          target = clampMult(t);
          reason = `LIVE ic=${r.ic} recent=${r.recentIC} n=${r.n}`;
        } else if (r.verdict === 'SHADOW') {
          target = CONFIG.bpFloor;
          reason = `SHADOW (failed gate) ic=${r.ic} n=${r.n} -> demote`;
        } else {
          reason = `INSUFFICIENT (n=${r.n}) -> neutral prior`;
        }
      }
      const next = clampMult(round3(prevMult + CONFIG.emaAlpha * (target - prevMult)));
      bp[F.id] = next;
      provenance[`bestpicks|${F.id}`] = { prev: round3(prevMult), next, verdict: r ? r.verdict : 'NONE', reason };
      if (Math.abs(next - prevMult) >= 0.005) changes.push({ key: `bestpicks|${F.id}`, prev: round3(prevMult), next });
    }
    // preserve any externally-set bestpicks keys (e.g. block:* set elsewhere)
    for (const k of Object.keys(prevBp)) if (bp[k] == null) bp[k] = prevBp[k];
    weights.bestpicks = bp;
  }

  // Preserve any externally-managed namespaces (e.g. prediction, written by generate-prediction.js).
  for (const ns of Object.keys(prevWeights)) {
    if (!weights[ns]) weights[ns] = prevWeights[ns];
  }

  const signals = tuneSigning(stats.stats, prevSignals);

  const out = {
    generatedAt: new Date().toISOString(),
    frozen: !!(prev && prev.frozen),
    config: {
      minSamples: CONFIG.minSamples, clampLo: CLAMP_LO, clampHi: CLAMP_HI,
      amplitude: CONFIG.amplitude, edgeScale: CONFIG.edgeScale, shrinkK: CONFIG.shrinkK,
      emaAlpha: CONFIG.emaAlpha, primaryHorizon: CONFIG.primaryHorizon,
      fallbackHorizon: CONFIG.fallbackHorizon, fallbackDiscount: CONFIG.fallbackDiscount,
    },
    weights,
    signals,
    provenance,
    history: [],
  };

  const prevHistory = (prev && Array.isArray(prev.history)) ? prev.history : [];
  out.history = [{ generatedAt: out.generatedAt, changes }, ...prevHistory].slice(0, CONFIG.historyCap);

  // Report
  console.log(`  Source: ${stats.totalOutcomes ?? '?'} signals, validated ${stats.generatedAt || '?'}`);
  const rows = [];
  for (const screener of CONFIG.managedScreeners) {
    for (const [sigType, mult] of Object.entries(weights[screener])) {
      const p = provenance[`${screener}|${sigType}`];
      rows.push(`    ${screener.padEnd(11)} ${String(sigType).padEnd(24)} ${String(mult).padEnd(6)} ${p ? p.reason : ''}`);
    }
  }
  console.log('  screener      signalType               mult   basis');
  console.log(rows.join('\n'));
  console.log(`  sizing: targetRRMult=${signals.targetRRMult} (medianR=${signals.basisMedianR}) stopAtrMult=${signals.stopAtrMult}`);
  console.log(`  ${changes.length} bucket(s) changed`);

  if (dryRun) {
    console.log('  --dry-run: nothing written.');
    return;
  }

  fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(out, null, 2));
  console.log(`  Wrote ${WEIGHTS_PATH}`);
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('learn-weights error:', e); process.exit(1); }
}
module.exports = { main, CONFIG };

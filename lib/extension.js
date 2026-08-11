'use strict';

// ── Over-extension penalty ────────────────────────────────────────────────────
// Measured, not assumed. score-lab.js bucketed every matured 20-day outcome in the
// ledger (non-overlapping episodes only) by how far above the pivot the entry was
// taken, and found a clean monotonic decay:
//
//   below pivot        n=313  medAlpha -0.80  beat 45%
//   at pivot (0-2%)    n=759  medAlpha -0.54  beat 48%
//   mild (2-5%)        n=227  medAlpha -0.52  beat 48%
//   extended (5-10%)   n=47   medAlpha -3.01  beat 43%
//   chased (10%+)      n=11   medAlpha -5.61  beat 27%
//
// The same shape holds inside breakout2 (+0.33 -> -1.10 -> -1.38 -> -5.99) and
// triggers (+0.84 -> +0.27 -> -3.42), i.e. it is not one page's quirk. Buying a
// name that has already run is the most consistently costly thing in this dataset.
//
// CAVEAT kept deliberately visible: the two worst buckets are thin (n=47 / n=11),
// so the penalty is sized conservatively — enough to stop chased names ranking top,
// not so much that it dominates a score. The 0-5% zone is treated as neutral because
// the data shows no meaningful difference across it.
//
// Every score that consumes this should ALSO be re-checked with score-lab after the
// change: the point is to make scores rank better, and that is a measurable claim.

// % above the reference level (pivot, or 50-DMA as a fallback). Negative = below.
function extensionPct({ price, pivot, sma50 }) {
  const ref = (pivot != null && pivot > 0) ? pivot : ((sma50 != null && sma50 > 0) ? sma50 : null);
  if (ref == null || price == null || !(price > 0)) return null;
  return ((price - ref) / ref) * 100;
}

// Graded penalty in score POINTS (subtract from a 0-100 score).
// 0-5% above the reference => 0 (the measured neutral zone)
// 5-10%  => 4   (medAlpha fell to -3.0 here)
// 10-20% => 8   (chased: -5.6)
// 20%+   => 12  (deep chase; capped so it never swamps a score)
function extensionPenalty(pctOrArgs) {
  const pct = typeof pctOrArgs === 'number' ? pctOrArgs : extensionPct(pctOrArgs || {});
  if (pct == null) return 0;
  if (pct <= 5) return 0;
  if (pct <= 10) return 4;
  if (pct <= 20) return 8;
  return 12;
}

// Label + tooltip text for the UI, so a demoted name explains itself.
function extensionLabel(pctOrArgs) {
  const pct = typeof pctOrArgs === 'number' ? pctOrArgs : extensionPct(pctOrArgs || {});
  if (pct == null) return null;
  if (pct <= 5) return null;                       // nothing worth flagging
  const p = pct.toFixed(1);
  if (pct <= 10) return { tag: '⚠ extended', pct: +p, penalty: 4, tip: `Entry sits ${p}% above the pivot/50-DMA. In this system's forward tests the 5-10% band returned a median -3.0% 20-day alpha vs -0.5% at the pivot, so the score is docked 4 points.` };
  if (pct <= 20) return { tag: '⚠ chased', pct: +p, penalty: 8, tip: `Entry sits ${p}% above the pivot/50-DMA — chased. Forward tests show a median -5.6% 20-day alpha for 10%+ extension (thin sample, n=11, but consistent across pages). Score docked 8 points.` };
  return { tag: '⚠ far extended', pct: +p, penalty: 12, tip: `Entry sits ${p}% above the pivot/50-DMA. Far beyond any level with supporting data; score docked 12 points. Wait for a base to form.` };
}

// Shared ticker -> pivot-extension% map, read from the breakout2 sidecar.
// WHY: the penalty bands above were calibrated on PIVOT extension. Other pages
// (apex, confluence) only carry a 200-DMA proxy, and a healthy Stage-2 stock can sit
// 15-20% above its 200-DMA quite legitimately — reusing pivot-calibrated bands on that
// measure would punish good setups. So instead of inventing unvalidated thresholds,
// those pages look up the SAME validated pivot measure computed by breakout2 and
// simply skip the penalty for names it doesn't cover.
// Ordering is safe: market-refresh.sh runs breakout2 (phase 2) before apex/confluence.
let _pivotExtCache = null;
function loadPivotExtensionMap(force = false) {
  if (_pivotExtCache && !force) return _pivotExtCache;
  const map = new Map();
  try {
    const p = require('path').join(__dirname, '..', 'docs', 'breakout2-data.json');
    const raw = JSON.parse(require('fs').readFileSync(p, 'utf8'));
    const rows = Array.isArray(raw) ? raw : (raw.rows || raw.stocks || []);
    for (const r of rows) {
      const t = String(r.ticker || '').toUpperCase();
      if (!t) continue;
      if (r.extPct != null) map.set(t, r.extPct);
      else if (r.price != null && r.pivot != null) {
        const pct = extensionPct({ price: r.price, pivot: r.pivot });
        if (pct != null) map.set(t, +pct.toFixed(1));
      }
    }
  } catch { /* optional — no penalty when unavailable */ }
  _pivotExtCache = map;
  return map;
}

// Penalty for a ticker using the validated pivot measure; 0 when not covered.
function penaltyForTicker(ticker, map) {
  const m = map || loadPivotExtensionMap();
  const pct = m.get(String(ticker || '').toUpperCase());
  return pct == null ? 0 : extensionPenalty(pct);
}

module.exports = { extensionPct, extensionPenalty, extensionLabel, loadPivotExtensionMap, penaltyForTicker };

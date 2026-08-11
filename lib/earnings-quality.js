'use strict';

// ── Earnings acceleration & post-results drift ────────────────────────────────
// Pure scoring over a stock's quarterly history (scraped by fetch-earnings-quality.js
// from Screener.in). The thesis, from the fundamental review: in India, thin sell-side
// coverage below ~₹5,000Cr mcap means genuine earnings surprises take days-to-weeks to
// price in, so post-earnings DRIFT is strong — and the classic multibagger pattern is
// 2-3 quarters of sequential YoY acceleration with margins expanding. Our system used
// to treat results purely as risk (a blackout); this makes them an offensive signal.
//
// Row shape produced by the fetcher:
//   { ticker, quarters:[labels...], sales:[], opm:[], profit:[],
//     latestQuarter, resultsSeenAt (ISO date first observed) }

const QMON = { mar: 1, jun: 2, sep: 3, dec: 4 };
function quarterOrd(label) {
  const m = String(label || '').match(/([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return 0;
  return parseInt(m[2], 10) * 4 + (QMON[m[1].toLowerCase()] || 0);
}

// YoY growth % series (quarter vs same quarter last year = 4 columns back).
function yoySeries(vals) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const cur = vals[i], prev = vals[i - 4];
    if (i < 4 || cur == null || prev == null || !(Math.abs(prev) > 0)) { out.push(null); continue; }
    out.push(((cur - prev) / Math.abs(prev)) * 100);
  }
  return out;
}

// How many of the last `look` quarters had YoY growth HIGHER than the quarter before
// (i.e. growth is accelerating, not just positive). Q0>Q1>Q2 in the user's shorthand.
function accelCount(yoy, look = 3) {
  let n = 0;
  for (let i = yoy.length - 1; i >= Math.max(1, yoy.length - look); i--) {
    const a = yoy[i], b = yoy[i - 1];
    if (a == null || b == null) continue;
    if (a > b) n++;
  }
  return n;
}

const lastNonNull = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };

// 0-100 acceleration score + the components, for display and scoring.
function accelerationScore(row) {
  const sales = row.sales || [], profit = row.profit || [], opm = row.opm || [];
  const sYoY = yoySeries(sales), pYoY = yoySeries(profit);
  const salesYoY  = lastNonNull(sYoY);
  const profitYoY = lastNonNull(pYoY);
  const salesAccel  = accelCount(sYoY);
  const profitAccel = accelCount(pYoY);
  // Operating-leverage inflection: margin expanding over the last 2 quarters.
  const o0 = lastNonNull(opm);
  const o2 = opm.length >= 3 ? opm[opm.length - 3] : null;
  const opmDelta2Q = (o0 != null && o2 != null) ? +(o0 - o2).toFixed(2) : null;

  let score = 0;
  // Growth level (0-30): profit YoY carries most weight, sales confirms.
  if (profitYoY != null) score += Math.max(-10, Math.min(20, profitYoY / 3));
  if (salesYoY  != null) score += Math.max(-5,  Math.min(10, salesYoY / 3));
  // Acceleration (0-40): the actual edge — growth getting faster, not just high.
  score += Math.min(24, profitAccel * 8);
  score += Math.min(16, salesAccel * 6);
  // Margin expansion (0-15): operating leverage kicking in.
  if (opmDelta2Q != null) score += Math.max(-8, Math.min(15, opmDelta2Q * 4));
  // Consistency bonus: both lines growing AND both accelerating.
  if ((profitYoY || 0) > 0 && (salesYoY || 0) > 0 && profitAccel >= 2 && salesAccel >= 1) score += 15;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    salesYoY: salesYoY != null ? +salesYoY.toFixed(1) : null,
    profitYoY: profitYoY != null ? +profitYoY.toFixed(1) : null,
    salesAccel, profitAccel, opmDelta2Q,
    latestQuarter: row.latestQuarter || null,
  };
}

// Trading days between an ISO date and now (approx: calendar days × 5/7).
function tradingDaysSince(iso) {
  if (!iso) return null;
  const days = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (!isFinite(days) || days < 0) return null;
  return Math.round(days * 5 / 7);
}

// Post-earnings drift window: results landed within the last `windowDays` trading days.
function inDriftWindow(row, windowDays = 15) {
  const td = tradingDaysSince(row && row.resultsSeenAt);
  return td != null && td <= windowDays;
}

// Convenience: load the sidecar into a ticker→{...score, driftDays} map.
function buildMap(sidecar, { windowDays = 15 } = {}) {
  const map = new Map();
  const rows = (sidecar && sidecar.rows) || [];
  for (const r of rows) {
    const s = accelerationScore(r);
    map.set(String(r.ticker || '').toUpperCase(), {
      ...s,
      resultsSeenAt: r.resultsSeenAt || null,
      driftDays: tradingDaysSince(r.resultsSeenAt),
      inDrift: inDriftWindow(r, windowDays),
    });
  }
  return map;
}

module.exports = { accelerationScore, yoySeries, accelCount, inDriftWindow, tradingDaysSince, buildMap, quarterOrd };

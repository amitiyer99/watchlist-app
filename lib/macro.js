'use strict';

// Macro / market-context layer.
//
// docs/macro.json is produced by fetch-macro.js from free Yahoo feeds (no keys):
// India VIX, USDINR, Brent, Gold, DXY, US 10Y, Nifty, plus breadth computed
// locally from breakout2-data.json. This module holds the pure scoring logic
// (so it is unit-testable without network) and a safe loader used by consumers.
//
// Macro is intentionally a LIGHT tilt, never a hard gate:
//   - riskScale(): global conviction multiplier in [0.9, 1.1]
//   - sectorTilt(sector): per-sector multiplier in ~[0.92, 1.08]
// Stale/missing macro degrades to perfectly neutral (1.0 everywhere).

const fs   = require('fs');
const path = require('path');

const MACRO_PATH = path.join(__dirname, '..', 'docs', 'macro.json');

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pctChange(arr, n) {
  if (!arr || arr.length <= n) return null;
  const a = arr[arr.length - 1 - n], b = arr[arr.length - 1];
  return (a && b) ? +(((b / a) - 1) * 100).toFixed(2) : null;
}
function emaLast(vals, n) {
  if (!vals || !vals.length) return null;
  const k = 2 / (n + 1);
  let e = vals[0];
  for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

// Build the macro snapshot from raw closes per series + a breadth object.
// series: { vix:[], nifty:[], usdinr:[], brent:[], gold:[], dxy:[], us10y:[] } (arrays of closes)
// breadth: { aboveSma50Pct, aboveSma200Pct } (0-100) or null
// flows: optional flowSignal() result from lib/flows (pass explicitly in tests;
//        when omitted it is read from docs/fii-dii.json, degrading to neutral).
function computeMacro(series, breadth, flows) {
  const s = series || {};
  const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);

  const niftyClose = last(s.nifty);
  const niftyEma50 = emaLast(s.nifty || [], 50);
  const niftyTrendUp = (niftyClose != null && niftyEma50 != null) ? niftyClose >= niftyEma50 : null;
  const niftyRet22 = pctChange(s.nifty, 22);

  const vixLevel = last(s.vix);
  const vixChg5 = pctChange(s.vix, 5);
  const usdinrChg22 = pctChange(s.usdinr, 22);
  const brentChg22 = pctChange(s.brent, 22);
  const dxyChg22 = pctChange(s.dxy, 22);
  const us10yChg22 = pctChange(s.us10y, 22);

  // ---- Risk-on score (0-100), sum of bounded components around a 50 neutral ----
  let score = 50;
  const reasons = [];

  // Volatility: low VIX = risk-on. India VIX ~10 calm, ~20+ stressed.
  if (vixLevel != null) {
    const v = clamp((16 - vixLevel) * 2.2, -16, 16); // 16 VIX neutral
    score += v;
    reasons.push(`VIX ${vixLevel.toFixed(1)} ${v >= 0 ? 'calm' : 'elevated'}`);
  }
  if (vixChg5 != null) score += clamp(-vixChg5 * 0.4, -6, 6); // VIX falling = risk-on

  // Trend: Nifty above EMA50 and positive 22d.
  if (niftyTrendUp != null) { score += niftyTrendUp ? 10 : -10; reasons.push(niftyTrendUp ? 'Nifty>EMA50' : 'Nifty<EMA50'); }
  if (niftyRet22 != null) score += clamp(niftyRet22 * 1.2, -10, 10);

  // Currency: weaker rupee (USDINR up) = risk-off for EM equities.
  if (usdinrChg22 != null) score += clamp(-usdinrChg22 * 1.5, -8, 8);
  // Dollar index up = risk-off for EM.
  if (dxyChg22 != null) score += clamp(-dxyChg22 * 0.8, -6, 6);
  // US 10Y rising sharply = risk-off.
  if (us10yChg22 != null) score += clamp(-us10yChg22 * 0.4, -6, 6);

  // Breadth: stage-2 participation (fallback: proximity to 52w highs) informs risk-on.
  const breadthPct = breadth ? (breadth.stage2Pct != null ? breadth.stage2Pct : breadth.nearHighPct) : null;
  if (breadthPct != null) {
    score += clamp((breadthPct - 45) * 0.25, -10, 10);
    reasons.push(`${Math.round(breadthPct)}% in stage-2 uptrend`);
  }

  // Institutional flows: FII 5d net buying = risk-on tilt (bounded, neutral when
  // docs/fii-dii.json is missing or stale-empty).
  let fl = flows;
  if (fl === undefined) {
    try { fl = require('./flows').flowSignal(); } catch { fl = null; }
  }
  if (fl && fl.fii5dNet != null) {
    const f = clamp(fl.fii5dNet / 1000, -8, 8); // ±₹8,000 Cr over 5d saturates
    score += f;
    reasons.push(`FII 5d ${fl.fii5dNet >= 0 ? '+' : ''}${Math.round(fl.fii5dNet)} Cr`);
  }

  const riskOn = Math.round(clamp(score, 0, 100));
  const regime = riskOn >= 62 ? 'Risk-On' : riskOn <= 38 ? 'Risk-Off' : 'Neutral';

  // ---- Sector tilts (modest, evidence-driven heuristics) ----
  const tilts = {};
  const bump = (sec, amt) => { tilts[sec] = clamp((tilts[sec] || 1) + amt, 0.9, 1.1); };
  // Crude up hurts OMCs/paint/aviation, helps upstream Energy/Materials.
  if (brentChg22 != null) {
    const c = clamp(brentChg22 / 100, -0.08, 0.08);
    bump('Energy', c); bump('Materials', c * 0.6);
    bump('Consumer Discretionary', -c * 0.5); bump('Industrials', -c * 0.3);
  }
  // Weaker rupee helps exporters (IT, Pharma/Health Care), hurts importers.
  if (usdinrChg22 != null) {
    const r = clamp(usdinrChg22 / 100, -0.06, 0.06);
    bump('Information Technology', r); bump('Health Care', r * 0.7);
    bump('Consumer Staples', -r * 0.4);
  }
  // Rates down helps rate-sensitives (Financials, Real Estate, Autos).
  if (us10yChg22 != null) {
    const t = clamp(-us10yChg22 / 100, -0.05, 0.05);
    bump('Financials', t); bump('Real Estate', t); bump('Consumer Discretionary', t * 0.5);
  }

  return {
    riskOn, regime,
    components: {
      vixLevel: vixLevel != null ? +vixLevel.toFixed(2) : null,
      vixChg5, niftyTrendUp, niftyRet22,
      usdinrChg22, brentChg22, dxyChg22, us10yChg22,
      breadthStage2: breadth ? breadth.stage2Pct : null,
      breadthNearHigh: breadth ? breadth.nearHighPct : null,
      fii5dNet: fl ? fl.fii5dNet : null,
      dii5dNet: fl ? fl.dii5dNet : null,
      flow5dTrend: fl ? fl.combined5dTrend : null,
    },
    sectorTilts: tilts,
    reasons,
  };
}

function loadMacro(maxAgeHours = 30) {
  try {
    if (!fs.existsSync(MACRO_PATH)) return defaultMacro(false);
    const raw = JSON.parse(fs.readFileSync(MACRO_PATH, 'utf8'));
    const asOf = raw.asOf ? new Date(raw.asOf) : null;
    const staleHours = asOf ? (Date.now() - asOf.getTime()) / 3.6e6 : null;
    const usable = staleHours != null && staleHours <= maxAgeHours;
    if (!usable) return { ...defaultMacro(false), asOf: raw.asOf || null, staleHours };
    return { ...raw, available: true, staleHours: staleHours != null ? +staleHours.toFixed(1) : null };
  } catch (e) {
    return defaultMacro(false);
  }
}

function defaultMacro(available) {
  return { available: !!available, riskOn: 50, regime: 'Neutral', components: {}, sectorTilts: {}, reasons: [], asOf: null, staleHours: null };
}

// Global conviction multiplier from risk-on score, kept tight [0.9, 1.1].
function riskScale(macro) {
  const m = macro || loadMacro();
  if (!m || m.riskOn == null) return 1;
  return clamp(1 + (m.riskOn - 50) / 500, 0.9, 1.1);
}

// Per-sector multiplier, neutral 1.0 when unknown.
function sectorTilt(macro, sector) {
  const m = macro || loadMacro();
  if (!m || !m.sectorTilts || !sector) return 1;
  const v = m.sectorTilts[sector];
  return (typeof v === 'number' && isFinite(v)) ? clamp(v, 0.9, 1.1) : 1;
}

module.exports = { MACRO_PATH, computeMacro, loadMacro, defaultMacro, riskScale, sectorTilt, clamp };

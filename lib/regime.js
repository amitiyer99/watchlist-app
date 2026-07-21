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

// ── Regime V2: composite risk gate ────────────────────────────────────
// The V1 rule (price < EMA26 AND 22D return < -3%) misses grinding bears and
// whipsaws on sharp corrections. V2 layers distribution-day counting, market
// breadth (from the breakout2 sidecar) and small-cap risk appetite on top,
// building a bounded 0-100 riskScore:
//   - old EMA26/ret22D trend signal ........ 0-40
//   - distribution days (>=6/25 = full) .... 0-25
//   - breadth (<=40% above 200dma = full) .. 0-20
//   - smallcap-vs-Nifty 63d spread (<-5%) .. 0-15
// isBearMarket = (old rule) OR riskScore >= 60 — the old rule alone can still
// trigger bear; the composite catches grinding bears the old rule missed.
// All V1 output fields (isBearMarket, ema26, price, ret22D, ret10D) are preserved.
function computeRegimeV2(niftyBars, { midcapBars = null, smallcapBars = null, breadth = null } = {}) {
  const base = computeMarketRegime(niftyBars);

  const closes = (niftyBars || []).map(b => b.close);
  const vols   = (niftyBars || []).map(b => b.volume);
  const n = closes.length;

  // Distribution days: last 25 sessions where Nifty fell >= 0.2% on volume higher
  // than the prior day. Yahoo index volume is often 0/null — if the window lacks
  // usable volume we fall back to counting decline days >= 0.35% (see ddBasis).
  let distributionDays = null;
  let ddBasis = null;
  if (n >= 6) {
    const win = Math.min(25, n - 1);
    let volOk = true;
    for (let i = n - win - 1; i < n; i++) {
      if (!(vols[i] > 0)) { volOk = false; break; }
    }
    let count = 0;
    for (let i = n - win; i < n; i++) {
      const chg = closes[i - 1] > 0 ? (closes[i] / closes[i - 1] - 1) * 100 : 0;
      if (volOk) { if (chg <= -0.2 && vols[i] > vols[i - 1]) count++; }
      else       { if (chg <= -0.35) count++; }
    }
    distributionDays = count;
    ddBasis = volOk ? 'price+volume' : 'price-only (index volume missing; decline >= 0.35% counted)';
  }

  // Breadth inputs (computed upstream from docs/breakout2-data.json; all optional)
  const breadthPct200  = breadth && breadth.pctAbove200 != null ? +(+breadth.pctAbove200).toFixed(1) : null;
  const netNewHighsPct = breadth && breadth.netNewHighs != null ? +(+breadth.netNewHighs).toFixed(1) : null;
  const pctNearHigh    = breadth && breadth.pctNearHigh != null ? +(+breadth.pctNearHigh).toFixed(1) : null;

  // 63-day return spread of an index vs Nifty (risk-appetite proxy; null if missing)
  const niftyRet63 = retPct(closes, 63);
  const spread63 = idxBars => {
    if (!idxBars || niftyRet63 == null) return null;
    const c = idxBars.filter(b => b && b.close != null).map(b => b.close);
    const r = retPct(c, 63);
    return r != null ? +(r - niftyRet63).toFixed(2) : null;
  };
  const smallVsNifty63 = spread63(smallcapBars);
  const midVsNifty63   = spread63(midcapBars);

  // ── Bounded risk components (higher = riskier) ──
  const clampR = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // 1) Old trend signal, 0-40: distance below EMA26 (full 20 at 4% below) + 22D drawdown (full 20 at -6%).
  let trendScore = 0;
  if (base.price != null && base.ema26 != null && base.price < base.ema26) {
    trendScore += clampR(20 * (((base.ema26 - base.price) / base.ema26) * 100) / 4, 0, 20);
  }
  if (base.ret22D != null && base.ret22D < 0) {
    trendScore += clampR(20 * (-base.ret22D) / 6, 0, 20);
  }
  trendScore = Math.round(clampR(trendScore, 0, 40));
  // 2) Distribution days, 0-25: >=6 in 25 sessions = full.
  const ddScore = distributionDays != null ? Math.round(clampR(25 * distributionDays / 6, 0, 25)) : 0;
  // 3) Breadth, 0-20: <=40% of universe above its 200dma = full; >=60% = zero.
  const breadthScore = breadthPct200 != null ? Math.round(clampR(20 * (60 - breadthPct200) / 20, 0, 20)) : 0;
  // 4) Small-cap risk appetite, 0-15: smallcap lagging Nifty by >=5% over 63d = full.
  const spreadScore = (smallVsNifty63 != null && smallVsNifty63 < 0)
    ? Math.round(clampR(15 * (-smallVsNifty63) / 5, 0, 15)) : 0;

  const riskScore = Math.round(clampR(trendScore + ddScore + breadthScore + spreadScore, 0, 100));
  const isBearMarket = base.isBearMarket || riskScore >= 60;

  return {
    ...base,            // ema26, price, ret22D, ret10D (V1 contract fields)
    isBearMarket,       // V1 field, now composite: old rule OR riskScore >= 60
    distributionDays,
    ddBasis,
    breadthPct200,
    netNewHighsPct,
    smallVsNifty63,
    riskScore,
    components: {
      trendScore,       // 0-40
      ddScore,          // 0-25
      breadthScore,     // 0-20
      spreadScore,      // 0-15
      oldRuleBear: base.isBearMarket,
      midVsNifty63,
      pctNearHigh,
    },
    version: 2,
  };
}

// Load the persisted regime snapshot.
//
// FAIL-CLOSED: this is a *risk gate*, so degraded states must tighten, not loosen.
//   - file missing / unreadable  -> treated as BEAR (cautious) + degraded:true
//   - file stale (> maxAgeHours) -> keep the LAST KNOWN regime (do not force bull) + degraded:true
// The old behaviour (missing/stale => bull) meant a broken regime pipeline silently
// switched every downstream gate to its loosest setting.
function loadRegime(maxAgeHours = 80) { // 80h tolerates weekend gaps (Fri eve -> Mon pre-refresh)
  const cautious = (reason, extra = {}) => ({
    isBearMarket: true, ema26: null, price: null, ret22D: null, ret10D: null,
    asOf: null, staleHours: null, available: false, degraded: true, degradedReason: reason, ...extra,
  });
  try {
    if (!fs.existsSync(REGIME_PATH)) return cautious('missing');
    const raw = JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8'));
    const asOf = raw.asOf ? new Date(raw.asOf) : null;
    const staleHours = asOf ? (Date.now() - asOf.getTime()) / 3.6e6 : null;
    const fresh = staleHours != null && staleHours <= maxAgeHours;
    return {
      isBearMarket: !!raw.isBearMarket, // stale => keep last known value, never reset to bull
      ema26: raw.ema26 ?? null,
      price: raw.price ?? null,
      ret22D: raw.ret22D ?? null,
      ret10D: raw.ret10D ?? null,
      asOf: raw.asOf ?? null,
      staleHours: staleHours != null ? +staleHours.toFixed(1) : null,
      available: true,
      degraded: !fresh,
      degradedReason: fresh ? null : 'stale',
    };
  } catch (e) {
    return cautious('error', { error: e.message });
  }
}

function writeRegime(regime) {
  const dir = path.dirname(REGIME_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = { ...regime, asOf: new Date().toISOString() };
  fs.writeFileSync(REGIME_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

module.exports = { computeMarketRegime, computeRegimeV2, loadRegime, writeRegime, REGIME_PATH };

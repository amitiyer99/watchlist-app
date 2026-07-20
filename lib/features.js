'use strict';

// Unified per-ticker feature assembly for the Best Picks meta-model.
// Loads every screener sidecar + delivery, merges by ticker, computes the
// normalized (higher = better) value for each registry feature, then winsorizes
// and z-scores each feature across the universe.

const fs   = require('fs');
const path = require('path');
const { REGISTRY } = require('./feature-registry');

const DOCS = path.join(__dirname, '..', 'docs');

function loadJson(file) {
  try {
    const fp = path.join(DOCS, file);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function up(t) { return String(t || '').trim().toUpperCase(); }

// Merge all sidecars into one record per ticker.
function buildUniverse() {
  const apex = loadJson('apex-tickers.json') || [];
  const b2   = loadJson('breakout2-data.json') || loadJson('breakout-tickers.json') || [];
  const cream = loadJson('creamy-tickers.json') || [];
  const mbf  = loadJson('multibagger-tickers.json') || [];
  const ir   = loadJson('indianresearch-tickers.json') || [];
  const rocket = loadJson('rocket-tickers.json') || [];
  const deliveryData = loadJson('delivery.json');
  let getDelivery = null;
  try { ({ getDelivery } = require('./delivery')); } catch { /* optional */ }

  const map = new Map();
  const ensure = (t, base) => {
    const k = up(t);
    if (!k) return null;
    if (!map.has(k)) map.set(k, { ticker: k, name: k, sector: '', price: null, marketCap: null, url: null, screeners: [], raw: {} });
    const rec = map.get(k);
    if (base) {
      if (base.name) rec.name = base.name;
      if (base.sector) rec.sector = base.sector;
      if (base.price != null) rec.price = base.price;
      if (base.marketCap != null) rec.marketCap = base.marketCap;
      if (base.url && !rec.url) rec.url = base.url;
    }
    return rec;
  };

  for (const s of apex) {
    const r = ensure(s.ticker, s); if (!r) continue;
    r.screeners.push('apex');
    Object.assign(r.raw, {
      apexScore: num(s.score), apexAction: s.action, apexConvergence: !!s.convergence,
      p1: num(s.p1), p2: num(s.p2), p3: num(s.p3), p4: num(s.p4), p5: num(s.p5),
      rsRating: num(s.rsRating), pegVal: num(s.pegVal), fcfYield: num(s.fcfYield),
      roe: num(s.roe), epsGwth5Y: num(s.epsGwth5Y),
      promoterHolding: num(s.promoterHolding), promoterChg3M: num(s.promoterChg3M),
    });
  }
  for (const s of b2) {
    const r = ensure(s.ticker, s); if (!r) continue;
    r.screeners.push('breakout2');
    if (!r.url && (s.stockUrl || s.url)) r.url = s.stockUrl || s.url;
    Object.assign(r.raw, {
      price: num(s.price) ?? r.price,
      s50: num(s.s50), s150: num(s.s150), s200: num(s.s200),
      high52: num(s.high52), low52: num(s.low52),
      rsRating: num(s.rsRating) ?? r.raw.rsRating,
      atrPct: num(s.atrPct), pctBelowPivot: num(s.pctBelowPivot), pivot: num(s.pivot),
      vcpPass: !!s.vcpPass, stage2: !!(s.stage2 || s.stage2Pass),
      volSurge: !!s.volSurgeConfirmed, b2Score: num(s.score) ?? num(s.totalScore),
      ret63: num(s.ret63), ret126_21: num(s.ret126_21), adv20: num(s.adv20),
    });
  }
  for (const s of cream)  { const r = ensure(s.ticker, s); if (r) { r.screeners.push('creamy'); r.raw.creamyScore = num(s.score); } }
  for (const s of mbf)    { const r = ensure(s.ticker, s); if (r) { r.screeners.push('multibagger'); r.raw.mbfScore = num(s.score); } }
  for (const s of rocket) { const r = ensure(s.ticker, s); if (r) { r.screeners.push('rocket'); if (num(s.rsRating) != null && r.raw.rsRating == null) r.raw.rsRating = num(s.rsRating); } }
  for (const s of ir) {
    const r = ensure(s.ticker, s); if (!r) continue;
    r.screeners.push('indianresearch');
    if (r.raw.roe == null) r.raw.roe = num(s.roe);
    if (r.raw.epsGwth5Y == null) r.raw.epsGwth5Y = num(s.epsGrowth5Y);
    if (r.raw.promoterHolding == null) r.raw.promoterHolding = num(s.promoterHolding);
    r.raw.debtEquity = num(s.debtEquity);
  }

  // Delivery surge flag
  if (deliveryData && getDelivery) {
    for (const rec of map.values()) {
      try { const d = getDelivery(deliveryData, rec.ticker); rec.raw.deliverySurge = !!(d && d.deliverySurge); }
      catch { rec.raw.deliverySurge = false; }
    }
  }

  return Array.from(map.values());
}

// Compute the normalized (higher = better) value for each registry feature.
// Returns rec.feat = { id: value|null }.
function computeFeatures(rec) {
  const x = rec.raw;
  const f = {};
  const price = num(x.price);
  f.rsRating   = num(x.rsRating);
  f.ret126_21  = num(x.ret126_21);   // 12-1 momentum — filled by generate-bestpicks from breakout2 bars
  f.ret63      = num(x.ret63);        // 3M return — same source
  f.high52prox = (price != null && num(x.high52)) ? +(price / x.high52).toFixed(4) : null;
  f.distSma200 = (price != null && num(x.s200)) ? +((price / x.s200) - 1).toFixed(4) : null;
  f.riskAdjMom = (num(x.rsRating) != null) ? +(x.rsRating / Math.max(num(x.atrPct) || 3, 0.5)).toFixed(3) : null;
  f.trendStack = (price != null && num(x.s50) && num(x.s150) && num(x.s200))
    ? (price > x.s50 ? 1 : 0) + (x.s50 > x.s150 ? 1 : 0) + (x.s150 > x.s200 ? 1 : 0) + (price > x.s200 ? 1 : 0) : null;
  f.vcp        = x.vcpPass != null ? (x.vcpPass ? 1 : 0) : null;
  f.stage2     = x.stage2 != null ? (x.stage2 ? 1 : 0) : null;
  f.volSurge   = x.volSurge != null ? (x.volSurge ? 1 : 0) : null;
  f.nearPivot  = num(x.pctBelowPivot) != null ? -Math.abs(x.pctBelowPivot) : null;
  f.apexQuality = num(x.p1);
  f.apexGrowth  = num(x.p2);
  f.apexValue   = num(x.p3);
  f.roe        = num(x.roe);
  f.epsGwth5Y  = num(x.epsGwth5Y);
  f.fcfYield   = num(x.fcfYield);
  f.pegInv     = (num(x.pegVal) != null && x.pegVal > 0) ? +(1 / x.pegVal).toFixed(4) : null;
  f.promoterHolding = num(x.promoterHolding);
  f.promoterChg3M   = num(x.promoterChg3M);
  f.deliverySurge   = x.deliverySurge != null ? (x.deliverySurge ? 1 : 0) : null;
  f.screenerCount   = rec.screeners.length;
  f.apexConvergence = x.apexConvergence != null ? (x.apexConvergence ? 1 : 0) : null;
  return f;
}

function winsorize(vals, loP = 0.02, hiP = 0.98) {
  const s = [...vals].sort((a, b) => a - b);
  const lo = s[Math.floor(loP * (s.length - 1))];
  const hi = s[Math.floor(hiP * (s.length - 1))];
  return { lo, hi };
}

// Build the universe with z-scored features.
function buildFeatureMatrix() {
  const stocks = buildUniverse();
  for (const rec of stocks) rec.feat = computeFeatures(rec);

  const z = {}; // id -> {mean,std,lo,hi}
  for (const F of REGISTRY) {
    const vals = stocks.map(s => s.feat[F.id]).filter(v => typeof v === 'number' && isFinite(v));
    if (vals.length < 5) { z[F.id] = null; continue; }
    const { lo, hi } = winsorize(vals);
    const wins = vals.map(v => Math.max(lo, Math.min(hi, v)));
    const mean = wins.reduce((a, b) => a + b, 0) / wins.length;
    const variance = wins.reduce((a, b) => a + (b - mean) ** 2, 0) / wins.length;
    const std = Math.sqrt(variance) || 1;
    z[F.id] = { mean, std, lo, hi };
  }

  for (const rec of stocks) {
    rec.z = {};
    for (const F of REGISTRY) {
      const stat = z[F.id];
      const v = rec.feat[F.id];
      if (!stat || typeof v !== 'number' || !isFinite(v)) { rec.z[F.id] = null; continue; }
      const w = Math.max(stat.lo, Math.min(stat.hi, v));
      rec.z[F.id] = +(((w - stat.mean) / stat.std)).toFixed(3);
    }
  }

  return { stocks, zStats: z };
}

module.exports = { buildUniverse, computeFeatures, buildFeatureMatrix };

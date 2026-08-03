'use strict';

// ── Marquee-investor holdings ─────────────────────────────────────────────────
// Pure logic for the "superstar investor" layer. The Playwright fetcher
// (fetch-investors.js) scrapes each investor's Screener.in shareholding matrix
// into raw rows { slug, name, pcts:[per-quarter %|null], quarters:[labels] }; this
// module turns those into current holdings + trend, and aggregates across all
// investors into a per-stock "how many superstars hold it" signal.

// A holding counts as CURRENT only if the investor still appears in the
// shareholding pattern within the last N quarters — a stock whose last disclosed
// stake is several quarters old means they fell below the 1% disclosure threshold
// (i.e. effectively exited), so we don't call that a current holding.
const DEFAULT_CURRENT_WINDOW = 2;

function num(v) { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,%]/g, '')); return isFinite(n) ? n : null; }

// From a per-quarter %s array, derive the latest stake, previous stake, trend and
// whether it's a current holding. `pcts` is aligned to `quarters` (same length);
// null = not held / below threshold that quarter.
function deriveHolding(pcts, { window = DEFAULT_CURRENT_WINDOW, quartersCount } = {}) {
  const n = quartersCount != null ? quartersCount : pcts.length;
  const nz = pcts.map((v, i) => ({ v: num(v), i })).filter(x => x.v != null);
  if (!nz.length) return null;
  const last = nz[nz.length - 1];
  const prev = nz.length > 1 ? nz[nz.length - 2] : null;
  const currentlyHeld = last.i >= n - window; // last disclosure within the recent window
  let trend;
  if (!prev) trend = 'NEW';
  else if (last.v > prev.v + 0.01) trend = 'ADDED';
  else if (last.v < prev.v - 0.01) trend = 'TRIMMED';
  else trend = 'HELD';
  return { latestPct: +last.v.toFixed(2), prevPct: prev ? +prev.v.toFixed(2) : null, trend, currentlyHeld, lastIdx: last.i };
}

// investorsData: [{ name, holdings:[{ slug, name, latestPct, prevPct, trend, currentlyHeld }] }]
// Returns rows sorted by (# investors desc, then total stake desc):
//   { ticker, name, count, investors:[{name, pct, trend}], adds, totalPct, anyAdd }
// where `adds` = number of investors who NEW/ADDED it in the latest quarter.
function aggregate(investorsData) {
  const bySlug = new Map();
  for (const inv of investorsData) {
    for (const h of (inv.holdings || [])) {
      if (!h.currentlyHeld || !h.slug) continue;
      const key = String(h.slug).toUpperCase();
      let rec = bySlug.get(key);
      if (!rec) { rec = { ticker: key, name: h.name || key, investors: [], slugIsCode: /^\d+$/.test(key) }; bySlug.set(key, rec); }
      // one investor can appear via multiple id-variants → keep the largest stake
      const existing = rec.investors.find(x => x.name === inv.name);
      if (existing) { if (h.latestPct > existing.pct) { existing.pct = h.latestPct; existing.trend = h.trend; } }
      else rec.investors.push({ name: inv.name, pct: h.latestPct, trend: h.trend });
    }
  }
  const rows = [];
  for (const rec of bySlug.values()) {
    const adds = rec.investors.filter(x => x.trend === 'ADDED' || x.trend === 'NEW').length;
    const totalPct = +rec.investors.reduce((s, x) => s + (x.pct || 0), 0).toFixed(2);
    rec.investors.sort((a, b) => b.pct - a.pct);
    rows.push({ ticker: rec.ticker, name: rec.name, count: rec.investors.length, investors: rec.investors, adds, anyAdd: adds > 0, totalPct, slugIsCode: rec.slugIsCode });
  }
  rows.sort((a, b) => (b.count - a.count) || (b.adds - a.adds) || (b.totalPct - a.totalPct));
  return rows;
}

// 0-100 conviction score for use as a confluence source / sniper kicker.
// Driven mainly by how many superstars hold it, boosted a bit for fresh adds.
function marqueeScore(count, adds) {
  let s = Math.min(80, count * 30);        // 1→30, 2→60, 3+→80/90
  s += Math.min(15, adds * 7);             // fresh accumulation bonus
  return Math.max(0, Math.min(100, Math.round(s + (count >= 3 ? 10 : 0))));
}

module.exports = { deriveHolding, aggregate, marqueeScore, DEFAULT_CURRENT_WINDOW };

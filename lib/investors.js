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

// Sortable ordinal for a "Mon YYYY" quarter label (higher = more recent).
const QMON = { mar: 1, jun: 2, sep: 3, dec: 4 };
function quarterOrd(label) {
  const m = String(label || '').match(/([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return 0;
  return parseInt(m[2], 10) * 4 + (QMON[m[1].toLowerCase()] || 0);
}

// From a per-quarter %s array, derive the latest stake, previous stake, trend and
// whether it's a current holding. `pcts` is aligned to `quarters` (same length);
// null = not held / below threshold that quarter.
function deriveHolding(pcts, { window = DEFAULT_CURRENT_WINDOW, quartersCount, quarters } = {}) {
  const n = quartersCount != null ? quartersCount : pcts.length;
  const nz = pcts.map((v, i) => ({ v: num(v), i })).filter(x => x.v != null);
  if (!nz.length) return null;
  const last = nz[nz.length - 1];
  const first = nz[0];
  const prev = nz.length > 1 ? nz[nz.length - 2] : null;
  const currentlyHeld = last.i >= n - window; // last disclosure within the recent window
  let trend;
  if (!prev) trend = 'NEW';
  else if (last.v > prev.v + 0.01) trend = 'ADDED';
  else if (last.v < prev.v - 0.01) trend = 'TRIMMED';
  else trend = 'HELD';
  const q = Array.isArray(quarters) ? quarters : null;
  return {
    latestPct: +last.v.toFixed(2), prevPct: prev ? +prev.v.toFixed(2) : null, trend, currentlyHeld, lastIdx: last.i,
    latestQuarter: q ? q[last.i] : null,   // as-of quarter of the current stake
    sinceQuarter: q ? q[first.i] : null,   // first quarter they appeared (tenure)
    quartersHeld: nz.length,               // number of quarters on record
  };
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
      const entry = { name: inv.name, pct: h.latestPct, trend: h.trend, latestQuarter: h.latestQuarter, sinceQuarter: h.sinceQuarter, quartersHeld: h.quartersHeld, lastBuyDate: h.lastBuyDate || null };
      // one investor can appear via multiple id-variants → keep the largest stake
      const existing = rec.investors.find(x => x.name === inv.name);
      if (existing) { if (h.latestPct > existing.pct) Object.assign(existing, entry); }
      else rec.investors.push(entry);
    }
  }
  const rows = [];
  for (const rec of bySlug.values()) {
    const adds = rec.investors.filter(x => x.trend === 'ADDED' || x.trend === 'NEW').length;
    const totalPct = +rec.investors.reduce((s, x) => s + (x.pct || 0), 0).toFixed(2);
    rec.investors.sort((a, b) => b.pct - a.pct);
    // Recency across investors: most recent disclosure quarter + most recent bulk/block buy date.
    const mostRecentQuarter = rec.investors.reduce((best, x) => quarterOrd(x.latestQuarter) > quarterOrd(best) ? x.latestQuarter : best, rec.investors[0].latestQuarter || null);
    const recencyOrd = quarterOrd(mostRecentQuarter);
    const buyDates = rec.investors.map(x => x.lastBuyDate).filter(Boolean).sort();
    const lastBuyDate = buyDates.length ? buyDates[buyDates.length - 1] : null;
    rows.push({ ticker: rec.ticker, name: rec.name, count: rec.investors.length, investors: rec.investors, adds, anyAdd: adds > 0, totalPct, slugIsCode: rec.slugIsCode, mostRecentQuarter, recencyOrd, lastBuyDate });
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

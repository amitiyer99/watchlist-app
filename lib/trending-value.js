'use strict';

// ── Trending Value (O'Shaughnessy) ────────────────────────────────────────────
// "What Works on Wall Street" combines a six-factor VALUE COMPOSITE with price
// MOMENTUM: buy the cheapest decile of the market, then own the ones already
// working. Cheapness alone buys falling knives; momentum alone buys froth.
//
// The scoring rules that actually matter — and that a naive implementation gets
// wrong — are all about the sign of the denominator:
//
//   • A negative P/E is not cheap, it is a loss. Sorting numerically would rank
//     a company at −4x as the cheapest stock in the market. Negative earnings,
//     negative book, negative cash flow and negative EBITDA are therefore
//     hard-assigned the WORST decile (10), never ranked.
//   • A MISSING metric is different from a bad one. Punishing absent data
//     measures our data coverage, not the company's valuation — so missing
//     metrics are dropped and the composite is renormalised over what is
//     present (minimum 4 of 6). The scale stays 6-60 either way.
//   • For banks, NBFCs and insurers, EV/EBITDA and P/CF are not meaningful
//     (there is no enterprise value when debt is raw material, and operating
//     cash flow swings with the loan book). Those two are dropped for
//     financials and the composite renormalises over the remaining four.
//
// Everything here is pure: no network, no filesystem. That makes the scoring
// testable against synthetic universes — see test-trending-value.js.

// ── Screen rules ──────────────────────────────────────────────────────────────
const RULES = {
  mcapMin: 500,          // ₹Cr — the user-specified floor
  adv20Min: 1e7,         // ₹1 Cr/day traded. Value screens surface illiquid names;
                         //   a composite score you cannot act on is decoration.
  minMetrics: 4,         // of 6 — below this the composite is too thin to compare
  decileCut: 0.10,       // "top decile" = cheapest 10% of the screened universe
  topN: 25,              // final list length
  excludeSurveillance: true, // ASM/GSM names are over-represented in cheap screens
};

// The six factors. `dir` is the direction of CHEAPNESS, not of the number.
const METRICS = [
  { id: 'pe',        label: 'P/E',       dir: 'low',  posOnly: true,  skipFin: false,
    tip: 'Price to earnings. Negative earnings are scored worst, not cheapest.' },
  { id: 'pb',        label: 'P/B',       dir: 'low',  posOnly: true,  skipFin: false,
    tip: 'Price to book. The one value factor that still works on financials.' },
  { id: 'pcf',       label: 'P/CF',      dir: 'low',  posOnly: true,  skipFin: true,
    tip: 'Price to cash flow. Harder to manage than earnings, which is why it earns its place.' },
  { id: 'ps',        label: 'P/S',       dir: 'low',  posOnly: true,  skipFin: false,
    tip: 'Price to sales. O\'Shaughnessy\'s single best standalone value factor in the US data.' },
  { id: 'evEbitda',  label: 'EV/EBITDA', dir: 'low',  posOnly: true,  skipFin: true,
    tip: 'Enterprise value to EBITDA — capital-structure neutral, so it sees through debt.' },
  { id: 'divYield',  label: 'Div Yield', dir: 'high', posOnly: false, skipFin: false,
    tip: 'Dividend yield. Highest yield scores 1; a non-payer scores 10.' },
];

// Sectors where EV/EBITDA and P/CF do not describe anything real.
const FINANCIAL_RE = /financ|bank|insur|nbfc|capital market|asset manage/i;
const isFinancial = s => FINANCIAL_RE.test(String(s || ''));

// ── Decile ranking ────────────────────────────────────────────────────────────
// Ties must share a decile, otherwise two identical valuations get different
// scores purely from array order. Average-rank handles that.
function decilesFor(entries, dir, pctOut = null) {
  const scored = new Map();
  const ok = entries.filter(e => e.v != null && isFinite(e.v));
  if (!ok.length) return scored;

  ok.sort((a, b) => dir === 'high' ? b.v - a.v : a.v - b.v);

  // Average rank within each tie group, then map to 1-10 by fractional position.
  let i = 0;
  while (i < ok.length) {
    let j = i;
    while (j + 1 < ok.length && ok[j + 1].v === ok[i].v) j++;
    const avgRank = (i + j) / 2;                       // 0-based
    const frac = (avgRank + 0.5) / ok.length;          // 0..1
    const d = Math.min(10, Math.max(1, Math.floor(frac * 10) + 1));
    for (let k = i; k <= j; k++) {
      scored.set(ok[k].key, d);
      // The same rank kept at full resolution. Six integer deciles only produce
      // 55 possible composites, so on a 1,200-stock universe ~20 names share
      // every score and a "cheapest 10%" cut would actually return 20%. The
      // percentile is carried alongside purely to break those ties.
      if (pctOut) pctOut.set(ok[k].key, frac);
    }
    i = j + 1;
  }
  return scored;
}

// One metric's score for every stock. Returns { byKey, ranked, worst, missing }.
function scoreMetric(stocks, metric) {
  const eligible = [];   // ranked normally
  const worst = [];      // negative/zero denominator → hard 10
  const missing = [];    // no data → excluded from the composite

  for (const s of stocks) {
    const key = s.ticker;
    if (metric.skipFin && isFinancial(s.sector)) { missing.push(key); continue; }
    const v = s[metric.id];

    if (v == null || !isFinite(v)) {
      // A non-payer is a real observation of zero yield, not a data gap.
      if (metric.id === 'divYield') { worst.push(key); continue; }
      missing.push(key); continue;
    }
    if (metric.id === 'divYield') {
      if (v <= 0) { worst.push(key); continue; }
      eligible.push({ key, v }); continue;
    }
    // Ratios: a non-positive denominator means the multiple is meaningless AND
    // the underlying is loss-making. Worst decile, never ranked.
    if (metric.posOnly && v <= 0) { worst.push(key); continue; }
    eligible.push({ key, v });
  }

  const pctByKey = new Map();
  const byKey = decilesFor(eligible, metric.dir, pctByKey);
  for (const k of worst) { byKey.set(k, 10); pctByKey.set(k, 1); }
  return { byKey, pctByKey, rankedCount: eligible.length, worstCount: worst.length, missingCount: missing.length };
}

// ── The composite ─────────────────────────────────────────────────────────────
// Sum of six 1-10 scores would be 6-60. With fewer than six present we take the
// MEAN of what is there and rescale by 6, so a 4-metric composite is directly
// comparable to a 6-metric one.
function compositeOf(scores) {
  const vals = METRICS.map(m => scores[m.id]).filter(v => v != null);
  if (vals.length < RULES.minMetrics) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { score: Math.round(mean * 6 * 10) / 10, nMetrics: vals.length };
}

// ── Full screen ───────────────────────────────────────────────────────────────
// stocks: [{ ticker, name, sector, price, marketCap, volume, pe, pb, pcf, ps,
//            evEbitda, divYield, ret6M, roce, roe, ... }]
// opts:   { surveillance:Set<ticker>, rules }
function runScreen(stocks, opts = {}) {
  const R = Object.assign({}, RULES, opts.rules || {});
  const surv = opts.surveillance || new Set();

  const rejected = { mcap: 0, liquidity: 0, surveillance: 0, thinData: 0, noMomentum: 0 };

  // 1 — universe
  const universe = [];
  for (const s of stocks) {
    if (!s.ticker) continue;
    // audit-ok: REJECT context — the branch rejects, so a null market cap is excluded, not admitted
    if (s.marketCap == null || s.marketCap < R.mcapMin) { rejected.mcap++; continue; }
    // Liquidity FAILS CLOSED: an unknown ADV is treated as untradeable, because
    // the alternative is putting a name on the page you cannot buy.
    const adv = (s.volume != null && s.price != null) ? s.volume * s.price : null;
    // audit-ok: REJECT context — an unknown ADV is treated as untradeable and dropped
    if (adv == null || adv < R.adv20Min) { rejected.liquidity++; continue; }
    if (R.excludeSurveillance && surv.has(s.ticker)) { rejected.surveillance++; continue; }
    universe.push(s);
  }

  // 2 — score each factor across the universe
  const perMetric = {};
  for (const m of METRICS) perMetric[m.id] = scoreMetric(universe, m);

  // 3 — composite per stock
  const scoredRows = [];
  for (const s of universe) {
    const scores = {};
    const pcts = [];
    for (const m of METRICS) {
      const d = perMetric[m.id].byKey.get(s.ticker);
      scores[m.id] = d == null ? null : d;
      const p = perMetric[m.id].pctByKey.get(s.ticker);
      if (d != null && p != null) pcts.push(p);
    }
    const c = compositeOf(scores);
    if (!c) { rejected.thinData++; continue; }
    scoredRows.push({
      ...s, scores, composite: c.score, nMetrics: c.nMetrics,
      // Full-resolution twin of the composite. Displayed nowhere; used only to
      // decide who makes the decile cut when composites tie.
      tiePct: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 1,
      financial: isFinancial(s.sector),
    });
  }

  // 4 — cheapest decile. Cut by COUNT, not by score threshold: on integer
  // composites, "composite <= cutoff" sweeps in every tied name and returns
  // roughly twice the intended decile. Ties broken on the percentile twin.
  const byCheapness = scoredRows.slice().sort((a, b) => (a.composite - b.composite) || (a.tiePct - b.tiePct));
  const takeN = Math.max(1, Math.ceil(byCheapness.length * R.decileCut));
  const valueDecile = byCheapness.slice(0, takeN);
  const cutoff = valueDecile.length ? valueDecile[valueDecile.length - 1].composite : null;

  // 5 — rank the cheap decile by 6-month momentum
  const rankable = valueDecile.filter(r => r.ret6M != null && isFinite(r.ret6M));
  rejected.noMomentum = valueDecile.length - rankable.length;
  rankable.sort((a, b) => b.ret6M - a.ret6M);

  const picks = rankable.slice(0, R.topN).map((r, i) => ({ ...r, rank: i + 1 }));

  return {
    picks,
    valueDecile,          // the whole cheap decile, for context and the "just missed" list
    scoredRows,
    universeSize: universe.length,
    scoredSize: scoredRows.length,
    cutoff,
    rejected,
    coverage: METRICS.map(m => ({
      id: m.id, label: m.label,
      ranked: perMetric[m.id].rankedCount,
      worst: perMetric[m.id].worstCount,
      missing: perMetric[m.id].missingCount,
    })),
    rules: R,
  };
}

module.exports = { RULES, METRICS, runScreen, compositeOf, decilesFor, scoreMetric, isFinancial };

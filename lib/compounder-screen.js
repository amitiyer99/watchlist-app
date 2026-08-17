'use strict';

// ── Compounder screen + cohort state ──────────────────────────────────────────
// The first version of this feature needed a hand-written thesis per position, which made
// it a chore rather than a system — so nothing ever went in it. This is the rethink:
//
//   • The SCREEN picks the cohort automatically from data already on disk.
//   • The first time a name qualifies, its fundamentals are SNAPSHOT. That snapshot IS the
//     thesis — "entered at ROE 26%, D/E 0.03, promoter 72%, EPS CAGR 71%" — so no prose is
//     required and the sell rule stays checkable.
//   • A THESIS BREAK is measurable drift from that snapshot: returns falling, debt
//     appearing, promoters selling down, growth decaying. Fully mechanical.
//
// Deliberately absent: price stops, price targets, trailing exits. A stock that multiplies
// 10x draws down 30-50% more than once; the exit rules that make the Triggers page work
// would take you out at ~1.5x every time. Price is context here, never a signal.
//
// Sources (all already produced by the nightly pipeline):
//   docs/indianresearch-tickers.json  roe, epsGrowth5Y, debtEquity, promoterHolding, marketCap
//   docs/multibagger-tickers.json     MBF score + badges (used for ranking)
//   docs/apex-tickers.json            pillar scores (capital quality / growth / insider)
//   docs/earnings-quality.json        13 quarters of sales/OPM/profit where available
//   docs/live-prices.json             current price for the multiple

const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const COHORT_PATH = path.join(DOCS, 'compounder-cohort.json');

// ── Entry rules ───────────────────────────────────────────────────────────────
// Quality + durable growth + room to compound + tradeable. Deliberately not a momentum
// or valuation screen: those are the other pages' job.
const RULES = {
  roeMin: 18,             // capital quality — the engine of compounding
  deMax: 0.5,             // a leveraged compounder is a different, worse bet
  promoterMin: 50,        // skin in the game
  eps5yMin: 18,           // durable growth, not one good year
  mcapMin: 500,           // ₹Cr — below this, liquidity and disclosure get unreliable
  mcapMax: 15000,         // ₹Cr — above this, a 10x needs to become a mega-cap
  adv20Min: 2e7,          // ₹2 Cr/day — you must be able to build and exit a position
  cohortSize: 20,         // power-law maths: enough to catch 1-2, few enough to follow
};

// ── Drift thresholds: what counts as the thesis breaking ─────────────────────
// Generous, because these are annual-ish metrics that wobble. The point is to catch
// deterioration, not to react to noise.
const DRIFT = {
  roeDropPp: 6,           // ROE fell this many points below the entry snapshot
  roeFloor: 12,           // ...or fell below this absolute level
  dePp: 0.35,             // debt appeared where there was none
  promoterDropPp: 4,      // promoters sold down materially
  eps5yDropPp: 8,         // the long-run growth record decayed
  salesYoYFloor: 0,       // a quarter of shrinking sales (when quarterly data exists)
};

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

function loadSources() {
  const ir  = readJson(path.join(DOCS, 'indianresearch-tickers.json'), []) || [];
  const mb  = readJson(path.join(DOCS, 'multibagger-tickers.json'), []) || [];
  const ap  = readJson(path.join(DOCS, 'apex-tickers.json'), []) || [];
  const eqR = readJson(path.join(DOCS, 'earnings-quality.json'), { rows: [] });
  return {
    ir,
    mbByTicker: new Map(mb.map(r => [r.ticker, r])),
    apByTicker: new Map(ap.map(r => [r.ticker, r])),
    eqByTicker: new Map((eqR.rows || []).map(r => [String(r.ticker).toUpperCase(), r])),
  };
}

// Year-on-year growth per quarter, so seasonality cancels.
function yoy(series) {
  const out = [];
  for (let i = 4; i < (series || []).length; i++) {
    const now = series[i], then = series[i - 4];
    out.push(then && then > 0 ? +(((now / then) - 1) * 100).toFixed(1) : null);
  }
  return out;
}

// The measurable state of a business right now — this is what gets snapshot at entry and
// compared against later.
function snapshotOf(r, eq) {
  const salesYoY = eq ? yoy(eq.sales).filter(v => v != null) : [];
  const opm = (eq && eq.opm) || [];
  return {
    roe: r.roe != null ? +r.roe.toFixed(1) : null,
    debtEquity: r.debtEquity != null ? +r.debtEquity.toFixed(2) : null,
    promoterHolding: r.promoterHolding != null ? +r.promoterHolding.toFixed(1) : null,
    epsGrowth5Y: r.epsGrowth5Y != null ? +r.epsGrowth5Y.toFixed(1) : null,
    marketCap: r.marketCap != null ? Math.round(r.marketCap) : null,
    salesYoY: salesYoY.length ? salesYoY[salesYoY.length - 1] : null,
    opm: opm.length ? opm[opm.length - 1] : null,
    latestQuarter: (eq && eq.latestQuarter) || null,
  };
}

// The snapshot rendered as the sentence you would otherwise have had to write yourself.
function thesisFrom(snap) {
  const bits = [];
  if (snap.roe != null) bits.push(`ROE ${snap.roe}%`);
  if (snap.epsGrowth5Y != null) bits.push(`EPS CAGR ${snap.epsGrowth5Y}% over 5 years`);
  if (snap.debtEquity != null) bits.push(snap.debtEquity <= 0.1 ? 'effectively debt-free' : `D/E ${snap.debtEquity}`);
  if (snap.promoterHolding != null) bits.push(`promoters hold ${snap.promoterHolding}%`);
  if (snap.marketCap != null) bits.push(`₹${snap.marketCap.toLocaleString('en-IN')} Cr — room to compound`);
  return `Entered on the strength of ${bits.join(', ')}. The thesis is that this rate of return on capital persists and is reinvested; it breaks if returns fall, debt appears, promoters sell down, or growth decays.`;
}

function qualifies(r, adv20) {
  return r.roe != null && r.roe >= RULES.roeMin
    && r.debtEquity != null && r.debtEquity <= RULES.deMax
    && r.promoterHolding != null && r.promoterHolding >= RULES.promoterMin
    && r.epsGrowth5Y != null && r.epsGrowth5Y >= RULES.eps5yMin
    && r.marketCap != null && r.marketCap >= RULES.mcapMin && r.marketCap <= RULES.mcapMax
    // Liquidity FAILS CLOSED: an unpriceable name is one you cannot size or exit.
    && (adv20 == null ? false : adv20 >= RULES.adv20Min);
}

// Compare today against the entry snapshot. Each drift is a named, quantified statement —
// never a vague "looks weak".
function driftFlags(entry, now) {
  const f = [];
  if (entry.roe != null && now.roe != null) {
    if (entry.roe - now.roe >= DRIFT.roeDropPp) f.push({ sev: 'warn', text: `ROE ${now.roe}% vs ${entry.roe}% at entry — ${(entry.roe - now.roe).toFixed(1)}pp of the compounding engine has gone` });
    if (now.roe < DRIFT.roeFloor) f.push({ sev: 'bad', text: `ROE ${now.roe}% is below the ${DRIFT.roeFloor}% floor — this no longer compounds fast enough to be here` });
  }
  if (entry.debtEquity != null && now.debtEquity != null && (now.debtEquity - entry.debtEquity) >= DRIFT.dePp) {
    f.push({ sev: 'warn', text: `D/E rose to ${now.debtEquity} from ${entry.debtEquity} at entry — growth is being bought with debt` });
  }
  if (entry.promoterHolding != null && now.promoterHolding != null && (entry.promoterHolding - now.promoterHolding) >= DRIFT.promoterDropPp) {
    f.push({ sev: 'bad', text: `Promoter holding ${now.promoterHolding}% vs ${entry.promoterHolding}% at entry — the people who know most are selling` });
  }
  if (entry.epsGrowth5Y != null && now.epsGrowth5Y != null && (entry.epsGrowth5Y - now.epsGrowth5Y) >= DRIFT.eps5yDropPp) {
    f.push({ sev: 'warn', text: `5-year EPS CAGR decayed to ${now.epsGrowth5Y}% from ${entry.epsGrowth5Y}%` });
  }
  if (now.salesYoY != null && now.salesYoY < DRIFT.salesYoYFloor) {
    f.push({ sev: 'bad', text: `Latest quarter sales SHRANK ${Math.abs(now.salesYoY)}% year-on-year` });
  }
  return f;
}

// ── Cohort state: written and maintained by the generator, never by hand ──────
function buildCohort({ today = new Date().toISOString().slice(0, 10), livePrices = {} } = {}) {
  const { ir, mbByTicker, apByTicker, eqByTicker } = loadSources();
  const state = readJson(COHORT_PATH, null) || { createdAt: today, rules: RULES, members: {} };

  // Rank qualifiers by MBF score — the composite that already blends quality, growth,
  // valuation and smart money — then take the cohort size.
  const eligible = ir
    .filter(r => qualifies(r, (mbByTicker.get(r.ticker) || {}).adv20))
    .map(r => ({ r, mbf: (mbByTicker.get(r.ticker) || {}).score || 0 }))
    .sort((a, b) => b.mbf - a.mbf);
  const selected = eligible.slice(0, RULES.cohortSize);
  const selectedSet = new Set(selected.map(x => x.r.ticker));

  const added = [];
  for (const { r, mbf } of selected) {
    const t = r.ticker;
    const eq = eqByTicker.get(t.toUpperCase());
    const snap = snapshotOf(r, eq);
    if (!state.members[t]) {
      // FIRST APPEARANCE — snapshot it. This is the entry, and the snapshot is the thesis.
      state.members[t] = {
        ticker: t, name: r.name, sector: r.sector,
        addedOn: today,
        entryPrice: r.price != null ? +r.price.toFixed(2) : null,
        entry: snap,
        thesis: thesisFrom(snap),
        mbfAtEntry: mbf,
        stillQualifies: true,
        leftScreenOn: null,
      };
      added.push(t);
    } else {
      state.members[t].stillQualifies = true;
      state.members[t].leftScreenOn = null;
    }
  }

  // Names that dropped out of the screen are NOT deleted — a cohort you can edit after the
  // fact teaches you nothing. They are marked, so the record stays honest.
  const dropped = [];
  for (const [t, m] of Object.entries(state.members)) {
    if (!selectedSet.has(t) && m.stillQualifies !== false) {
      m.stillQualifies = false;
      m.leftScreenOn = today;
      dropped.push(t);
    }
  }

  // Current readings + drift, for every member ever added.
  const irByTicker = new Map(ir.map(r => [r.ticker, r]));
  const rows = Object.values(state.members).map(m => {
    const r = irByTicker.get(m.ticker);
    const eq = eqByTicker.get(m.ticker.toUpperCase());
    const now = r ? snapshotOf(r, eq) : null;
    const lp = livePrices[m.ticker];
    const price = (lp && lp.p != null) ? lp.p : (r ? r.price : null);
    const mult = (price != null && m.entryPrice > 0) ? price / m.entryPrice : null;
    const heldYears = (Date.now() - new Date(m.addedOn + 'T00:00:00').getTime()) / 3.15576e10;
    const flags = now ? driftFlags(m.entry, now) : [{ sev: 'warn', text: 'No current fundamentals on file — cannot judge the thesis this run' }];
    const ap = apByTicker.get(m.ticker);
    return {
      ...m, now, price, mult, heldYears, flags,
      apexAction: ap ? ap.action : null,
      mbfNow: (mbByTicker.get(m.ticker) || {}).score ?? null,
      hasQuarterly: !!eq,
    };
  }).sort((a, b) => (b.mbfNow || 0) - (a.mbfNow || 0));

  return { state, rows, added, dropped, eligibleCount: eligible.length, RULES, DRIFT };
}

function saveCohort(state) {
  state.updatedAt = new Date().toISOString();
  if (!fs.existsSync(DOCS)) fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(COHORT_PATH, JSON.stringify(state, null, 2), 'utf8');
}

module.exports = { buildCohort, saveCohort, qualifies, snapshotOf, thesisFrom, driftFlags, yoy, RULES, DRIFT, COHORT_PATH };

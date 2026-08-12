'use strict';

// ── Factor Lab ────────────────────────────────────────────────────────────────
// score-lab answers "does the SCORE rank?". When the answer is FLAT — as it was for
// every page — the next question is "then WHICH FACTORS rank, and which are dead
// weight?". This slices the same outcome ledger by the individual factors each page
// stamped onto its emissions, so weights can be set from realised forward alpha
// instead of from the Minervini/O'Neil literature and hope.
//
// Why this matters for Breakout GEN2 specifically: its score is
//   stage(48) + vcp(30) + volume-dry-up(22) + accumulation(10), scaled, minus extension
// RS Rating carries ZERO weight despite being the most-cited factor in the framework,
// and the confirming volume surge also carries zero while the quiet base carries 22.
// Those are testable claims, so test them.
//
// Method mirrors score-lab deliberately (same ledger, same maturity rule, same
// NON-OVERLAPPING episode dedup, same Spearman-on-ranks) so numbers are comparable:
//   • only matured 20d rows with a computable alpha
//   • one row per ticker-episode, so a name re-emitted daily can't fake significance
//   • per factor bucket: n, median alpha, beat-Nifty rate, and lift vs the page median
//   • for continuous factors, the rank correlation with alpha
//   • A/B: does bolting a candidate factor onto the live score improve its ordering?
//
// Usage:
//   node factor-lab.js                 → breakout2 (default)
//   node factor-lab.js --screener=all  → every screener that stamps extras
//   node factor-lab.js --min-n=15

const fs = require('fs');
const path = require('path');
const { spearman, dedupeEpisodes } = require('./score-lab');

const LEDGER = path.join(__dirname, 'screener-outcomes.json');
const OUT = path.join(__dirname, 'docs', 'factor-lab.json');
const HORIZON = '20d';

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const alphaOf = r => r.results[HORIZON].alpha;

// ── Factor definitions ────────────────────────────────────────────────────────
// Each returns a bucket label (or null to exclude the row). `order` fixes the
// print order so a monotonic pattern is visible at a glance rather than alphabetical.
const extPct = r => (r.entry != null && r.pivot > 0) ? ((r.entry - r.pivot) / r.pivot) * 100 : null;

const FACTORS = [
  {
    key: 'rsRating', label: 'RS Rating (percentile vs universe)', intent: +1, weightId: 'rs',
    value: r => r.extras && r.extras.rsRating,
    bucket: v => v == null ? null : v >= 90 ? 'E 90-99' : v >= 80 ? 'D 80-89' : v >= 70 ? 'C 70-79' : v >= 50 ? 'B 50-69' : 'A <50',
    order: ['A <50', 'B 50-69', 'C 70-79', 'D 80-89', 'E 90-99'],
    note: 'Currently worth 0 points in the breakout2 score.',
  },
  {
    key: 'stage2', label: 'Stage-2 template passed (>=5 of 6 checks)', intent: +1, weightId: 'stage',
    value: r => r.extras && r.extras.stage2,
    bucket: v => v == null ? null : v ? 'B pass' : 'A fail',
    order: ['A fail', 'B pass'],
    note: 'Worth up to 48 points — the single largest block.',
  },
  {
    key: 'vcpPass', label: 'VCP base structure confirmed', intent: +1, weightId: 'vcp',
    value: r => r.extras && r.extras.vcpPass,
    bucket: v => v == null ? null : v ? 'B pass' : 'A fail',
    order: ['A fail', 'B pass'],
    note: 'Worth up to 30 points.',
  },
  {
    key: 'volSurgePct', label: 'Breakout-day volume vs 50-day average', intent: +1, weightId: 'volSurge',
    value: r => r.extras && r.extras.volSurgePct,
    bucket: v => v == null ? null : v >= 300 ? 'E 300%+' : v >= 200 ? 'D 200-299%' : v >= 150 ? 'C 150-199%' : v >= 100 ? 'B 100-149%' : 'A <100%',
    order: ['A <100%', 'B 100-149%', 'C 150-199%', 'D 200-299%', 'E 300%+'],
    note: 'Currently worth 0 points; the quiet base is worth 22.',
  },
  {
    key: 'atrPct', label: 'Volatility (ATR14 as % of price)', intent: -1, weightId: 'atrTight',
    value: r => (r.extras && r.extras.atr14 != null && r.entry > 0) ? (r.extras.atr14 / r.entry) * 100 : null,
    bucket: v => v == null ? null : v >= 6 ? 'D 6%+' : v >= 4 ? 'C 4-6%' : v >= 2.5 ? 'B 2.5-4%' : 'A <2.5%',
    order: ['A <2.5%', 'B 2.5-4%', 'C 4-6%', 'D 6%+'],
    note: 'Only used for stop sizing, not scored.',
  },
  {
    key: 'extension', label: 'Entry extension above pivot', intent: -1, weightId: 'extension',
    value: extPct,
    bucket: v => v == null ? null : v < 0 ? 'A below pivot' : v < 2 ? 'B at pivot' : v < 5 ? 'C mild 2-5%' : v < 10 ? 'D extended 5-10%' : 'E chased 10%+',
    order: ['A below pivot', 'B at pivot', 'C mild 2-5%', 'D extended 5-10%', 'E chased 10%+'],
    note: 'Already penalised via lib/extension.js — included as a control.',
  },
  {
    key: 'signalType', label: 'Signal type',
    value: r => r.signalType,
    bucket: v => v || null,
    note: 'Which trigger emitted the row.',
  },
  {
    key: 'regime', label: 'Market regime at emission',
    value: r => r.regime,
    bucket: v => v || null,
    note: 'Context, not a stock factor.',
  },
];

// ── Verdict per factor ────────────────────────────────────────────────────────
// `ic` = Spearman rank correlation between the factor's ORDINAL BUCKET (works for
// booleans too) and forward alpha, signed by the factor's INTENDED direction. So
// ic > 0 means "the textbook is right on this data"; ic < 0 means the factor is
// actively pointing the wrong way.
//
// The gate is significance-aware rather than a fixed cutoff: with n episodes the
// standard error of a rank correlation is ~1/sqrt(n), so we require 2 SEs. At n=450
// that is |ic| >= 0.094 — which correctly refuses to promote the +-0.05 noise that a
// naive threshold would have dressed up as an edge.
function factorVerdict(rows, f, minN) {
  if (!f.weightId) return null;
  const ord = new Map((f.order || []).map((l, i) => [l, i]));
  const pairs = [];
  for (const r of rows) {
    const b = f.bucket(f.value(r));
    if (b == null) continue;
    const oi = ord.has(b) ? ord.get(b) : null;
    if (oi == null) continue;
    pairs.push([oi, alphaOf(r)]);
  }
  const n = pairs.length;
  if (n < minN) return { weightId: f.weightId, n, ic: null, verdict: 'INSUFFICIENT', reason: `only ${n} episodes` };
  const raw = spearman(pairs);
  if (raw == null) return { weightId: f.weightId, n, ic: null, verdict: 'INSUFFICIENT', reason: 'no correlation computable' };
  const ic = +(raw * (f.intent || 1)).toFixed(3);
  const gate = +(2 / Math.sqrt(n)).toFixed(3);
  const verdict = ic >= gate ? 'LIVE' : ic <= -gate ? 'CONTRADICTED' : 'NEUTRAL';
  const reason = verdict === 'LIVE' ? `ic ${ic} clears the ${gate} significance gate — factor predicts as intended`
    : verdict === 'CONTRADICTED' ? `ic ${ic} is significantly NEGATIVE — this factor points the wrong way on live data`
    : `ic ${ic} is inside the +-${gate} noise band — no evidence either way, stay neutral`;
  return { weightId: f.weightId, n, ic, gate, verdict, reason };
}

function bucketTable(rows, f, pageMedian) {
  const groups = {};
  for (const r of rows) {
    const b = f.bucket(f.value(r));
    if (b == null) continue;
    (groups[b] = groups[b] || []).push(alphaOf(r));
  }
  const labels = f.order ? f.order.filter(l => groups[l]) : Object.keys(groups).sort();
  return labels.map(l => {
    const a = groups[l];
    const med = median(a);
    return {
      bucket: l, n: a.length,
      medianAlpha: +med.toFixed(2),
      beatRate: +((a.filter(x => x > 0).length / a.length) * 100).toFixed(0),
      lift: pageMedian != null ? +(med - pageMedian).toFixed(2) : null,
    };
  });
}

// Continuous rank correlation, on the numeric value rather than the bucket.
function contCorr(rows, f) {
  const pairs = rows.map(r => [f.value(r), alphaOf(r)])
    .filter(p => typeof p[0] === 'number' && isFinite(p[0]));
  return pairs.length >= 8 ? { rho: spearman(pairs), n: pairs.length } : null;
}

// ── A/B: would adding this factor to the live score improve its ORDERING? ─────
// Recompute a candidate score = live score + weight × normalised factor, then compare
// Spearman against alpha. If the candidate's rho isn't better, the factor doesn't
// deserve points no matter what the textbooks say.
function candidateTest(rows, name, adjust) {
  const base = rows.filter(r => r.score != null).map(r => [r.score, alphaOf(r)]);
  const cand = rows.filter(r => r.score != null).map(r => [adjust(r), alphaOf(r)]);
  const rhoBase = spearman(base), rhoCand = spearman(cand);
  return {
    name, n: base.length, rhoBase, rhoCand,
    delta: (rhoBase != null && rhoCand != null) ? +(rhoCand - rhoBase).toFixed(3) : null,
  };
}

function analyse(scr, rowsRaw, minN) {
  const rows = dedupeEpisodes(rowsRaw);
  const pageMedian = median(rows.map(alphaOf));
  const out = { screener: scr, episodes: rows.length, rawRows: rowsRaw.length, medianAlpha: pageMedian != null ? +pageMedian.toFixed(2) : null, factors: {}, candidates: [] };

  console.log(`\n══ ${scr.toUpperCase()} — ${rows.length} episodes (from ${rowsRaw.length} raw rows) · page median alpha ${pageMedian != null ? pageMedian.toFixed(2) : '—'}%`);

  for (const f of FACTORS) {
    const table = bucketTable(rows, f, pageMedian);
    if (!table.length) continue;
    const cc = contCorr(rows, f);
    const v = factorVerdict(rows, f, minN);
    out.factors[f.key] = { label: f.label, note: f.note, buckets: table, corr: cc, ...(v || {}) };
    if (v) (out.weightable = out.weightable || {})[v.weightId] = v;

    const corrTxt = cc && cc.rho != null ? `  rank-corr ${cc.rho >= 0 ? '+' : ''}${cc.rho}` : '';
    const vTxt = v ? `   [${v.verdict}${v.ic != null ? ' ic ' + (v.ic >= 0 ? '+' : '') + v.ic : ''}]` : '';
    console.log(`\n  ${f.label}${corrTxt}${vTxt}`);
    if (f.note) console.log(`    (${f.note})`);
    for (const b of table) {
      const lift = b.lift == null ? '' : `  lift ${b.lift >= 0 ? '+' : ''}${b.lift}`;
      console.log(`    ${b.bucket.padEnd(18)} n=${String(b.n).padEnd(5)} medAlpha=${String(b.medianAlpha).padEnd(7)} beat=${String(b.beatRate).padEnd(4)}%${lift}${b.n < minN ? '   (thin)' : ''}`);
    }
  }

  // Candidates are only meaningful where the factor exists on these rows.
  const has = k => rows.some(r => r.extras && r.extras[k] != null);
  const cands = [];
  if (has('rsRating')) {
    cands.push(candidateTest(rows, 'score + 15 × (RS-50)/49, clamped 0-15  [reward relative strength]',
      r => r.score + Math.max(0, Math.min(15, ((r.extras.rsRating - 50) / 49) * 15))));
  }
  if (has('volSurgePct')) {
    cands.push(candidateTest(rows, 'score + 10 when breakout volume >= 200% of average  [reward the thrust]',
      r => r.score + (r.extras.volSurgePct >= 200 ? 10 : 0)));
  }
  if (has('rsRating') && has('volSurgePct')) {
    cands.push(candidateTest(rows, 'score + both of the above',
      r => r.score + Math.max(0, Math.min(15, ((r.extras.rsRating - 50) / 49) * 15)) + (r.extras.volSurgePct >= 200 ? 10 : 0)));
  }
  cands.push(candidateTest(rows, 'score - 8 when entry is already 10%+ above pivot  [dock chasing]',
    r => r.score - ((extPct(r) != null && extPct(r) >= 10) ? 8 : 0)));

  if (cands.length) {
    console.log('\n  ── A/B: does the candidate score ORDER outcomes better than the live one? ──');
    for (const c of cands) {
      const verdict = c.delta == null ? 'n/a'
        : c.delta > 0.03 ? '✅ better'
        : c.delta < -0.03 ? '❌ worse' : '➖ no change';
      console.log(`    ${verdict}  Δrho ${c.delta == null ? 'n/a' : (c.delta >= 0 ? '+' : '') + c.delta}  (live ${c.rhoBase} → candidate ${c.rhoCand}, n=${c.n})`);
      console.log(`        ${c.name}`);
    }
  }
  out.candidates = cands;
  return out;
}

function main() {
  const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
  const want = arg('screener') || 'breakout2';
  const minN = parseInt(arg('min-n') || '20', 10);

  const d = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  const all = (d.rows || []).filter(r => r.results && r.results[HORIZON] && r.results[HORIZON].alpha != null);

  console.log('🧪 Factor Lab — which individual factors actually predict forward alpha?');
  console.log(`   ledger: ${all.length} matured ${HORIZON} rows · horizon ${HORIZON} · min bucket n=${minN}`);

  const screeners = want === 'all'
    ? [...new Set(all.filter(r => r.extras).map(r => r.screener))].sort()
    : [want];

  const report = {};
  for (const scr of screeners) {
    const rows = all.filter(r => r.screener === scr);
    if (!rows.length) { console.log(`\n   (no matured rows for "${scr}")`); continue; }
    report[scr] = analyse(scr, rows, minN);
  }

  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), horizon: HORIZON, minN, screeners: report }, null, 2));
  console.log(`\n   Wrote ${OUT}`);
  console.log('   Read "lift" as: median alpha of this bucket minus the page median. A factor earns points only if lift rises monotonically AND the A/B Δrho is positive.');
  console.log('   Buckets marked (thin) are below the minimum n — suggestive, not evidence.');
}

if (require.main === module) main();
module.exports = { FACTORS, bucketTable, candidateTest };

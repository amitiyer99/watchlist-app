'use strict';

// ── Trending Value scoring regression test ────────────────────────────────────
// The composite has six factors, three special cases (negative denominators,
// missing data, financials) and a renormalisation step — too much arithmetic to
// check by eye, and the generator can't run without live Tickertape access.
// So this drives the real runScreen() over SYNTHETIC universes with known
// shapes and asserts the properties that must hold.
//
// Run: npm run test-tv   (exit code 1 on failure)

const { runScreen, decilesFor, industryGroupOf, pcfFrom, PCF_MIN_COVERAGE, RULES, METRICS } = require('./lib/trending-value');

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// A stock that is deliberately mid-priced on everything, so tests can vary one
// factor at a time. Volume × price clears the ₹1 Cr ADV floor comfortably.
function stock(i, over = {}) {
  return Object.assign({
    ticker: 'T' + String(i).padStart(3, '0'),
    name: 'Test Co ' + i,
    sector: 'Industrials',
    price: 100,
    volume: 200000,          // ADV = ₹2 Cr
    marketCap: 1000,
    pe: 20, pb: 3, pcf: 15, ps: 2, evEbitda: 12, divYield: 1,
    ret6M: 10, roce: 15, roe: 15,
  }, over);
}

// 100 stocks spread evenly across every factor: stock i is the i-th cheapest on
// all six at once, so its composite should be its own decile × 6.
function ladder(n = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(stock(i, {
      pe: 5 + i, pb: 0.5 + i * 0.1, pcf: 3 + i * 0.5, ps: 0.2 + i * 0.1,
      evEbitda: 2 + i * 0.4,
      divYield: (n - i) * 0.1,      // highest yield at i=0 → cheapest
      ret6M: i,                      // so momentum ranking is predictable
    }));
  }
  return out;
}

// ── 1. Decile mechanics ───────────────────────────────────────────────────────
const d100 = decilesFor(Array.from({ length: 100 }, (_, i) => ({ key: 'k' + i, v: i })), 'low');
const counts = {};
for (const v of d100.values()) counts[v] = (counts[v] || 0) + 1;
check('100 distinct values split into 10 deciles of 10',
  Object.keys(counts).length === 10 && Object.values(counts).every(c => c === 10),
  JSON.stringify(counts));
check('cheapest value lands in decile 1 and dearest in decile 10',
  d100.get('k0') === 1 && d100.get('k99') === 10,
  `k0=${d100.get('k0')} k99=${d100.get('k99')}`);

const dTies = decilesFor([{ key: 'a', v: 5 }, { key: 'b', v: 5 }, { key: 'c', v: 5 }, { key: 'd', v: 9 }], 'low');
check('tied values share a decile', dTies.get('a') === dTies.get('b') && dTies.get('b') === dTies.get('c'),
  `a=${dTies.get('a')} b=${dTies.get('b')} c=${dTies.get('c')} d=${dTies.get('d')}`);

const dHigh = decilesFor(Array.from({ length: 100 }, (_, i) => ({ key: 'k' + i, v: i })), 'high');
check('dir:high inverts the ranking (dividend yield)', dHigh.get('k99') === 1 && dHigh.get('k0') === 10,
  `k99=${dHigh.get('k99')} k0=${dHigh.get('k0')}`);

// ── 2. The rule that matters most: a negative multiple is NOT cheap ───────────
{
  const u = ladder();
  // Give the most expensive stock (i=99) negative earnings AND negative book.
  u[99].pe = -4; u[99].pb = -2;
  // And give a mid stock negative earnings, to check it gets docked not promoted.
  u[50].pe = -8;
  const res = runScreen(u);
  const byT = new Map(res.scoredRows.map(r => [r.ticker, r]));
  check('negative P/E scores the WORST decile, not the cheapest',
    byT.get('T050').scores.pe === 10, `T050 pe decile=${byT.get('T050').scores.pe} (raw -8)`);
  check('negative P/B scores the worst decile too',
    byT.get('T099').scores.pb === 10, `T099 pb decile=${byT.get('T099').scores.pb}`);
  check('a loss-making stock does not enter the cheap decile on that factor alone',
    !res.picks.some(p => p.ticker === 'T050' && p.scores.pe === 1),
    `T050 in picks=${res.picks.some(p => p.ticker === 'T050')}`);
}

// ── 3. Composite scale and renormalisation ───────────────────────────────────
{
  const u = ladder();
  // pcfCoverage:1 opts into the full SIX-factor path. Without it the coverage gate
  // correctly drops P/CF and the composite is a five-factor one — a different test.
  const res = runScreen(u, { pcfCoverage: 1 });
  const cheapest = res.scoredRows.find(r => r.ticker === 'T000');
  check('cheapest-on-everything stock scores the floor of 6',
    cheapest.composite === 6 && cheapest.nMetrics === 6,
    `composite=${cheapest.composite} n=${cheapest.nMetrics}`);
  const dearest = res.scoredRows.find(r => r.ticker === 'T099');
  check('dearest-on-everything stock scores the ceiling of 60',
    dearest.composite === 60, `composite=${dearest.composite}`);
  check('every composite sits inside 6-60',
    res.scoredRows.every(r => r.composite >= 6 && r.composite <= 60),
    `min=${Math.min(...res.scoredRows.map(r => r.composite))} max=${Math.max(...res.scoredRows.map(r => r.composite))}`);
}

{
  // Renormalisation invariance: a stock cheapest on 4 of 6 factors, with the
  // other two absent, must score the same 6 as one cheapest on all six.
  const u = ladder();
  u[0].pcf = null; u[0].ps = null;
  const res = runScreen(u);
  const r0 = res.scoredRows.find(r => r.ticker === 'T000');
  check('missing factors are renormalised, not scored as expensive',
    r0.composite === 6 && r0.nMetrics === 4,
    `composite=${r0.composite} n=${r0.nMetrics} — punishing gaps would have pushed this well above 6`);
}

{
  // Below the minimum factor count the stock is dropped, not guessed at.
  const u = ladder();
  u[0].pe = null; u[0].pb = null; u[0].pcf = null;
  const res = runScreen(u);
  check(`fewer than ${RULES.minMetrics} usable factors excludes the stock`,
    !res.scoredRows.some(r => r.ticker === 'T000') && res.rejected.thinData === 1,
    `thinData=${res.rejected.thinData}`);
}

// ── 4. Dividend yield: a non-payer is an observation, not a gap ──────────────
{
  const u = ladder();
  u[0].divYield = 0;      // cheapest on everything else, but pays nothing
  u[1].divYield = null;   // no dividend data at all
  const res = runScreen(u, { pcfCoverage: 1 });   // six-factor path, see test 3
  const byT = new Map(res.scoredRows.map(r => [r.ticker, r]));
  check('zero dividend yield scores 10 (real observation, not missing data)',
    byT.get('T000').scores.divYield === 10, `decile=${byT.get('T000').scores.divYield}`);
  check('null dividend yield is also treated as a non-payer',
    byT.get('T001').scores.divYield === 10 && byT.get('T001').nMetrics === 6,
    `decile=${byT.get('T001').scores.divYield} n=${byT.get('T001').nMetrics}`);
}

// ── 5. Financials drop the two meaningless factors ──────────────────────────
{
  const u = ladder();
  u[0].sector = 'Banking and Finance';
  const res = runScreen(u);
  const r0 = res.scoredRows.find(r => r.ticker === 'T000');
  check('financials drop EV/EBITDA and P/CF and renormalise over 4 factors',
    r0.financial === true && r0.scores.evEbitda == null && r0.scores.pcf == null && r0.nMetrics === 4,
    `financial=${r0.financial} n=${r0.nMetrics} ev=${r0.scores.evEbitda} pcf=${r0.scores.pcf}`);
  check('a cheap financial still reaches the composite floor',
    r0.composite === 6, `composite=${r0.composite}`);
}

// ── 6. Universe gates ────────────────────────────────────────────────────────
{
  const u = ladder();
  u[0].marketCap = 100;              // below the ₹500 Cr floor
  u[1].volume = null;                // unknown ADV → must fail closed
  u[2].volume = 100;                 // ADV = ₹10,000 — far below the floor
  const res = runScreen(u, { surveillance: new Set(['T003']) });
  const inUniverse = new Set(res.scoredRows.map(r => r.ticker));
  check('market cap floor excludes small names', !inUniverse.has('T000') && res.rejected.mcap === 1);
  check('unknown ADV fails CLOSED (untradeable, not assumed liquid)',
    !inUniverse.has('T001'), `liquidity rejects=${res.rejected.liquidity}`);
  check('illiquid names are excluded', !inUniverse.has('T002') && res.rejected.liquidity === 2,
    `liquidity=${res.rejected.liquidity}`);
  check('surveillance names are excluded',
    !inUniverse.has('T003') && res.rejected.surveillance === 1, `surv=${res.rejected.surveillance}`);
}

// ── 7. The momentum leg ─────────────────────────────────────────────────────
{
  const u = ladder();
  const res = runScreen(u);
  check('the cheap decile is exactly 10% of the scored universe',
    res.valueDecile.length === Math.ceil(res.scoredSize * RULES.decileCut),
    `decile size=${res.valueDecile.length} of ${res.scoredSize}`);
  const decileSet = new Set(res.valueDecile.map(r => r.ticker));
  check('picks are drawn only from the cheap decile',
    res.picks.every(p => decileSet.has(p.ticker)),
    `cutoff=${res.cutoff} strays=${res.picks.filter(p => !decileSet.has(p.ticker)).map(p => p.ticker).join(',')}`);
  const rets = res.picks.map(p => p.ret6M);
  check('picks are ordered by 6-month momentum, descending',
    rets.every((v, i) => i === 0 || rets[i - 1] >= v), JSON.stringify(rets));
  check('ranks are 1..n in order', res.picks.every((p, i) => p.rank === i + 1));
}

{
  // In the ladder, cheapness and momentum run in opposite directions by design,
  // so the cheapest names have the LOWEST 6M returns. The top pick must still be
  // the highest-momentum name *within the cheap decile*, not in the universe.
  const u = ladder();
  const res = runScreen(u);
  const decileTickers = new Set(res.valueDecile.map(r => r.ticker));
  const bestInDecile = res.valueDecile.reduce((a, b) => (b.ret6M > a.ret6M ? b : a));
  check('rank 1 is the strongest momentum inside the cheap decile (not the market)',
    res.picks[0].ticker === bestInDecile.ticker && decileTickers.has(res.picks[0].ticker),
    `pick1=${res.picks[0].ticker} bestInDecile=${bestInDecile.ticker}`);
}

{
  // No 6M return means it cannot be ranked on momentum — the strategy has
  // nothing to say about it, so it must not silently appear at the top.
  const u = ladder();
  for (let i = 0; i < 5; i++) u[i].ret6M = null;
  const res = runScreen(u);
  check('cheap-decile names with no 6M return are counted and excluded from the picks',
    res.picks.every(p => p.ret6M != null) && res.rejected.noMomentum > 0,
    `noMomentum=${res.rejected.noMomentum}`);
}

{
  // The tie problem this cut exists to solve: make every stock score an
  // identical composite except for tiny valuation differences, and a
  // threshold-based cut ("composite <= cutoff") would return the whole
  // universe. The count-based cut with a percentile tiebreak must still
  // return exactly 10%.
  const u = [];
  for (let i = 0; i < 500; i++) {
    u.push(stock(i, { pe: 20 + i * 1e-6, pb: 3, pcf: 15, ps: 2, evEbitda: 12, divYield: 1, ret6M: i }));
  }
  const res = runScreen(u);
  const uniqueComposites = new Set(res.scoredRows.map(r => r.composite)).size;
  check('a near-universal composite tie still yields a 10% decile, not the whole market',
    res.valueDecile.length === Math.ceil(res.scoredSize * RULES.decileCut),
    `decile=${res.valueDecile.length} of ${res.scoredSize}, distinct composites=${uniqueComposites}`);
  check('the tiebreak picks the genuinely cheapest names within the tie',
    res.valueDecile.every(r => parseInt(r.ticker.slice(1), 10) < 100),
    `worst included=${Math.max(...res.valueDecile.map(r => parseInt(r.ticker.slice(1), 10)))}`);
}

// ── 8. topN cap ─────────────────────────────────────────────────────────────
{
  const u = ladder(600);   // cheap decile ≈ 60, well above topN
  const res = runScreen(u);
  check(`the list is capped at ${RULES.topN}`, res.picks.length === RULES.topN,
    `picks=${res.picks.length} decile=${res.valueDecile.length}`);
}

// ── 8b. The industry cap ────────────────────────────────────────────────────
{
  // The exact failure this exists for: the real first run returned these seven
  // sugar mills in 25 names. Tickertape splits them across two sectors, so the
  // classifier — not the sector field — has to be what catches them.
  const realSugar = [
    ['AVADHSUGAR', 'Avadh Sugar & Energy Ltd', 'Consumer Staples'],
    ['DALMIASUG', 'Dalmia Bharat Sugar and Industries Ltd', 'Consumer Staples'],
    ['DHAMPURSUG', 'Dhampur Sugar Mills Ltd', 'Consumer Staples'],
    ['UTTAMSUGAR', 'Uttam Sugar Mills Ltd', 'Consumer Staples'],
    ['DBOL', 'Dhampur Bio Organics Ltd', 'Consumer Staples'],
    ['ANDHRSUGAR', 'The Andhra Sugars Ltd', 'Materials'],
    ['MAGADSUGAR', 'Magadh Sugar & Energy Ltd', 'Materials'],
  ];
  const groups = realSugar.map(([t, n, s]) => industryGroupOf({ ticker: t, name: n, sector: s }));
  check('all seven real sugar mills group together despite spanning two sectors',
    groups.every(g => g === 'Sugar'), JSON.stringify(groups));

  // A real industry label from the data source must win over the classifier.
  check('a resolved industry field takes precedence over the keyword fallback',
    industryGroupOf({ ticker: 'X', name: 'Some Sugar Ltd', sector: 'Materials', industry: 'Speciality Chemicals' }) === 'Speciality Chemicals');
  check('an unclassifiable name falls back to its sector, tagged as such',
    industryGroupOf({ ticker: 'ZZ', name: 'Zephyr Holdings Ltd', sector: 'Industrials' }) === 'sector: Industrials');
}

{
  // 40 cheap names, all one industry except a handful. The cap must bite.
  const u = [];
  for (let i = 0; i < 300; i++) {
    const sugar = i < 60;
    u.push(stock(i, {
      name: sugar ? `Test Sugar Mills ${i} Ltd` : `Test Software ${i} Ltd`,
      sector: sugar ? 'Consumer Staples' : 'Information Technology',
      pe: 5 + i * 0.2, pb: 0.5 + i * 0.05, pcf: 3 + i * 0.2, ps: 0.2 + i * 0.05,
      evEbitda: 2 + i * 0.2, divYield: (300 - i) * 0.02,
      ret6M: 200 - i,       // the cheapest names also have the best momentum here
    }));
  }
  const res = runScreen(u);
  const sugarCount = res.picks.filter(p => p.industryGroup === 'Sugar' && !p.overCap).length;
  check(`no more than ${RULES.maxPerIndustry} names per industry are admitted within the cap`,
    sugarCount <= RULES.maxPerIndustry,
    `sugar within cap=${sugarCount}, mix=${JSON.stringify(res.industryMix)}`);
  check('the cap reports what it displaced', res.displacedCount > 0, `displaced=${res.displacedCount}`);
  // The mix must describe the list that actually shipped, over-cap names included.
  check('industryMix accounts for every pick, including over-cap ones',
    res.industryMix.reduce((a, m) => a + m.n, 0) === res.picks.length,
    `mixTotal=${res.industryMix.reduce((a, m) => a + m.n, 0)} picks=${res.picks.length}`);
  check('industryMix reflects over-cap reality rather than the cap limit',
    res.overCap.length === 0 || res.industryMix.some(m => m.n > RULES.maxPerIndustry),
    `mix=${JSON.stringify(res.industryMix)} overCap=${res.overCap.length}`);
  check('uncappedMix records the concentration that would have shipped',
    res.uncappedMix[0].n > RULES.maxPerIndustry,
    `uncapped leader=${JSON.stringify(res.uncappedMix[0])}`);
  check('the list is still filled to topN, with over-cap names marked',
    res.picks.length === RULES.topN && res.picks.every(p => p.overCap || (p.industryGroup && true)),
    `picks=${res.picks.length} overCap=${res.overCap.length}`);
  // Over-cap names are a last resort, so they must occupy the LAST ranks — never
  // displace a name the cap admitted legitimately.
  const within = res.picks.filter(p => !p.overCap);
  const over = res.picks.filter(p => p.overCap);
  check('over-cap names occupy only the trailing ranks, never displacing a within-cap name',
    !over.length || Math.min(...over.map(p => p.rank)) > Math.max(...within.map(p => p.rank)),
    `withinMaxRank=${within.length ? Math.max(...within.map(p => p.rank)) : '—'} overMinRank=${over.length ? Math.min(...over.map(p => p.rank)) : '—'}`);
  check('capping does not promote a weaker-momentum name above a stronger one within its own industry',
    res.picks.filter(p => p.industryGroup === 'Sugar').every((p, i, a) => i === 0 || a[i - 1].ret6M >= p.ret6M),
    JSON.stringify(res.picks.filter(p => p.industryGroup === 'Sugar').map(p => p.ret6M)));
}

{
  // Cap disabled must reproduce the old pure behaviour exactly.
  const u = [];
  for (let i = 0; i < 300; i++) {
    u.push(stock(i, {
      name: `Test Sugar Mills ${i} Ltd`, sector: 'Consumer Staples',
      pe: 5 + i * 0.2, pb: 0.5 + i * 0.05, pcf: 3 + i * 0.2, ps: 0.2 + i * 0.05,
      evEbitda: 2 + i * 0.2, divYield: (300 - i) * 0.02, ret6M: 200 - i,
    }));
  }
  const capped = runScreen(u);
  const pure = runScreen(u, { rules: { maxPerIndustry: 0 } });
  check('maxPerIndustry:0 disables the cap entirely (pure O\'Shaughnessy)',
    pure.picks.length === RULES.topN && pure.displacedCount === 0 && pure.overCap.length === 0,
    `pure displaced=${pure.displacedCount} overCap=${pure.overCap.length}`);
  check('a single-industry universe still returns a full list under the cap',
    capped.picks.length === RULES.topN, `picks=${capped.picks.length}`);
}

{
  // Coarse sector fallbacks get the looser limit: 3 unrelated engineering firms
  // are not the same risk as 3 sugar mills, so they must not be capped alike.
  const u = [];
  for (let i = 0; i < 400; i++) {
    u.push(stock(i, {
      name: `Zephyr Holdings ${i} Ltd`, sector: 'Industrials',   // deliberately unclassifiable
      pe: 5 + i * 0.2, pb: 0.5 + i * 0.05, pcf: 3 + i * 0.2, ps: 0.2 + i * 0.05,
      evEbitda: 2 + i * 0.2, divYield: (400 - i) * 0.02, ret6M: 200 - i,
    }));
  }
  const res = runScreen(u);
  const withinCap = res.picks.filter(p => !p.overCap).length;
  check('coarse sector fallback uses the looser cap, not the industry cap',
    withinCap === RULES.maxPerSectorFallback,
    `within cap=${withinCap}, expected ${RULES.maxPerSectorFallback} (industry cap is ${RULES.maxPerIndustry})`);
  check('a real industry group still gets the tight cap',
    runScreen(u.map((s, i) => ({ ...s, name: `Test Sugar Mills ${i} Ltd` })))
      .picks.filter(p => !p.overCap).length === RULES.maxPerIndustry);
}

// ── 8c. P/CF: unit conversion and the coverage gate ─────────────────────────
{
  // The conversion that would otherwise be invisible: a wrong factor of 1e7 still
  // RANKS every stock correctly, so the deciles would look perfect while every
  // displayed multiple was nonsense. Anchor it to a hand-checked number.
  //   ₹1,000 Cr market cap, ₹100 Cr operating cash flow -> P/CF = 10
  check('P/CF converts ₹Cr market cap against absolute-₹ cash flow',
    pcfFrom(1000, 100 * 1e7) === 10, `got ${pcfFrom(1000, 100 * 1e7)}, expected 10`);
  check('P/CF of a ₹500 Cr company earning ₹25 Cr cash is 20',
    pcfFrom(500, 25 * 1e7) === 20, `got ${pcfFrom(500, 25 * 1e7)}`);
  check('negative cash flow yields a negative P/CF (so the scorer sends it to decile 10)',
    pcfFrom(1000, -50 * 1e7) < 0, `got ${pcfFrom(1000, -50 * 1e7)}`);
  check('zero or missing cash flow yields null, not Infinity',
    pcfFrom(1000, 0) === null && pcfFrom(1000, null) === null && pcfFrom(null, 1e7) === null);

  // The gate itself. Below the threshold P/CF must be dropped for EVERY stock, even
  // the ones we do have data for — partial coverage ranks against a biased subset.
  const withPcf = () => {
    const u = ladder();
    u.forEach((s, i) => { s.pcf = 3 + i * 0.5; });
    return u;
  };
  const gated = runScreen(withPcf(), { pcfCoverage: 0.35 });
  const scored = runScreen(withPcf(), { pcfCoverage: 0.92 });

  check('below the coverage gate, P/CF is dropped for every stock',
    gated.scoredRows.every(r => r.scores.pcf == null) && gated.pcf.gated === true,
    `gated=${gated.pcf.gated} reason=${gated.pcf.reason}`);
  check('below the gate the composite renormalises to 5 factors',
    gated.scoredRows.every(r => r.nMetrics <= 5) && gated.activeMetricCount === 5,
    `active=${gated.activeMetricCount} maxN=${Math.max(...gated.scoredRows.map(r => r.nMetrics))}`);
  check('above the coverage gate, P/CF is scored',
    scored.pcf.gated === false && scored.scoredRows.some(r => r.scores.pcf != null) && scored.activeMetricCount === 6,
    `gated=${scored.pcf.gated} active=${scored.activeMetricCount}`);
  check('no cash-flow cache at all is treated as gated, not as zero coverage',
    runScreen(withPcf(), {}).pcf.gated === true);
  check('the gate is reported with a reason the page can print',
    /below the/.test(gated.pcf.reason) && gated.pcf.gate === PCF_MIN_COVERAGE,
    gated.pcf.reason);
  // A gated factor must be visibly gated in the coverage table, not silently absent.
  check('the coverage table marks P/CF as gated rather than merely missing',
    gated.coverage.find(c => c.id === 'pcf').gated === true
    && scored.coverage.find(c => c.id === 'pcf').gated === false);
  // And the composite floor must still be reachable on five factors.
  check('a cheapest-on-everything stock still scores 6 with P/CF gated out',
    gated.scoredRows.find(r => r.ticker === 'T000').composite === 6,
    `composite=${gated.scoredRows.find(r => r.ticker === 'T000').composite}`);
}

// ── 9. Coverage reporting must add up ───────────────────────────────────────
{
  const u = ladder();
  u[0].pe = null; u[1].pe = -3; u[2].sector = 'Banking and Finance';
  const res = runScreen(u);
  const pe = res.coverage.find(c => c.id === 'pe');
  check('coverage counts partition the universe for each factor',
    res.coverage.every(c => c.ranked + c.worst + c.missing === res.universeSize),
    JSON.stringify(res.coverage.map(c => `${c.id}:${c.ranked}+${c.worst}+${c.missing}`)));
  check('a null P/E is reported as missing and a negative one as worst',
    pe.missing === 1 && pe.worst === 1, `missing=${pe.missing} worst=${pe.worst}`);
}

// ── 10. Every factor the ledger logs must exist ─────────────────────────────
{
  const res = runScreen(ladder());
  const want = ['pe', 'pb', 'pcf', 'ps', 'evEbitda', 'divYield'];
  check('all six factors are present in the scores object',
    want.every(k => k in res.scoredRows[0].scores) && METRICS.length === 6,
    Object.keys(res.scoredRows[0].scores).join(','));
}

// ── Report ──────────────────────────────────────────────────────────────────
let failed = 0;
console.log('\nTrending Value — scoring regression\n' + '─'.repeat(72));
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.name}${r.detail && !r.pass ? `\n         ${r.detail}` : ''}`);
}
console.log('─'.repeat(72));
console.log(`${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);

'use strict';

// ── Trending Value ────────────────────────────────────────────────────────────
// James O'Shaughnessy's Trending Value: score the whole market on six value
// factors, keep the cheapest decile, then rank that decile by 6-month price
// momentum and take the top 25.
//
// The scoring rules (negative denominators, missing data, financials) all live in
// lib/trending-value.js and are unit-tested by test-trending-value.js. This file
// is fetch + render + log.
//
// Two things worth knowing before you use the page:
//
//   1. FIELD DISCOVERY. Tickertape's screener exposes P/E, P/B, EV/EBITDA and
//      dividend yield under codes this repo already uses in production, but P/S,
//      P/CF and ROCE were never needed before and their codes are undocumented.
//      Rather than hardcode a guess, resolveFields() probes candidate codes once,
//      keeps whichever actually returns data, and caches the result in
//      docs/tv-fields.json. If a factor cannot be resolved the composite
//      renormalises over the factors that did resolve and the page says so — it
//      does not silently score five factors and call it six.
//
//   2. The evidence for this strategy is US data, 1964-2009. It has not been
//      validated on Indian equities by this repo or, as far as I know, anywhere
//      with comparable rigour. The page logs its picks to the outcome ledger so
//      that in a year there is a local measurement instead of a belief.
//
// Output: docs/trending-value.html
//         docs/trendingvalue-tickers.json  (sidecar: price universe + confluence)
//         docs/tv-fields.json              (resolved API field codes + coverage)

const fs = require('fs');
const path = require('path');
const https = require('https');
const { HUB_BACK_LINK } = require('./lib/hub-nav');
const stockActions = require('./lib/stock-actions');
const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');
const { fmtPrice, esc } = require('./lib/format');
const { loadSurveillance, isRestricted } = require('./lib/surveillance');
const { RULES, METRICS, runScreen, pcfFrom, PCF_MIN_COVERAGE } = require('./lib/trending-value');

const DOCS = path.join(__dirname, 'docs');
const OUT_HTML = path.join(DOCS, 'trending-value.html');
const SIDECAR = path.join(DOCS, 'trendingvalue-tickers.json');
const FIELDS_CACHE = path.join(DOCS, 'tv-fields.json');
const CASHFLOW = path.join(DOCS, 'cashflow.json');
// The full screened universe, cheapest-first. Not rendered — it exists so
// fetch-cashflow.js knows which names are near the decile boundary and fetches
// those first, instead of covering the market in arbitrary order.
const UNIVERSE = path.join(DOCS, 'trendingvalue-universe.json');

// ── API plumbing (same shape as the other Tickertape generators) ──────────────
function apiPostOnce(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 20000,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://www.tickertape.in', 'Referer': 'https://www.tickertape.in/screener',
        'Accept': 'application/json',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse error')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(data);
  });
}
async function apiPost(body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await apiPostOnce('https://api.tickertape.in/screener/query', body); }
    catch (e) { if (i === retries - 1) throw e; await sleep(2000 * (i + 1)); }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Field codes ───────────────────────────────────────────────────────────────
// Proven in production elsewhere in this repo — no discovery needed.
const KNOWN = {
  pe: 'apef', pb: 'pbr', evEbitda: 'evebitd', divYield: 'divDps',
  ret6M: '26wpct', ret1Y: '52wpct', roe: 'roe',
  mrktCapf: 'mrktCapf', lastPrice: 'lastPrice', acVol: 'acVol',
};

// Never used here before, so the code is a guess until measured. Ordered by how
// likely each is to be the real one; discovery keeps whichever has coverage.
const CANDIDATES = {
  ps:   ['ps', 'psr', 'apsr', 'psRatio', 'p2s', 'pricesales', 'sr'],
  // Every first-round candidate came back empty (0/300), so P/CF is probably not
  // exposed as a ratio at all. Second round tries the raw cash-flow figures too —
  // if operating cash flow resolves, P/CF is derived from it below.
  pcf:  ['pcfr', 'pcf', 'apcf', 'pcfRatio', 'p2cf', 'pricecf', 'ocfr',
         'pcflow', 'pocf', 'pfcf', 'evocf', 'pcfl'],
  ocf:  ['ocf', 'cfo', 'opCF', 'cashFlowOps', 'netCashOps', 'ocfl', 'cfops'],
  ocfps: ['ocfps', 'cfps', 'cashFlowPerShare', 'ocfSh'],
  roce: ['roce', 'roc', 'apce', 'retOnCapEmp', 'roceRatio'],
};

// Probed for their string value rather than a number, so they need their own
// coverage counter. A real industry label beats the keyword classifier.
const STR_CANDIDATES = {
  industry: ['industry', 'subindustry', 'indName', 'industryName', 'subSector', 'basicIndustry', 'sectorName'],
};

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

// Probe candidates in small batches against a real page of results and keep the
// code with the best non-null coverage. Cached, so this costs nothing after the
// first run — but re-runs automatically if a cached code stops returning data.
async function resolveFields({ force = false } = {}) {
  const cached = readJson(FIELDS_CACHE, null);
  if (!force && cached && cached.resolved && cached.probedAt) {
    const ageDays = (Date.now() - new Date(cached.probedAt).getTime()) / 86400000;
    if (ageDays < 30) return cached;
  }

  console.log('  Resolving undocumented field codes (one-off probe)…');
  const resolved = {};
  const evidence = {};

  for (const [want, codes] of Object.entries(CANDIDATES)) {
    let best = null;
    for (let i = 0; i < codes.length; i += 4) {
      const batch = codes.slice(i, i + 4);
      let r;
      try {
        r = await apiPost({
          match: {}, sortBy: 'mrktCapf', sortOrder: -1,
          project: ['ticker'].concat(batch), offset: 0, count: 300,
        });
      } catch { continue; }
      // An unknown field can make the whole query fail; if so, fall back to
      // probing this batch one code at a time.
      if (!r || !r.success) {
        for (const c of batch) {
          try {
            const one = await apiPost({ match: {}, sortBy: 'mrktCapf', sortOrder: -1, project: ['ticker', c], offset: 0, count: 300 });
            if (one && one.success) {
              const n = countCoverage(one, c);
              evidence[c] = n;
              if (!best || n > best.n) best = { code: c, n };
            } else { evidence[c] = 'query rejected'; }
          } catch { evidence[c] = 'error'; }
          await sleep(400);
        }
        continue;
      }
      for (const c of batch) {
        const n = countCoverage(r, c);
        evidence[c] = n;
        if (n > 0 && (!best || n > best.n)) best = { code: c, n };
      }
      await sleep(400);
    }
    resolved[want] = best ? best.code : null;
    console.log(`    ${want.padEnd(5)} → ${best ? `${best.code} (${best.n}/300 populated)` : 'UNRESOLVED — factor will be dropped'}`);
  }

  // String fields (the industry label) — same probe, different coverage test.
  for (const [want, codes] of Object.entries(STR_CANDIDATES)) {
    let best = null;
    for (const c of codes) {
      try {
        const r = await apiPost({ match: {}, sortBy: 'mrktCapf', sortOrder: -1, project: ['ticker', c], offset: 0, count: 300 });
        if (r && r.success) {
          const n = countCoverage(r, c, 'string');
          evidence[c] = n;
          if (n > 0 && (!best || n > best.n)) best = { code: c, n };
        } else { evidence[c] = 'query rejected'; }
      } catch { evidence[c] = 'error'; }
      await sleep(400);
    }
    resolved[want] = best ? best.code : null;
    console.log(`    ${want.padEnd(5)} → ${best ? `${best.code} (${best.n}/300 populated)` : 'UNRESOLVED — falling back to the name-keyword classifier'}`);
  }

  const out = { probedAt: new Date().toISOString(), resolved, evidence, known: KNOWN };
  try { fs.writeFileSync(FIELDS_CACHE, JSON.stringify(out, null, 2), 'utf8'); } catch { /* non-fatal */ }
  return out;
}

// Fraction of the stocks that will actually be SCREENED (past the mcap, liquidity and
// surveillance gates) for which we have a usable operating cash flow. Measuring against
// the full fetched market instead would understate coverage badly — most of those names
// never enter the ranking, so their cash flow is irrelevant.
function coverageOf(stocks, cfRows, restricted) {
  let inUniverse = 0, priced = 0;
  for (const s of stocks) {
    if (s.marketCap == null || s.marketCap < RULES.mcapMin) continue;
    const adv = (s.volume != null && s.price != null) ? s.volume * s.price : null;
    if (adv == null || adv < RULES.adv20Min) continue;
    if (restricted.has(s.ticker)) continue;
    inUniverse++;
    const row = cfRows[s.ticker];
    if (row && row.ocf != null) priced++;
  }
  return inUniverse ? priced / inUniverse : null;
}

function countCoverage(r, code, kind = 'number') {
  const rows = (r.data && r.data.results) || [];
  let n = 0;
  for (const it of rows) {
    const v = it.stock && it.stock.advancedRatios ? it.stock.advancedRatios[code] : undefined;
    if (kind === 'string') { if (typeof v === 'string' && v.trim()) n++; }
    else if (v != null && isFinite(v)) n++;
  }
  return n;
}

// ── Fetch the whole market ────────────────────────────────────────────────────
async function fetchUniverse(fields) {
  const PAGE = 1000;
  const project = ['ticker', 'name', 'sector', 'mrktCapf', 'lastPrice', 'acVol',
    KNOWN.pe, KNOWN.pb, KNOWN.evEbitda, KNOWN.divYield, KNOWN.ret6M, KNOWN.ret1Y, KNOWN.roe]
    .concat(Object.values(fields.resolved).filter(Boolean));

  const out = [];
  let offset = 0, total = Infinity;
  while (offset < total) {
    const r = await apiPost({ match: {}, sortBy: 'mrktCapf', sortOrder: -1, project, offset, count: PAGE });
    if (!r || !r.success) throw new Error('Screener API failed');
    total = r.data.stats.count;
    const results = r.data.results || [];
    if (!results.length) break;
    for (const item of results) {
      const ar = item.stock?.advancedRatios || {};
      const g = k => (k && ar[k] != null && isFinite(ar[k])) ? ar[k] : null;
      const ticker = item.stock?.info?.ticker || '';
      if (!ticker) continue;
      const mcap = g(KNOWN.mrktCapf);
      const px = g(KNOWN.lastPrice);

      // P/CF, three ways, in order of preference:
      //   1. a real price-to-cash-flow ratio, if one exists;
      //   2. market cap ÷ operating cash flow (both ₹Cr);
      //   3. price ÷ operating cash flow per share.
      // Whichever is used, a non-positive cash flow flows through as a negative
      // ratio and the scorer sends it to the worst decile, which is correct.
      let pcf = g(fields.resolved.pcf);
      if (pcf == null && fields.resolved.ocf) {
        const ocf = g(fields.resolved.ocf);
        if (ocf != null && mcap != null && ocf !== 0) pcf = mcap / ocf;
      }
      if (pcf == null && fields.resolved.ocfps) {
        const ocfps = g(fields.resolved.ocfps);
        if (ocfps != null && px != null && ocfps !== 0) pcf = px / ocfps;
      }

      const indRaw = fields.resolved.industry ? ar[fields.resolved.industry] : null;

      out.push({
        ticker,
        name: item.stock?.info?.name || ticker,
        sector: ar.sector || item.stock?.info?.sector || '',
        industry: typeof indRaw === 'string' && indRaw.trim() ? indRaw.trim() : null,
        slug: item.stock?.slug || '',
        marketCap: mcap,
        price: px,
        volume: g(KNOWN.acVol),
        pe: g(KNOWN.pe),
        pb: g(KNOWN.pb),
        evEbitda: g(KNOWN.evEbitda),
        divYield: g(KNOWN.divYield),
        ps: g(fields.resolved.ps),
        pcf: pcf != null && isFinite(pcf) ? pcf : null,
        roce: g(fields.resolved.roce),
        roe: g(KNOWN.roe),
        ret6M: g(KNOWN.ret6M),
        ret1Y: g(KNOWN.ret1Y),
      });
    }
    offset += PAGE;
    process.stdout.write(`  Fetched ${out.length}/${total}\r`);
  }
  console.log(`  Fetched ${out.length} stocks                    `);
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const force = process.argv.includes('--probe');
  const fields = await resolveFields({ force });

  const stocks = await fetchUniverse(fields);

  // Surveillance names (GSM / long-term ASM) are excluded: cheap screens attract
  // them, and a stock in a 5% price band with 100% margin cannot be traded.
  const surv = loadSurveillance();
  const restricted = new Set();
  if (surv) for (const s of stocks) if (isRestricted(surv, s.ticker)) restricted.add(s.ticker);

  // ── P/CF from the cash-flow cache ──────────────────────────────────────────
  // Tickertape has no price-to-cash-flow field, so operating cash flow comes from
  // Yahoo via fetch-cashflow.js, one stock at a time into an accumulating cache.
  // Coverage therefore builds over days — and until it is high enough, scoring it
  // would rank each stock against whichever subset happened to be fetched rather
  // than against the market. See PCF_MIN_COVERAGE in lib/trending-value.js.
  const cf = readJson(CASHFLOW, null);
  const cfRows = (cf && cf.rows) || {};
  let cfHits = 0;
  for (const s of stocks) {
    const row = cfRows[s.ticker];
    if (row && row.ocf != null) {
      s.pcf = pcfFrom(s.marketCap, row.ocf);   // handles the ₹Cr vs absolute-₹ conversion
      if (s.pcf != null) cfHits++;
    }
  }

  const res = runScreen(stocks, { surveillance: restricted, pcfCoverage: cf ? coverageOf(stocks, cfRows, restricted) : null });

  // Any factor not actually scored this run is named on the page rather than
  // quietly renormalised away: either its API code could not be resolved, or (for
  // P/CF) its coverage is still below the gate.
  const dropped = METRICS
    .filter(m => (CANDIDATES[m.id] && !fields.resolved[m.id] && m.id !== 'pcf') || (m.id === 'pcf' && res.pcf.gated))
    .map(m => m.label);

  // Cheapest-first universe for fetch-cashflow.js to prioritise from.
  fs.writeFileSync(UNIVERSE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    note: 'Screened universe, cheapest composite first. Consumed by fetch-cashflow.js to decide fetch order; not rendered.',
    rows: res.scoredRows
      .slice().sort((a, b) => a.composite - b.composite)
      .map(r => ({ ticker: r.ticker, composite: r.composite, nMetrics: r.nMetrics })),
  }), 'utf8');

  fs.writeFileSync(OUT_HTML, buildHtml(res, { fields, restrictedCount: restricted.size, survAge: surv ? surv.ageHours : null, dropped }), 'utf8');

  fs.writeFileSync(SIDECAR, JSON.stringify(res.picks.map(r => ({
    ticker: r.ticker, name: r.name, sector: r.sector, industryGroup: r.industryGroup || null,
    overCap: !!r.overCap, price: r.price,
    marketCap: r.marketCap, composite: r.composite, nMetrics: r.nMetrics,
    ret6M: r.ret6M, roce: r.roce, roe: r.roe, rank: r.rank,
    url: r.slug ? 'https://www.tickertape.in' + r.slug : '',
  }))), 'utf8');

  // Log to the outcome ledger so the strategy gets measured locally rather than
  // taken on trust from US backtests.
  try {
    const { appendOutcomes, todayIST } = require('./lib/outcomes');
    const { loadRegime } = require('./lib/regime');
    const regime = loadRegime();
    const date = todayIST();
    const rows = res.picks.map(r => ({
      date, screener: 'trendingvalue', signalType: 'TV_PICK',
      ticker: r.ticker, name: r.name, sector: r.sector,
      entry: r.price, pivot: null, stop: null, target: null, rr: null, sizePct: null,
      score: Math.round(100 - ((r.composite - 6) / 54) * 100),   // cheap = high score, so monotonicity tests read correctly
      regime: regime.isBearMarket ? 'BEAR' : 'BULL',
      extras: {
        composite: r.composite, nMetrics: r.nMetrics, rank: r.rank,
        ret6M: r.ret6M, roce: r.roce, roe: r.roe, marketCap: r.marketCap,
        financial: r.financial, industryGroup: r.industryGroup || null, overCap: !!r.overCap,
        ...r.scores,
      },
    }));
    const lg = appendOutcomes(rows);
    console.log(`Outcomes (trendingvalue): +${lg.added} added (${lg.skipped} dupes/skipped, ${lg.total} total)`);
  } catch (e) { console.warn('Outcome ledger append failed:', e.message); }

  console.log(`Trending Value: ${res.universeSize} in universe → ${res.scoredSize} scored → ${res.valueDecile.length} in cheapest decile (composite ≤ ${res.cutoff}) → top ${res.picks.length} → ${OUT_HTML}`);
  console.log(`  Factors scored: ${res.activeMetricCount}/6 · P/CF ${res.pcf.gated ? 'GATED OUT' : 'scored'} (${res.pcf.reason})`
    + (cfHits ? ` · ${cfHits} stocks had a usable cash flow` : ' · run: npm run fetch-cashflow'));
  console.log(`  Rejected: ${res.rejected.mcap} on market cap, ${res.rejected.liquidity} on liquidity, ${res.rejected.surveillance} on surveillance, ${res.rejected.thinData} on thin data, ${res.rejected.noMomentum} in the decile with no 6M return`);
}

// ── Rendering ─────────────────────────────────────────────────────────────────
const chipCls = d => d == null ? 'na' : d <= 3 ? 'cheap' : d <= 7 ? 'mid' : 'rich';
const fmtN = (v, dp = 1) => v == null ? '—' : Number(v).toFixed(dp);
const fmtPct = v => v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(1) + '%';
const fmtCr = v => v == null ? '—' : '₹' + Math.round(v).toLocaleString('en-IN') + ' Cr';

function chips(r) {
  return METRICS.map(m => {
    const d = r.scores[m.id];
    const raw = r[m.id];
    const rawTxt = raw == null ? 'no data'
      : m.id === 'divYield' ? fmtN(raw, 2) + '%'
      : raw <= 0 ? fmtN(raw, 1) + ' (negative → worst decile)'
      : fmtN(raw, 1);
    const why = d == null
      ? (m.skipFin && r.financial ? `${m.label} is not meaningful for a financial — dropped, composite renormalised.` : `${m.label} unavailable — dropped, composite renormalised over ${r.nMetrics} factors.`)
      : `${m.label} = ${rawTxt} → decile ${d} of 10. ${m.tip}`;
    return `<span class="chip ${chipCls(d)} tip" tabindex="0" data-tip="${esc(why)}">${esc(m.label)} <b>${d == null ? '–' : d}</b></span>`;
  }).join('');
}

function panelFor(r) {
  const metrics = [
    { label: 'Value Composite', val: String(r.composite), sub: `${r.nMetrics} of 6 factors`, cls: r.composite <= 15 ? 'pos' : '' },
    { label: '6M Return', val: fmtPct(r.ret6M), sub: 'the momentum leg', cls: (r.ret6M || 0) > 0 ? 'pos' : 'neg' },
    { label: 'P/E', val: fmtN(r.pe), sub: 'decile ' + (r.scores.pe ?? '–') },
    { label: 'P/B', val: fmtN(r.pb, 2), sub: 'decile ' + (r.scores.pb ?? '–') },
    { label: 'EV/EBITDA', val: fmtN(r.evEbitda), sub: 'decile ' + (r.scores.evEbitda ?? '–') },
    { label: 'Div Yield', val: r.divYield != null ? fmtN(r.divYield, 2) + '%' : '—', sub: 'decile ' + (r.scores.divYield ?? '–') },
    { label: 'ROCE', val: r.roce != null ? fmtN(r.roce) + '%' : '—', sub: 'quality check' },
    { label: 'ROE', val: r.roe != null ? fmtN(r.roe) + '%' : '—', sub: 'quality check' },
  ];
  const signals = [];
  signals.push({ tone: 'bull', icon: '◆', text: `Value composite ${r.composite} — inside the cheapest decile of ${r.universeSize || 'the screened'} tradeable stocks` });
  if (r.ret6M != null && r.ret6M > 0) signals.push({ tone: 'bull', icon: '▲', text: `6-month momentum ${fmtPct(r.ret6M)} — cheap AND already working, which is the whole point of the strategy` });
  if (r.ret6M != null && r.ret6M <= 0) signals.push({ tone: 'neut', icon: '▪', text: `6-month momentum ${fmtPct(r.ret6M)} — this name made the list because the cheap decile had few risers, not because it is trending` });
  if (r.roce != null && r.roce < 10) signals.push({ tone: 'bear', icon: '▼', text: `ROCE ${fmtN(r.roce)}% — cheap for a reason. Low returns on capital are the classic value trap signature` });
  if (r.roe != null && r.roe < 8) signals.push({ tone: 'bear', icon: '▼', text: `ROE ${fmtN(r.roe)}% — weak profitability; the composite says cheap, the quality metrics say why` });
  if (r.financial) signals.push({ tone: 'neut', icon: '▪', text: 'Financial — EV/EBITDA and P/CF dropped as meaningless; scored on the remaining factors' });
  if (r.nMetrics < 6) signals.push({ tone: 'neut', icon: '▪', text: `Scored on ${r.nMetrics} of 6 factors. Fewer factors means a noisier composite` });
  signals.push({ tone: 'neut', icon: '◆', text: 'Mechanical screen. It is a monthly rebalanced basket in the research, not a stock tip — single names in a value basket fail routinely' });
  return [{ title: '💰 Value & Momentum', metrics }, { title: '🔍 What the numbers say', signals }];
}

function row(r, universeSize) {
  r.universeSize = universeSize;
  const trap = (r.roce != null && r.roce < 10) || (r.roe != null && r.roe < 8);
  return `<tr data-ticker="${esc(r.ticker)}">
  <td class="rk">${r.rank}</td>
  <td>
    <span class="name-row">
      <a class="tk" href="${r.slug ? 'https://www.tickertape.in' + esc(r.slug) : '#'}" target="_blank" rel="noopener">${esc(r.name)}</a>
      ${stockActions.buttonsHtml({ ticker: r.ticker, name: r.name, price: r.price || 0, panel: panelFor(r) })}
    </span>
    <div class="sub">${esc(r.ticker)}${r.industryGroup ? ' · ' + esc(r.industryGroup) : (r.sector ? ' · ' + esc(r.sector) : '')}${r.overCap ? ' · <span class="overcap tip" tabindex="0" data-tip="Admitted over the ' + RULES.maxPerIndustry + '-per-industry cap. The cheap decile was too concentrated to fill the list without it — so this name adds to an industry that is already at its limit here.">over cap</span>' : ''}${r.financial ? ' · <span class="tip" tabindex="0" data-tip="EV/EBITDA and P/CF are not meaningful for lenders and insurers, so they are dropped and the composite is renormalised over the remaining factors.">financial</span>' : ''}${trap ? ' · <span class="flagtrap tip" tabindex="0" data-tip="Low return on capital alongside a cheap valuation is the classic value-trap pattern. The strategy does not exclude these — momentum is supposed to be the filter — but you should know which names carry the risk.">trap risk</span>' : ''}</div>
  </td>
  <td class="num"><span class="comp">${r.composite}</span><div class="chips">${chips(r)}</div></td>
  <td class="num ${(r.ret6M || 0) >= 0 ? 'pos' : 'neg'}">${fmtPct(r.ret6M)}</td>
  <td class="num">${r.roce != null ? fmtN(r.roce) + '%' : '—'}</td>
  <td class="num">${r.roe != null ? fmtN(r.roe) + '%' : '—'}</td>
  <td class="num" data-price-cell data-live-px="${esc(r.ticker)}">${fmtPrice(r.price)}</td>
  <td class="num dim">${fmtCr(r.marketCap)}</td>
</tr>`;
}

function buildHtml(res, { fields, restrictedCount, survAge, dropped }) {
  const picks = res.picks;
  const cov = res.coverage;
  const avgComp = picks.length ? (picks.reduce((a, r) => a + r.composite, 0) / picks.length).toFixed(1) : '—';
  const avgMom = picks.length ? (picks.reduce((a, r) => a + (r.ret6M || 0), 0) / picks.length).toFixed(1) : '—';
  const nFactors = METRICS.length - dropped.length;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trending Value — cheapest decile, ranked by momentum</title>
<style>
:root{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#f59e0b;--tx:#e8e8f0;--t2:#9898b0;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--yw:#eab308}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx)}
.header{background:var(--s1);border-bottom:1px solid var(--bd);padding:18px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.header h1{font-size:1.3rem}.header h1 span{color:var(--ac)}
.header .sub{font-size:.76rem;color:var(--t2);margin-top:3px}
.back-link{color:var(--t2);text-decoration:none;font-size:.78rem;padding:5px 11px;border:1px solid var(--bd);border-radius:6px;margin-left:6px}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
main{max-width:1280px;margin:0 auto;padding:20px 18px 60px}
.warnbox{background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.28);border-radius:10px;padding:14px 16px;font-size:.83rem;line-height:1.65;margin-bottom:14px}
.warnbox h3{font-size:.9rem;color:var(--ac);margin-bottom:6px}
.hardbox{background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.28);border-radius:10px;padding:13px 16px;font-size:.82rem;line-height:1.6;margin-bottom:16px}
.hardbox h3{font-size:.88rem;color:#f87171;margin-bottom:5px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.stat{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:11px 15px;min-width:104px}
.stat .v{font-size:1.3rem;font-weight:700}.stat .l{font-size:.64rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.tblwrap{background:var(--s1);border:1px solid var(--bd);border-radius:10px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.83rem}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--bd);vertical-align:top}
th{font-size:.63rem;text-transform:uppercase;letter-spacing:.06em;color:var(--t2);font-weight:600;position:sticky;top:0;background:var(--s2);z-index:2;white-space:nowrap}
tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--s2)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.rk{color:var(--t3);font-weight:700;width:34px}
td.dim{color:var(--t3)}
.pos{color:var(--gn)}.neg{color:var(--rd)}
.tk{color:var(--tx);font-weight:600;text-decoration:none}.tk:hover{color:var(--ac)}
.name-row{display:inline-flex;align-items:center;gap:3px}
.sub{font-size:.68rem;color:var(--t3);margin-top:3px}
.flagtrap{color:var(--rd);cursor:help}
.comp{font-size:1.05rem;font-weight:700;color:var(--ac)}
.chips{display:flex;flex-wrap:wrap;gap:3px;margin-top:5px;justify-content:flex-end;max-width:230px}
.chip{font-size:.58rem;padding:2px 5px;border-radius:4px;background:var(--s3);color:var(--t2);cursor:help;white-space:nowrap}
.chip b{font-variant-numeric:tabular-nums}
.chip.cheap{background:rgba(34,197,94,.14);color:#86efac}
.chip.mid{background:var(--s3);color:var(--t2)}
.chip.rich{background:rgba(239,68,68,.12);color:#fca5a5}
.chip.na{background:transparent;border:1px dashed var(--bd);color:var(--t3)}
.mixbox{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:12px 15px;margin-bottom:16px}
.mixhead{font-size:.64rem;text-transform:uppercase;letter-spacing:.06em;color:var(--t2);font-weight:700;margin-bottom:8px}
.mixbars{display:flex;flex-wrap:wrap;gap:6px}
.mixbar{font-size:.72rem;background:var(--s2);border:1px solid var(--bd);border-radius:5px;padding:3px 9px;color:var(--t2)}
.mixbar b{color:var(--ac);font-variant-numeric:tabular-nums;margin-right:3px}
.mixnote{font-size:.75rem;color:var(--t3);line-height:1.55;margin-top:9px}
.mixnote b{color:var(--t2)}
.overcap{color:var(--yw);cursor:help}
.covtbl{width:100%;font-size:.76rem;margin-top:8px}
.covtbl td{padding:5px 8px;border-bottom:1px solid var(--bd)}
h2.sec{font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:var(--t2);margin:22px 0 10px;font-weight:700}
.footer{text-align:center;padding:22px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd);margin-top:26px}
@media(max-width:700px){.chips{max-width:150px}main{padding:14px 10px 50px}}
${stockActions.css}
${TOOLTIP_CSS}
</style></head>
<body>
<div class="header">
  <div>
    <h1>💰 <span>Trending Value</span></h1>
    <div class="sub">O'Shaughnessy · cheapest decile of ${res.universeSize.toLocaleString('en-IN')} tradeable stocks, ranked by 6-month momentum · top ${picks.length}</div>
  </div>
  <div>
    <a href="creamy.html" class="back-link">🍦 Creamy Layer</a>
    <a href="multibagger.html" class="back-link">🏆 Multibagger</a>
    <a href="playbook.html" class="back-link">📘 Playbook</a>
    ${HUB_BACK_LINK}
  </div>
</div>
<main>
  <div class="warnbox">
    <h3>How the list is built</h3>
    Every stock above <b>₹${RULES.mcapMin} Cr</b> that trades at least <b>₹${(RULES.adv20Min / 1e7).toFixed(0)} Cr a day</b> is scored 1&ndash;10 on
    ${nFactors} valuation factors &mdash; <b>${METRICS.filter(m => !dropped.includes(m.label)).map(m => m.label).join(', ')}</b> &mdash; where <b>1 is the cheapest decile of the market</b> and 10 the most expensive.
    Add them up and you get the <b>Value Composite</b> (6 = cheap on everything, 60 = expensive on everything).
    Keep the cheapest ${(RULES.decileCut * 100).toFixed(0)}% (composite ≤ <b>${res.cutoff}</b>), then sort <i>those</i> by 6-month price return and take the top ${RULES.topN}.<br><br>
    The two-step matters: cheap-only screens buy declining businesses, and momentum-only screens buy whatever is already expensive.
    Requiring both is what O'Shaughnessy found beat either leg on its own.
  </div>

  <div class="hardbox">
    <h3>What this page does not know</h3>
    The evidence for Trending Value is <b>US data from 1964&ndash;2009</b>. Nothing here has validated it on Indian equities &mdash; not this repo, and not, to my knowledge, anywhere with comparable rigour.
    It is also a <b>basket strategy rebalanced monthly</b>: in the research the 25 names are held together and refreshed as a group, and individual positions failing is normal and expected.
    Reading the top row as a stock tip is not how the strategy works.
    Every pick is logged to the outcome ledger from today, so in a few months <a href="playbook.html" style="color:#7dd3fc">the scoreboard</a> will have a local measurement instead of a borrowed one.
  </div>

  <div class="stats">
    <div class="stat"><div class="v">${picks.length}</div><div class="l">Picks</div></div>
    <div class="stat"><div class="v">${avgComp}</div><div class="l tip" tabindex="0" data-tip="Average Value Composite across the list. The theoretical floor is 6 — cheapest decile on all six factors at once, which almost never happens.">Avg composite</div></div>
    <div class="stat"><div class="v ${parseFloat(avgMom) >= 0 ? 'pos' : 'neg'}">${avgMom}%</div><div class="l">Avg 6M return</div></div>
    <div class="stat"><div class="v">${res.valueDecile.length}</div><div class="l tip" tabindex="0" data-tip="The cheapest ${res.scoredSize ? (res.valueDecile.length / res.scoredSize * 100).toFixed(1) : '10'}% of the ${res.scoredSize.toLocaleString('en-IN')} scored stocks, cut by count so ties cannot inflate it. The top ${RULES.topN} by momentum are drawn from these.">Cheap decile</div></div>
    <div class="stat"><div class="v">${res.universeSize.toLocaleString('en-IN')}</div><div class="l tip" tabindex="0" data-tip="Stocks passing market cap and liquidity. Deciles are computed against this universe, so a score of 1 means cheapest 10% of tradeable India — not of some index.">Universe</div></div>
    <div class="stat"><div class="v">${restrictedCount}</div><div class="l tip" tabindex="0" data-tip="Excluded for being under NSE graded surveillance or long-term ASM stage 2+. Cheap screens attract these names, and price bands plus 100% margin make them untradeable.">Excluded (surv)</div></div>
    <div class="stat"><div class="v">${res.industryMix.length}</div><div class="l tip" tabindex="0" data-tip="Distinct industries represented, at most ${RULES.maxPerIndustry} names each. Without the cap this list would have been ${res.uncappedMix.length} industries, led by ${esc(res.uncappedMix[0] ? `${res.uncappedMix[0].group} with ${res.uncappedMix[0].n}` : 'n/a')}.">Industries</div></div>
  </div>

  <div class="mixbox">
    <div class="mixhead">Industry mix <span class="tip" tabindex="0" data-tip="Cyclicals get cheap together, so an uncapped value screen concentrates in whatever industry is currently depressed. Capped at ${RULES.maxPerIndustry} names per industry — or ${RULES.maxPerSectorFallback} for entries showing only a broad sector, since a sector spans hundreds of unrelated businesses and is not one cycle bet.">ⓘ</span></div>
    <div class="mixbars">${res.industryMix.map(m => `<span class="mixbar"><b>${m.n}</b> ${esc(m.group)}</span>`).join('')}</div>
    ${res.displacedCount ? `<div class="mixnote">The cap displaced <b>${res.displacedCount}</b> name${res.displacedCount === 1 ? '' : 's'} that ranked high on momentum but sat in an already-full industry.
      Uncapped, the top ${RULES.topN} would have been led by <b>${esc(res.uncappedMix[0].group)} with ${res.uncappedMix[0].n}</b> of ${RULES.topN} &mdash; one cycle bet placed ${res.uncappedMix[0].n} times rather than a diversified basket.</div>` : ''}
    ${res.overCap.length ? `<div class="mixnote">${res.overCap.length} name${res.overCap.length === 1 ? ' was' : 's were'} admitted <b>over</b> the cap (${esc(res.overCap.join(', '))}) because the cheap decile was too concentrated to fill ${RULES.topN} slots without them. Marked on their rows.</div>` : ''}
  </div>

  ${dropped.length ? `<div class="hardbox"><h3>Running on ${nFactors} factors, not 6</h3>
    ${esc(dropped.join(' and '))} ${dropped.length > 1 ? 'are' : 'is'} not being scored this run, so every composite is
    renormalised over the factors that are present (scale still 6&ndash;60, so scores stay comparable).
    This is stated rather than hidden because a ${nFactors}-factor composite is not a six-factor composite.
    ${res.pcf.gated ? `<br><br><b>P/CF specifically:</b> the data source that covers the whole market in one query does not expose price-to-cash-flow,
      so operating cash flow is fetched per-stock from Yahoo into a cache that fills a few hundred names a night
      (<code>docs/cashflow.json</code>). Coverage is currently <b>${res.pcf.coverage == null ? '0' : (res.pcf.coverage * 100).toFixed(1)}%</b>
      of the screened universe and the factor is only scored above <b>${(res.pcf.gate * 100).toFixed(0)}%</b>.
      <br><br>The gate exists because deciles are ranked <i>across the universe</i>: with partial coverage, a stock's P/CF decile would be its rank
      among whichever names happened to be fetched, not among the market &mdash; a number that looks like a real factor but is an artefact of fetch order.
      Better to score five factors honestly than six dishonestly.` : ''}</div>` : ''}

  <h2 class="sec">Top ${picks.length} Trending Value picks</h2>
  <div class="tblwrap">
  <table>
    <thead><tr>
      <th>#</th><th>Company</th>
      <th class="num">Value composite <span class="tip" tabindex="0" data-tip="Sum of the per-factor deciles, renormalised to a 6-60 scale when a factor is missing. Lower is cheaper. The chips below show each factor's decile — hover one for the raw number.">ⓘ</span></th>
      <th class="num">6M return <span class="tip" tabindex="0" data-tip="The momentum leg. The cheap decile is ranked by this, descending — the list is ordered by it.">ⓘ</span></th>
      <th class="num">ROCE</th><th class="num">ROE</th><th class="num">Price</th><th class="num">Mkt cap</th>
    </tr></thead>
    <tbody>
    ${picks.length ? picks.map(r => row(r, res.universeSize)).join('') : `<tr><td colspan="8" style="padding:22px;color:var(--t2)">No stocks passed. That is a real outcome, not an error — check the rejection counts in the run log.</td></tr>`}
    </tbody>
  </table>
  </div>

  ${legendHtml('Method, factor coverage and caveats (tap to expand)', [
    { title: 'Why negative P/E scores 10 and not 1', bodyHtml: '<p>Sorted numerically, a company at &minus;4&times; earnings looks like the cheapest stock in the market. It is not cheap; it is loss-making. Negative earnings, negative book value, negative cash flow and negative EBITDA are therefore hard-assigned the <b>worst</b> decile and never ranked. This single rule is the difference between a value screen and a list of companies in trouble.</p>' },
    { title: 'Missing data vs bad data', bodyHtml: `<p>A factor with no data is dropped for that stock and the composite is renormalised over what remains &mdash; minimum ${RULES.minMetrics} of 6 factors, else the stock is excluded entirely. Scoring a data gap as "expensive" would measure this repo's data coverage rather than the company's valuation. A non-payer of dividends is different: zero yield is a real observation, so it correctly scores 10.</p>` },
    { title: 'Financials are scored differently', bodyHtml: '<p>For banks, NBFCs and insurers, EV/EBITDA and P/CF describe nothing real &mdash; debt is raw material rather than leverage, and operating cash flow swings with the loan book. Both factors are dropped for financials and the composite renormalises over the rest. They are marked <b>financial</b> on the row so you can see which comparison you are making.</p>' },
    { title: 'Factor coverage this run', bodyHtml: `<table class="covtbl"><tr><td><b>Factor</b></td><td><b>Ranked</b></td><td><b>Worst decile (negative)</b></td><td><b>Dropped (no data / financial)</b></td></tr>${cov.map(c => `<tr><td>${esc(c.label)}</td><td>${c.ranked}</td><td>${c.worst}</td><td>${c.missing}</td></tr>`).join('')}</table><p style="margin-top:8px">Big numbers in the last column mean a thinner composite than the name suggests. Worth a look before trusting a score.</p>` },
    { title: 'Why the decile is cut by count, not by score', bodyHtml: `<p>Six integer deciles can only produce 55 distinct composites, so on a ${res.scoredSize.toLocaleString('en-IN')}-stock universe roughly ${Math.round(res.scoredSize / 55)} names share <i>every</i> score. Keeping everything at or below a threshold would then return about 20% of the market and call it a decile. So the cut takes the cheapest <b>${(RULES.decileCut * 100).toFixed(0)}% by count</b>, and where composites tie it prefers the name with the better average percentile rank across the factors &mdash; the same ordering at full resolution. O'Shaughnessy sums 1&ndash;100 percentile ranks for exactly this reason; the 1&ndash;10 scale is kept here because it is readable, with the finer ranking used only to break ties.</p>` },
    { title: `Why the list is capped at ${RULES.maxPerIndustry} per industry`, bodyHtml: `<p>The first live run of this screen returned <b>seven sugar mills</b> in 25 names, plus ten in Materials &mdash; a "diversified basket" that was really one bet on the sugar cycle placed seven times. That is not a bug in the composite; it is what a mechanical cheap-decile screen does when a whole industry gets cheap together.</p><p>O'Shaughnessy's published rules are silent on sector limits, because the US universe he tested is large enough that clustering is rarer. On roughly 1,600 tradeable Indian names it is the normal case, so the list is capped at ${RULES.maxPerIndustry} per industry, applied in momentum order. Grouping is by <b>industry</b> rather than sector deliberately: the data source files four sugar mills under Consumer Staples and two under Materials, so a sector cap would still have admitted six of them.</p><p>Where a cap slot cannot be filled without breaching it, the name is admitted and marked <b>over cap</b> rather than shipping a list of 14 &mdash; and the mix above always shows what the uncapped list would have looked like.</p>` },
    { title: 'Value traps and the trap-risk flag', bodyHtml: '<p>Momentum is meant to be the trap filter: a genuinely broken business rarely has a strong 6-month return. It is an imperfect filter. Rows where ROCE is under 10% or ROE under 8% carry a <b>trap risk</b> mark &mdash; cheap <i>and</i> earning poorly on capital is the classic pattern. These are not excluded, because excluding them would no longer be the tested strategy, but you should know which ones they are.</p>' },
    { title: 'What was excluded and why', bodyHtml: `<p>From the full market: <b>${res.rejected.mcap.toLocaleString('en-IN')}</b> below ₹${RULES.mcapMin} Cr, <b>${res.rejected.liquidity.toLocaleString('en-IN')}</b> below ₹${(RULES.adv20Min / 1e7).toFixed(0)} Cr average daily traded value (an unknown ADV counts as untradeable &mdash; the screen fails closed), <b>${res.rejected.surveillance}</b> under NSE surveillance, <b>${res.rejected.thinData}</b> with fewer than ${RULES.minMetrics} usable factors${res.rejected.noMomentum ? `, and <b>${res.rejected.noMomentum}</b> inside the cheap decile with no 6-month return to rank on` : ''}.${survAge != null ? ` Surveillance list is ${survAge.toFixed(0)}h old.` : ''}</p>` },
    { title: 'How this differs from Creamy Layer and Multibagger', bodyHtml: '<p><a href="creamy.html" style="color:#7dd3fc">Creamy Layer</a> and <a href="multibagger.html" style="color:#7dd3fc">Multibagger</a> hunt quality and growth, and mostly surface businesses that are expensive for good reasons. This page does the opposite: it ranks on cheapness first and only asks about price behaviour second. Overlap between them is rare and worth a second look when it happens.</p>' },
  ])}
</main>
<div class="footer">
  Trending Value &middot; six-factor value composite &times; 6-month momentum &middot; universe ${res.universeSize.toLocaleString('en-IN')} stocks.<br>
  Mechanical screen output, not investment advice. Every buy, sell and sizing decision is yours.
</div>
${stockActions.bannerHtml}
${stockActions.modalHtml}
${stockActions.researchModalHtml}
<script>${stockActions.setupScript}
${stockActions.js}
<\/script>
</body></html>`;
}

if (require.main === module) main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
module.exports = { buildHtml, resolveFields, CANDIDATES, KNOWN };

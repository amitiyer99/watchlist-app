'use strict';

// ── Operating cash-flow fetcher ───────────────────────────────────────────────
// Fills the one gap in the Trending Value composite: PRICE TO CASH FLOW.
//
// Tickertape's screener returns the whole market in two calls but does not expose
// price-to-cash-flow under any of the 14 field codes probed (see docs/tv-fields.json
// — psr/ps/apsr/... resolved for P/S, pcfr/pcf/apcf/... all came back 0/300).
// Yahoo DOES have it, in quoteSummary's `financialData` module, as TTM
// `operatingCashflow` and `freeCashflow`.
//
// The catch is cost: Yahoo is one request per stock, so covering the ~1,600-name
// screened universe every night is 1,600 requests. Cash flow is a QUARTERLY number,
// so that would be almost entirely wasted work. Instead this follows the same shape
// as fetch-earnings-quality.js: a capped number of stocks per run, accumulating into
// a cache, refreshed only when a row goes stale. Coverage converges over ~2 weeks
// and then self-maintains.
//
// P/CF is then market cap ÷ operating cash flow. MIND THE UNITS: Tickertape's
// mrktCapf is in ₹ CRORE, Yahoo's operatingCashflow is in ABSOLUTE rupees. Getting
// that wrong gives a P/CF off by 1e7 — which would still rank consistently, so every
// decile would look plausible while every displayed number was nonsense. The
// conversion lives in lib/trending-value.js and is unit-tested.
//
// Run: npm run fetch-cashflow          (MAX_STOCKS=400 npm run fetch-cashflow to go faster)
// Out: docs/cashflow.json

const fs = require('fs');
const path = require('path');
const { makeClient } = require('./lib/yahoo');
const EX = require('./lib/exchange');

const DOCS = path.join(__dirname, 'docs');
const OUT_PATH = path.join(DOCS, 'cashflow.json');

const MAX_STOCKS  = parseInt(process.env.MAX_STOCKS || '150', 10);  // requests per run
const CONCURRENCY = 4;
const THROTTLE_MS = 250;
// Cash flow is reported quarterly, so a 90-day-old figure is still the current one.
// Refreshing sooner just burns requests that could be extending coverage instead.
const FRESH_DAYS  = 90;
const KEEP_DAYS   = 400;   // drop rows not seen in this long (delisted / renamed)

const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const daysSince = d => { const t = Date.parse(d); return isFinite(t) ? (Date.now() - t) / 864e5 : Infinity; };

// ── Which stocks to fetch, in priority order ─────────────────────────────────
// Priority matters because coverage is partial for the first couple of weeks, and a
// partially-covered factor is only useful if the covered part is the part that
// actually competes for the cheap decile.
//   1. names already in the Trending Value picks (keep the visible page complete)
//   2. the rest of the screened universe, cheapest-first on the factors we DO have
//   3. everything else the site tracks, so other pages can use it later
function buildCandidates(cache) {
  const seen = new Set();
  const out = [];
  const push = t => {
    const k = String(t || '').toUpperCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    // Skip anything already fresh — that is the whole point of the cache.
    const row = cache.rows[k];
    if (row && row.refreshedAt && daysSince(row.refreshedAt) < FRESH_DAYS) return;
    out.push(k);
  };

  for (const r of readJson(path.join(DOCS, 'trendingvalue-tickers.json'), []) || []) push(r.ticker);

  // The screened universe, cheapest-composite first. Written by generate-trendingvalue.js
  // so this fetcher knows which names are near the decile boundary and worth having.
  const univ = readJson(path.join(DOCS, 'trendingvalue-universe.json'), null);
  if (univ && Array.isArray(univ.rows)) {
    univ.rows.slice().sort((a, b) => (a.composite ?? 999) - (b.composite ?? 999)).forEach(r => push(r.ticker));
  }

  for (const f of ['multibagger-tickers.json', 'apex-tickers.json', 'creamy-tickers.json',
    'indianresearch-tickers.json', 'bestpicks-tickers.json', 'rocket-tickers.json']) {
    for (const r of readJson(path.join(DOCS, f), []) || []) push(r.ticker);
  }
  return out;
}

async function main() {
  const prev = readJson(OUT_PATH, null);
  const cache = {
    updatedAt: null,
    rows: (prev && prev.rows) || {},
    // How much of the last screened universe we can price on cash flow. The
    // generator reads this to decide whether P/CF is trustworthy enough to score.
    coverage: (prev && prev.coverage) || null,
  };

  const candidates = buildCandidates(cache).slice(0, MAX_STOCKS);
  const known = Object.keys(cache.rows).length;
  console.log(`Cash flow: ${candidates.length} to fetch this run (cap ${MAX_STOCKS}) · ${known} already cached`);
  if (!candidates.length) console.log('  nothing stale and nothing new — cache is current');

  const yf = makeClient();
  EX.loadExchangeMap();
  let ok = 0, noData = 0, failed = 0;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ticker => {
      const sym = EX.yahooSymbol(ticker);
      if (!sym) { failed++; return; }
      try {
        const qs = await yf.quoteSummary(sym, { modules: ['financialData'] });
        const fd = (qs && qs.financialData) || {};
        const ocf = typeof fd.operatingCashflow === 'number' ? fd.operatingCashflow : null;
        const fcf = typeof fd.freeCashflow === 'number' ? fd.freeCashflow : null;
        if (ocf == null && fcf == null) {
          // Record the MISS too, with a date. Otherwise every run re-requests the
          // same coverage holes forever and never advances.
          cache.rows[ticker] = { ticker, ocf: null, fcf: null, refreshedAt: today(), miss: true };
          noData++;
          return;
        }
        cache.rows[ticker] = {
          ticker,
          ocf,                    // absolute ₹, TTM — NOT crore
          fcf,
          ebitda: typeof fd.ebitda === 'number' ? fd.ebitda : null,
          refreshedAt: today(),
        };
        ok++;
      } catch (e) {
        failed++;
        if (failed <= 3) console.warn(`  ${ticker} (${sym}): ${e.message}`);
      }
    }));
    await sleep(THROTTLE_MS);
    if ((i + CONCURRENCY) % 40 === 0) process.stdout.write(`  ${Math.min(i + CONCURRENCY, candidates.length)}/${candidates.length}\r`);
  }

  // Drop long-unseen rows so the file does not accumulate delisted names forever.
  let dropped = 0;
  for (const [t, r] of Object.entries(cache.rows)) {
    if (daysSince(r.refreshedAt) > KEEP_DAYS) { delete cache.rows[t]; dropped++; }
  }

  // Coverage against the last known screened universe — the number that decides
  // whether the factor is allowed into the composite.
  const univ = readJson(path.join(DOCS, 'trendingvalue-universe.json'), null);
  if (univ && Array.isArray(univ.rows) && univ.rows.length) {
    const usable = univ.rows.filter(r => {
      const row = cache.rows[String(r.ticker).toUpperCase()];
      return row && row.ocf != null;
    }).length;
    cache.coverage = {
      universeSize: univ.rows.length,
      priced: usable,
      pct: +((usable / univ.rows.length) * 100).toFixed(1),
      asOf: today(),
    };
  }

  cache.updatedAt = new Date().toISOString();
  fs.writeFileSync(OUT_PATH, JSON.stringify(cache, null, 1), 'utf8');

  const total = Object.keys(cache.rows).length;
  const withOcf = Object.values(cache.rows).filter(r => r.ocf != null).length;
  console.log(`  +${ok} priced · ${noData} no cash-flow data · ${failed} failed${dropped ? ` · ${dropped} expired` : ''}`);
  console.log(`  cache: ${total} tickers, ${withOcf} with operating cash flow`
    + (cache.coverage ? ` · universe coverage ${cache.coverage.pct}% (${cache.coverage.priced}/${cache.coverage.universeSize})` : ''));
  if (cache.coverage) {
    const { PCF_MIN_COVERAGE } = require('./lib/trending-value');
    console.log(cache.coverage.pct >= PCF_MIN_COVERAGE * 100
      ? `  ✅ above the ${(PCF_MIN_COVERAGE * 100).toFixed(0)}% gate — P/CF is scored in the composite`
      : `  ⏳ below the ${(PCF_MIN_COVERAGE * 100).toFixed(0)}% gate — P/CF stays OUT of the composite until coverage catches up`);
  }
  console.log(`→ ${OUT_PATH}`);
}

if (require.main === module) main().catch(e => { console.error('\nError:', e.message); process.exit(1); });
module.exports = { buildCandidates, FRESH_DAYS };

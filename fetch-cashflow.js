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
const os = require('os');
const { makeClient } = require('./lib/yahoo');
const EX = require('./lib/exchange');

const DOCS = path.join(__dirname, 'docs');
const OUT_PATH = path.join(DOCS, 'cashflow.json');

// Limits are settable by FLAG as well as env var. Env-var-only meant
// `MAX_STOCKS=400 npm run ...`, which is bash syntax and simply fails on a Windows
// CMD prompt ("'MAX_STOCKS' is not recognized"). Flags work in every shell.
//   node fetch-cashflow.js --max=400 --scrape=150
const argNum = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) { const n = parseInt(hit.split('=')[1], 10); if (isFinite(n)) return n; }
  return fallback;
};

const MAX_STOCKS  = argNum('max', parseInt(process.env.MAX_STOCKS || '150', 10));  // Yahoo requests per run
const CONCURRENCY = 4;
const THROTTLE_MS = 250;

// ── Second source: Screener.in ────────────────────────────────────────────────
// Yahoo turned out to cover only ~8% of this universe (12 of 148 on the first real
// run), and the gaps were not small companies — CHENNPETRO, REDINGTON, GNFC and
// KTKBANK all came back empty. Screener.in is an Indian source and carries a Cash
// Flow Statement on every company page, so it picks up what Yahoo misses.
//
// It costs a browser page load per stock instead of an API call, so it runs second
// and only over Yahoo's misses, with its own smaller cap. Uses the same saved
// Chromium profile as fetch-earnings-quality.js — run login-screener.bat once.
//
// UNIT NOTE: Screener.in reports ₹ CRORE per fiscal year; Yahoo reports ABSOLUTE
// rupees TTM. Screener values are multiplied to absolute rupees so both sources
// land in the same units. Annual-vs-TTM is a mild mismatch, acceptable for a
// valuation decile and preferable to having no factor at all.
const MAX_SCRAPE  = argNum('scrape', parseInt(process.env.MAX_SCRAPE || '100', 10));
const SCRAPE_MS   = 3000;   // Screener.in throttles bursts
const SESSION_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'watchlist-app-session');
const HEADLESS    = process.env.HEADLESS === '1';
const NO_SCRAPE   = process.argv.includes('--no-scrape') || MAX_SCRAPE === 0;
const CRORE       = 1e7;
// Cash flow is reported quarterly, so a 90-day-old figure is still the current one.
// Refreshing sooner just burns requests that could be extending coverage instead.
const FRESH_DAYS  = 90;
// A MISS is different from a hit and must expire sooner. Measured on the first real
// run: Yahoo's financialData returned operatingCashflow for only 12 of 148 NSE names
// (8%) — and the misses were not obscure micro-caps, they included CHENNPETRO
// (₹21,000 Cr), REDINGTON (₹27,700 Cr) and GNFC. So most gaps are Yahoo's coverage,
// not the company's. Holding a miss for 90 days would freeze that verdict in place
// long after a better source or module was wired in.
const MISS_RETRY_DAYS = 21;
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
    // Skip anything already fresh — that is the whole point of the cache. Misses
    // expire sooner than hits, so a source improvement gets picked up (see MISS_RETRY_DAYS).
    const row = cache.rows[k];
    const ttl = row && row.miss ? MISS_RETRY_DAYS : FRESH_DAYS;
    if (row && row.refreshedAt && daysSince(row.refreshedAt) < ttl) return;
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

// Runs in-page on a Screener.in company page: pull the cash-flow statement's
// operating-activity row. Labels vary slightly ("Cash from Operating Activity",
// sometimes with a +/- suffix), so match loosely on the leading words.
async function scrapeCashflow(page) {
  return page.evaluate(() => {
    const sec = document.querySelector('#cash-flow');
    if (!sec) return null;
    const t = sec.querySelector('table');
    if (!t) return null;
    const years = [...t.querySelectorAll('thead th')].map(x => x.textContent.trim()).slice(1).filter(Boolean);
    for (const tr of t.querySelectorAll('tbody tr')) {
      const tds = [...tr.querySelectorAll('td')];
      if (!tds.length) continue;
      const label = (tds[0].textContent || '').replace(/\s+/g, ' ').trim();
      if (/^cash\s+from\s+operating\s+activit/i.test(label)) {
        return { years, values: tds.slice(1).map(td => td.textContent.trim()) };
      }
    }
    return null;
  });
}

const toNum = v => {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').replace(/%/g, '').trim();
  if (!s || s === '-' || s === '') return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
};

// Screener.in pass over the tickers Yahoo could not price.
async function scrapePass(tickers, cache) {
  if (!tickers.length || NO_SCRAPE) return { ok: 0, missing: 0, skipped: !!NO_SCRAPE };
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.warn('  Screener.in pass skipped: playwright not installed'); return { ok: 0, missing: 0, skipped: true }; }

  let context;
  try {
    context = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: HEADLESS, viewport: { width: 1300, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    console.warn(`  Screener.in pass skipped: could not launch Chromium (${e.message}). Try: npx playwright install chromium`);
    return { ok: 0, missing: 0, skipped: true };
  }

  const day = today();
  let ok = 0, missing = 0, rateLimited = false;
  try {
    const page = context.pages()[0] || await context.newPage();
    for (const ticker of tickers) {
      if (rateLimited) break;
      const url = `https://www.screener.in/company/${encodeURIComponent(ticker)}/consolidated/`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        if (/too many requests/i.test(body)) {
          console.warn(`    rate-limited at ${ticker} — waiting 60s, then one retry…`);
          await page.waitForTimeout(60000);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const b2 = await page.evaluate(() => document.body.innerText || '').catch(() => '');
          if (/too many requests/i.test(b2)) { rateLimited = true; console.warn('    still rate-limited — stopping; re-run later to continue.'); break; }
        }
        const cf = await scrapeCashflow(page);
        const vals = cf ? cf.values.map(toNum).filter(v => v != null) : [];
        if (!vals.length) {
          cache.rows[ticker] = { ticker, ocf: null, fcf: null, refreshedAt: day, miss: true, triedScreener: true };
          missing++;
        } else {
          // Most recent fiscal year is the last column. ₹Cr -> absolute ₹ so both
          // sources share units.
          const latestCr = vals[vals.length - 1];
          cache.rows[ticker] = {
            ticker,
            ocf: latestCr * CRORE,
            fcf: null,
            source: 'screener',
            period: cf.years.length ? cf.years[cf.years.length - 1] : null,
            refreshedAt: day,
          };
          ok++;
        }
      } catch {
        cache.rows[ticker] = { ticker, ocf: null, fcf: null, refreshedAt: day, miss: true, triedScreener: true };
        missing++;
      }
      await page.waitForTimeout(SCRAPE_MS);
      if (ok && ok % 20 === 0) process.stdout.write(`    …${ok} scraped\r`);
    }
  } finally {
    await context.close().catch(() => {});
  }
  return { ok, missing, skipped: false };
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
        let ocf = typeof fd.operatingCashflow === 'number' ? fd.operatingCashflow : null;
        const fcf = typeof fd.freeCashflow === 'number' ? fd.freeCashflow : null;
        let src = ocf != null ? 'yahoo:financialData' : null;

        // financialData carried operatingCashflow for only ~8% of this universe, and
        // the library warns that quoteSummary's statement submodules "have provided
        // almost no data since Nov 2024 — use fundamentalsTimeSeries instead". So that
        // is the real second attempt: still one API call, no browser, and it is the
        // endpoint Yahoo actually populates.
        if (ocf == null) {
          try {
            const ts = await yf.fundamentalsTimeSeries(sym, {
              period1: new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10),
              type: 'annual', module: 'cash-flow',
            });
            const rows = Array.isArray(ts) ? ts : [];
            for (let k = rows.length - 1; k >= 0; k--) {
              const v = rows[k] && (rows[k].annualOperatingCashFlow ?? rows[k].operatingCashFlow);
              if (typeof v === 'number' && isFinite(v) && v !== 0) { ocf = v; src = 'yahoo:timeSeries'; break; }
            }
          } catch { /* fall through to the Screener.in pass */ }
        }
        if (ocf == null && fcf == null) {
          // Record the MISS too, with a date. Otherwise every run re-requests the
          // same coverage holes forever and never advances. Not marked `miss` yet —
          // Screener.in gets a turn at these below, and only then is it a real gap.
          cache.rows[ticker] = { ticker, ocf: null, fcf: null, refreshedAt: today(), yahooMiss: true };
          noData++;
          return;
        }
        cache.rows[ticker] = {
          ticker,
          ocf,                    // absolute ₹, TTM — NOT crore
          fcf,
          ebitda: typeof fd.ebitda === 'number' ? fd.ebitda : null,
          source: src || 'yahoo',
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

  // ── Pass 2: Screener.in over everything Yahoo could not price ──────────────
  // Includes names from earlier runs still sitting unpriced, not just this batch —
  // otherwise the 8% Yahoo coverage would never be topped up.
  const needScrape = Object.values(cache.rows)
    .filter(r => r.ocf == null && !r.triedScreener)
    .map(r => r.ticker)
    .slice(0, MAX_SCRAPE);
  let scraped = { ok: 0, missing: 0, skipped: true };
  if (needScrape.length) {
    console.log(`  Yahoo left ${Object.values(cache.rows).filter(r => r.ocf == null && !r.triedScreener).length} unpriced · trying Screener.in on ${needScrape.length} (cap ${MAX_SCRAPE})`);
    scraped = await scrapePass(needScrape, cache);
    if (!scraped.skipped) console.log(`  Screener.in: +${scraped.ok} priced · ${scraped.missing} with no cash-flow table`);
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
  const bySrc = Object.values(cache.rows).reduce((a, r) => { if (r.ocf != null) a[r.source || '?'] = (a[r.source || '?'] || 0) + 1; return a; }, {});
  console.log(`  Yahoo: +${ok} priced · ${noData} no data · ${failed} failed${dropped ? ` · ${dropped} expired` : ''}`);
  console.log(`  by source: ${Object.entries(bySrc).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`);
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

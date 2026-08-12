'use strict';
// Fetches live prices for all NSE stocks in nse-tickers.json and writes docs/live-prices.json.
// Run server-side (GitHub Actions) — no CORS issues. Browser loads the output file directly.

const { makeClient } = require('./lib/yahoo');
const yahooFinance = makeClient();
const fs   = require('fs');
const path = require('path');

const TICKERS_PATH = path.join(__dirname, 'docs', 'nse-tickers.json');
const OUTPUT_PATH  = path.join(__dirname, 'docs', 'live-prices.json');
const CONCURRENCY  = 20;          // 50 tripped Yahoo throttling; failures were silent
const MAX_FAIL_RATIO = 0.5;       // if more than half the fetches fail, keep the old file

async function quoteWithRetry(yahooFinance, sym) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Exchange-aware: BSE-listed names quote under <scripCode>.BO, not SYM.NS.
      const q = await yahooFinance.quote(require('./lib/exchange').yahooSymbol(sym), {}, { fetchOptions: { signal: AbortSignal.timeout(15000) } });
      if (q && q.regularMarketPrice) return q;
      return null;
    } catch (e) {
      if (attempt === 0) await new Promise(r => setTimeout(r, 800)); // brief backoff then retry once
      else return null;
    }
  }
  return null;
}

// Every sidecar a page renders from. Each is optional: a missing file just contributes
// nothing, so a fresh clone still works.
const UNIVERSE_SOURCES = [
  ['docs/nse-tickers.json',            r => r.t],
  ['docs/breakout2-data.json',         r => r.ticker],
  ['docs/confluence-tickers.json',     r => r.ticker],
  ['docs/bestpicks-tickers.json',      r => r.ticker],
  ['docs/multibagger-tickers.json',    r => r.ticker],
  ['docs/apex-tickers.json',           r => r.ticker],
  ['docs/creamy-tickers.json',         r => r.ticker],
  ['docs/indianresearch-tickers.json', r => r.ticker],
  ['docs/rocket-tickers.json',         r => r.ticker],
  ['docs/investors-tickers.json',      r => r.ticker],
];

function collectUniverse() {
  const set = new Set();
  for (const [rel, pick] of UNIVERSE_SOURCES) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
      const rows = Array.isArray(j) ? j : (j.rows || j.tickers || []);
      let n = 0;
      for (const r of rows) {
        const t = pick(r);
        if (typeof t === 'string' && t) { if (!set.has(t)) n++; set.add(t); }
      }
      console.log(`  + ${String(n).padStart(4)} new from ${rel}`);
    } catch { /* absent — skip */ }
  }
  // Watchlist + the triggers feed (different shapes, handled separately)
  try {
    const tj = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs', 'triggers.json'), 'utf8'));
    for (const r of [...(tj.triggers || []), ...(tj.armed || [])]) if (r.ticker) set.add(r.ticker);
  } catch { /* absent */ }
  return [...set];
}

async function main() {
  if (!fs.existsSync(TICKERS_PATH)) {
    console.log('  nse-tickers.json not found — run npm run breakout2 first');
    return;
  }
  // PRICE UNIVERSE = the union of every page's tickers, not just Breakout GEN2's.
  // The feed was built from nse-tickers.json alone (breakout2's analysed set), so any name
  // that appears only on Multibagger, Best Picks, Marquee or FII/DII was NEVER fetched and
  // could only ever show the price baked in at build time. Measured coverage before this
  // change: Multibagger 16% of rows priced, Best Picks 36%, Breakout GEN2 66%. That is the
  // real reason prices looked wrong "across pages" — not staleness, absence.
  const symbols = collectUniverse();
  console.log(`Fetching prices for ${symbols.length} stocks (union of every page's tickers)...`);

  const priceMap = {};
  let ok = 0, fail = 0;

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async sym => {
      const q = await quoteWithRetry(yahooFinance, sym);
      if (!q) return null;
      return {
        sym,
        p:    q.regularMarketPrice,
        prev: q.regularMarketPreviousClose || null,
        n:    q.longName || q.shortName || '',
      };
    }));
    for (const r of results) {
      if (r) { priceMap[r.sym] = { p: r.p, prev: r.prev, n: r.n }; ok++; }
      else fail++;
    }
    process.stdout.write(`  ${Math.min(i + CONCURRENCY, symbols.length)}/${symbols.length} (${ok} ok, ${fail} fail)\r`);
    await new Promise(r => setTimeout(r, 150)); // pace between batches
  }

  // Thin-data guard. The old test was `fail / requested > 50%`, which breaks the moment the
  // universe widens: adding ~700 obscure names (many with no Yahoo coverage at all) would
  // push the failure RATIO past the threshold on every run and abort forever, quietly
  // freezing the feed. The invariant that actually matters is "don't replace a good file
  // with a much worse one", so compare the priced COUNT against the previous run.
  let prevPriced = 0;
  try { prevPriced = Object.keys(JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')).prices || {}).length; } catch { /* first run */ }
  if (prevPriced > 50 && ok < prevPriced * 0.6) {
    console.error(`\n  ABORT: only ${ok} tickers priced vs ${prevPriced} last run (<60%) — throttled or broken, keeping previous live-prices.json`);
    process.exit(1);
  }
  if (!prevPriced && symbols.length && fail / symbols.length > MAX_FAIL_RATIO) {
    console.error(`\n  ABORT: first run and ${fail}/${symbols.length} fetches failed (>${MAX_FAIL_RATIO * 100}%) — not writing a thin file`);
    process.exit(1);
  }

  let niftyChangePct = null;
  try {
    const nq = await yahooFinance.quote('^NSEI', {}, { fetchOptions: { signal: AbortSignal.timeout(15000) } });
    niftyChangePct = nq.regularMarketChangePercent ?? null;
  } catch { /* optional */ }

  const out = {
    ts: Date.now(),
    prices: priceMap,
    niftyChangePct,
    // Coverage, so consumers can distinguish "no live price for this name" from "stale feed".
    coverage: { requested: symbols.length, priced: ok, failed: fail },
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out), 'utf8');
  console.log(`\n  Saved live-prices.json: ${ok}/${symbols.length} priced (${Math.round(ok / Math.max(symbols.length, 1) * 100)}% coverage, ${fail} failed), Nifty ${niftyChangePct != null ? niftyChangePct.toFixed(2) + '%' : 'n/a'}`);
  if (fail > 0) console.log(`  ${fail} ticker(s) have no live price — those rows keep the end-of-day price baked in at build time.`);
}

main().catch(err => { console.error('generate-prices error:', err.message); process.exit(1); });

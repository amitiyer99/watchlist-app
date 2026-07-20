'use strict';
// Fetches live prices for all NSE stocks in nse-tickers.json and writes docs/live-prices.json.
// Run server-side (GitHub Actions) — no CORS issues. Browser loads the output file directly.

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const fs   = require('fs');
const path = require('path');

const TICKERS_PATH = path.join(__dirname, 'docs', 'nse-tickers.json');
const OUTPUT_PATH  = path.join(__dirname, 'docs', 'live-prices.json');
const CONCURRENCY  = 20;          // 50 tripped Yahoo throttling; failures were silent
const MAX_FAIL_RATIO = 0.5;       // if more than half the fetches fail, keep the old file

async function quoteWithRetry(yahooFinance, sym) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const q = await yahooFinance.quote(sym + '.NS');
      if (q && q.regularMarketPrice) return q;
      return null;
    } catch (e) {
      if (attempt === 0) await new Promise(r => setTimeout(r, 800)); // brief backoff then retry once
      else return null;
    }
  }
  return null;
}

async function main() {
  if (!fs.existsSync(TICKERS_PATH)) {
    console.log('  nse-tickers.json not found — run npm run breakout2 first');
    return;
  }
  const nse     = JSON.parse(fs.readFileSync(TICKERS_PATH, 'utf8'));
  const symbols = nse.map(s => s.t);
  console.log(`Fetching prices for ${symbols.length} NSE stocks...`);

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

  // Thin-data guard: a throttled run silently producing a mostly-empty file would
  // feed stale/missing quotes to every consumer (incl. LIVE_BREAKOUT confirmation).
  if (symbols.length && fail / symbols.length > MAX_FAIL_RATIO) {
    console.error(`\n  ABORT: ${fail}/${symbols.length} fetches failed (>${MAX_FAIL_RATIO * 100}%) — keeping previous live-prices.json`);
    process.exit(1);
  }

  let niftyChangePct = null;
  try {
    const nq = await yahooFinance.quote('^NSEI');
    niftyChangePct = nq.regularMarketChangePercent ?? null;
  } catch { /* optional */ }

  const out = { ts: Date.now(), prices: priceMap, niftyChangePct };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out), 'utf8');
  console.log(`\n  Saved live-prices.json: ${ok} stocks with prices (${fail} failed), Nifty ${niftyChangePct != null ? niftyChangePct.toFixed(2) + '%' : 'n/a'}`);
}

main().catch(err => { console.error('generate-prices error:', err.message); process.exit(1); });

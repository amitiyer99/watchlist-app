'use strict';
// Fetches live prices for all NSE stocks in nse-tickers.json and writes docs/live-prices.json.
// Run server-side (GitHub Actions) — no CORS issues. Browser loads the output file directly.

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const fs   = require('fs');
const path = require('path');

const TICKERS_PATH = path.join(__dirname, 'docs', 'nse-tickers.json');
const OUTPUT_PATH  = path.join(__dirname, 'docs', 'live-prices.json');
const CONCURRENCY  = 50;

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
      try {
        const q = await yahooFinance.quote(sym + '.NS');
        if (!q || !q.regularMarketPrice) return null;
        return {
          sym,
          p:    q.regularMarketPrice,
          prev: q.regularMarketPreviousClose || null,
          n:    q.longName || q.shortName || '',
        };
      } catch { return null; }
    }));
    for (const r of results) {
      if (r) { priceMap[r.sym] = { p: r.p, prev: r.prev, n: r.n }; ok++; }
      else fail++;
    }
    process.stdout.write(`  ${Math.min(i + CONCURRENCY, symbols.length)}/${symbols.length} (${ok} ok, ${fail} fail)\r`);
  }

  const out = { ts: Date.now(), prices: priceMap };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out), 'utf8');
  console.log(`\n  Saved live-prices.json: ${ok} stocks with prices (${fail} failed)`);
}

main().catch(err => { console.error('generate-prices error:', err.message); process.exit(1); });

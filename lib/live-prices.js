'use strict';

// Shared loader for docs/live-prices.json — the freshest price feed, regenerated
// every market-refresh by generate-prices.js. Screener sidecars bake in an EOD-ish
// price at their own generation time, so display pages should OVERLAY this live feed
// to show the current price instead of a stale one.
//
// Shape: { ts, prices: { TICKER: { p, prev, n } }, niftyChangePct }
//   p    = latest price   prev = previous close   n = name

const fs = require('fs');
const path = require('path');

const LIVE_PRICES_PATH = path.join(__dirname, '..', 'docs', 'live-prices.json');

function loadLivePrices() {
  try {
    const d = JSON.parse(fs.readFileSync(LIVE_PRICES_PATH, 'utf8'));
    return { ts: d.ts || null, prices: d.prices || {}, niftyChangePct: d.niftyChangePct };
  } catch { return { ts: null, prices: {} }; }
}

// Latest price for a ticker, or null if the feed doesn't have it.
function livePriceOf(prices, ticker) {
  const e = prices && prices[String(ticker || '').toUpperCase()];
  return e && e.p != null ? e.p : null;
}

// Day change % vs previous close, or null.
function dayChangePct(prices, ticker) {
  const e = prices && prices[String(ticker || '').toUpperCase()];
  if (!e || e.p == null || !e.prev) return null;
  return +(((e.p - e.prev) / e.prev) * 100).toFixed(2);
}

module.exports = { loadLivePrices, livePriceOf, dayChangePct, LIVE_PRICES_PATH };

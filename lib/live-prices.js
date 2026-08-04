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

// Reconcile a fresh (live/Yahoo) price against a stable reference (sidecar/Tickertape).
// Small differences = normal intraday movement → take the fresh price. A large gap
// (default >30%) between two "current price" sources almost always means bad/misadjusted
// data (e.g. Yahoo missing a split/bonus, as happens for some SME stocks) → keep the
// stable reference instead of emitting an obviously-wrong number.
function reconcile(ref, live, tol = 0.30) {
  if (live == null) return ref == null ? null : ref;
  if (ref == null || !(ref > 0)) return live;
  if (Math.abs(live - ref) / ref > tol) return ref; // sources disagree wildly → distrust live
  return live;
}

// Overlay reconciled live prices onto an array of rows in place. Returns count changed.
function overlayLivePrices(rows, { key = 'ticker', priceKey = 'price', tol = 0.30 } = {}) {
  const { prices } = loadLivePrices();
  let n = 0;
  for (const r of (rows || [])) {
    if (!r) continue;
    const e = prices[String(r[key] || '').toUpperCase()];
    const live = e && e.p != null ? e.p : null;
    const rp = reconcile(r[priceKey], live, tol);
    if (rp != null && rp !== r[priceKey]) { r[priceKey] = rp; n++; }
  }
  return n;
}

// Build a ticker→price reference map from the Tickertape-sourced screener sidecars.
// Tickertape prices are on the correct corporate-action basis, so they're a reliable
// reference to reconcile the Yahoo live feed against (used by the email scripts, which
// don't otherwise have a sidecar price to compare with).
function loadSidecarPrices() {
  const files = ['creamy-tickers.json', 'apex-tickers.json', 'multibagger-tickers.json', 'indianresearch-tickers.json', 'screenerin-tickers.json'];
  const docs = path.join(__dirname, '..', 'docs');
  const map = {};
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(docs, f), 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.rows || raw.stocks || []);
      for (const r of arr) {
        const t = String(r.ticker || r.t || '').toUpperCase();
        if (t && r.price != null && map[t] == null) map[t] = r.price;
      }
    } catch { /* optional */ }
  }
  return map;
}

module.exports = { loadLivePrices, livePriceOf, dayChangePct, reconcile, overlayLivePrices, loadSidecarPrices, LIVE_PRICES_PATH };

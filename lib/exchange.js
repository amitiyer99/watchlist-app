'use strict';

// ── Exchange-aware ticker identity ────────────────────────────────────────────
// WHY THIS EXISTS: our fundamental source (Tickertape) covers BSE-listed companies
// as well as NSE ones — names like SHUKRAPHAR, VALIANT, GRAVITY, IFINSEC, ARYAMAN
// are already sitting in the creamy / india-research / multibagger / bestpicks
// sidecars. But every Yahoo call in this repo used to hardcode `TICKER + '.NS'`,
// which 404s for a BSE-only listing. The failures were SILENT and had real teeth:
//
//   • no daily bars  -> no RS rating, no 200-DMA, no breakout/VCP analysis
//   • no ADV20       -> the ₹2Cr/day liquidity floor was BYPASSED (the filters are
//                       written `adv20 == null || adv20 >= MIN` so an unpriceable
//                       stock sails through the very check meant to stop it)
//   • no live price  -> stale display prices
//   • alerts on those tickers could never fire
//
// Yahoo does serve BSE, but under the numeric scrip code with a `.BO` suffix
// (verified: 524632.BO, 532015.BO, 526775.BO all return data). So the fix is a
// ticker -> {exchange, yahooSymbol} map, resolved once and cached by
// fetch-exchange-map.js, and consulted by every Yahoo caller.

const fs = require('fs');
const path = require('path');

const MAP_PATH = path.join(__dirname, '..', 'docs', 'exchange-map.json');

let _cache = null;
function loadExchangeMap(force = false) {
  if (_cache && !force) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    _cache = raw && raw.tickers ? raw.tickers : {};
  } catch { _cache = {}; }
  return _cache;
}

const key = t => String(t || '').trim().toUpperCase();

// 'NSE' | 'BSE' | 'UNKNOWN' (unknown = not yet resolved by the mapper)
function exchangeOf(ticker, map) {
  const m = map || loadExchangeMap();
  const e = m[key(ticker)];
  return (e && e.exchange) || 'UNKNOWN';
}

// The symbol to hand Yahoo. NSE (and not-yet-resolved) => TICKER.NS, which keeps
// existing behaviour exactly; BSE => <scripCode>.BO.
function yahooSymbol(ticker, map) {
  const m = map || loadExchangeMap();
  const e = m[key(ticker)];
  if (e && e.yahooSymbol) return e.yahooSymbol;
  return key(ticker) + '.NS';
}

// True when this stock can be traded/alerted through the NSE-shaped parts of the
// app (order links, price alerts). BSE-only names are shown but not actionable here.
function isNse(ticker, map) {
  return exchangeOf(ticker, map) !== 'BSE';
}

// Known-illiquid check for names the mapper priced from .BO bars. Returns
// { adv20, illiquid } or nulls when we have no data.
function liquidityOf(ticker, minAdv20, map) {
  const m = map || loadExchangeMap();
  const e = m[key(ticker)];
  const adv20 = e && e.adv20 != null ? e.adv20 : null;
  return { adv20, illiquid: adv20 != null && minAdv20 != null ? adv20 < minAdv20 : null };
}

// Human label for the UI.
function exchangeBadge(ticker, map) {
  const ex = exchangeOf(ticker, map);
  return ex === 'BSE' ? 'BSE' : ex === 'NSE' ? 'NSE' : '';
}

module.exports = { loadExchangeMap, exchangeOf, yahooSymbol, isNse, liquidityOf, exchangeBadge, MAP_PATH };

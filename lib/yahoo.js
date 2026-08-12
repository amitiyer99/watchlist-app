'use strict';

// Single Yahoo Finance client factory.
//
// Previously each script instantiated `new YahooFinance({...})` with its
// own copy of the suppressNotices list (and inconsistent variable names —
// `yf` vs `yahooFinance`). Centralising gives one place to tune notice
// suppression, and later rate-limiting or retry policy, for every caller.
//
// Both notices are suppressed for everyone: 'yahooSurvey' always, and
// 'ripHistorical' — which only ever fires for callers of the deprecated
// .historical() API, so listing it is inert (not harmful) for quote-only
// callers. That makes this a behaviour-identical drop-in for both of the
// old variants (['yahooSurvey'] and ['yahooSurvey','ripHistorical']).
//
// Usage:
//   const { makeClient } = require('./lib/yahoo');
//   const yahooFinance = makeClient();

const YahooFinance = require('yahoo-finance2').default;

function makeClient() {
  return new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
}

// ── Daily history, via the endpoint that actually works ───────────────────────
// yahooFinance.historical() is DEPRECATED and returns nothing for many symbols — it was
// silently failing for 11 of 14 NSE sector indices, which is how the Sectors page lost
// most of its rows without a single error being logged. chart() is the current v8
// endpoint. This wraps it, reshapes the response to the same {date, open, high, low,
// close, adjclose, volume} rows historical() produced (so callers need no other change),
// and retries transient failures with backoff.
//
//   const { makeClient, history } = require('./lib/yahoo');
//   const rows = await history(client, 'TCS.NS', { period1, period2, interval: '1d' });
//
// Returns [] rather than throwing when the symbol genuinely has no data, so a missing
// ticker degrades to "no bars" instead of taking down a whole run — but DOES throw on a
// persistent transport error, so real breakage stays visible.
async function history(client, symbol, opts, extra, tries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const c = extra ? await client.chart(symbol, opts, extra) : await client.chart(symbol, opts);
      const rows = (c && Array.isArray(c.quotes)) ? c.quotes.filter(r => r && r.close != null) : [];
      if (rows.length) return rows;
      return [];                      // valid response, symbol simply has no bars
    } catch (e) {
      lastErr = e;
      if (attempt < tries - 1) await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr || new Error(`history(${symbol}) failed`);
}

module.exports = { makeClient, YahooFinance, history };

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

module.exports = { makeClient, YahooFinance };

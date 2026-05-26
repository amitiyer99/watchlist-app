'use strict';

const fs   = require('fs');
const path = require('path');

const EARNINGS_PATH = path.join(__dirname, '..', 'docs', 'earnings-calendar.json');

function loadEarnings() {
  try {
    if (!fs.existsSync(EARNINGS_PATH)) return null;
    return JSON.parse(fs.readFileSync(EARNINGS_PATH, 'utf8'));
  } catch { return null; }
}

function getEarnings(data, ticker) {
  if (!data || !data.stocks || !ticker) return null;
  return data.stocks[ticker] || null;
}

// Returns true when the ticker has an earnings announcement within `days` calendar days.
function earningsWithin(data, ticker, days = 7) {
  const e = getEarnings(data, ticker);
  if (!e || e.calDays == null) return false;
  return e.calDays >= 0 && e.calDays <= days;
}

module.exports = { loadEarnings, getEarnings, earningsWithin, EARNINGS_PATH };

'use strict';

const fs   = require('fs');
const path = require('path');

const DEALS_PATH = path.join(__dirname, '..', 'docs', 'deals.json');

// Null-safe read of docs/deals.json (written by fetch-nse-deals.js).
// Returns null when missing/unreadable, else { updatedAt, rows }.
function loadDeals() {
  try {
    if (!fs.existsSync(DEALS_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(DEALS_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.rows)) return null;
    return { updatedAt: raw.updatedAt || null, rows: raw.rows };
  } catch { return null; }
}

// Recent bulk/block deal rows for a ticker within the last `days` days.
function dealsFor(data, ticker, days = 30) {
  if (!data || !Array.isArray(data.rows) || !ticker) return [];
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  return data.rows.filter(r => r && r.symbol === ticker && r.date && r.date >= cutoff);
}

// True when any bulk/block deal BUY was disclosed for this ticker in the window —
// institutional money entered.
function hasRecentBulkBuy(data, ticker, days = 30) {
  return dealsFor(data, ticker, days).some(r => r.buySell === 'BUY');
}

module.exports = { loadDeals, dealsFor, hasRecentBulkBuy, DEALS_PATH };

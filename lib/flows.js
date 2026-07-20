'use strict';

// FII/DII flow layer.
//
// docs/fii-dii.json is produced by fetch-fii-dii.js from the NSE India API:
//   { updatedAt, rows: [ { date: 'YYYY-MM-DD', category: 'FII'|'DII',
//                          buyValue, sellValue, netValue } ] }   (₹ Cr)
//
// This module holds the pure signal logic plus a safe loader. Missing or
// malformed data degrades to nulls so consumers stay perfectly neutral.

const fs   = require('fs');
const path = require('path');

const FLOWS_PATH = path.join(__dirname, '..', 'docs', 'fii-dii.json');

function loadFlows() {
  try {
    if (!fs.existsSync(FLOWS_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.rows) || !raw.rows.length) return null;
    return raw;
  } catch { return null; }
}

// Sum net values over the last 5 / 20 distinct trading dates.
// Returns { fii5dNet, dii5dNet, fii20dNet, combined5dTrend, asOf } — all null /
// 'MIXED' when no usable data.
function flowSignal(data) {
  const d = data === undefined ? loadFlows() : data;
  if (!d || !Array.isArray(d.rows) || !d.rows.length) {
    return { fii5dNet: null, dii5dNet: null, fii20dNet: null, combined5dTrend: 'MIXED', asOf: null };
  }
  const dates = [...new Set(d.rows.map(r => r.date).filter(Boolean))].sort();
  const last5  = new Set(dates.slice(-5));
  const last20 = new Set(dates.slice(-20));
  let fii5 = 0, dii5 = 0, fii20 = 0, sawFii = false, sawDii = false;
  for (const r of d.rows) {
    const net = typeof r.netValue === 'number' ? r.netValue : parseFloat(r.netValue);
    if (!isFinite(net) || !r.date) continue;
    if (r.category === 'FII') {
      if (last5.has(r.date))  { fii5 += net; sawFii = true; }
      if (last20.has(r.date)) fii20 += net;
    } else if (r.category === 'DII') {
      if (last5.has(r.date))  { dii5 += net; sawDii = true; }
    }
  }
  const combined5dTrend =
    (sawFii && sawDii && fii5 > 0 && dii5 > 0) ? 'INFLOW'  :
    (sawFii && sawDii && fii5 < 0 && dii5 < 0) ? 'OUTFLOW' : 'MIXED';
  return {
    fii5dNet:  sawFii ? +fii5.toFixed(2)  : null,
    dii5dNet:  sawDii ? +dii5.toFixed(2)  : null,
    fii20dNet: sawFii ? +fii20.toFixed(2) : null,
    combined5dTrend,
    asOf: dates.length ? dates[dates.length - 1] : null,
  };
}

module.exports = { FLOWS_PATH, loadFlows, flowSignal };

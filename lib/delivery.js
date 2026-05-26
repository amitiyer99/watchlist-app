'use strict';

const fs   = require('fs');
const path = require('path');

const DELIVERY_PATH = path.join(__dirname, '..', 'docs', 'delivery.json');

function loadDelivery() {
  try {
    if (!fs.existsSync(DELIVERY_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(DELIVERY_PATH, 'utf8'));
    return raw && raw.stocks ? raw : null;
  } catch { return null; }
}

// Quick lookup helper — returns deliveryPct, deliverySurge boolean, surge multiplier, or nulls.
function getDelivery(data, ticker) {
  if (!data || !data.stocks || !ticker) return { deliveryPct: null, deliverySurge: false, deliverySurgeMult: null, avg20d: null };
  const s = data.stocks[ticker];
  if (!s || !s.latest) return { deliveryPct: null, deliverySurge: false, deliverySurgeMult: null, avg20d: null };
  return {
    deliveryPct: s.latest.deliveryPct,
    deliverySurge: !!s.deliverySurge,
    deliverySurgeMult: s.deliverySurgeMult,
    avg20d: s.avg20d,
    latestDate: s.latest.date,
  };
}

module.exports = { loadDelivery, getDelivery, DELIVERY_PATH };

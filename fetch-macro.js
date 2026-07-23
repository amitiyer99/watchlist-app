'use strict';

// Fetch macro / market-context series from free Yahoo feeds (no API keys) and
// write docs/macro.json. Breadth is computed locally from breakout2-data.json so
// we don't refetch the whole universe. Safe: on any failure it still writes a
// neutral snapshot so consumers never break.

const fs   = require('fs');
const path = require('path');
const { makeClient } = require('./lib/yahoo');
const yf = makeClient();

const { computeMacro, MACRO_PATH } = require('./lib/macro');

// Yahoo symbols for each macro series.
const SYMBOLS = {
  vix:    '^INDIAVIX',
  nifty:  '^NSEI',
  usdinr: 'INR=X',
  brent:  'BZ=F',
  gold:   'GC=F',
  dxy:    'DX-Y.NYB',
  us10y:  '^TNX',
};

async function fetchCloses(symbol) {
  const p2 = new Date();
  const p1 = new Date(Date.now() - 200 * 86400000); // ~200 calendar days
  try {
    const rows = await yf.historical(symbol, { period1: p1, period2: p2, interval: '1d' });
    if (!rows || !rows.length) return [];
    return rows.filter(r => r.close != null).sort((a, b) => new Date(a.date) - new Date(b.date)).map(r => r.close);
  } catch (e) {
    console.warn(`  macro fetch failed ${symbol}: ${e.message}`);
    return [];
  }
}

function computeBreadth() {
  try {
    const fp = path.join(__dirname, 'docs', 'breakout2-data.json');
    if (!fs.existsSync(fp)) return null;
    const rows = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!Array.isArray(rows) || !rows.length) return null;
    // breakout2 sidecar carries stage2 + 52w high/low (no SMA fields), so use
    // stage-2 participation and proximity-to-52w-high as breadth proxies.
    let n = 0, st = 0, nh = 0;
    for (const r of rows) {
      if (r.price == null) continue;
      n++;
      if (r.stage2) st++;
      if (r.high52 != null && r.price >= 0.75 * r.high52) nh++;
    }
    if (!n) return null;
    return { stage2Pct: +(st / n * 100).toFixed(1), nearHighPct: +(nh / n * 100).toFixed(1), universe: n };
  } catch { return null; }
}

async function main() {
  console.log('Fetching macro context...');
  const series = {};
  for (const [key, sym] of Object.entries(SYMBOLS)) {
    series[key] = await fetchCloses(sym);
    process.stdout.write(`  ${key}(${sym}): ${series[key].length} bars\n`);
    await new Promise(r => setTimeout(r, 150));
  }
  const breadth = computeBreadth();
  const macro = computeMacro(series, breadth);

  const payload = {
    asOf: new Date().toISOString(),
    ...macro,
    raw: Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.length ? +v[v.length - 1].toFixed(2) : null])),
  };
  if (!fs.existsSync(path.dirname(MACRO_PATH))) fs.mkdirSync(path.dirname(MACRO_PATH), { recursive: true });
  fs.writeFileSync(MACRO_PATH, JSON.stringify(payload, null, 2));
  console.log(`  Risk-On ${payload.riskOn}/100 (${payload.regime}) — ${payload.reasons.join(' · ')}`);
  console.log(`  Wrote ${MACRO_PATH}`);
}

if (require.main === module) {
  main().catch(e => { console.error('macro error:', e); process.exit(1); });
}
module.exports = { main };

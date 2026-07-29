'use strict';

// ── Screener.in ingest ──────────────────────────────────────────────────────
// Reads every CSV you've dropped into imports/screener/ — each file is treated
// as ONE Screener.in custom screen (the filename becomes the screen's name) —
// resolves company names to tickers, and merges them into a single sidecar:
//
//   docs/screenerin-tickers.json
//     { updatedAt, screens:[{name,count,unmatched}], rows:[ {
//         ticker, name, sector, price, marketCap, score,       // sidecar contract
//         screens:[names...],  // which of YOUR screens this stock appears in
//         metrics:{ roce, pe, salesGrowth, debtEquity, ... }   // merged fundamentals
//       } ] }
//
// `score` = a 0-100 fundamental-conviction proxy: appearing in more of your own
// hand-built quality screens is itself a signal, blended with a light quality
// nudge from ROCE/debt when present. Confluence & Sniper consume this sidecar.
//
// LOCAL step (like the FII/DII deal fetch): run it on your machine, commit the
// sidecar JSON, and CI rebuilds the pages from it.  Usage:  npm run ingest-screener

const fs   = require('fs');
const path = require('path');
const { buildResolver, ingestCsv } = require('./lib/screener-import');

const IMPORT_DIR = path.join(__dirname, 'imports', 'screener');
const OUT_PATH   = path.join(__dirname, 'docs', 'screenerin-tickers.json');

// Attach sector from whatever sidecar already knows it (Screener export has none).
function buildSectorMap() {
  const m = new Map();
  const docsDir = path.join(__dirname, 'docs');
  try {
    for (const f of fs.readdirSync(docsDir)) {
      if (!/-tickers\.json$|-data\.json$/.test(f)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(docsDir, f), 'utf8'));
        const arr = Array.isArray(raw) ? raw : (raw.rows || raw.stocks || raw.triggers || []);
        for (const r of arr) {
          const t = (r.ticker || r.t || '').toUpperCase();
          if (t && r.sector && !m.has(t)) m.set(t, r.sector);
        }
      } catch { /* skip */ }
    }
  } catch { /* none */ }
  return m;
}

// 0-100 fundamental score. Base rewards multi-screen overlap; small quality nudge.
function fundScore(nScreens, totalScreens, metrics) {
  const overlap = totalScreens > 0 ? (nScreens / totalScreens) : 0;
  let s = 40 + overlap * 45; // 1 screen → 40-ish, in all screens → 85
  if (metrics.roce != null)       s += Math.max(-5, Math.min(10, (metrics.roce - 15) / 3));
  if (metrics.debtEquity != null) s += metrics.debtEquity < 0.3 ? 4 : metrics.debtEquity > 1.5 ? -6 : 0;
  if (metrics.salesGrowth != null) s += Math.max(-4, Math.min(6, metrics.salesGrowth / 8));
  return Math.max(0, Math.min(100, Math.round(s)));
}

function main() {
  console.log('📊  Screener.in ingest');
  if (!fs.existsSync(IMPORT_DIR)) {
    fs.mkdirSync(IMPORT_DIR, { recursive: true });
    console.log(`  Created ${IMPORT_DIR} — drop your Screener.in CSV export(s) here and re-run.`);
    return;
  }
  const files = fs.readdirSync(IMPORT_DIR).filter(f => /\.csv$/i.test(f));
  if (!files.length) {
    console.log(`  No CSV files in ${IMPORT_DIR}. Export a screen from Screener.in as CSV and drop it here.`);
    if (fs.existsSync(OUT_PATH)) console.log('  Keeping existing sidecar unchanged.');
    return;
  }

  const resolver = buildResolver();
  const sectorMap = buildSectorMap();
  console.log(`  Universe: ${resolver.tickerSet.size} known tickers · ${files.length} screen file(s)`);

  const screens = [];
  const byTicker = new Map(); // ticker -> merged row
  for (const f of files) {
    const res = ingestCsv(path.join(IMPORT_DIR, f), resolver);
    screens.push({ name: res.screenName, count: res.rows.length, unmatched: res.unmatched.length });
    console.log(`  • "${res.screenName}": ${res.rows.length} matched, ${res.unmatched.length} unmatched${res.unmatched.length ? ' → ' + res.unmatched.slice(0, 6).join(', ') + (res.unmatched.length > 6 ? '…' : '') : ''}`);
    for (const r of res.rows) {
      let rec = byTicker.get(r.ticker);
      if (!rec) {
        rec = { ticker: r.ticker, name: r.name, sector: sectorMap.get(r.ticker) || '', price: r.price, marketCap: r.marketCap, screens: [], metrics: {} };
        byTicker.set(r.ticker, rec);
      }
      if (!rec.screens.includes(res.screenName)) rec.screens.push(res.screenName);
      if (r.price != null) rec.price = r.price;
      if (r.marketCap != null) rec.marketCap = r.marketCap;
      Object.assign(rec.metrics, r.metrics); // later screens can enrich metrics
    }
  }

  const totalScreens = screens.length;
  const rows = [...byTicker.values()].map(r => ({
    ticker: r.ticker,
    name: r.name,
    sector: r.sector,
    price: r.price ?? null,
    marketCap: r.marketCap ?? null,
    score: fundScore(r.screens.length, totalScreens, r.metrics),
    screens: r.screens,
    screenCount: r.screens.length,
    metrics: r.metrics,
    url: '',
  }));
  rows.sort((a, b) => (b.screenCount - a.screenCount) || (b.score - a.score));

  const payload = {
    updatedAt: new Date().toISOString(),
    source: 'screener.in',
    totalScreens,
    screens,
    rows,
  };
  if (!fs.existsSync(path.dirname(OUT_PATH))) fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  const multi = rows.filter(r => r.screenCount > 1).length;
  console.log(`\n  ✅  ${rows.length} unique stocks across ${totalScreens} screen(s) (${multi} in 2+ of your screens)`);
  console.log(`  Wrote ${OUT_PATH}`);
  console.log('  Next: commit docs/screenerin-tickers.json (or run ingest-screener.bat) — CI folds it into Confluence + Sniper.');
}

if (require.main === module) main();
module.exports = { main, fundScore };

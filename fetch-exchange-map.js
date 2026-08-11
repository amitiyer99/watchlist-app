'use strict';

// ── Exchange mapper ───────────────────────────────────────────────────────────
// Resolves every ticker in our sidecars to its real exchange + the symbol Yahoo
// actually knows it by, and caches the answer in docs/exchange-map.json.
//
// Method per unresolved ticker:
//   1. Probe `TICKER.NS`. If Yahoo returns bars -> NSE, done (the common case).
//   2. Otherwise it's likely BSE-only. Search Yahoo by company name, take the best
//      `.BO` match (Yahoo exposes BSE under the numeric scrip code) and verify it
//      returns bars. Record `<code>.BO`.
//   3. Still nothing -> record UNRESOLVED so we don't re-probe it every single run
//      (retried after RETRY_UNRESOLVED_DAYS in case of listing changes).
// For BSE names we also compute ADV20 (₹/day) from the .BO bars, so the SAME
// ₹2Cr/day liquidity floor that governs NSE names can finally be applied to them
// instead of being silently bypassed.
//
// Cheap and self-limiting: only unresolved tickers cost a request, so after the
// first pass this is nearly free. Run locally: npm run fetch-exchange-map

const fs   = require('fs');
const path = require('path');
const { makeClient } = require('./lib/yahoo');
const yf = makeClient();

const DOCS     = path.join(__dirname, 'docs');
const MAP_PATH = path.join(DOCS, 'exchange-map.json');
const MAX_RESOLVE = parseInt(process.env.MAX_RESOLVE || '250', 10);
const RETRY_UNRESOLVED_DAYS = 30;
const PACE_MS = 250;

function readJson(p, fb = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }

// Every ticker we care about, with a display name for the Yahoo name-search fallback.
function collectTickers() {
  const out = new Map(); // TICKER -> name
  const files = fs.existsSync(DOCS) ? fs.readdirSync(DOCS) : [];
  for (const f of files) {
    if (!/-tickers\.json$|^breakout2-data\.json$|^nse-tickers\.json$/.test(f)) continue;
    const raw = readJson(path.join(DOCS, f));
    const arr = Array.isArray(raw) ? raw : (raw && (raw.rows || raw.stocks)) || [];
    for (const r of arr) {
      const t = String(r.ticker || r.t || '').trim().toUpperCase();
      if (!t || /^\d+$/.test(t)) continue;
      const n = r.name || r.n || '';
      if (!out.has(t) || (!out.get(t) && n)) out.set(t, n);
    }
  }
  return out;
}

async function bars(sym) {
  try {
    const p1 = new Date(Date.now() - 45 * 864e5), p2 = new Date();
    const c = await yf.chart(sym, { period1: p1, period2: p2, interval: '1d' }, { fetchOptions: { signal: AbortSignal.timeout(15000) } });
    const q = (c && Array.isArray(c.quotes)) ? c.quotes.filter(r => r && r.close != null) : [];
    return q.length ? q : null;
  } catch { return null; }
}

const adv20Of = rows => {
  const tail = rows.slice(-20).filter(r => r.close != null && r.volume != null);
  if (!tail.length) return null;
  return Math.round(tail.reduce((a, r) => a + r.close * r.volume, 0) / tail.length);
};

async function findBse(name) {
  if (!name) return null;
  try {
    const res = await yf.search(name, { quotesCount: 10, newsCount: 0 }, { fetchOptions: { signal: AbortSignal.timeout(15000) } });
    const quotes = (res && res.quotes) || [];
    const bo = quotes.find(q => q.symbol && /\.BO$/i.test(q.symbol));
    return bo ? bo.symbol : null;
  } catch { return null; }
}

async function main() {
  console.log('🔀  Exchange mapper (NSE vs BSE ticker identity)');
  const prev = readJson(MAP_PATH, null);
  const tickers = prev && prev.tickers ? { ...prev.tickers } : {};
  const all = collectTickers();
  const today = new Date().toISOString().slice(0, 10);
  const staleBefore = new Date(Date.now() - RETRY_UNRESOLVED_DAYS * 864e5).toISOString().slice(0, 10);

  const todo = [];
  for (const [t, name] of all) {
    const e = tickers[t];
    if (!e) { todo.push([t, name]); continue; }
    if (e.exchange === 'UNRESOLVED' && (e.checkedAt || '0000') < staleBefore) todo.push([t, name]);
  }
  console.log(`  ${all.size} tickers known · ${todo.length} need resolving (cap ${MAX_RESOLVE} this run)`);
  if (!todo.length) { console.log('  Nothing to do — map is current.'); return; }

  let nse = 0, bse = 0, unresolved = 0;
  const slice = todo.slice(0, MAX_RESOLVE);
  for (let i = 0; i < slice.length; i++) {
    const [t, name] = slice[i];
    const nseRows = await bars(t + '.NS');
    if (nseRows) {
      tickers[t] = { exchange: 'NSE', yahooSymbol: t + '.NS', adv20: adv20Of(nseRows), name: name || undefined, checkedAt: today };
      nse++;
    } else {
      const boSym = await findBse(name || t);
      const boRows = boSym ? await bars(boSym) : null;
      if (boSym && boRows) {
        tickers[t] = { exchange: 'BSE', yahooSymbol: boSym, adv20: adv20Of(boRows), name: name || undefined, checkedAt: today };
        bse++;
        console.log(`    BSE: ${t} -> ${boSym}${tickers[t].adv20 != null ? ` (ADV20 ₹${(tickers[t].adv20 / 1e7).toFixed(2)}Cr)` : ''}`);
      } else {
        tickers[t] = { exchange: 'UNRESOLVED', yahooSymbol: null, adv20: null, name: name || undefined, checkedAt: today };
        unresolved++;
      }
    }
    await new Promise(r => setTimeout(r, PACE_MS));
    if ((i + 1) % 25 === 0) process.stdout.write(`    …${i + 1}/${slice.length} probed\r`);
  }

  const counts = Object.values(tickers).reduce((a, e) => { a[e.exchange] = (a[e.exchange] || 0) + 1; return a; }, {});
  const payload = { updatedAt: new Date().toISOString(), counts, tickers };
  if (!fs.existsSync(DOCS)) fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(MAP_PATH, JSON.stringify(payload, null, 2));
  console.log(`\n  This run: +${nse} NSE, +${bse} BSE, ${unresolved} unresolved`);
  console.log(`  Map totals: ${JSON.stringify(counts)}`);
  console.log(`  Wrote ${MAP_PATH}`);
  if (todo.length > slice.length) console.log(`  ${todo.length - slice.length} still pending — re-run to continue (or raise MAX_RESOLVE).`);
}

if (require.main === module) {
  main().catch(e => { console.warn(`  WARNING: exchange mapping failed (${e.message}). Keeping old map.`); process.exit(0); });
}
module.exports = { main, collectTickers };

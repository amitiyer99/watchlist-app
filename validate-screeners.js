'use strict';

// Validate every entry in screener-outcomes.json against forward returns at
// 5 / 20 / 60 trading days, compute alpha vs Nifty, persist enriched rows back
// to the same file, and aggregate per-screener stats into docs/screener-stats.json.
//
// Idempotent: only fills in result snapshots that don't already exist and have
// matured (the snapshot horizon has passed).

const fs   = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const OUTCOMES_PATH = path.join(__dirname, 'screener-outcomes.json');
const STATS_PATH    = path.join(__dirname, 'docs', 'screener-stats.json');
const BENCH         = '^NSEI';
const HORIZONS      = [5, 20, 60];

function tradingDaysBetween(from, to) {
  let cnt = 0;
  const d = new Date(from);
  while (d < to) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() >= 1 && d.getDay() <= 5) cnt++;
  }
  return cnt;
}
function addTradingDays(from, n) {
  const d = new Date(from);
  let cnt = 0;
  while (cnt < n) { d.setDate(d.getDate() + 1); if (d.getDay() >= 1 && d.getDay() <= 5) cnt++; }
  return d;
}
function medianVal(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function num(v) { return typeof v === 'number' && !isNaN(v) ? v : null; }

async function fetchBars(ticker, fromDate) {
  // Pull 30 calendar days beyond the longest horizon so weekends don't truncate
  const p1 = new Date(fromDate.getTime() - 5 * 86400000);
  const p2 = new Date(Date.now() - 86400000);
  try {
    const rows = await yf.historical(ticker, { period1: p1, period2: p2, interval: '1d' });
    if (!rows || !rows.length) return null;
    return rows.filter(r => r.close != null).sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (e) {
    console.warn(`  history failed ${ticker}: ${e.message}`);
    return null;
  }
}

function priceOnOrAfter(bars, target) {
  for (const b of bars) {
    if (new Date(b.date) >= target) return { date: new Date(b.date).toISOString().slice(0, 10), close: b.close };
  }
  return null;
}

function priceAtOrBefore(bars, target) {
  let last = null;
  for (const b of bars) {
    if (new Date(b.date) <= target) last = b;
    else break;
  }
  return last ? { date: new Date(last.date).toISOString().slice(0, 10), close: last.close } : null;
}

async function main() {
  console.log('Validating screener outcomes...');
  if (!fs.existsSync(OUTCOMES_PATH)) { console.log('  No outcomes file yet — nothing to validate.'); return; }
  const data = JSON.parse(fs.readFileSync(OUTCOMES_PATH, 'utf8'));
  if (!data.rows || !data.rows.length) { console.log('  Outcomes file empty — nothing to validate.'); return; }
  console.log(`  ${data.rows.length} outcome rows`);

  const today = new Date();
  // Group rows by ticker so we minimize fetches; also figure earliest entry date per ticker.
  const byTicker = new Map();
  for (const row of data.rows) {
    if (!row.ticker) continue;
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
    byTicker.get(row.ticker).push(row);
  }

  // Filter to rows that need any horizon update
  const tickersNeeded = [];
  for (const [ticker, rows] of byTicker.entries()) {
    const needsUpdate = rows.some(r => {
      r.results = r.results || {};
      r.matured = r.matured || {};
      const entryDate = new Date(r.date);
      return HORIZONS.some(h => {
        const matureDate = addTradingDays(entryDate, h);
        return matureDate <= today && !r.results[h + 'd'];
      });
    });
    if (needsUpdate) tickersNeeded.push(ticker);
  }
  console.log(`  ${tickersNeeded.length} tickers need history fetch (${byTicker.size - tickersNeeded.length} fully validated already)`);
  if (!tickersNeeded.length) {
    writeStats(data);
    return;
  }

  // Fetch Nifty bars first (single fetch covering all entry dates)
  console.log(`  Fetching ${BENCH}...`);
  const earliestEntry = tickersNeeded
    .flatMap(t => byTicker.get(t))
    .reduce((acc, r) => { const d = new Date(r.date); return acc == null || d < acc ? d : acc; }, null);
  const niftyBars = await fetchBars(BENCH, earliestEntry || new Date(Date.now() - 365 * 86400000));
  if (!niftyBars) { console.warn('  Nifty fetch failed — alpha will be null.'); }

  // Now validate per ticker
  let validated = 0;
  for (let i = 0; i < tickersNeeded.length; i++) {
    const ticker = tickersNeeded[i];
    const rows = byTicker.get(ticker);
    const earliest = rows.reduce((acc, r) => { const d = new Date(r.date); return acc == null || d < acc ? d : acc; }, null);
    const bars = await fetchBars(ticker + '.NS', earliest);
    if (!bars) { continue; }
    for (const r of rows) {
      r.results = r.results || {};
      r.matured = r.matured || {};
      const entryDate = new Date(r.date);
      const entryBar = priceOnOrAfter(bars, entryDate) || priceAtOrBefore(bars, entryDate);
      const realEntry = entryBar ? entryBar.close : num(r.entry);
      if (realEntry == null) continue;
      const niftyEntryBar = niftyBars ? (priceOnOrAfter(niftyBars, entryDate) || priceAtOrBefore(niftyBars, entryDate)) : null;
      const niftyEntry = niftyEntryBar ? niftyEntryBar.close : null;

      for (const h of HORIZONS) {
        const key = h + 'd';
        if (r.results[key]) continue;
        const matureDate = addTradingDays(entryDate, h);
        if (matureDate > today) { r.matured[key] = false; continue; }
        const fwdBar = priceOnOrAfter(bars, matureDate);
        if (!fwdBar) continue;
        const fwdRet = +((fwdBar.close / realEntry - 1) * 100).toFixed(2);
        let niftyRet = null, alpha = null;
        if (niftyEntry && niftyBars) {
          const niftyFwd = priceOnOrAfter(niftyBars, matureDate);
          if (niftyFwd) {
            niftyRet = +((niftyFwd.close / niftyEntry - 1) * 100).toFixed(2);
            alpha = +(fwdRet - niftyRet).toFixed(2);
          }
        }
        let rMultiple = null;
        if (num(r.entry) != null && num(r.stop) != null && r.entry > r.stop) {
          const risk = r.entry - r.stop;
          rMultiple = +((fwdBar.close - r.entry) / risk).toFixed(2);
        }
        r.results[key] = {
          date: fwdBar.date,
          close: fwdBar.close,
          fwdRet, niftyRet, alpha, rMultiple,
          win: fwdRet > 0,
          beatNifty: alpha != null ? alpha > 0 : null,
        };
        r.matured[key] = true;
        validated++;
      }
    }
    if ((i + 1) % 10 === 0) process.stdout.write(`  validated ${i + 1}/${tickersNeeded.length}\r`);
    // gentle pacing
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`\n  Filled ${validated} horizon snapshots.`);

  data.lastValidatedAt = new Date().toISOString();
  fs.writeFileSync(OUTCOMES_PATH, JSON.stringify(data, null, 2));
  writeStats(data);
}

function writeStats(data) {
  // Aggregate per (screener, signalType, horizon)
  const buckets = new Map();
  for (const r of data.rows) {
    if (!r.results) continue;
    for (const h of HORIZONS) {
      const res = r.results[h + 'd'];
      if (!res) continue;
      const keys = [
        `${r.screener}|*|${h}d`,
        `${r.screener}|${r.signalType}|${h}d`,
      ];
      for (const key of keys) {
        if (!buckets.has(key)) buckets.set(key, { rets: [], alphas: [], rs: [], wins: 0, beats: 0, count: 0 });
        const b = buckets.get(key);
        b.rets.push(res.fwdRet);
        if (res.alpha != null) b.alphas.push(res.alpha);
        if (res.rMultiple != null) b.rs.push(res.rMultiple);
        if (res.win) b.wins++;
        if (res.beatNifty) b.beats++;
        b.count++;
      }
    }
  }

  const stats = [];
  for (const [key, b] of buckets.entries()) {
    const [screener, signalType, horizon] = key.split('|');
    stats.push({
      screener,
      signalType,
      horizon,
      count: b.count,
      hitRate: b.count ? +((b.wins / b.count) * 100).toFixed(1) : null,
      beatNiftyRate: b.alphas.length ? +((b.beats / b.alphas.length) * 100).toFixed(1) : null,
      medianRet: medianVal(b.rets) != null ? +medianVal(b.rets).toFixed(2) : null,
      medianAlpha: medianVal(b.alphas) != null ? +medianVal(b.alphas).toFixed(2) : null,
      medianR: medianVal(b.rs) != null ? +medianVal(b.rs).toFixed(2) : null,
    });
  }
  stats.sort((a, b) => {
    if (a.screener !== b.screener) return a.screener.localeCompare(b.screener);
    if (a.signalType !== b.signalType) return a.signalType.localeCompare(b.signalType);
    return parseInt(a.horizon) - parseInt(b.horizon);
  });

  // Per-screener "best/worst" summary using 20d horizon (the workhorse comparison)
  const summary = {};
  for (const s of stats) {
    if (s.signalType !== '*' || s.horizon !== '20d') continue;
    summary[s.screener] = {
      count: s.count,
      hitRate20d: s.hitRate,
      medianAlpha20d: s.medianAlpha,
      medianRet20d: s.medianRet,
      flag: s.medianAlpha != null && s.medianAlpha < -2 ? 'DEMOTE'
            : s.medianAlpha != null && s.medianAlpha > 2 ? 'PROMOTE'
            : 'NEUTRAL',
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    totalOutcomes: data.rows.length,
    summary,
    stats,
  };
  if (!fs.existsSync(path.dirname(STATS_PATH))) fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(out, null, 2));
  console.log(`  Wrote ${STATS_PATH} (${stats.length} buckets, ${Object.keys(summary).length} screener summaries)`);
}

if (require.main === module) {
  main().catch(e => { console.error('Error:', e); process.exit(1); });
}
module.exports = { main };

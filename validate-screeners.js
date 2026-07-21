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
    const rows = await yf.historical(ticker, { period1: p1, period2: p2, interval: '1d' }, { fetchOptions: { signal: AbortSignal.timeout(15000) } });
    if (!rows || !rows.length) return null;
    // Use adjClose when available: a bonus/split inside the horizon otherwise
    // produces a wildly wrong forward return for that row.
    return rows
      .filter(r => (r.adjClose ?? r.close) != null)
      .map(r => ({ ...r, close: r.adjClose ?? r.close }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (e) {
    console.warn(`  history failed ${ticker}: ${e.message}`);
    return null;
  }
}

// Conservative imputation for tickers whose history has permanently disappeared
// (delisted / suspended / renamed after a crash — precisely the worst outcomes).
// Silently skipping them censors the left tail and biases every measured alpha up.
const CENSOR_AFTER_FAILURES = 5;
const CENSOR_IMPUTED_RET = -25; // conservative loss assumption for vanished tickers

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
  data.fetchFailures = data.fetchFailures || {};
  for (let i = 0; i < tickersNeeded.length; i++) {
    const ticker = tickersNeeded[i];
    const rows = byTicker.get(ticker);
    const earliest = rows.reduce((acc, r) => { const d = new Date(r.date); return acc == null || d < acc ? d : acc; }, null);
    const bars = await fetchBars(ticker + '.NS', earliest);
    if (!bars) {
      // Survivorship guard: after N consecutive failed runs, impute a conservative
      // loss on matured horizons instead of silently dropping the ticker forever.
      data.fetchFailures[ticker] = (data.fetchFailures[ticker] || 0) + 1;
      if (data.fetchFailures[ticker] >= CENSOR_AFTER_FAILURES) {
        for (const r of rows) {
          r.results = r.results || {}; r.matured = r.matured || {};
          const entryDate = new Date(r.date);
          for (const h of HORIZONS) {
            const key = h + 'd';
            if (r.results[key]) continue;
            if (addTradingDays(entryDate, h) > today) continue;
            r.results[key] = {
              date: null, close: null,
              fwdRet: CENSOR_IMPUTED_RET, niftyRet: null, alpha: CENSOR_IMPUTED_RET,
              rMultiple: null, win: false, beatNifty: false, censored: true,
            };
            r.matured[key] = true;
            validated++;
          }
        }
      }
      continue;
    }
    delete data.fetchFailures[ticker]; // recovered — reset the counter
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
        // rMultiple must be computed on the SAME price basis as fwdBar.close, which
        // is adjClose (see fetchBars). r.entry/r.stop were recorded raw at signal
        // time — if a split/bonus occurred between then and now, mixing them with
        // an adjClose forward price silently produces a wildly wrong R-multiple.
        // Rescale both by the cumulative adjustment factor (realEntry/r.entry,
        // which is 1.0 when nothing has happened) before computing risk/reward.
        let rMultiple = null;
        if (num(r.entry) != null && num(r.stop) != null && r.entry > r.stop && r.entry > 0) {
          const adjFactor = realEntry / r.entry;
          const adjStop = r.stop * adjFactor;
          const risk = realEntry - adjStop;
          if (risk > 0) rMultiple = +((fwdBar.close - realEntry) / risk).toFixed(2);
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

// Select non-overlapping episodes per (screener, signalType, ticker, horizon):
// a stock re-emitted daily creates rows whose forward windows overlap ~95% — they
// are nearly the same observation, so counting them all wildly inflates n (the
// old stats reported n≈1000 from ~22 days of one regime). Keep only the first
// row per ticker-episode, where a new episode starts once the previous window
// has fully matured.
function selectNonOverlapping(rows, horizonDays) {
  const sorted = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
  const out = [];
  let nextOk = null;
  for (const r of sorted) {
    const d = new Date(r.date);
    if (nextOk == null || d >= nextOk) {
      out.push(r);
      nextOk = addTradingDays(d, horizonDays);
    }
  }
  return out;
}

function writeStats(data) {
  // Group rows by (screener|signalType|ticker) so we can dedupe overlapping episodes
  const groups = new Map();
  for (const r of data.rows) {
    if (!r.results || !r.ticker) continue;
    for (const sig of ['*', r.signalType]) {
      const gk = `${r.screener}|${sig}|${r.ticker}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(r);
    }
  }

  // Aggregate per (screener, signalType, horizon) over non-overlapping episodes only
  const buckets = new Map();
  for (const [gk, rows] of groups.entries()) {
    const [screener, signalType] = gk.split('|');
    for (const h of HORIZONS) {
      const key = `${screener}|${signalType}|${h}d`;
      const episodes = selectNonOverlapping(rows.filter(r => r.results[h + 'd']), h);
      if (!episodes.length) continue;
      if (!buckets.has(key)) buckets.set(key, { rets: [], alphas: [], rs: [], wins: 0, beats: 0, count: 0, rawCount: 0, dates: new Set(), censored: 0 });
      const b = buckets.get(key);
      b.rawCount += rows.filter(r => r.results[h + 'd']).length;
      for (const r of episodes) {
        const res = r.results[h + 'd'];
        b.rets.push(res.fwdRet);
        if (res.alpha != null) b.alphas.push(res.alpha);
        if (res.rMultiple != null) b.rs.push(res.rMultiple);
        if (res.win) b.wins++;
        if (res.beatNifty) b.beats++;
        if (res.censored) b.censored++;
        b.count++;
        b.dates.add(r.date);
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
      count: b.count,              // non-overlapping episodes (the honest n)
      rawCount: b.rawCount,        // total rows incl. daily re-emissions (for reference)
      entryDates: b.dates.size,    // distinct entry dates — cross-sectional clustering unit
      censored: b.censored,        // imputed delisted/vanished tickers included above
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
    // Require enough distinct entry dates before flagging: 22 days of one regime
    // is not evidence, however many rows it produced.
    const enoughDates = s.entryDates >= 15;
    summary[s.screener] = {
      count: s.count,
      entryDates: s.entryDates,
      hitRate20d: s.hitRate,
      medianAlpha20d: s.medianAlpha,
      medianRet20d: s.medianRet,
      flag: !enoughDates ? 'INSUFFICIENT'
            : s.medianAlpha != null && s.medianAlpha < -2 ? 'DEMOTE'
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
module.exports = { main, writeStats };

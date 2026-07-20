'use strict';

// Historical training-dataset builder (Stage 1 of the ML roadmap — see IMPROVEMENTS.md).
//
// For every stock in the breakout2 universe, walks ~8 years of daily bars and
// takes a POINT-IN-TIME feature snapshot every 5 trading days (weekly), using
// only data up to the snapshot date. Labels each snapshot with the realized
// forward 20d / 60d return and alpha vs ^NSEI. Output feeds a future
// gradient-boosted model that will be compared against the current linear
// weights strictly out-of-sample before anything goes live.
//
// Usage:  node build-dataset.js [--max 800] [--years 8]
// Output: dataset.jsonl            (one row per ticker×date — gitignored, large)
//         docs/dataset-summary.json (small committed summary + readiness stats)
//
// Bars are cached in .dataset-cache/<ticker>.json so reruns are cheap.

const fs   = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const UNIVERSE_PATH = path.join(__dirname, 'docs', 'breakout2-data.json');
const CACHE_DIR     = path.join(__dirname, '.dataset-cache');
const OUT_PATH      = path.join(__dirname, 'dataset.jsonl');
const SUMMARY_PATH  = path.join(__dirname, 'docs', 'dataset-summary.json');
const BENCH         = '^NSEI';

const DEFAULT_YEARS = 8;
const SAMPLE_EVERY  = 5;     // trading days between snapshots
const WARMUP        = 260;   // bars needed before first snapshot
const FWD_SHORT     = 20;    // primary label horizon (trading days)
const FWD_LONG      = 60;
const BATCH_SIZE    = 5;
const BATCH_PAUSE   = 300;

function parseArgs(argv) {
  const a = { max: 800, years: DEFAULT_YEARS };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--max' && argv[i + 1]) a.max = parseInt(argv[++i], 10) || a.max;
    if (argv[i] === '--years' && argv[i + 1]) a.years = parseInt(argv[++i], 10) || a.years;
  }
  return a;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function cachePath(t) { return path.join(CACHE_DIR, `${t.replace(/[^A-Za-z0-9_-]/g, '_')}.json`); }

async function loadBars(symbol, years) {
  const cp = cachePath(symbol);
  try {
    if (fs.existsSync(cp)) {
      const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
      if (c && Array.isArray(c.bars) && c.years >= years) return c.bars;
    }
  } catch { /* refetch */ }
  const p2 = new Date();
  const p1 = new Date(Date.now() - Math.round(years * 365.25 + 60) * 86400000);
  let rows;
  try { rows = await yf.historical(symbol, { period1: p1, period2: p2, interval: '1d' }); }
  catch (e) { console.warn(`  history failed ${symbol}: ${e.message}`); return null; }
  if (!rows || !rows.length) return null;
  // adjClose-consistent OHLCV (splits/bonuses must not fabricate signals)
  const bars = rows
    .filter(r => r.close != null && r.high != null && r.low != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(r => {
      const f = (r.adjClose != null && r.close) ? r.adjClose / r.close : 1;
      return {
        date: new Date(r.date).toISOString().slice(0, 10),
        open: (r.open != null ? r.open : r.close) * f,
        high: r.high * f, low: r.low * f,
        close: r.adjClose != null ? r.adjClose : r.close,
        volume: r.volume != null ? r.volume : 0,
      };
    });
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ symbol, years, fetchedAt: new Date().toISOString(), bars }));
  } catch { /* non-fatal */ }
  return bars;
}

// ---- indicators (all computed from bars[0..i] only — no look-ahead) ----
function prefixSum(vals) {
  const p = new Array(vals.length + 1).fill(0);
  for (let i = 0; i < vals.length; i++) p[i + 1] = p[i] + vals[i];
  return p;
}
const smaAt = (pre, i, n) => (i + 1 >= n) ? (pre[i + 1] - pre[i + 1 - n]) / n : null;

function wilderAtrArr(bars, n) {
  const atr = new Array(bars.length).fill(null);
  if (bars.length <= n) return atr;
  const tr = i => Math.max(bars[i].high - bars[i].low,
    Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  let s = 0;
  for (let i = 1; i <= n; i++) s += tr(i);
  atr[n] = s / n;
  for (let i = n + 1; i < bars.length; i++) atr[i] = (atr[i - 1] * (n - 1) + tr(i)) / n;
  return atr;
}
function ret(closes, i, span, skip = 0) {
  const a = closes[i - skip], b = closes[i - skip - span];
  return (a != null && b > 0) ? (a / b - 1) * 100 : null;
}
function maxHigh(bars, from, to) { // inclusive range
  let h = -Infinity;
  for (let j = Math.max(0, from); j <= to; j++) if (bars[j].high > h) h = bars[j].high;
  return h === -Infinity ? null : h;
}
function minLow(bars, from, to) {
  let l = Infinity;
  for (let j = Math.max(0, from); j <= to; j++) if (bars[j].low < l) l = bars[j].low;
  return l === Infinity ? null : l;
}

// Snapshot the feature vector at bar index i (point-in-time).
function snapshot(bars, i, ctx) {
  const { preClose, preVol, preTV, atr } = ctx;
  const closes = ctx.closes;
  const c = closes[i];
  if (c == null || c <= 0) return null;

  const s50 = smaAt(preClose, i, 50), s150 = smaAt(preClose, i, 150), s200 = smaAt(preClose, i, 200);
  const s200p = i >= 220 ? smaAt(preClose, i - 20, 200) : null;
  const hi252 = maxHigh(bars, i - 251, i);
  const lo252 = minLow(bars, i - 251, i);
  const vol5 = smaAt(preVol, i, 5), vol50 = smaAt(preVol, i, 50);
  const adv20 = smaAt(preTV, i, 20);
  const a14 = atr[i];

  // VCP-ish structure: depths of three 20-bar windows ending at i
  const dd = (from, to) => {
    const h = maxHigh(bars, from, to), l = minLow(bars, from, to);
    return (h && h > 0) ? (h - l) / h : null;
  };
  const d1 = i >= 59 ? dd(i - 59, i - 40) : null;
  const d2 = i >= 39 ? dd(i - 39, i - 20) : null;
  const d3 = i >= 19 ? dd(i - 19, i) : null;
  const contracting = (d1 != null && d2 != null && d3 != null && d1 > d2 && d2 > d3) ? 1 : 0;

  const pivot30 = i >= 31 ? maxHigh(bars, i - 30, i - 1) : null;

  return {
    // momentum
    ret21: ret(closes, i, 21), ret63: ret(closes, i, 63),
    ret126: ret(closes, i, 126), ret126_21: i > 148 ? ret(closes, i, 126, 21) : null,
    ret252_21: i > 274 ? ret(closes, i, 231, 21) : null,
    hi252prox: hi252 ? +(c / hi252).toFixed(4) : null,
    lo252dist: lo252 ? +((c / lo252) - 1).toFixed(4) : null,
    // trend
    trendStack: (s50 && s150 && s200)
      ? (c > s50 ? 1 : 0) + (s50 > s150 ? 1 : 0) + (s150 > s200 ? 1 : 0) + (c > s200 ? 1 : 0) : null,
    distSma200: s200 ? +((c / s200 - 1) * 100).toFixed(2) : null,
    sma200Rising: (s200 != null && s200p != null) ? (s200 > s200p ? 1 : 0) : null,
    // volatility / structure
    atrPct: (a14 != null) ? +((a14 / c) * 100).toFixed(2) : null,
    volDryRatio: (vol5 != null && vol50 > 0) ? +(vol5 / vol50).toFixed(3) : null,
    contracting,
    lastLegDepth: d3 != null ? +d3.toFixed(4) : null,
    pctBelowPivot30: pivot30 ? +(((pivot30 - c) / pivot30) * 100).toFixed(2) : null,
    // liquidity
    advCr: adv20 != null ? +(adv20 / 1e7).toFixed(2) : null, // ₹ Cr/day
  };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Building dataset: max ${args.max} tickers, ${args.years}y history, snapshot every ${SAMPLE_EVERY} bars`);

  let universe = [];
  try {
    universe = [...new Set(JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8')).map(r => r.ticker).filter(Boolean))];
  } catch (e) { console.error(`Cannot read ${UNIVERSE_PATH}: ${e.message}`); process.exit(1); }
  universe = universe.slice(0, args.max);

  console.log('Fetching benchmark ' + BENCH + '...');
  const bench = await loadBars(BENCH, args.years);
  if (!bench) { console.error('Benchmark fetch failed — cannot label alpha.'); process.exit(1); }
  const benchIdx = new Map(bench.map((b, i) => [b.date, i]));
  const benchCloses = bench.map(b => b.close);

  const out = fs.createWriteStream(OUT_PATH, { flags: 'w' });
  let rowCount = 0, tickerOk = 0, tickerFail = 0;
  let minDate = null, maxDate = null;
  const byDateCounts = new Map();

  for (let bi = 0; bi < universe.length; bi += BATCH_SIZE) {
    const chunk = universe.slice(bi, bi + BATCH_SIZE);
    const results = await Promise.all(chunk.map(t => loadBars(t + '.NS', args.years)));
    for (let k = 0; k < chunk.length; k++) {
      const ticker = chunk[k], bars = results[k];
      if (!bars || bars.length < WARMUP + FWD_SHORT + 5) { tickerFail++; continue; }
      tickerOk++;
      const closes = bars.map(b => b.close);
      const ctx = {
        closes,
        preClose: prefixSum(closes),
        preVol: prefixSum(bars.map(b => b.volume)),
        preTV: prefixSum(bars.map(b => b.volume * b.close)),
        atr: wilderAtrArr(bars, 14),
      };
      for (let i = WARMUP; i < bars.length - FWD_SHORT; i += SAMPLE_EVERY) {
        const feat = snapshot(bars, i, ctx);
        if (!feat) continue;
        const date = bars[i].date;
        // labels
        const fwd20 = (closes[i + FWD_SHORT] / closes[i] - 1) * 100;
        const fwd60 = (i + FWD_LONG < bars.length) ? (closes[i + FWD_LONG] / closes[i] - 1) * 100 : null;
        // benchmark alpha (align by date; skip if bench misses the date)
        const bIdx = benchIdx.get(date);
        let alpha20 = null, alpha60 = null;
        if (bIdx != null && bIdx + FWD_SHORT < benchCloses.length) {
          alpha20 = fwd20 - (benchCloses[bIdx + FWD_SHORT] / benchCloses[bIdx] - 1) * 100;
          if (fwd60 != null && bIdx + FWD_LONG < benchCloses.length) {
            alpha60 = fwd60 - (benchCloses[bIdx + FWD_LONG] / benchCloses[bIdx] - 1) * 100;
          }
        }
        out.write(JSON.stringify({
          ticker, date, ...feat,
          fwd20: +fwd20.toFixed(2), alpha20: alpha20 != null ? +alpha20.toFixed(2) : null,
          fwd60: fwd60 != null ? +fwd60.toFixed(2) : null, alpha60: alpha60 != null ? +alpha60.toFixed(2) : null,
        }) + '\n');
        rowCount++;
        if (minDate == null || date < minDate) minDate = date;
        if (maxDate == null || date > maxDate) maxDate = date;
        byDateCounts.set(date, (byDateCounts.get(date) || 0) + 1);
      }
    }
    process.stdout.write(`  ${Math.min(bi + BATCH_SIZE, universe.length)}/${universe.length} tickers (${rowCount} rows)\r`);
    await sleep(BATCH_PAUSE);
  }
  await new Promise(r => out.end(r));

  const summary = {
    generatedAt: new Date().toISOString(),
    tickersRequested: universe.length, tickersOk: tickerOk, tickersFailed: tickerFail,
    rows: rowCount, distinctDates: byDateCounts.size,
    dateRange: { from: minDate, to: maxDate },
    horizons: { short: FWD_SHORT, long: FWD_LONG }, sampleEveryBars: SAMPLE_EVERY,
    file: path.basename(OUT_PATH),
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log(`\nDataset: ${rowCount} rows, ${byDateCounts.size} distinct dates, ${tickerOk} tickers (${tickerFail} failed)`);
  console.log(`Wrote ${OUT_PATH} and ${SUMMARY_PATH}`);
}

if (require.main === module) {
  main().catch(e => { console.error('build-dataset error:', e); process.exit(1); });
}
module.exports = { snapshot };

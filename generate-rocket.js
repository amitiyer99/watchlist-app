'use strict';

const { HUB_BACK_LINK } = require('./lib/hub-nav');

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { makeClient } = require('./lib/yahoo');
const yahooFinance = makeClient();
const { fmtPrice, esc } = require('./lib/format');
const alertSystem  = require('./alert-system');
const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');

const OUTPUT_PATH      = path.join(__dirname, 'docs', 'rocket.html');
const SIDECAR_PATH     = path.join(__dirname, 'docs', 'rocket-tickers.json');
const BREAKOUT2_PATH   = path.join(__dirname, 'docs', 'breakout2-data.json');
const WATCHLIST_PATH   = path.join(__dirname, 'my-watchlists.json');
const BATCH_SIZE       = 15;
const HISTORY_DAYS     = 370;
const SCREENER_CAP     = 1000;
const MCAP_MIN         = 200;   // Crores
const MCAP_MAX         = 5000;  // Crores
const PRICE_MIN        = 20;    // ₹
const SCORE_MIN        = 40;
// Liquidity floor: min 20-day average daily traded value (volume × close), in ₹.
// Paper edge on illiquid small caps is fake; impact cost exceeds the modeled edge.
const ADV20_MIN        = 2e7;   // ₹2 Cr/day

// ── API helpers ────────────────────────────────────────────────────────────────

function apiPostOnce(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 15000,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.tickertape.in', 'Referer': 'https://www.tickertape.in/',
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse error')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(data);
  });
}
async function apiPost(url, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await apiPostOnce(url, body); }
    catch (e) { if (i === retries - 1) throw e; await sleep(2000 * (i + 1)); }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sma(closes, n) { const s = closes.slice(-n); return s.length < n ? null : avg(s); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n, dec = 2) { if (n == null || isNaN(n)) return '—'; return Number(n).toFixed(dec); }
function fmtCr(n) { if (n == null) return '—'; if (n >= 100000) return (n / 100000).toFixed(1) + 'L'; if (n >= 1000) return (n / 1000).toFixed(1) + 'K'; return Math.round(n) + ''; }

// ── Load watchlist tickers ─────────────────────────────────────────────────────

function loadWatchlistTickers() {
  if (!fs.existsSync(WATCHLIST_PATH)) return new Set();
  const watchlists = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
  const tickers = new Set();
  for (const wl of watchlists) {
    for (const period of Object.values(wl.periods || {})) {
      for (const s of (period.stocks || [])) {
        const ticker = (s.name || '').split('\n')[1]?.trim();
        if (ticker) tickers.add(ticker);
      }
    }
  }
  return tickers;
}

// ── Fetch screener universe from Tickertape (MCap 200–5000 Cr) ────────────────

async function fetchScreenerUniverse() {
  const fields = [
    'ticker', 'name', 'sector', 'mrktCapf', 'lastPrice',
    '52wpct', '26wpct', '4wpct',
    'roe', 'pftMrg', 'aopm', 'rvng', 'epsg', 'ebitg',
    'apef', 'evebitd', 'epsGwth', '5YrevChg',
    'dbtEqt', 'aint', 'cafFcf',
    'strown', 'strown3', 'instown3', 'forInstHldng3M',
    'pab12Mma', '52whd',
  ];
  const allStocks = [];
  let offset = 0, total = Infinity;
  while (offset < total && allStocks.length < SCREENER_CAP) {
    const toFetch = Math.min(500, SCREENER_CAP - allStocks.length);
    const body = {
      match: { mrktCapf: { gte: MCAP_MIN, lte: MCAP_MAX } },
      sortBy: 'mrktCapf', sortOrder: -1,
      project: fields, offset, count: toFetch,
    };
    try {
      const r = await apiPost('https://api.tickertape.in/screener/query', body);
      if (!r.success) { console.log('  Screener returned success:false'); break; }
      total = r.data.stats.count;
      const results = r.data.results || [];
      if (!results.length) break;
      for (const item of results) {
        const ar = item.stock?.advancedRatios || {};
        const g = k => ar[k] != null ? ar[k] : null;
        allStocks.push({
          sid:          item.sid,
          ticker:       item.stock?.info?.ticker || '',
          name:         item.stock?.info?.name   || '',
          sector:       ar.sector || item.stock?.info?.sector || '',
          slug:         item.stock?.slug || '',
          marketCap:    g('mrktCapf'), price: g('lastPrice'),
          ret1Y: g('52wpct'), ret6M: g('26wpct'), ret1M: g('4wpct'),
          roe: g('roe'), npm: g('pftMrg'), ebitdaMargin: g('aopm'),
          revGrowth: g('rvng'), epsGrowth: g('epsg'), ebitdaGrowth: g('ebitg'),
          epsGwth5Y: g('epsGwth'), revGrowth5Y: g('5YrevChg'),
          pe: g('apef'), evEbitda: g('evebitd'),
          debtEquity: g('dbtEqt'), intCoverage: g('aint'),
          fcf: g('cafFcf'), priceAbove200SMA: g('pab12Mma'),
          promoterHolding: g('strown'), promoterChg3M: g('strown3'),
          mfChg3M: g('instown3'), fiiChg3M: g('forInstHldng3M'),
        });
      }
      offset += results.length;
      process.stdout.write(`  Screener: ${allStocks.length}/${Math.min(total, SCREENER_CAP)} fetched (MCap ${MCAP_MIN}–${MCAP_MAX} Cr)\r`);
      if (results.length < toFetch) break;
    } catch (e) { console.error(`  Screener error (offset=${offset}):`, e.message); break; }
  }
  console.log(`\n  Screener: ${allStocks.length} stocks in MCap ${MCAP_MIN}–${MCAP_MAX} Cr range`);
  return allStocks.filter(s => s.ticker);
}

// ── Fetch OHLCV history from Yahoo Finance ─────────────────────────────────────

async function fetchHistory(ticker) {
  const period1 = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const period2 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    const rows = await yahooFinance.historical(ticker + '.NS', { period1, period2, interval: '1d' });
    if (!rows || rows.length < 60) return null;
    return rows
      .filter(r => r.close != null && r.volume != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch { return null; }
}

// ── IBD-style RS Value (weighted 4-quarter return) ────────────────────────────

function computeRSValue(closes) {
  const n = closes.length;
  if (n < 63) return 0;
  const p0 = closes[n - 1];
  const p1 = closes[n - 1 - Math.min(63,  n - 1)];
  const p2 = closes[n - 1 - Math.min(126, n - 1)];
  const p3 = closes[n - 1 - Math.min(189, n - 1)];
  const p4 = closes[n - 1 - Math.min(252, n - 1)];
  if (!p1 || p1 <= 0) return 0;
  const q4 = p1 > 0 ? p0 / p1 - 1 : 0;
  const q3 = p2 > 0 ? p1 / p2 - 1 : q4;
  const q2 = p3 > 0 ? p2 / p3 - 1 : q4;
  const q1 = p4 > 0 ? p3 / p4 - 1 : q4;
  return 0.4 * q4 + 0.2 * q3 + 0.2 * q2 + 0.2 * q1;
}

// ── Analyse technical data from bars ──────────────────────────────────────────

function analyzeTech(bars) {
  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const price   = closes[closes.length - 1];
  const n       = closes.length;

  const s50  = sma(closes, 50);
  const s150 = sma(closes, 150);
  const s200 = sma(closes, 200);
  const s200_20ago = n >= 220
    ? avg(closes.slice(n - 220, n - 20))
    : (n >= 170 ? avg(closes.slice(0, n - 20)) : null);

  const high52 = Math.max(...highs);
  const low52  = Math.min(...lows);

  // Stage 2 checks
  const stage2Checks = {
    aboveSma50:  s50  != null && price > s50,
    aboveSma150: s150 != null && price > s150,
    aboveSma200: s200 != null && price > s200,
    maStacked:   s50  != null && s150 != null && s200 != null && s50 > s150 && s150 > s200,
    sma200Up:    s200 != null && s200_20ago != null && s200 > s200_20ago,
    nearHigh:    price >= high52 * 0.75,
  };
  const stage2Count = Object.values(stage2Checks).filter(Boolean).length;
  const stage2Pass  = stage2Count >= 5;

  // VCP
  let progressivePullback = false;
  if (n >= 60) {
    const w1 = bars.slice(n - 60, n - 40), w2 = bars.slice(n - 40, n - 20), w3 = bars.slice(n - 20, n);
    const dd = w => { const h = Math.max(...w.map(b => b.high)), l = Math.min(...w.map(b => b.low)); return (h - l) / h; };
    progressivePullback = dd(w1) > dd(w2) && dd(w2) > dd(w3);
  }
  let tightRightSide = false;
  if (n >= 20) {
    const r5  = bars.slice(n - 5,  n).map(b => (b.high - b.low) / b.close);
    const r15 = bars.slice(n - 20, n - 5).map(b => (b.high - b.low) / b.close);
    tightRightSide = avg(r5) < avg(r15) * 0.75;
  }
  const vcpPass = progressivePullback || tightRightSide;

  // Volume
  const vol5  = n >= 5  ? avg(volumes.slice(n - 5,  n)) : null;
  const vol50 = n >= 50 ? avg(volumes.slice(n - 50, n)) : null;
  const volRatio = vol5 != null && vol50 != null && vol50 > 0 ? vol5 / vol50 : null;

  // 52W distance
  const distFromHigh = high52 > 0 ? (high52 - price) / high52 : null;

  // Liquidity: 20-day average daily traded value (₹) = avg(volume × close)
  const adv20 = n >= 20
    ? avg(bars.slice(n - 20).map(b => b.volume * b.close))
    : null;

  const rsValue = computeRSValue(closes);

  return {
    price, s50, s150, s200, high52, low52,
    stage2Pass, stage2Count, stage2Checks,
    progressivePullback, tightRightSide, vcpPass,
    vol5: vol5 ? Math.round(vol5) : null,
    vol50: vol50 ? Math.round(vol50) : null,
    volRatio,
    distFromHigh,
    adv20,
    rsValue,
    rsRating: 50, // placeholder, overwritten after ranking
  };
}

// ── Compute RS Ratings (percentile rank) ─────────────────────────────────────

function computeRSRatings(results) {
  const valid = results.filter(r => r.rsValue != null).slice();
  valid.sort((a, b) => a.rsValue - b.rsValue);
  const n = valid.length;
  const ranks = {};
  valid.forEach((r, i) => {
    ranks[r.ticker] = Math.max(1, Math.min(99, Math.round((i / Math.max(n - 1, 1)) * 98) + 1));
  });
  return ranks;
}

// ── ROCKET Score ───────────────────────────────────────────────────────────────
// Pillar 1 — FUEL (Fundamentals)       max 35
// Pillar 2 — THRUST (Technical)        max 40
// Pillar 3 — IGNITION (Catalyst)       max 25
// Total                                max 100

function scoreFuel(f) {
  let pts = 0;
  // EPS 5Y CAGR (max 12)
  const eps5 = f.epsGwth5Y;
  if (eps5 != null) pts += eps5 >= 30 ? 12 : eps5 >= 20 ? 8 : eps5 >= 15 ? 5 : eps5 >= 10 ? 2 : 0;
  // Rev 5Y CAGR (max 8)
  const rev5 = f.revGrowth5Y;
  if (rev5 != null) pts += rev5 >= 25 ? 8 : rev5 >= 15 ? 5 : rev5 >= 10 ? 2 : 0;
  // ROE (max 8)
  if (f.roe != null) pts += f.roe >= 25 ? 8 : f.roe >= 18 ? 5 : f.roe >= 12 ? 2 : 0;
  // PEG (max 5)
  if (f.pe != null && f.pe > 0 && eps5 != null && eps5 > 0) {
    const peg = f.pe / eps5;
    pts += peg < 1 ? 5 : peg <= 1.5 ? 3 : peg <= 2 ? 1 : 0;
  }
  // FCF positive (max 2)
  if (f.fcf != null && f.fcf > 0) pts += 2;
  return Math.min(35, Math.max(0, pts));
}

function scoreThrust(tech, rsRating) {
  let pts = 0;
  // RS Rating (max 15)
  pts += rsRating >= 90 ? 15 : rsRating >= 80 ? 12 : rsRating >= 70 ? 8 : rsRating >= 60 ? 4 : 0;
  // Stage 2 (max 10)
  if (tech.stage2Pass)        pts += 10;
  else if (tech.stage2Count >= 3) pts += 5;
  // Volume surge (max 10)
  const vr = tech.volRatio;
  if (vr != null) pts += vr >= 2 ? 10 : vr >= 1.5 ? 6 : vr >= 1.2 ? 3 : 0;
  // Distance from 52W high (max 5)
  const d = tech.distFromHigh;
  if (d != null) pts += d <= 0.05 ? 5 : d <= 0.10 ? 3 : d <= 0.20 ? 1 : 0;
  return Math.min(40, Math.max(0, pts));
}

function scoreIgnition(f, tech, vcpFromBreakout2) {
  let pts = 0;
  // 1M momentum acceleration vs 3M baseline (max 10)
  const ret1M = f.ret1M, ret3M_monthly = f.ret6M != null ? f.ret6M / 2 : null;
  if (ret1M != null) {
    if (ret3M_monthly != null && ret3M_monthly > 0) {
      const accel = ret1M / ret3M_monthly;
      pts += accel >= 2 ? 10 : accel >= 1.3 ? 5 : ret1M > 0 ? 2 : 0;
    } else {
      pts += ret1M >= 15 ? 6 : ret1M >= 5 ? 3 : ret1M > 0 ? 1 : 0;
    }
  }
  // VCP bonus from breakout2-data.json (max 8)
  const vcpData = vcpFromBreakout2;
  const vcpPass = vcpData ? vcpData.vcpPass : tech.vcpPass;
  if (vcpPass) pts += 8;
  // Smart Money (max 7)
  if (f.promoterHolding != null) {
    const promPts = f.promoterHolding >= 50 ? (f.promoterChg3M != null && f.promoterChg3M > 0 ? 7 : 5)
                  : f.promoterHolding >= 40 ? 3 : 1;
    pts += promPts;
  }
  // FII + MF both increasing bonus (max 3 bonus)
  if (f.fiiChg3M != null && f.fiiChg3M > 0 && f.mfChg3M != null && f.mfChg3M > 0) pts += 3;

  return Math.min(25, Math.max(0, pts));
}

// ── Tier labels ────────────────────────────────────────────────────────────────

function rocketTier(score) {
  if (score >= 75) return { label: '🚀 LAUNCH READY', cls: 'launch', colour: '#a855f7' };
  if (score >= 60) return { label: '⚡ PRIMED',        cls: 'primed',  colour: '#3b82f6' };
  if (score >= 45) return { label: '🔥 HEATING UP',   cls: 'heating', colour: '#f59e0b' };
  return                   { label: '👀 MONITORING',   cls: 'monitor', colour: '#64748b' };
}

// ── Build full result set ──────────────────────────────────────────────────────

async function buildResults(stocks, vcpMap) {
  const results = [];
  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = stocks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async s => {
      const bars = await fetchHistory(s.ticker);
      if (!bars) return null;
      const tech = analyzeTech(bars);
      return { ...s, ...tech };
    }));
    for (const r of batchResults) { if (r) results.push(r); }
    process.stdout.write(`  Analyzed ${Math.min(i + BATCH_SIZE, stocks.length)}/${stocks.length} stocks\r`);
    if (i + BATCH_SIZE < stocks.length) await sleep(80);
  }
  console.log(`  Analyzed ${results.length}/${stocks.length} stocks (${stocks.length - results.length} skipped/insufficient data)`);
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🚀 ROCKET Screener — 40-50%+ potential in ~1 month');
  console.log('─────────────────────────────────────────────────────');

  // Load optional breakout2 VCP data
  let vcpMap = new Map();
  if (fs.existsSync(BREAKOUT2_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(BREAKOUT2_PATH, 'utf8'));
      for (const item of data) { if (item.ticker) vcpMap.set(item.ticker, item); }
      console.log(`  VCP data: ${vcpMap.size} stocks from breakout2-data.json`);
    } catch { console.log('  VCP data: could not load breakout2-data.json (skipping bonus)'); }
  } else {
    console.log('  VCP data: breakout2-data.json not found (run npm run breakout2 first for bonus pts)');
  }

  const wlTickers = loadWatchlistTickers();
  console.log(`  Watchlist: ${wlTickers.size} tickers loaded`);

  console.log('\n[1/4] Fetching fundamentals from Tickertape screener…');
  const rawStocks = await fetchScreenerUniverse();
  if (!rawStocks.length) {
    console.warn('  No stocks returned from Tickertape — writing empty rocket page (non-fatal)');
    fs.writeFileSync(SIDECAR_PATH, '[]\n', 'utf8');
    fs.writeFileSync(OUTPUT_PATH, buildHtml([], Date.now()), 'utf8');
    return;
  }

  // Filter by price minimum early (avoid fetching history for penny stocks)
  const filtered = rawStocks.filter(s => s.price == null || s.price >= PRICE_MIN);
  console.log(`  After price filter (≥₹${PRICE_MIN}): ${filtered.length} stocks`);

  console.log('\n[2/4] Fetching OHLCV history from Yahoo Finance…');
  let withTech = await buildResults(filtered, vcpMap);

  // Liquidity floor (applied BEFORE scoring/ranking): drop stocks trading less
  // than ₹2 Cr/day (adv20 = 20-day avg of volume × close). Paper edge on
  // illiquid small caps is fake; impact cost exceeds the modeled edge.
  // Stocks where adv20 is not computable are left in (don't fail hard).
  const illiquidCount = withTech.filter(s => s.adv20 != null && s.adv20 < ADV20_MIN).length;
  withTech = withTech.filter(s => s.adv20 == null || s.adv20 >= ADV20_MIN);
  console.log(`  Liquidity floor: skipped ${illiquidCount} stocks with adv20 < ₹2 Cr/day (${withTech.length} remain)`);

  console.log('\n[3/4] Computing RS ratings and ROCKET scores…');
  const rsRanks = computeRSRatings(withTech);
  for (const r of withTech) {
    r.rsRating = rsRanks[r.ticker] || 50;
  }

  // Optional delivery surge enrichment (Phase 4 — smart-money proxy)
  let deliveryData = null;
  try {
    const { loadDelivery } = require('./lib/delivery');
    deliveryData = loadDelivery();
    if (deliveryData) console.log(`  Delivery: ${Object.keys(deliveryData.stocks).length} symbols loaded`);
  } catch {}
  const { getDelivery } = deliveryData ? require('./lib/delivery') : { getDelivery: () => null };

  const scored = withTech.map(s => {
    const p1 = scoreFuel(s);
    const p2 = scoreThrust(s, s.rsRating);
    const p3 = scoreIgnition(s, s, vcpMap.get(s.ticker));
    const del = deliveryData ? getDelivery(deliveryData, s.ticker) : null;
    const deliveryBonus = (del && del.deliverySurge) ? 4 : 0;
    const total = Math.min(100, p1 + p2 + p3 + deliveryBonus);
    const tier  = rocketTier(total);
    return {
      ...s,
      p1, p2, p3, total,
      deliveryBonus,
      deliverySurge: !!(del && del.deliverySurge),
      deliveryPct:   del ? del.deliveryPct : null,
      deliveryMult:  del ? del.deliverySurgeMult : null,
      tier: tier.label, tierCls: tier.cls, tierColour: tier.colour,
      inWatchlist: wlTickers.has(s.ticker),
      stockUrl: s.slug ? `https://www.tickertape.in${s.slug}` : `https://www.tickertape.in/stocks/${s.ticker}`,
    };
  });

  // Filter and sort
  const qualified = scored
    .filter(s => s.price >= PRICE_MIN && s.total >= SCORE_MIN)
    .sort((a, b) => b.total - a.total);

  console.log(`  Qualified stocks (score ≥${SCORE_MIN}): ${qualified.length}`);

  // Write sidecar JSON for confluence
  const sidecar = qualified.map(s => ({
    ticker: s.ticker, name: s.name, score: s.total, tier: s.tier,
    sector: s.sector, price: s.price, marketCap: s.marketCap,
    url: s.stockUrl, p1: s.p1, p2: s.p2, p3: s.p3,
    roe: s.roe, epsGwth5Y: s.epsGwth5Y, debtEquity: s.debtEquity,
    stage2: s.stage2Pass, vcpPass: s.vcpPass, rsRating: s.rsRating,
    adv20: s.adv20 != null ? Math.round(s.adv20) : null,
  }));
  fs.writeFileSync(SIDECAR_PATH, JSON.stringify(sidecar, null, 2), 'utf8');
  console.log(`  Sidecar saved: docs/rocket-tickers.json (${sidecar.length} stocks)`);

  console.log('\n[4/4] Generating HTML…');
  const html = buildHtml(qualified, Date.now());
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');

  const launchCnt  = qualified.filter(s => s.tierCls === 'launch').length;
  const primedCnt  = qualified.filter(s => s.tierCls === 'primed').length;
  const heatingCnt = qualified.filter(s => s.tierCls === 'heating').length;
  console.log(`\n✅ Done! ${qualified.length} stocks written to docs/rocket.html`);
  console.log(`   🚀 Launch Ready: ${launchCnt}  ⚡ Primed: ${primedCnt}  🔥 Heating Up: ${heatingCnt}`);
}

// ── HTML Generator ─────────────────────────────────────────────────────────────

function buildHtml(stocks, updatedAt) {
  const genTime = new Date(updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const launchCnt  = stocks.filter(s => s.tierCls === 'launch').length;
  const primedCnt  = stocks.filter(s => s.tierCls === 'primed').length;
  const heatingCnt = stocks.filter(s => s.tierCls === 'heating').length;
  const wlCnt      = stocks.filter(s => s.inWatchlist).length;
  const dataJson   = JSON.stringify(stocks.map(s => ({
    ticker: s.ticker, name: s.name, sector: s.sector, price: s.price, marketCap: s.marketCap,
    total: s.total, p1: s.p1, p2: s.p2, p3: s.p3, tier: s.tier, tierCls: s.tierCls, tierColour: s.tierColour,
    rsRating: s.rsRating, stage2Pass: s.stage2Pass, vcpPass: s.vcpPass,
    volRatio: s.volRatio, distFromHigh: s.distFromHigh,
    epsGwth5Y: s.epsGwth5Y, revGrowth5Y: s.revGrowth5Y, roe: s.roe,
    pe: s.pe, fcf: s.fcf, debtEquity: s.debtEquity,
    promoterHolding: s.promoterHolding, promoterChg3M: s.promoterChg3M,
    fiiChg3M: s.fiiChg3M, mfChg3M: s.mfChg3M,
    ret1M: s.ret1M, ret6M: s.ret6M, ret1Y: s.ret1Y,
    high52: s.high52, low52: s.low52,
    stockUrl: s.stockUrl, inWatchlist: s.inWatchlist,
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🚀 Rocket Screener · NSE Small/Mid Cap</title>
<script>
(function(){var s=localStorage.getItem('rocket-theme');document.documentElement.setAttribute('data-theme',s||'dark');})();
<\/script>
<style>
:root,html[data-theme="dark"]{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#a855f7;--tx:#e8e8f0;--t2:#9898b0;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7;--tl:#06b6d4;--or:#f97316;--hdr-bg:linear-gradient(135deg,#1a0a2e,#12121a);--shadow:0 8px 24px rgba(0,0,0,.4);--row-hover:rgba(168,85,247,.04);--card-border:rgba(42,42,56,.4)}
html[data-theme="light"]{--bg:#f8f9fc;--s1:#fff;--s2:#fff;--s3:#eef0f5;--bd:#d5d8e0;--ac:#7c3aed;--tx:#1e1e32;--t2:#44495e;--t3:#6b7188;--gn:#15803d;--rd:#b91c1c;--yw:#a16207;--bl:#1d4ed8;--pp:#6d28d9;--tl:#0e7490;--or:#c2410c;--hdr-bg:linear-gradient(135deg,#ede9fe,#eaecf2);--shadow:0 4px 16px rgba(0,0,0,.07);--row-hover:rgba(124,58,237,.03);--card-border:rgba(0,0,0,.08)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);overflow-x:hidden;line-height:1.55;transition:background .3s,color .3s}
.header{background:var(--hdr-bg);border-bottom:1px solid var(--bd);padding:18px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.4rem;font-weight:700;background:linear-gradient(90deg,#a855f7,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .subtitle{font-size:.78rem;color:var(--t2);margin-top:3px}
.header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.back-link{color:var(--t2);text-decoration:none;font-size:.82rem;padding:7px 14px;border:1px solid var(--bd);border-radius:6px;transition:all .2s}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
.theme-toggle{width:42px;height:24px;border-radius:12px;border:1px solid var(--bd);background:var(--s3);cursor:pointer;position:relative;transition:all .3s;flex-shrink:0}
.theme-toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--ac);transition:transform .3s}
html[data-theme="light"] .theme-toggle::after{transform:translateX(18px)}
.theme-label{font-size:.68rem;color:var(--t3);white-space:nowrap}
.stats-bar{display:flex;gap:12px;padding:16px 28px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap;transition:background .3s}
.stat-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:12px 18px;min-width:100px;transition:background .3s,border .3s}
.stat-card .label{font-size:.7rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.stat-card .value{font-size:1.25rem;font-weight:700}
.stat-card .value.purple{color:var(--pp)}.stat-card .value.blue{color:var(--bl)}.stat-card .value.yellow{color:var(--yw)}.stat-card .value.green{color:var(--gn)}.stat-card .value.teal{color:var(--tl)}
.controls{display:flex;gap:10px;padding:16px 28px;flex-wrap:wrap;align-items:center;transition:background .3s}
.filter-group{display:flex;gap:4px;align-items:center;border:1px solid var(--bd);border-radius:8px;padding:3px;background:var(--s1);transition:background .3s,border .3s}
.filter-group .fg-label{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.04em;padding:0 8px;white-space:nowrap;font-weight:600}
.btn{padding:6px 14px;border-radius:5px;border:1px solid transparent;background:transparent;color:var(--t2);cursor:pointer;font-size:.8rem;font-family:inherit;transition:all .2s}
.btn:hover{color:var(--tx);background:var(--s3)}
.btn.active{background:var(--ac);color:#fff;border-color:var(--ac);font-weight:600}
.search{padding:8px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.88rem;font-family:inherit;width:230px;outline:none;transition:border .2s,background .3s}
.search:focus{border-color:var(--ac)}
.table-container{padding:8px 28px 28px;overflow-x:auto}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:.84rem}
thead{position:sticky;top:0;z-index:10}
th{background:var(--s1);color:var(--ac);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;padding:12px;text-align:left;border-bottom:2px solid var(--bd);cursor:pointer;white-space:nowrap;user-select:none;transition:color .2s,background .3s}
th:hover{color:var(--tx)}
th .arrow{margin-left:4px;font-size:.6rem;opacity:.5}
th.sorted .arrow{opacity:1;color:var(--ac)}
td{padding:10px 12px;border-bottom:1px solid var(--card-border);white-space:nowrap;vertical-align:middle;transition:background .15s}
tr:hover td{background:var(--row-hover)}
.stock-name a{color:var(--tx);text-decoration:none;font-weight:600;font-size:.88rem;transition:color .2s}
.stock-name a:hover{color:var(--ac)}
.stock-name .ticker{color:var(--t2);font-size:.74rem;margin-top:1px}
.name-row{display:inline-flex;align-items:center;flex-wrap:wrap;gap:2px}
.stock-actions{display:inline-flex;align-items:center;gap:2px;margin-left:4px;flex-shrink:0}
.wl-dot{color:var(--yw)}
.pos{color:var(--gn)}.neg{color:var(--rd)}.dim{color:var(--t3)}
/* Rocket score ring */
.rkt-ring{width:42px;height:42px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:800;border:3px solid;cursor:default;flex-shrink:0}
.r-launch{border-color:#a855f7;color:#a855f7;background:rgba(168,85,247,.1)}
.r-primed{border-color:#3b82f6;color:#3b82f6;background:rgba(59,130,246,.08)}
.r-heating{border-color:#f59e0b;color:#f59e0b;background:rgba(245,158,11,.08)}
.r-monitor{border-color:var(--t3);color:var(--t3);background:rgba(90,90,112,.06)}
/* Tier badge */
.tier-badge{display:inline-block;padding:3px 9px;border-radius:5px;font-size:.7rem;font-weight:700;white-space:nowrap}
.tier-launch{background:rgba(168,85,247,.15);color:#a855f7;border:1px solid rgba(168,85,247,.35)}
.tier-primed{background:rgba(59,130,246,.13);color:#3b82f6;border:1px solid rgba(59,130,246,.3)}
.tier-heating{background:rgba(245,158,11,.12);color:#f59e0b;border:1px solid rgba(245,158,11,.3)}
.tier-monitor{background:rgba(100,100,130,.08);color:var(--t3);border:1px solid rgba(100,100,130,.15)}
/* Pillar bars */
.pillar-bars{display:flex;flex-direction:column;gap:2px}
.pb-row{display:flex;align-items:center;gap:4px;font-size:.58rem;color:var(--t3);font-weight:600;line-height:1}
.pb-bg{width:48px;height:5px;background:var(--s3);border-radius:3px;overflow:hidden;flex-shrink:0}
.pb-fill{height:100%;border-radius:3px}
/* RS badge */
.rs-badge{display:inline-block;padding:2px 8px;border-radius:5px;font-size:.76rem;font-weight:800;font-variant-numeric:tabular-nums}
.rs-elite{background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.3)}
.rs-high{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.rs-mid{background:rgba(234,179,8,.10);color:var(--yw);border:1px solid rgba(234,179,8,.2)}
.rs-low{background:rgba(100,100,130,.07);color:var(--t3);border:1px solid rgba(100,100,130,.15)}
/* Check badges */
.chk{display:inline-block;padding:2px 7px;border-radius:4px;font-size:.7rem;font-weight:600;margin:2px 2px 2px 0;white-space:nowrap}
.chk-pass{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.chk-fail{background:rgba(239,68,68,.07);color:var(--t3);border:1px solid rgba(100,100,120,.2)}
/* Alert/Research buttons */
.alert-btn,.research-btn{background:none;border:none;cursor:pointer;padding:1px 4px;border-radius:4px;font-size:.82rem;color:var(--t3);transition:color .15s;vertical-align:middle;margin-left:2px;line-height:1;flex-shrink:0}
.alert-btn:hover{color:var(--yw)}.research-btn:hover{color:var(--ac)}
/* DR modal */
#dr-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9991;overflow-y:auto;padding:20px 12px}
#dr-modal{background:var(--s2);border:1px solid var(--bd);border-radius:14px;max-width:640px;margin:20px auto;padding:22px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.dr-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--bd)}
.dr-title{font-size:1.1rem;font-weight:700;color:var(--tx)}.dr-subtitle{font-size:.75rem;color:var(--t2);margin-top:3px}
#dr-close{background:none;border:none;cursor:pointer;color:var(--t3);font-size:1.2rem;padding:0;line-height:1;flex-shrink:0}
.dr-section{margin-bottom:18px}.dr-section-title{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ac);font-weight:700;margin-bottom:8px}
.dr-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dr-metric{background:var(--s1);border:1px solid var(--bd);border-radius:8px;padding:10px 12px}
.dr-metric .dm-label{font-size:.65rem;color:var(--t2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.dr-metric .dm-val{font-size:.9rem;font-weight:600}
.dr-metric .dm-sub{font-size:.65rem;color:var(--t3);margin-top:2px}
.dr-signal{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:7px;margin-bottom:5px;font-size:.8rem;line-height:1.4}
.dr-signal.bull{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.18);color:var(--gn)}
.dr-signal.bear{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);color:var(--rd)}
.dr-signal.neut{background:rgba(234,179,8,.07);border:1px solid rgba(234,179,8,.18);color:var(--yw)}
.dr-signal .ds-icon{flex-shrink:0;margin-top:1px}
.dr-ai-box{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:14px;font-size:.82rem;line-height:1.7;color:var(--tx);min-height:80px}
.dr-ai-box.loading{color:var(--t2);font-style:italic}
.dr-ai-error{color:var(--rd);font-size:.78rem;padding:6px 0}
.dr-ai-key-row{display:flex;gap:8px;margin-top:10px;align-items:center}
.dr-ai-key-input{flex:1;padding:7px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--s3);color:var(--tx);font-size:.78rem;font-family:inherit;outline:none}
.dr-ai-key-btn{padding:7px 14px;border:none;border-radius:6px;background:var(--ac);color:#fff;cursor:pointer;font-size:.78rem;font-weight:700;font-family:inherit;white-space:nowrap}
.dr-ai-key-btn:hover{opacity:.85}
@media(max-width:768px){#dr-overlay{padding:0}#dr-modal{border-radius:0;min-height:100dvh;margin:0;max-width:100%}.dr-grid{grid-template-columns:1fr}}
${alertSystem.css}
#no-results{display:none;padding:40px;text-align:center;color:var(--t2)}
.hidden{display:none!important}
#cards-container{display:none;padding:0 14px 24px}
.stock-card{background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:12px;transition:background .3s,border .3s}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.card-name{font-weight:600;font-size:.9rem}.card-name a{color:var(--tx);text-decoration:none}
.card-name a:hover{color:var(--ac)}
.card-ticker{color:var(--t2);font-size:.74rem;margin-top:2px}
.card-price .price{font-size:1.1rem;font-weight:700}
.card-row{display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--card-border);font-size:.8rem}
.card-label{color:var(--t2)}
.sort-select{display:none;padding:8px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.88rem;font-family:inherit;outline:none}
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.74rem;border-top:1px solid var(--bd);line-height:1.8}
@media(max-width:768px){
  .header{padding:14px 16px}.header h1{font-size:1.1rem}
  .stats-bar{padding:12px 14px;gap:8px}
  .stat-card{min-width:0;flex:1 1 calc(33% - 8px);padding:10px 12px}.stat-card .value{font-size:1rem}
  .controls{padding:12px 14px;gap:8px}
  .filter-group{flex-wrap:wrap;width:100%}
  .search{width:100%;font-size:16px}
  .table-container{display:none}
  #cards-container{display:block}
  .sort-select{display:block;width:100%;margin-top:4px}
  .back-link{font-size:.72rem;padding:5px 10px}
  .theme-label{display:none}
}
${TOOLTIP_CSS}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>&#x1F680; Rocket Screener</h1>
    <div class="subtitle">Combined momentum + fundamentals &nbsp;&middot;&nbsp; NSE Small/Mid Cap (&#x20B9;200–5000 Cr) &nbsp;&middot;&nbsp; ROCKET Score: FUEL + THRUST + IGNITION &nbsp;&middot;&nbsp; <span style="color:var(--ac)">Generated: ${genTime} IST</span></div>
  </div>
  <div class="header-right">
    <div class="status" id="status-text"></div>
    <span class="theme-label" id="theme-label">Dark</span>
    <div class="theme-toggle" id="theme-toggle" title="Toggle dark/light mode"></div>
    <a href="alerts.html"            class="back-link" style="color:var(--yw);border-color:rgba(234,179,8,.4)">&#x1F514; Alerts</a>
    <a href="apex.html"              class="back-link" style="color:#6366f1;border-color:rgba(99,102,241,.4)">&#x1F52E; APEX</a>
    <a href="confluence.html"        class="back-link" style="color:#8b5cf6;border-color:rgba(139,92,246,.4)">&#x26A1; Confluence</a>
    <a href="multibagger.html"       class="back-link" style="color:#f59e0b;border-color:rgba(245,158,11,.4)">&#x1F3C6; Multibagger</a>
    <a href="breakout2.html"         class="back-link" style="color:var(--tl);border-color:rgba(6,182,212,.4)">&#x26A1; Breakout GEN2</a>
    <a href="creamy.html"            class="back-link">Creamy Layer</a>
    <a href="trades.html"            class="back-link" style="color:#22c55e;border-color:rgba(34,197,94,.4)">&#x1F4C8; Trades</a>
    <a href="sectors.html"           class="back-link" style="color:#f97316;border-color:rgba(249,115,22,.4)">&#x1F4CA; Sectors</a>
    <a href="indian-research.html"   class="back-link" style="color:#fb923c;border-color:rgba(251,146,60,.4)">&#x1F1EE;&#x1F1F3; India Research</a>
    ${HUB_BACK_LINK}
    <a href="index.html"              class="back-link">My Watchlist</a>
  </div>
</div>
${legendHtml('How to read this page (tap to expand)', [
  {
    title: 'What this scan does',
    bodyHtml: `<p>Hunts for NSE small/mid-cap stocks (₹${MCAP_MIN.toLocaleString('en-IN')}–${MCAP_MAX.toLocaleString('en-IN')} Cr market cap, ≥₹${PRICE_MIN} price) with the combination of fundamentals, technical momentum and a catalyst that historically precedes a fast 1-month move.</p>`,
  },
  {
    title: 'How the ROCKET score works',
    bodyHtml: `<p>0-100 total = <b>FUEL</b> (fundamentals, max 35: EPS/revenue 5Y CAGR, ROE, PEG, positive FCF) + <b>THRUST</b> (technical, max 40: RS Rating, Stage 2, volume surge, distance from 52-week high) + <b>IGNITION</b> (catalyst, max 25: 1-month momentum acceleration, VCP bonus from the Breakout scanner, promoter/FII/MF buying) + an optional delivery-surge bonus.</p>
    <p><span class="tier-badge tier-launch">🚀 LAUNCH READY</span> ≥75 &nbsp; <span class="tier-badge tier-primed">⚡ PRIMED</span> ≥60 &nbsp; <span class="tier-badge tier-heating">🔥 HEATING UP</span> ≥45 &nbsp; <span class="tier-badge tier-monitor">👀 MONITORING</span> below 45. Only stocks scoring ≥${SCORE_MIN} make this page at all.</p>`,
  },
  {
    title: 'Column glossary',
    bodyHtml: `<p>Hover any column header for its exact definition — RS Rating, EPS 5Y%, ROE, 1M return and Promoter holding are the FUEL/THRUST/IGNITION building blocks above.</p>`,
  },
  {
    title: 'Caveats',
    bodyHtml: `<p>A liquidity floor is applied <i>before</i> scoring: stocks trading under ₹${(ADV20_MIN / 1e7).toFixed(0)} Cr/day (20-day average traded value) are dropped outright, because impact cost on illiquid small/microcaps would erase any modeled edge. This is a screening/research page, not a trade trigger — validate manually before acting, and always size small-cap positions conservatively. Not financial advice.</p>`,
  },
])}

<div class="stats-bar">
  <div class="stat-card"><div class="label">Total Stocks</div><div class="value purple">${stocks.length}</div></div>
  <div class="stat-card"><div class="label">&#x1F680; Launch Ready</div><div class="value purple">${launchCnt}</div></div>
  <div class="stat-card"><div class="label">&#x26A1; Primed</div><div class="value blue">${primedCnt}</div></div>
  <div class="stat-card"><div class="label">&#x1F525; Heating Up</div><div class="value yellow">${heatingCnt}</div></div>
  <div class="stat-card"><div class="label">&#x2605; Watchlist</div><div class="value green">${wlCnt}</div></div>
  <div class="stat-card" style="margin-left:auto"><div class="label">Data</div><div class="value" style="font-size:.78rem;color:var(--t2)">${genTime} IST</div></div>
</div>

${alertSystem.bannerHtml}
${alertSystem.modalHtml}

<div id="dr-overlay">
  <div id="dr-modal">
    <div class="dr-header">
      <div><div class="dr-title" id="dr-title">Rocket Deep Research</div><div class="dr-subtitle" id="dr-subtitle"></div></div>
      <button id="dr-close">&#x2715;</button>
    </div>
    <div id="dr-content"></div>
  </div>
</div>

<div class="controls">
  <div class="filter-group">
    <span class="fg-label">Tier</span>
    <button class="btn tier-btn active" data-tier="all">All</button>
    <button class="btn tier-btn" data-tier="launch">&#x1F680; Launch</button>
    <button class="btn tier-btn" data-tier="primed">&#x26A1; Primed</button>
    <button class="btn tier-btn" data-tier="heating">&#x1F525; Heating</button>
    <button class="btn tier-btn" data-tier="wl">&#x2605; Watchlist</button>
  </div>
  <div class="filter-group">
    <span class="fg-label">Score</span>
    <button class="btn score-btn active" data-min="0">All</button>
    <button class="btn score-btn" data-min="50">50+</button>
    <button class="btn score-btn" data-min="60">60+</button>
    <button class="btn score-btn" data-min="75">75+</button>
  </div>
  <input type="text" class="search" id="search" placeholder="Search ticker or name&hellip;" style="margin-left:auto">
  <select id="sort-select" class="search sort-select">
    <option value="total:desc">Sort: ROCKET Score (best)</option>
    <option value="p1:desc">Sort: FUEL (Fundamentals)</option>
    <option value="p2:desc">Sort: THRUST (Technical)</option>
    <option value="p3:desc">Sort: IGNITION (Catalyst)</option>
    <option value="rsRating:desc">Sort: RS Rating</option>
    <option value="marketCap:desc">Sort: Market Cap</option>
    <option value="name:asc">Sort: Name A–Z</option>
  </select>
</div>

<div class="table-container">
  <table>
    <thead><tr id="table-head"></tr></thead>
    <tbody id="table-body"></tbody>
  </table>
  <div id="no-results">No stocks match the current filter.</div>
</div>

<div id="cards-container"></div>
<div class="footer" id="footer"></div>

<script>
var RAW = ${dataJson};
var allStocks = RAW;
// Client-side HTML escaper (runs in the browser; cannot use the Node lib/format).
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
var sortCol = 'total', sortAsc = false;
var tierFilter = 'all', minScore = 0, searchTerm = '';

var COLS = [
  {key:'rank',       label:'#',         w:'36px'},
  {key:'name',       label:'Stock',      w:'210px', tip:'Company name and NSE ticker. \u2605 = in your watchlist. \ud83d\udd14 = price alert. \ud83e\udde0 = AI research.'},
  {key:'total',      label:'ROCKET Score', w:'170px', num:true, tip:'ROCKET Score (0\u2013100) = FUEL(35) + THRUST(40) + IGNITION(25). Higher = better short-term breakout potential. \ud83d\ude80 Launch Ready \u226575 | \u26a1 Primed \u226560 | \ud83d\udd25 Heating Up \u226545.'},
  {key:'pillars',    label:'Pillars',    w:'180px', tip:'3 mini-bars: FUEL=fundamentals (purple, max 35) | THRUST=technical momentum (blue, max 40) | IGNITION=catalyst signals (orange, max 25).'},
  {key:'rsRating',   label:'RS',         w:'52px',  num:true, tip:'IBD-style Relative Strength Rating 1\u201399. Percentile rank by weighted 4-quarter return within this universe.'},
  {key:'epsGwth5Y',  label:'EPS 5Y%',   w:'70px',  num:true, tip:'5-year EPS CAGR %. Key FUEL metric. \u226530% = max points.'},
  {key:'roe',        label:'ROE',        w:'60px',  num:true, tip:'Return on Equity %. \u226525% = max FUEL points.'},
  {key:'ret1M',      label:'1M Ret',     w:'65px',  num:true, tip:'1-month price return %. Recent momentum signal.'},
  {key:'promoterHolding', label:'Promoter', w:'72px', num:true, tip:'Promoter holding %. High holding + increasing = strong conviction signal.'},
  {key:'sector',     label:'Sector',     w:'110px'},
  {key:'marketCap',  label:'MCap Cr',    w:'78px',  num:true, tip:'Market cap in Crores. Universe: ₹200–5000 Cr small/mid cap.'},
];

var TIER_TIPS={launch:'ROCKET score \u226575 \u2014 FUEL, THRUST and IGNITION all line up. Highest-conviction setups on this page.',primed:'ROCKET score 60\u201374 \u2014 strong setup, most conditions met.',heating:'ROCKET score 45\u201359 \u2014 building, worth watching for confirmation.',monitor:'ROCKET score below 45 \u2014 shown for visibility only, not yet a strong signal.'};
function ringCls(s){return s.tierCls?'r-'+s.tierCls:'r-monitor';}
function tierBadgeHtml(s){var t=TIER_TIPS[s.tierCls]||'';return '<span class="tier-badge tier-'+s.tierCls+(t?' tip':'')+'"'+(t?' tabindex="0" data-tip="'+t.replace(/"/g,'&quot;')+'"':'')+'>'+s.tier+'</span>';}
function rsHtml(rs){if(!rs)return'<span class="dim">\u2014</span>';var c=rs>=90?'rs-elite':rs>=80?'rs-high':rs>=60?'rs-mid':'rs-low';return'<span class="rs-badge '+c+' tip" tabindex="0" data-tip="Percentile rank (1-99) of this stock\u2019s weighted 12-month return vs every other stock in this universe. \u226580 = top 20% strongest.">'+rs+'</span>';}
function retHtml(v){if(v==null)return'<span class="dim">\u2014</span>';var c=v>=0?'pos':'neg';return'<span class="'+c+'">'+(v>=0?'+':'')+v.toFixed(1)+'%</span>';}
function pillarsHtml(s){
  var bars=[
    {lbl:'FUE',v:s.p1,max:35,c:'#a855f7'},
    {lbl:'THR',v:s.p2,max:40,c:'#3b82f6'},
    {lbl:'IGN',v:s.p3,max:25,c:'#f97316'},
  ];
  return'<div class="pillar-bars">'+bars.map(function(b){var pct=Math.min(100,Math.round(b.v/b.max*100));return'<div class="pb-row"><span>'+b.lbl+'</span><div class="pb-bg"><div class="pb-fill" style="width:'+pct+'%;background:'+b.c+'"></div></div><span style="font-size:.55rem;margin-left:2px;color:var(--t2)">'+b.v+'</span></div>';}).join('')+'</div>';
}
function chk(pass,lbl){return'<span class="chk '+(pass?'chk-pass':'chk-fail')+'">'+lbl+(pass?' \u2713':' \u2717')+'</span>';}
function fmtCr(n){if(n==null)return'\u2014';if(n>=100000)return(n/100000).toFixed(1)+'L';if(n>=1000)return(n/1000).toFixed(1)+'K';return Math.round(n)+'';}

function buildHead(){
  document.getElementById('table-head').innerHTML=COLS.map(function(c){
    var labelHtml=c.tip?'<span class="tip" tabindex="0" data-tip="'+c.tip.replace(/"/g,'&quot;')+'">'+c.label+'</span>':c.label;
    var sorted=sortCol===c.key;
    var arrow=sorted?(sortAsc?'\u25b2':'\u25bc'):'\u21c5';
    return'<th style="width:'+c.w+'" class="'+(sorted?'sorted':'')+'">'
      +labelHtml+'<span class="arrow">'+arrow+'</span></th>';
  }).join('');
  document.getElementById('table-head').querySelectorAll('th').forEach(function(th,i){
    var col=COLS[i];if(col)th.addEventListener('click',function(){doSort(col.key,col.num);});
  });
}

function getFiltered(){
  return allStocks.filter(function(s){
    if(tierFilter==='launch'  && s.tierCls!=='launch')  return false;
    if(tierFilter==='primed'  && s.tierCls!=='primed')  return false;
    if(tierFilter==='heating' && s.tierCls!=='heating') return false;
    if(tierFilter==='wl'      && !s.inWatchlist)        return false;
    if(s.total < minScore) return false;
    if(searchTerm){var q=searchTerm.toLowerCase();if(s.ticker.toLowerCase().indexOf(q)<0&&s.name.toLowerCase().indexOf(q)<0&&(s.sector||'').toLowerCase().indexOf(q)<0)return false;}
    return true;
  }).sort(function(a,b){
    var av=a[sortCol],bv=b[sortCol];
    if(sortCol==='name'){return sortAsc?a.name.localeCompare(b.name):b.name.localeCompare(a.name);}
    if(av==null&&bv==null)return 0;if(av==null)return 1;if(bv==null)return -1;
    return sortAsc?(av-bv):(bv-av);
  });
}

function renderTable(){
  var list=getFiltered();
  document.getElementById('status-text').textContent=list.length+' stocks';
  var rows=list.slice(0,300).map(function(s,i){
    return'<tr data-ticker="'+esc(s.ticker)+'">'
      +'<td style="color:var(--t3);font-size:.8rem">'+(i+1)+'</td>'
      +'<td><div class="stock-name"><span class="name-row"><a href="'+esc(s.stockUrl)+'" target="_blank" rel="noopener">'+esc(s.name)+'</a><span class="stock-actions"><button class="alert-btn" data-alert-ticker="'+esc(s.ticker)+'" data-alert-price="'+(s.price||0)+'" data-alert-name="'+esc(s.name)+'">&#x1F514;</button><button class="research-btn" data-r-ticker="'+esc(s.ticker)+'" title="Rocket AI Deep Research">&#x1F9E0;</button></span></span>'
        +'<div class="ticker">'+esc(s.ticker)+(s.inWatchlist?' <span class="wl-dot">\u2605</span>':'')+'</div></div>'
      +'</td>'
      +'<td><div style="display:inline-flex;align-items:center;gap:8px"><div class="rkt-ring '+ringCls(s)+'">'+s.total+'</div>'
        +tierBadgeHtml(s)+'</div></td>'
      +'<td>'+pillarsHtml(s)+'</td>'
      +'<td>'+rsHtml(s.rsRating)+'</td>'
      +'<td>'+retHtml(s.epsGwth5Y)+'</td>'
      +'<td>'+(s.roe!=null?'<span class="'+(s.roe>=20?'pos':s.roe>=10?'':'neg')+'">'+s.roe.toFixed(1)+'%</span>':'\u2014')+'</td>'
      +'<td>'+retHtml(s.ret1M)+'</td>'
      +'<td>'+(s.promoterHolding!=null?s.promoterHolding.toFixed(1)+'%'+((s.promoterChg3M||0)>0?' <span class="pos">\u25b2</span>':''):'\u2014')+'</td>'
      +'<td style="font-size:.78rem;color:var(--t2)">'+esc(s.sector||'')+'</td>'
      +'<td style="font-size:.8rem;color:var(--t2)">'+fmtCr(s.marketCap)+'</td>'
      +'</tr>';
  }).join('');
  document.getElementById('table-body').innerHTML=rows||'';
  document.getElementById('no-results').style.display=list.length===0?'block':'none';
  renderCards(list);
}

function renderCards(list){
  document.getElementById('cards-container').innerHTML=list.slice(0,300).map(function(s){
    return'<div class="stock-card">'
      +'<div class="card-header">'
        +'<div><div class="card-name"><span class="name-row"><a href="'+esc(s.stockUrl)+'" target="_blank" rel="noopener">'+esc(s.name)+'</a><span class="stock-actions"><button class="alert-btn" data-alert-ticker="'+esc(s.ticker)+'" data-alert-price="'+(s.price||0)+'" data-alert-name="'+esc(s.name)+'">&#x1F514;</button><button class="research-btn" data-r-ticker="'+esc(s.ticker)+'" title="Rocket AI Deep Research">&#x1F9E0;</button></span></span></div>'
          +'<div class="card-ticker">'+esc(s.ticker)+(s.inWatchlist?' \u2605':'')+'</div></div>'
        +'<div><div class="rkt-ring '+ringCls(s)+'" style="width:38px;height:38px;font-size:.8rem">'+s.total+'</div></div>'
      +'</div>'
      +'<div class="card-row"><span class="card-label">Tier</span><span>'+tierBadgeHtml(s)+'</span></div>'
      +'<div class="card-row"><span class="card-label">FUEL / THRUST / IGNITION</span><span>'+pillarsHtml(s)+'</span></div>'
      +'<div class="card-row"><span class="card-label">RS Rating</span><span>'+rsHtml(s.rsRating)+'</span></div>'
      +'<div class="card-row"><span class="card-label">EPS 5Y CAGR</span><span>'+retHtml(s.epsGwth5Y)+'</span></div>'
      +'<div class="card-row"><span class="card-label">ROE</span><span>'+(s.roe!=null?s.roe.toFixed(1)+'%':'\u2014')+'</span></div>'
      +'<div class="card-row"><span class="card-label">1M Return</span><span>'+retHtml(s.ret1M)+'</span></div>'
      +'<div class="card-row"><span class="card-label">Promoter</span><span>'+(s.promoterHolding!=null?s.promoterHolding.toFixed(1)+'%':'\u2014')+'</span></div>'
      +'<div class="card-row"><span class="card-label">MCap</span><span>'+fmtCr(s.marketCap)+' Cr</span></div>'
      +'</div>';
  }).join('');
}

function doSort(col,isNum){
  if(sortCol===col){sortAsc=!sortAsc;}else{sortCol=col;sortAsc=(col==='name');}
  buildHead();renderTable();
}

document.addEventListener('DOMContentLoaded',function(){
  buildHead();renderTable();

  // Theme
  var toggle=document.getElementById('theme-toggle'),lbl=document.getElementById('theme-label');
  function applyTheme(t){document.documentElement.setAttribute('data-theme',t);localStorage.setItem('rocket-theme',t);lbl.textContent=t==='dark'?'Dark':'Light';}
  applyTheme(document.documentElement.getAttribute('data-theme')||'dark');
  toggle.addEventListener('click',function(){applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');});

  // Tier filter
  document.querySelectorAll('.tier-btn').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.tier-btn').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active');tierFilter=b.dataset.tier;renderTable();
    });
  });

  // Score filter
  document.querySelectorAll('.score-btn').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.score-btn').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active');minScore=parseInt(b.dataset.min)||0;renderTable();
    });
  });

  // Search
  document.getElementById('search').addEventListener('input',function(){searchTerm=this.value.trim();renderTable();});

  // Mobile sort
  document.getElementById('sort-select').addEventListener('change',function(){
    var p=this.value.split(':');sortCol=p[0];sortAsc=p[1]==='asc';buildHead();renderTable();
  });

  // Footer
  document.getElementById('footer').innerHTML=
    '\ud83d\ude80 Rocket Screener &middot; FUEL(35) + THRUST(40) + IGNITION(25) = 100 pts<br>'
    +'Universe: NSE Small/Mid Cap \u20b9200\u20135000 Cr &middot; Technical: Yahoo Finance 370-day OHLCV &middot; Fundamentals: Tickertape screener<br>'
    +'Generated ${genTime} IST &nbsp;&middot;&nbsp; Not financial advice. Always do your own research.';
});

window._GH_ALERTS_REPO='amitiyer99/watchlist-app';
${alertSystem.js}

// ── Deep Research AI (Rocket edition) ─────────────────────────────────
(function(){
  var DR_PROV_KEY='dr_provider';
  var DR_PROVIDERS={groq:{label:'Groq (Llama/Mixtral) \u2014 30 req/min free \u2605',keyName:'dr_groq_key',keyPlaceholder:'Paste Groq API key (console.groq.com)',keyLink:'https://console.groq.com/keys',keyLinkLabel:'console.groq.com',models:[{id:'llama-3.3-70b-versatile',label:'Llama 3.3 70B \u2014 best quality'},{id:'llama3-8b-8192',label:'Llama 3 8B \u2014 fastest'},{id:'mixtral-8x7b-32768',label:'Mixtral 8x7B'}]},openrouter:{label:'OpenRouter \u2014 free tier models',keyName:'dr_openrouter_key',keyPlaceholder:'Paste OpenRouter API key (openrouter.ai/keys)',keyLink:'https://openrouter.ai/keys',keyLinkLabel:'openrouter.ai',models:[{id:'meta-llama/llama-3.1-8b-instruct:free',label:'Llama 3.1 8B (free)'},{id:'mistralai/mistral-7b-instruct:free',label:'Mistral 7B (free)'},{id:'google/gemma-3-27b-it:free',label:'Gemma 3 27B (free)'}]},gemini:{label:'Google Gemini',keyName:'dr_gemini_key',keyPlaceholder:'Paste Gemini API key (aistudio.google.com)',keyLink:'https://aistudio.google.com/app/apikey',keyLinkLabel:'aistudio.google.com',models:[{id:'gemini-2.0-flash-lite',label:'Gemini 2.0 Flash Lite \u2014 30 req/min'},{id:'gemini-2.0-flash',label:'Gemini 2.0 Flash \u2014 15 req/min'},{id:'gemini-1.5-flash-8b',label:'Gemini 1.5 Flash 8B'}]}};
  var drCur=null;
  document.addEventListener('click',function(e){
    var btn=e.target.closest('.research-btn');if(!btn)return;e.stopPropagation();
    var ticker=btn.dataset.rTicker;
    var s=allStocks.find(function(x){return x.ticker===ticker;});if(!s)return;
    drCur=s;
    document.getElementById('dr-title').textContent=s.name;
    document.getElementById('dr-subtitle').textContent=s.ticker+' \u00b7 NSE India \u00b7 '+(s.sector||'')+' \u00b7 ROCKET '+s.total+(s.inWatchlist?' \u00b7 \u2605 WL':'');
    document.getElementById('dr-content').innerHTML=buildDrContent(s);
    document.getElementById('dr-overlay').style.display='block';document.body.style.overflow='hidden';
    var sp=localStorage.getItem(DR_PROV_KEY)||'groq';var psel=document.getElementById('dr-provider-select');if(psel)psel.value=sp;
    drChangeProvider();
    var sprov=DR_PROVIDERS[sp];var key=sprov?localStorage.getItem(sprov.keyName):null;
    if(key){var inp=document.getElementById('dr-key-input');if(inp)inp.value='\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';var msel=document.getElementById('dr-model-select');runAIAnalysis(s,key,sp,msel?msel.value:null);}
  });
  document.getElementById('dr-close').addEventListener('click',closeDr);
  document.getElementById('dr-overlay').addEventListener('click',function(e){if(e.target===document.getElementById('dr-overlay'))closeDr();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDr();});
  function closeDr(){document.getElementById('dr-overlay').style.display='none';document.body.style.overflow='';}
  window.drRunWithKey=function(){
    var inp=document.getElementById('dr-key-input');if(!inp)return;
    var psel=document.getElementById('dr-provider-select');var pid=(psel&&psel.value)||localStorage.getItem(DR_PROV_KEY)||'groq';var prov=DR_PROVIDERS[pid]||DR_PROVIDERS.groq;
    var typedKey=inp.value.trim().replace(/[^\x20-\x7E]/g,'');var key=typedKey||localStorage.getItem(prov.keyName)||'';
    if(!key){inp.focus();return;}
    localStorage.setItem(DR_PROV_KEY,pid);localStorage.setItem(prov.keyName,key);inp.value='\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    var msel=document.getElementById('dr-model-select');var model=msel?msel.value:prov.models[0].id;
    if(drCur)runAIAnalysis(drCur,key,pid,model);
  };
  window.drChangeProvider=function(){
    var psel=document.getElementById('dr-provider-select');var msel=document.getElementById('dr-model-select');var inp=document.getElementById('dr-key-input');var link=document.getElementById('dr-key-link');
    if(!psel)return;var prov=DR_PROVIDERS[psel.value];if(!prov)return;
    if(msel){msel.innerHTML=prov.models.map(function(m){return'<option value="'+m.id+'">'+m.label+'</option>';}).join('');var sm=localStorage.getItem('dr_model.'+psel.value);if(sm)msel.value=sm;}
    var sk=localStorage.getItem(prov.keyName);if(inp){inp.value=sk?'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022':'';inp.placeholder=prov.keyPlaceholder;}
    if(link){link.href=prov.keyLink;link.textContent=prov.keyLinkLabel;}
  };
  function dm(lbl,val,sub,cls){return'<div class="dr-metric"><div class="dm-label">'+lbl+'</div><div class="dm-val'+(cls?' '+cls:'')+'">'+(val||'\u2014')+'</div>'+(sub?'<div class="dm-sub">'+sub+'</div>':'')+'</div>';}
  function buildDrContent(s){
    var signals=[];
    if(s.p1>=25)signals.push({type:'bull',icon:'\u25b2',text:'FUEL '+s.p1+'/35 \u2014 strong fundamentals with high EPS/revenue growth and ROE.'});
    else if(s.p1<=10)signals.push({type:'neut',icon:'\u25c6',text:'FUEL '+s.p1+'/35 \u2014 weak fundamental base.'});
    if(s.p2>=30)signals.push({type:'bull',icon:'\u25b2',text:'THRUST '+s.p2+'/40 \u2014 strong RS + Stage2 + volume surge confirms breakout momentum.'});
    else if(s.p2<=12)signals.push({type:'bear',icon:'\u25bc',text:'THRUST '+s.p2+'/40 \u2014 weak technical momentum.'});
    if(s.p3>=18)signals.push({type:'bull',icon:'\u25c6',text:'IGNITION '+s.p3+'/25 \u2014 strong catalyst: momentum acceleration, VCP, and smart money.'});
    else if(s.p3<=6)signals.push({type:'neut',icon:'\u25c6',text:'IGNITION '+s.p3+'/25 \u2014 limited short-term catalyst signals.'});
    if(s.stage2Pass)signals.push({type:'bull',icon:'\u2713',text:'Stage 2 confirmed: price above SMA50/150/200 with stacked MAs.'});
    else signals.push({type:'neut',icon:'\u26a0',text:'Stage 2 not fully confirmed. Some MA conditions unmet.'});
    if(s.vcpPass)signals.push({type:'bull',icon:'\u25c6',text:'VCP (Volatility Contraction) pattern detected \u2014 coiling for breakout.'});
    if(!signals.length)signals.push({type:'neut',icon:'\u25c6',text:'Moderate signal quality. Review pillar details below.'});
    var html='<div class="dr-section"><div class="dr-section-title">\ud83d\ude80 Rocket Score Breakdown</div><div class="dr-grid">'
      +dm('ROCKET Total',s.total+'/100',s.tier,'')
      +dm('FUEL (P1)',s.p1+'/35','EPS 5Y: '+(s.epsGwth5Y!=null?'+'+s.epsGwth5Y.toFixed(1)+'%':'\u2014'),'')
      +dm('THRUST (P2)',s.p2+'/40','RS: '+(s.rsRating||'\u2014')+' | Stage2: '+(s.stage2Pass?'\u2713':'\u2717'),'')
      +dm('IGNITION (P3)',s.p3+'/25','VCP: '+(s.vcpPass?'\u2713':'\u2717'),'')
      +dm('1M Return',s.ret1M!=null?(s.ret1M>=0?'+':'')+s.ret1M.toFixed(1)+'%':'\u2014','','')
      +dm('Promoter',s.promoterHolding!=null?s.promoterHolding.toFixed(1)+'%':'\u2014',s.promoterChg3M!=null&&s.promoterChg3M>0?'\u25b2 Buying':s.promoterChg3M<0?'\u25bc Selling':'','')
      +'</div></div>';
    html+='<div class="dr-section"><div class="dr-section-title">&#x1F4CA; Key Metrics</div><div class="dr-grid">'
      +dm('Price',s.price!=null?'\u20b9'+s.price.toFixed(2):'\u2014','','')
      +dm('MCap',fmtCr(s.marketCap)+' Cr','small/mid cap','')
      +dm('ROE',s.roe!=null?s.roe.toFixed(1)+'%':'\u2014',s.roe>=20?'Excellent':s.roe>=12?'Good':'','')
      +dm('D/E',s.debtEquity!=null?s.debtEquity.toFixed(2):'\u2014',s.debtEquity!=null&&s.debtEquity<=0.3?'Low debt':s.debtEquity>1.5?'High leverage':'','')
      +dm('6M Ret',s.ret6M!=null?(s.ret6M>=0?'+':'')+s.ret6M.toFixed(1)+'%':'\u2014','','')
      +dm('1Y Ret',s.ret1Y!=null?(s.ret1Y>=0?'+':'')+s.ret1Y.toFixed(1)+'%':'\u2014','','')
      +'</div></div>';
    html+='<div class="dr-section"><div class="dr-section-title">&#x2728; Signals</div>';
    for(var i=0;i<signals.length;i++)html+='<div class="dr-signal '+signals[i].type+'"><span class="ds-icon">'+signals[i].icon+'</span><span>'+signals[i].text+'</span></div>';
    html+='</div>';
    html+='<div class="dr-section"><div class="dr-section-title">\ud83e\udde0 AI Deep Analysis</div>'
      +'<div id="dr-ai-box" class="dr-ai-box loading">Enter your API key below for Rocket-powered analysis \u2014 momentum thesis, catalyst assessment, risk factors &amp; verdict.</div>'
      +'<div id="dr-ai-error" class="dr-ai-error" style="display:none"></div>'
      +'<div style="margin-bottom:6px"><select id="dr-provider-select" onchange="drChangeProvider()" style="width:100%;background:var(--s3);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;font-size:.78rem;cursor:pointer">'
      +Object.keys(DR_PROVIDERS).map(function(k){return'<option value="'+k+'">'+DR_PROVIDERS[k].label+'</option>';}).join('')+'</select></div>'
      +'<div style="margin-bottom:6px"><select id="dr-model-select" style="width:100%;background:var(--s3);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;font-size:.78rem;cursor:pointer"></select></div>'
      +'<div class="dr-ai-key-row"><input type="password" class="dr-ai-key-input" id="dr-key-input" placeholder="Paste API key"><button class="dr-ai-key-btn" onclick="drRunWithKey()">Analyse \u2726</button></div>'
      +'<div style="font-size:.62rem;color:var(--t3);margin-top:5px">Get free key at <a id="dr-key-link" href="https://console.groq.com/keys" target="_blank" rel="noopener" style="color:var(--ac)">console.groq.com</a> &middot; Stored only in your browser</div>'
      +'</div>';
    return html;
  }
  function buildAIPrompt(s){
    var N=String.fromCharCode(10);
    return 'You are a professional Indian equity analyst specialising in short-term momentum opportunities. Analyse this stock using the ROCKET Score framework.'+N+N
      +'STOCK: '+s.name+' ('+s.ticker+') | NSE India | Sector: '+(s.sector||'N/A')+' | MCap: '+fmtCr(s.marketCap)+' Cr'+N+N
      +'ROCKET SCORE: '+s.total+'/100 ('+s.tier+')'+N
      +'- P1 FUEL (Fundamentals): '+s.p1+'/35 | EPS 5Y: '+(s.epsGwth5Y!=null?s.epsGwth5Y.toFixed(1)+'%':'N/A')+' | ROE: '+(s.roe!=null?s.roe.toFixed(1)+'%':'N/A')+N
      +'- P2 THRUST (Technical): '+s.p2+'/40 | RS: '+(s.rsRating||'N/A')+' | Stage2: '+(s.stage2Pass?'YES':'NO')+' | VCP: '+(s.vcpPass?'YES':'NO')+N
      +'- P3 IGNITION (Catalyst): '+s.p3+'/25 | 1M Return: '+(s.ret1M!=null?s.ret1M.toFixed(1)+'%':'N/A')+' | Promoter: '+(s.promoterHolding!=null?s.promoterHolding.toFixed(1)+'%':'N/A')+N+N
      +'CONTEXT: This is a small/mid-cap stock screened for 40\u201350%+ potential in ~1 month.'+N+N
      +'Write a concise Rocket research note:'+N+N
      +'**MOMENTUM THESIS**'+N+'What is driving the price momentum? Is the setup valid?'+N+N
      +'**FUNDAMENTAL CATALYST**'+N+'EPS/revenue growth quality and near-term earnings catalyst.'+N+N
      +'**TECHNICAL SETUP**'+N+'Stage 2 status, VCP, RS rank and breakout readiness.'+N+N
      +'**SMART MONEY**'+N+'Promoter + FII/MF conviction signals.'+N+N
      +'**RISK FACTORS**'+N+'Key downside risks for this small/mid-cap pick.'+N+N
      +'**VERDICT**: ['+s.tier+'] \u2014 [one sentence on upside potential and key risk]';
  }
  function runAIAnalysis(s,apiKey,provId,model){
    var prov=DR_PROVIDERS[provId]||DR_PROVIDERS.groq;
    if(!model)model=prov.models[0].id;
    localStorage.setItem('dr_model.'+provId,model);
    var box=document.getElementById('dr-ai-box'),errEl=document.getElementById('dr-ai-error');
    if(!box)return;
    box.className='dr-ai-box loading';box.textContent='\u23f3 Analysing '+s.name+'\u2026';errEl.style.display='none';
    var prompt=buildAIPrompt(s);
    apiKey=String(apiKey).replace(/[^\x20-\x7E]/g,'');
    if(!apiKey){box.className='dr-ai-box';errEl.style.display='block';errEl.textContent='\u26a0\ufe0f Invalid API key.';return;}
    var fUrl,fBody,fH={'Content-Type':'application/json'};
    if(provId==='gemini'){fUrl='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(apiKey);fBody=JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.65,maxOutputTokens:1024}});}
    else if(provId==='openrouter'){fUrl='https://openrouter.ai/api/v1/chat/completions';fH['Authorization']='Bearer '+apiKey;fH['HTTP-Referer']='https://amitiyer99.github.io/watchlist-app/';fBody=JSON.stringify({model:model,messages:[{role:'user',content:prompt}],temperature:0.65,max_tokens:1024});}
    else{fUrl='https://api.groq.com/openai/v1/chat/completions';fH['Authorization']='Bearer '+apiKey;fBody=JSON.stringify({model:model,messages:[{role:'user',content:prompt}],temperature:0.65,max_tokens:1024});}
    fetch(fUrl,{method:'POST',headers:fH,body:fBody})
      .then(function(r){return r.json();})
      .then(function(d){
        var text='';
        if(provId==='gemini')text=(d.candidates&&d.candidates[0]&&d.candidates[0].content&&d.candidates[0].content.parts&&d.candidates[0].content.parts[0]&&d.candidates[0].content.parts[0].text)||'';
        else text=(d.choices&&d.choices[0]&&d.choices[0].message&&d.choices[0].message.content)||'';
        if(!text&&d.error){throw new Error(d.error.message||JSON.stringify(d.error));}
        box.className='dr-ai-box';
        box.innerHTML=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')
          .replace(/\\n/g,'<br>');
      })
      .catch(function(e){
        box.className='dr-ai-box';errEl.style.display='block';errEl.textContent='\u26a0\ufe0f '+e.message;
        box.textContent='Analysis failed. Check your API key and try again.';
      });
  }
})();
<\/script>
</body>
</html>`;
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });

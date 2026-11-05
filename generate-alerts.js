'use strict';
const { HUB_BACK_LINK } = require('./lib/hub-nav');
const fs = require('fs');
const path = require('path');
const { makeClient } = require('./lib/yahoo');
const yahooFinance = makeClient();
const EX = require('./lib/exchange'); // exchange-aware Yahoo symbols (NSE .NS / BSE .BO)
const stockActions = require('./lib/stock-actions');
const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');
const { loadLivePrices, livePriceOf, reconcile, loadSidecarPrices } = require('./lib/live-prices');

const USER_ALERTS_PATH = path.join(__dirname, 'user-alerts.json');
const WATCHLIST_PATH   = path.join(__dirname, 'my-watchlists.json');
const TICKER_URLS_PATH = path.join(__dirname, 'ticker-urls.json');
const OUTPUT_PATH      = path.join(__dirname, 'docs', 'alerts.html');

// Sidecar paths for Techno-Fundamental & Entry timing intelligence
const BREAKOUT2_PATH   = path.join(__dirname, 'docs', 'breakout2-data.json');
const TRIGGERS_PATH    = path.join(__dirname, 'docs', 'triggers.json');
const MULTIBAGGER_PATH = path.join(__dirname, 'docs', 'multibagger-tickers.json');
const APEX_PATH        = path.join(__dirname, 'docs', 'apex-tickers.json');
const CREAMY_PATH      = path.join(__dirname, 'docs', 'creamy-tickers.json');
const SCORECARD_PATH   = path.join(__dirname, 'scorecard-tags.json');
const COHORT_PATH      = path.join(__dirname, 'docs', 'compounder-cohort.json');

// Helper to safely read JSON
function readJsonSafe(p, fallback = {}) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return fallback;
}

// Load watchlist metadata (3M low/high, stockUrl, watchlist name) keyed by ticker
function loadWatchlistMeta() {
  const meta = {};
  try {
    const watchlists = readJsonSafe(WATCHLIST_PATH, []);
    const tickerUrls = readJsonSafe(TICKER_URLS_PATH, {});
    for (const wl of watchlists) {
      const data3m = wl.periods?.['3M'];
      if (!data3m) continue;
      for (const s of data3m.stocks || []) {
        const parts = (s.name || '').split('\n');
        const ticker = (parts[1] || '').trim();
        if (!ticker || meta[ticker]) continue;
        const p = v => parseFloat(String(v || '').replace(/[₹,]/g, ''));
        meta[ticker] = {
          fullName: parts[0] || ticker,
          watchlist: wl.name.replace(/^Equity Watchlist\s*/, '') || 'Main',
          stockUrl: s.stockUrl || tickerUrls[ticker] || '',
          low3m: p(s.cells?.[3]),
          high3m: p(s.cells?.[4]),
        };
      }
    }
  } catch {}
  return meta;
}

// Load sidecar datasets
function loadSidecars() {
  const boData = readJsonSafe(BREAKOUT2_PATH, []);
  const breakoutMap = new Map();
  if (Array.isArray(boData)) {
    for (const item of boData) {
      if (item && item.ticker) breakoutMap.set(item.ticker, item);
    }
  }

  const trData = readJsonSafe(TRIGGERS_PATH, {});
  const triggerMap = new Map();
  if (Array.isArray(trData.triggers)) {
    for (const tr of trData.triggers) {
      if (tr && tr.ticker) triggerMap.set(tr.ticker, { ...tr, isLive: true, isArmed: false });
    }
  }
  if (Array.isArray(trData.armed)) {
    for (const ar of trData.armed) {
      if (ar && ar.ticker && !triggerMap.has(ar.ticker)) {
        triggerMap.set(ar.ticker, { ...ar, isLive: false, isArmed: true });
      }
    }
  }

  const mbData = readJsonSafe(MULTIBAGGER_PATH, []);
  const multibaggerMap = new Map();
  if (Array.isArray(mbData)) {
    for (const mb of mbData) {
      if (mb && mb.ticker) multibaggerMap.set(mb.ticker, mb);
    }
  }

  const apData = readJsonSafe(APEX_PATH, []);
  const apexMap = new Map();
  if (Array.isArray(apData)) {
    for (const ap of apData) {
      if (ap && ap.ticker) apexMap.set(ap.ticker, ap);
    }
  }

  const crData = readJsonSafe(CREAMY_PATH, []);
  const creamyMap = new Map();
  if (Array.isArray(crData)) {
    for (const cr of crData) {
      if (cr && cr.ticker) creamyMap.set(cr.ticker, cr);
    }
  }

  const scData = readJsonSafe(SCORECARD_PATH, {});
  const scorecardMap = new Map(Object.entries(scData || {}));

  const cohortData = readJsonSafe(COHORT_PATH, {});
  const cohortSet = new Set(Object.keys(cohortData.members || {}));

  return { breakoutMap, triggerMap, multibaggerMap, apexMap, creamyMap, scorecardMap, cohortSet };
}

// Fetch historical charts for tickers missing from breakout2-data or missing 3M range data
async function fetchMissingTechnicals(tickers, breakoutMap, meta) {
  const missing = tickers.filter(t => {
    const bo = breakoutMap.get(t);
    const m = meta && meta[t];
    const hasTech = bo && bo.s200 != null;
    const hasRange = (m && m.low3m != null && m.high3m != null && !isNaN(m.low3m) && m.high3m > m.low3m) ||
                     (bo && bo.low3m != null && bo.high3m != null && bo.high3m > bo.low3m);
    return !hasTech || !hasRange;
  });
  if (!missing.length) return {};
  console.log(`Fetching 1-year historical chart for ${missing.length} alerted tickers for 200 DMA, 3M range & technicals...`);
  const results = {};
  const period1 = new Date(Date.now() - 370 * 24 * 3600 * 1000);
  const period2 = new Date();

  for (let i = 0; i < missing.length; i += 5) {
    const batch = missing.slice(i, i + 5);
    await Promise.all(batch.map(async t => {
      try {
        const sym = EX.yahooSymbol(t);
        const chart = await yahooFinance.chart(sym, { period1, period2, interval: '1d' });
        const quotes = (chart?.quotes || []).filter(q => q && q.close != null && q.high != null && q.low != null);
        if (quotes.length >= 25) {
          const closes = quotes.map(q => q.close);
          const highs = quotes.map(q => q.high);
          const lows = quotes.map(q => q.low);
          const n = closes.length;
          const price = closes[n - 1];

          const sma = (arr, len) => {
            if (arr.length < len) return null;
            return arr.slice(-len).reduce((a, b) => a + b, 0) / len;
          };

          const s50 = sma(closes, Math.min(50, n));
          const s150 = sma(closes, Math.min(150, n));
          const s200 = n >= 180 ? sma(closes, 200) : null;
          const s200_20ago = n >= 220 ? sma(closes.slice(0, -20), 200) : null;
          const sma200Up = s200 != null && s200_20ago != null ? s200 >= s200_20ago : null;
          const aboveSma200 = s200 != null ? price > s200 : null;

          let dma200Cross = null;
          if (n >= 205 && s200 != null) {
            const firstSide = closes[n - 6] > s200 ? 1 : -1;
            const lastSide  = price > s200 ? 1 : -1;
            if (firstSide !== lastSide) dma200Cross = lastSide === 1 ? 'RECLAIM' : 'BREAKDOWN';
          }

          const high52 = Math.max(...highs);
          const low52 = Math.min(...lows);
          const high3m = Math.max(...highs.slice(-63));
          const low3m = Math.min(...lows.slice(-63));

          // ATR14
          let atr14 = null;
          if (n >= 15) {
            let trSum = 0;
            for (let k = n - 14; k < n; k++) {
              const tr = Math.max(highs[k] - lows[k], Math.abs(highs[k] - closes[k - 1]), Math.abs(lows[k] - closes[k - 1]));
              trSum += tr;
            }
            atr14 = trSum / 14;
          }
          const atrPct = atr14 && price ? (atr14 / price) * 100 : 3.5;

          // Pivot: highest high in recent 20-40 bars
          const pivotWindow = highs.slice(Math.max(0, n - 40));
          const pivot = Math.max(...pivotWindow);

          // Stan Weinstein Stage 2 proxy
          const stage2 = s200 != null ? (price > s200 && (s50 > s150 || price > s50) && (sma200Up || s50 > s200)) : (s50 != null && price > s50);

          results[t] = {
            s50: s50 ? Math.round(s50 * 100) / 100 : null,
            s150: s150 ? Math.round(s150 * 100) / 100 : null,
            s200: s200 ? Math.round(s200 * 100) / 100 : null,
            sma200Up,
            aboveSma200,
            dma200Cross,
            high52: Math.round(high52 * 100) / 100,
            low52: Math.round(low52 * 100) / 100,
            high3m: Math.round(high3m * 100) / 100,
            low3m: Math.round(low3m * 100) / 100,
            atr14: atr14 ? Math.round(atr14 * 100) / 100 : null,
            atrPct: atrPct ? Math.round(atrPct * 10) / 10 : 3.5,
            pivot: Math.round(pivot * 100) / 100,
            stage2,
            rsRating: null,
            vcpPass: false,
          };
        }
      } catch (e) {
        // Safe fallback in sandbox / network glitch
      }
    }));
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

// Fetch live prices with sidecar / live-prices.json reconciliation
async function fetchPrices(tickers) {
  const LP = loadLivePrices().prices;
  const REF = loadSidecarPrices();
  const results = {};
  for (let i = 0; i < tickers.length; i += 10) {
    const batch = tickers.slice(i, i + 10);
    const res = await Promise.all(batch.map(async t => {
      const key = String(t).toUpperCase();
      try {
        const q = await yahooFinance.quote(EX.yahooSymbol(t));
        const ref = REF[key] != null ? REF[key] : livePriceOf(LP, key);
        const price = reconcile(ref, q.regularMarketPrice);
        return { ticker: t, price, changePct: q.regularMarketChangePercent };
      } catch {
        const price = livePriceOf(LP, key) != null ? livePriceOf(LP, key) : (REF[key] ?? null);
        return { ticker: t, price, changePct: null };
      }
    }));
    for (const r of res) results[r.ticker] = r;
  }
  return results;
}

// ── Techno-Fundamental Classification ───────────────────────────────
function evaluateTechnoFundamental(ticker, tech, sidecars) {
  const { multibaggerMap, apexMap, creamyMap, scorecardMap, cohortSet } = sidecars;
  const mb = multibaggerMap.get(ticker);
  const ap = apexMap.get(ticker);
  const cr = creamyMap.get(ticker);
  const sc = scorecardMap.get(ticker);
  const isCohort = cohortSet.has(ticker);

  const mbScore = mb?.score ?? null;
  const apScore = ap?.score ?? null;
  const crScore = cr?.score ?? null;
  const rsRating = tech.rsRating ?? ap?.rsRating ?? null;
  const stage2 = tech.stage2 ?? false;
  const aboveSma200 = tech.aboveSma200 ?? false;

  const rawBadges = [];
  if (mb?.badges && Array.isArray(mb.badges)) {
    for (const b of mb.badges) rawBadges.push({ icon: b.icon || '⭐', label: b.label });
  }

  const hasBadge = label => rawBadges.some(b => b.label.toLowerCase().includes(label.toLowerCase()));

  // Assign Potential Tier
  let tier = 'NEUTRAL';
  let tierLabel = 'Watchlist Stock';
  let tierIcon = '👁️';
  let tierBadgeClass = 'tier-neutral';

  if (
    (mbScore != null && mbScore >= 75) ||
    (apScore != null && apScore >= 75) ||
    (hasBadge('Accelerating Growth') && (stage2 || aboveSma200)) ||
    (sc?.growthTag === 'High' && sc?.profitTag === 'High' && (stage2 || aboveSma200))
  ) {
    tier = 'HUGE_POTENTIAL';
    tierLabel = 'Huge Potential';
    tierIcon = '🚀';
    tierBadgeClass = 'tier-huge';
  } else if (
    isCohort ||
    hasBadge('Compounding Machine') ||
    hasBadge('Fortress') ||
    hasBadge('FCF Champion') ||
    (mbScore != null && mbScore >= 58) ||
    (apScore != null && apScore >= 60) ||
    (crScore != null && crScore >= 55)
  ) {
    tier = 'COMPOUNDER';
    tierLabel = 'Quality Compounder';
    tierIcon = '🏆';
    tierBadgeClass = 'tier-compounder';
  } else if (
    (rsRating != null && rsRating >= 80) ||
    hasBadge('Momentum Leader') ||
    (tech.volSurgePct != null && tech.volSurgePct >= 100)
  ) {
    tier = 'MOMENTUM';
    tierLabel = 'Momentum Leader';
    tierIcon = '⚡';
    tierBadgeClass = 'tier-momentum';
  } else if (tech.dma200Cross === 'RECLAIM') {
    tier = 'REVERSAL';
    tierLabel = 'Turnaround Reclaim';
    tierIcon = '🔄';
    tierBadgeClass = 'tier-reversal';
  } else if (aboveSma200 && (sc?.profitTag === 'High' || sc?.perfTag === 'High')) {
    tier = 'CORE';
    tierLabel = 'Quality Core';
    tierIcon = '🛡️';
    tierBadgeClass = 'tier-core';
  }

  // Composite Techno-Fundamental Score (0-100)
  let compositeScore = 50;
  if (mbScore != null) compositeScore = mbScore;
  else if (apScore != null) compositeScore = apScore;
  else if (crScore != null) compositeScore = crScore;
  if (stage2) compositeScore = Math.min(99, compositeScore + 6);
  if (aboveSma200) compositeScore = Math.min(99, compositeScore + 4);
  if (rsRating != null && rsRating >= 80) compositeScore = Math.min(99, compositeScore + 5);

  return {
    tier,
    tierLabel,
    tierIcon,
    tierBadgeClass,
    score: compositeScore,
    badges: rawBadges,
    sector: mb?.sector || ap?.sector || cr?.sector || null,
  };
}

// ── Entry Timing & Execution Engine ─────────────────────────────────
function evaluateEntryTiming(price, tech, trig) {
  const {
    s50, s150, s200, sma200Up, aboveSma200, dma200Cross,
    pivot, atrPct, stage2, vcpPass
  } = tech;

  const effPivot = trig?.pivot || pivot || price;
  const pctToPivot = (price != null && effPivot != null && effPivot > 0)
    ? ((price - effPivot) / effPivot) * 100
    : null;

  const pctTo200 = (price != null && s200 != null && s200 > 0)
    ? ((price - s200) / s200) * 100
    : null;

  const pctTo50 = (price != null && s50 != null && s50 > 0)
    ? ((price - s50) / s50) * 100
    : null;

  let code = 'BASE_BUILDING';
  let badge = '💤 Base Forming';
  let color = 'slate';
  let summary = 'Consolidating in base';
  let action = 'Watch for volume dry-up and volatility contraction.';
  let priority = 5;

  // 1. Guardrail: Below 200 DMA (Strict Avoid)
  if (s200 != null && price != null && price < s200 * 0.985 && (sma200Up === false || dma200Cross === 'BREAKDOWN')) {
    code = 'AVOID_BELOW_200';
    badge = '🛑 AVOID · Below 200 DMA';
    color = 'red';
    summary = `Trading ${Math.abs(pctTo200 || 0).toFixed(1)}% below declining 200 DMA. High structural trend risk.`;
    action = 'Strictly DO NOT ENTER until 200 DMA is decisively reclaimed on heavy volume.';
    priority = 7;
  }
  // 2. Turnaround: 200 DMA Reclaim
  else if (dma200Cross === 'RECLAIM' || (s200 != null && price != null && price >= s200 && price <= s200 * 1.03 && tech.dma200Cross !== 'BREAKDOWN')) {
    code = 'RECLAIM_200';
    badge = '🔄 200 DMA Reclaim · Turnaround Entry';
    color = 'purple';
    summary = `Fresh crossover back above the 200-day moving average (₹${s200?.toFixed(2)}).`;
    action = `High upside early turnaround entry. Set stop loss tightly below 200 DMA (~₹${(s200 * 0.96).toFixed(2)}).`;
    priority = 2;
  }
  // 3. Prime Breakout Entry (In Buy Zone: 0% to +3.5% of pivot)
  else if (
    (trig?.isLive) ||
    (pctToPivot != null && pctToPivot >= 0 && pctToPivot <= 3.5 && (aboveSma200 !== false || stage2))
  ) {
    code = 'PRIME_BUY_ZONE';
    badge = '🎯 PRIME ENTRY · In Buy Zone';
    color = 'green';
    summary = `Trading ${pctToPivot ? '+' + pctToPivot.toFixed(1) + '%' : 'in sweet spot'} around Pivot (₹${effPivot?.toFixed(2)}).`;
    action = `Ideal entry window right now. Accumulate in Buy Zone: ₹${effPivot?.toFixed(2)} – ₹${(effPivot * 1.03).toFixed(2)}.`;
    priority = 1; // Top priority!
  }
  // 4. Armed & Coiling (-2.5% to 0% below pivot)
  else if (
    (trig?.isArmed) ||
    (pctToPivot != null && pctToPivot >= -2.8 && pctToPivot < 0 && (aboveSma200 !== false || stage2))
  ) {
    code = 'ARMED_COILING';
    badge = '⏳ ARMED · Coiling to Break Out';
    color = 'amber';
    summary = `Only ${Math.abs(pctToPivot || 0).toFixed(1)}% below Pivot (₹${effPivot?.toFixed(2)}). Volatility contracting.`;
    action = `Set a Buy-Stop Limit order at ₹${effPivot?.toFixed(2)}. Breakout is imminent.`;
    priority = 1; // Top priority!
  }
  // 5. Pullback to 50 DMA Support
  else if (
    stage2 && s50 != null && price != null &&
    price >= s50 * 0.985 && price <= s50 * 1.025
  ) {
    code = 'PULLBACK_50DMA';
    badge = '🛡️ 50 DMA Pullback · Low Risk Dip Buy';
    color = 'cyan';
    summary = `Testing rising 50 DMA support (₹${s50.toFixed(2)}). Low-volume consolidation.`;
    action = `Enter on bounce off 50 DMA with tight stop loss at ₹${(s50 * 0.965).toFixed(2)}.`;
    priority = 3;
  }
  // 6. 200 DMA Institutional Floor Support
  else if (
    sma200Up && s200 != null && price != null &&
    price >= s200 * 0.985 && price <= s200 * 1.03
  ) {
    code = 'SUPPORT_200DMA';
    badge = '🛡️ 200 DMA Floor · Institutional Support';
    color = 'blue';
    summary = `Testing rising 200 DMA floor (₹${s200.toFixed(2)}). Long-term institutional accumulation level.`;
    action = `Accumulate near ₹${s200.toFixed(2)} with stop below ₹${(s200 * 0.955).toFixed(2)}. Asymmetric R:R.`;
    priority = 3;
  }
  // 7. Extended (>5% past pivot or >18% past 50 DMA)
  else if ((pctToPivot != null && pctToPivot > 5.0) || (s50 != null && price != null && price > s50 * 1.18)) {
    code = 'EXTENDED';
    badge = '⚠️ EXTENDED · Do Not Chase';
    color = 'orange';
    summary = `Price is ${pctToPivot != null && pctToPivot > 0 ? '+' + pctToPivot.toFixed(1) + '%' : ''} past breakout pivot.`;
    action = 'Do not chase at current levels. High risk of pullback; wait for a healthy consolidation base.';
    priority = 6;
  }
  // 8. Base Building
  else {
    code = 'BASE_BUILDING';
    badge = `💤 Base Forming · ${pctToPivot != null ? pctToPivot.toFixed(1) + '%' : ''} to Pivot`;
    color = 'slate';
    summary = `Consolidating in base pattern. Resistance at ₹${effPivot?.toFixed(2)}.`;
    action = 'Monitor for volume dry-up and tightening ATR before placing orders.';
    priority = 5;
  }

  // Calculate Trade Execution Blueprint
  const entry = trig?.entry || effPivot || price;
  const buyZoneMin = entry ? Math.round(entry * 100) / 100 : null;
  const buyZoneMax = entry ? Math.round(entry * 1.03 * 100) / 100 : null;

  let stopLoss = trig?.stop || null;
  if (!stopLoss && entry) {
    if (code === 'PULLBACK_50DMA' && s50) stopLoss = Math.round(s50 * 0.965 * 100) / 100;
    else if ((code === 'RECLAIM_200' || code === 'SUPPORT_200DMA') && s200) stopLoss = Math.round(s200 * 0.96 * 100) / 100;
    else {
      const riskFraction = Math.max(0.045, Math.min(0.08, (atrPct || 3.5) / 100 * 1.5));
      stopLoss = Math.round(entry * (1 - riskFraction) * 100) / 100;
    }
  }

  const riskPerShare = (entry && stopLoss) ? Math.max(0.01, entry - stopLoss) : null;
  const riskPct = (entry && riskPerShare) ? (riskPerShare / entry) * 100 : null;
  const target1 = (entry && riskPerShare) ? Math.round((entry + riskPerShare * 2) * 100) / 100 : null;
  const target2 = (entry && riskPerShare) ? Math.round((entry + riskPerShare * 3) * 100) / 100 : null;
  const target1Pct = (entry && target1) ? ((target1 - entry) / entry) * 100 : null;
  const target2Pct = (entry && target2) ? ((target2 - entry) / entry) * 100 : null;

  return {
    code,
    badge,
    color,
    summary,
    action,
    priority,
    pivot: effPivot,
    pctToPivot,
    pctTo200,
    pctTo50,
    buyZoneMin,
    buyZoneMax,
    stopLoss,
    riskPct: riskPct ? Math.round(riskPct * 10) / 10 : null,
    target1,
    target2,
    target1Pct: target1Pct ? Math.round(target1Pct * 10) / 10 : null,
    target2Pct: target2Pct ? Math.round(target2Pct * 10) / 10 : null,
    rr: '1 : 2.5',
  };
}

// ── Main Execution ──────────────────────────────────────────────────
async function main() {
  const userAlerts = readJsonSafe(USER_ALERTS_PATH, {});
  const tickers = Object.keys(userAlerts);
  const meta = loadWatchlistMeta();
  const tickerUrlMap = readJsonSafe(TICKER_URLS_PATH, {});
  const sidecars = loadSidecars();

  console.log(`Analyzing ${tickers.length} alerted stocks with Techno-Fundamental and Entry Timing Engine...`);

  // Fetch missing 1-year historical technicals & 3M range for any alerted stocks
  const extraTech = await fetchMissingTechnicals(tickers, sidecars.breakoutMap, meta);

  // Fetch live prices (reconciled against live-prices.json / sidecars)
  const prices = tickers.length ? await fetchPrices(tickers) : {};

  // Build Enriched Stock Intelligence Array
  const stocks = tickers.map(ticker => {
    const al = userAlerts[ticker] || {};
    const m = meta[ticker] || {};
    const pq = prices[ticker] || {};
    const price = pq.price ?? null;

    // Technical base: from breakout2 sidecar, else extraTech
    const bo = sidecars.breakoutMap.get(ticker) || {};
    const ex = extraTech[ticker] || {};
    const trig = sidecars.triggerMap.get(ticker) || null;

    const technicals = {
      s50: bo.s50 ?? ex.s50 ?? null,
      s150: bo.s150 ?? ex.s150 ?? null,
      s200: bo.s200 ?? ex.s200 ?? null,
      sma200Up: bo.sma200Up ?? ex.sma200Up ?? null,
      aboveSma200: bo.aboveSma200 ?? ex.aboveSma200 ?? (bo.s200 && price ? price > bo.s200 : null),
      dma200Cross: bo.dma200Cross ?? ex.dma200Cross ?? null,
      high52: ex.high52 ?? bo.high52 ?? null,
      low52: ex.low52 ?? bo.low52 ?? null,
      high3m: ex.high3m ?? m.high3m ?? bo.high3m ?? ex.high52 ?? bo.high52 ?? null,
      low3m: ex.low3m ?? m.low3m ?? bo.low3m ?? ex.low52 ?? bo.low52 ?? null,
      pivot: bo.pivot ?? ex.pivot ?? (m.high3m || price),
      atr14: bo.atr14 ?? ex.atr14 ?? null,
      atrPct: bo.atrPct ?? ex.atrPct ?? 3.5,
      stage2: bo.stage2 ?? ex.stage2 ?? false,
      vcpPass: bo.vcpPass ?? ex.vcpPass ?? false,
      rsRating: bo.rsRating ?? ex.rsRating ?? null,
      volSurgePct: bo.volSurgePct ?? null,
      volDryUp: bo.volDryUp ?? null,
      udVolRatio50: bo.udVolRatio50 ?? null,
      dmaStacked: (bo.s50 && bo.s150 && bo.s200) ? (bo.s50 > bo.s150 && bo.s150 > bo.s200) : false,
    };

    // Techno-fundamental classification
    const tf = evaluateTechnoFundamental(ticker, technicals, sidecars);

    // Entry timing & execution plan
    const et = evaluateEntryTiming(price, technicals, trig);

    // Calculate Anticipated Potential Growth %
    const p = price;
    const t2 = et.target2;
    let targetUpside = (p && t2 && t2 > p) ? Math.round(((t2 - p) / p) * 1000) / 10 : null;

    const apItem = sidecars.apexMap.get(ticker);
    const epsGwth5Y = (apItem?.epsGwth5Y && apItem.epsGwth5Y > 0 && apItem.epsGwth5Y < 250)
      ? Math.round(apItem.epsGwth5Y * 10) / 10
      : null;

    const crItem = sidecars.creamyMap.get(ticker);
    const earnBeat = crItem?.earnSurprisePct ? Math.round(crItem.earnSurprisePct * 10) / 10 : null;

    // Baseline technical target upside (15% - 40%)
    let anticipatedGrowthPct = targetUpside || 20.0;
    // Tier 1 Huge Potential stocks have high fundamental runway (at least 35%)
    if (tf.tier === 'HUGE_POTENTIAL') anticipatedGrowthPct = Math.max(anticipatedGrowthPct, 35.0);
    // If fundamental 5Y EPS CAGR is high, blend it into the anticipated growth projection
    if (epsGwth5Y && epsGwth5Y > anticipatedGrowthPct) {
      anticipatedGrowthPct = Math.round((anticipatedGrowthPct * 0.55 + epsGwth5Y * 0.45) * 10) / 10;
    }
    anticipatedGrowthPct = Math.round(anticipatedGrowthPct * 10) / 10;

    // Calculate Composite Attractiveness Score (0 - 99)
    let attrScore = 0;
    // 1. Potential Tier (max 35)
    if (tf.tier === 'HUGE_POTENTIAL') attrScore += 35;
    else if (tf.tier === 'COMPOUNDER') attrScore += 28;
    else if (tf.tier === 'MOMENTUM') attrScore += 22;
    else if (tf.tier === 'REVERSAL') attrScore += 20;
    else if (tf.tier === 'CORE') attrScore += 15;
    else attrScore += 10;

    // Add composite score normalized bonus (0-8)
    attrScore += Math.round(((tf.score || 50) / 100) * 8);

    // 2. Anticipated % Growth bonus (max 15 pts)
    const gBonus = Math.min(15, Math.max(2, Math.round((anticipatedGrowthPct / 40) * 14)));
    attrScore += gBonus;

    // 3. Entry Timing Window (max 30)
    if (et.code === 'PRIME_BUY_ZONE') attrScore += 30;
    else if (et.code === 'ARMED_COILING') attrScore += 28;
    else if (et.code === 'RECLAIM_200') attrScore += 24;
    else if (et.code === 'PULLBACK_50DMA' || et.code === 'SUPPORT_200DMA') attrScore += 22;
    else if (et.code === 'BASE_BUILDING') attrScore += 12;
    else if (et.code === 'EXTENDED') attrScore += 4;
    else if (et.code === 'AVOID_BELOW_200') attrScore += 0;

    // 4. Trend & Safety (max 12)
    if (technicals.aboveSma200 && technicals.sma200Up) attrScore += 7;
    else if (technicals.aboveSma200) attrScore += 4;
    else attrScore -= 14; // penalty for below 200 DMA

    if (technicals.stage2) attrScore += 3;
    if (technicals.rsRating && technicals.rsRating >= 75) attrScore += 2;

    attrScore = Math.max(5, Math.min(99, attrScore));

    // Price alert checks
    const aboveHit = al.above != null && price != null && price >= al.above;
    const belowHit = al.below != null && price != null && price <= al.below;

    return {
      ticker,
      name: al.name || m.fullName || ticker,
      fullName: m.fullName || al.name || ticker,
      watchlist: m.watchlist || '—',
      sector: tf.sector || '—',
      stockUrl: m.stockUrl || tickerUrlMap[ticker] || ('https://www.tickertape.in/search?q=' + encodeURIComponent(ticker)),
      price,
      changePct: pq.changePct ?? null,
      above: al.above ?? null,
      below: al.below ?? null,
      aboveHit,
      belowHit,
      triggered: aboveHit || belowHit,

      // Techno-Fundamental
      tfTier: tf.tier,
      tfTierLabel: tf.tierLabel,
      tfTierIcon: tf.tierIcon,
      tfTierBadgeClass: tf.tierBadgeClass,
      tfScore: tf.score,
      badges: tf.badges,
      rsRating: technicals.rsRating,
      stage2: technicals.stage2,

      // Attractiveness & Anticipated Growth
      attrScore,
      anticipatedGrowthPct,
      targetUpside,
      epsGwth5Y,
      earnBeat,

      // 200 DMA & Trend
      s50: technicals.s50,
      s150: technicals.s150,
      s200: technicals.s200,
      pctTo200: et.pctTo200,
      sma200Up: technicals.sma200Up,
      aboveSma200: technicals.aboveSma200,
      dma200Cross: technicals.dma200Cross,
      dmaStacked: technicals.dmaStacked,

      // Entry Timing Engine
      entryCode: et.code,
      entryBadge: et.badge,
      entryColor: et.color,
      entrySummary: et.summary,
      entryAction: et.action,
      entryPriority: et.priority,
      pivot: et.pivot,
      pctToPivot: et.pctToPivot,
      pctTo50: et.pctTo50,
      buyZoneMin: et.buyZoneMin,
      buyZoneMax: et.buyZoneMax,
      stopLoss: et.stopLoss,
      riskPct: et.riskPct,
      target1: et.target1,
      target2: et.target2,
      target1Pct: et.target1Pct,
      target2Pct: et.target2Pct,
      rr: et.rr,
      atrPct: technicals.atrPct,

      // 3M & 52W range
      low3m: technicals.low3m,
      high3m: technicals.high3m,
      low52: technicals.low52,
      high52: technicals.high52,
    };
  });

  // Sort stocks by Attractiveness & Anticipated Potential Growth descending
  stocks.sort((a, b) => (b.attrScore || 0) - (a.attrScore || 0));

  // Calculate Hero Summary Counts
  const primeCount = stocks.filter(s => s.entryCode === 'PRIME_BUY_ZONE' || s.entryCode === 'ARMED_COILING').length;
  const hugePotentialCount = stocks.filter(s => s.tfTier === 'HUGE_POTENTIAL').length;
  const dma200Count = stocks.filter(s => s.entryCode === 'RECLAIM_200' || s.entryCode === 'SUPPORT_200DMA').length;
  const triggeredCount = stocks.filter(s => s.triggered).length;

  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const dataJson = JSON.stringify({ stocks, updatedAt: new Date().toISOString() });

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Price Alerts & Techno-Fundamental Entry Timing</title>
<script>(function(){var s=localStorage.getItem('creamy-theme');var p=s||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',p)})();<\/script>
<style>
:root{--bg:#0c0c10;--s1:#0f0f15;--s2:#14141c;--s3:#1a1a26;--tx:#e4e4ea;--t2:#9898b0;--t3:#606078;--bd:#2a2a38;--ac:#00d4aa;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--pp:#a78bfa;--or:#f97316;--cy:#06b6d4;--bl:#3b82f6}
html[data-theme="light"]{--bg:#f4f5f7;--s1:#ffffff;--s2:#ffffff;--s3:#f0f0f5;--tx:#111118;--t2:#505068;--t3:#8888a0;--bd:#dcdce8;--ac:#009980;--gn:#16a34a;--rd:#dc2626;--yw:#ca8a04;--pp:#7c3aed;--or:#ea580c;--cy:#0891b2;--bl:#2563eb}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);min-height:100vh;font-size:14px}

.header{display:flex;justify-content:space-between;align-items:center;padding:14px 28px;border-bottom:1px solid var(--bd);background:var(--s1);position:sticky;top:0;z-index:100}
.header h1{font-size:1.15rem;font-weight:700;color:var(--tx);display:flex;align-items:center;gap:8px}
.header h1 span.bell{color:var(--yw)}
.header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.nav-link{color:var(--t2);text-decoration:none;font-size:.8rem;padding:6px 12px;border:1px solid var(--bd);border-radius:6px;transition:all .2s;white-space:nowrap}
.nav-link:hover{color:var(--ac);border-color:var(--ac)}
.nav-link.active{color:var(--ac);border-color:var(--ac);background:rgba(0,212,170,.06)}
.theme-btn{background:none;border:1px solid var(--bd);border-radius:6px;padding:5px 10px;cursor:pointer;color:var(--t2);font-size:.8rem;transition:all .2s}
.theme-btn:hover{color:var(--ac);border-color:var(--ac)}

.page-hero{padding:24px 28px 18px;border-bottom:1px solid var(--bd);background:linear-gradient(180deg,var(--s1) 0%,var(--bg) 100%)}
.page-hero h2{font-size:1.45rem;font-weight:700;color:var(--tx);margin-bottom:6px}
.page-hero p{color:var(--t2);font-size:.88rem;max-width:960px;line-height:1.5}
.hero-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:16px}
.hero-stat{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:12px 14px;text-align:center;transition:transform .15s}
.hero-stat:hover{transform:translateY(-2px);border-color:var(--ac)}
.hero-stat .hs-val{font-size:1.5rem;font-weight:800;letter-spacing:-.02em}
.hero-stat .hs-lbl{font-size:.68rem;color:var(--t2);text-transform:uppercase;letter-spacing:.06em;margin-top:4px;font-weight:600}

/* Filter Bar & Controls */
.controls-bar{padding:14px 28px;background:var(--s1);border-bottom:1px solid var(--bd);display:flex;gap:14px;align-items:center;flex-wrap:wrap;justify-content:space-between}
.filter-pills{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.filter-pill{background:var(--s2);border:1px solid var(--bd);border-radius:20px;padding:6px 12px;font-size:.76rem;color:var(--t2);cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:5px;font-weight:600}
.filter-pill:hover{border-color:var(--ac);color:var(--tx)}
.filter-pill.active{background:var(--ac);color:#000;border-color:var(--ac)}
.filter-pill .count{background:rgba(255,255,255,.15);padding:1px 6px;border-radius:10px;font-size:.68rem}
.filter-pill.active .count{background:rgba(0,0,0,.25);color:#000}

.search-sort-box{display:flex;gap:8px;align-items:center}
.search-input{background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:6px 12px;color:var(--tx);font-size:.8rem;outline:none;width:180px;transition:border-color .2s}
.search-input:focus{border-color:var(--ac);width:220px}
.sort-select{background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:6px 10px;color:var(--tx);font-size:.78rem;outline:none;cursor:pointer}

.content{padding:22px 28px}
.alerts-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:16px}

/* Enhanced Alert Card */
.alert-card{background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;transition:all .2s;position:relative}
.alert-card:hover{border-color:var(--ac);box-shadow:0 8px 24px rgba(0,0,0,.25)}
.alert-card.is-triggered{border-color:rgba(239,68,68,.6);background:rgba(239,68,68,.02)}
.alert-card.hit-above{border-color:rgba(34,197,94,.6);background:rgba(34,197,94,.02)}
.alert-card.card-prime{border-color:rgba(34,197,94,.5);box-shadow:0 0 16px rgba(34,197,94,.12)}
.alert-card.card-armed{border-color:rgba(234,179,8,.5)}
.alert-card.card-reversal{border-color:rgba(167,139,250,.5)}
.alert-card.card-avoid{border-color:rgba(239,68,68,.35);opacity:.9}

/* Ribbons & Header */
.ac-top-ribbon{display:flex;justify-content:space-between;align-items:center;gap:6px}
.tier-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.tier-huge{background:rgba(234,179,8,.15);color:var(--yw);border:1px solid rgba(234,179,8,.3)}
.tier-compounder{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.3)}
.tier-momentum{background:rgba(6,182,212,.12);color:var(--cy);border:1px solid rgba(6,182,212,.3)}
.tier-reversal{background:rgba(167,139,250,.12);color:var(--pp);border:1px solid rgba(167,139,250,.3)}
.tier-core{background:rgba(59,130,246,.12);color:var(--bl);border:1px solid rgba(59,130,246,.3)}
.tier-neutral{background:var(--s3);color:var(--t2);border:1px solid var(--bd)}
.attr-score-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:.68rem;font-weight:800;background:rgba(234,179,8,.18);border:1px solid rgba(234,179,8,.45);color:var(--yw);letter-spacing:.02em}
.growth-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:.68rem;font-weight:800;background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.45);color:var(--gn);letter-spacing:.02em}

.ac-meta-tags{display:flex;align-items:center;gap:6px}
.sector-tag{font-size:.65rem;color:var(--t3);background:var(--s3);padding:2px 6px;border-radius:4px;border:1px solid var(--bd)}
.wl-tag{font-size:.65rem;color:var(--t2);background:var(--s3);padding:2px 6px;border-radius:4px;border:1px solid var(--bd)}

/* Price Block */
.ac-title-row{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.ac-stock-info{flex:1;min-width:0}
.ac-name{font-size:.95rem;font-weight:700;line-height:1.3;display:flex;align-items:center;gap:4px;min-width:0}
.ac-name a, .ac-name span.name-txt{color:var(--tx);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ac-name a:hover{color:var(--ac)}
.ac-ticker-line{font-size:.75rem;color:var(--t2);margin-top:2px;display:flex;align-items:center;gap:6px}

.ac-price-info{text-align:right;flex-shrink:0}
.ac-price{font-size:1.25rem;font-weight:800;letter-spacing:-.01em}
.ac-change{font-size:.76rem;font-weight:700;margin-top:1px}
.pos{color:var(--gn)}
.neg{color:var(--rd)}

/* Entry Status Banner */
.entry-banner{padding:9px 12px;border-radius:8px;font-size:.78rem;line-height:1.4;display:flex;flex-direction:column;gap:3px;border:1px solid transparent}
.banner-title{font-weight:700;display:flex;align-items:center;gap:6px}
.banner-text{color:var(--t2);font-size:.72rem}
.banner-action{font-weight:600;font-size:.72rem;margin-top:2px}

.banner-green{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.35);color:var(--gn)}
.banner-green .banner-action{color:#86efac}
.banner-amber{background:rgba(234,179,8,.1);border-color:rgba(234,179,8,.35);color:var(--yw)}
.banner-amber .banner-action{color:#fde047}
.banner-purple{background:rgba(167,139,250,.1);border-color:rgba(167,139,250,.35);color:var(--pp)}
.banner-purple .banner-action{color:#c4b5fd}
.banner-cyan{background:rgba(6,182,212,.1);border-color:rgba(6,182,212,.35);color:var(--cy)}
.banner-cyan .banner-action{color:#67e8f9}
.banner-blue{background:rgba(59,130,246,.1);border-color:rgba(59,130,246,.35);color:var(--bl)}
.banner-blue .banner-action{color:#93c5fd}
.banner-orange{background:rgba(249,115,22,.1);border-color:rgba(249,115,22,.35);color:var(--or)}
.banner-orange .banner-action{color:#fdba74}
.banner-red{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.35);color:var(--rd)}
.banner-red .banner-action{color:#fca5a5}
.banner-slate{background:var(--s3);border-color:var(--bd);color:var(--tx)}
.banner-slate .banner-action{color:var(--t2)}

/* Trade Execution Blueprint */
.trade-plan{background:var(--s3);border:1px solid var(--bd);border-radius:8px;padding:9px 12px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center}
.tp-item .tp-lbl{font-size:.62rem;color:var(--t2);text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.tp-item .tp-val{font-size:.82rem;font-weight:700;margin-top:2px}
.tp-item .tp-sub{font-size:.62rem;color:var(--t3);margin-top:1px}

/* 200 DMA & Trend Indicator */
.dma-row{display:flex;justify-content:space-between;align-items:center;background:var(--s1);border:1px solid var(--bd);border-radius:6px;padding:6px 10px;font-size:.74rem}
.dma-lbl{color:var(--t2);display:flex;align-items:center;gap:4px}
.dma-val{font-weight:700}
.dma-trend{font-size:.7rem;font-weight:600}

/* Fundamental & Technical Badges */
.badges-wrap{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.badge-pill{font-size:.65rem;padding:2px 7px;border-radius:4px;background:var(--s3);color:var(--t2);border:1px solid var(--bd);font-weight:600;display:inline-flex;align-items:center;gap:3px}
.badge-pill.stage2{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.3);color:var(--gn)}
.badge-pill.rs{background:rgba(99,102,241,.12);border-color:rgba(99,102,241,.35);color:#a5b4fc}

/* Targets Block */
.ac-targets{display:flex;flex-direction:column;gap:5px}
.ac-target{display:flex;justify-content:space-between;align-items:center;padding:6px 9px;border-radius:6px;font-size:.78rem;background:var(--s3);border:1px solid transparent}
.ac-target.hit{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3)}
.ac-target.hit.above-hit{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.3)}
.ac-target-val{font-weight:700}
.ac-target.hit .ac-target-val{color:var(--rd)}
.ac-target.hit.above-hit .ac-target-val{color:var(--gn)}
.ac-hit-badge{display:inline-block;background:var(--rd);color:#fff;font-size:.6rem;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:6px;letter-spacing:.04em}
.ac-hit-badge.above{background:var(--gn)}

/* Range Bar */
.ac-range-row{display:flex;justify-content:space-between;font-size:.68rem;color:var(--t3);margin-bottom:4px}
.range-bar{width:100%;height:5px;background:var(--s3);border-radius:3px;position:relative;display:block}
.range-bar .fill{height:100%;border-radius:3px;position:absolute;left:0;top:0}
.range-bar .marker{position:absolute;top:-3px;width:2px;height:11px;border-radius:1px}

/* Actions */
.ac-actions{display:flex;gap:6px;margin-top:2px}
.ac-edit-btn{flex:1;padding:6px 0;border:1px solid var(--bd);border-radius:6px;background:transparent;color:var(--t2);cursor:pointer;font-size:.76rem;font-weight:600;font-family:inherit;transition:all .2s}
.ac-edit-btn:hover{border-color:var(--ac);color:var(--ac)}
.ac-del-btn{padding:6px 12px;border:1px solid rgba(239,68,68,.3);border-radius:6px;background:transparent;color:var(--rd);cursor:pointer;font-size:.76rem;font-weight:600;font-family:inherit;transition:all .2s}
.ac-del-btn:hover{background:rgba(239,68,68,.1)}

.empty-state{text-align:center;padding:60px 20px;color:var(--t2);grid-column:1/-1}
.empty-state .es-icon{font-size:2.5rem;margin-bottom:12px}
.footer{text-align:center;padding:18px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd)}

${stockActions.css}
${TOOLTIP_CSS}
#ap-modal{width:300px}

@media(max-width:768px){
  .header{padding:12px 14px}
  .page-hero{padding:16px 14px}
  .controls-bar{padding:10px 14px}
  .content{padding:14px}
  .alerts-grid{grid-template-columns:1fr}
  .trade-plan{grid-template-columns:repeat(2,1fr)}
}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1><span class="bell">&#x1F514;</span> Price Alerts & Techno-Fundamental Timing</h1>
    <div style="font-size:.72rem;color:var(--t2);margin-top:2px">Generated: ${now} IST</div>
  </div>
  <div class="header-right">
    ${HUB_BACK_LINK.replace('back-link', 'nav-link')}
    <a href="index.html" class="nav-link">Dashboard</a>
    <a href="apex.html" class="nav-link" style="color:#6366f1;border-color:rgba(99,102,241,.4)">&#x1F52E; APEX</a>
    <a href="creamy.html" class="nav-link">Creamy Layer</a>
    <a href="multibagger.html" class="nav-link" style="color:#f59e0b;border-color:rgba(245,158,11,.4)">&#x1F3C6; Multibagger</a>
    <a href="breakout2.html" class="nav-link" style="color:#06b6d4;border-color:rgba(6,182,212,.4)">&#x26A1; Breakout GEN2</a>
    <a href="triggers.html" class="nav-link" style="color:#22c55e;border-color:rgba(34,197,94,.4)">&#x1F3AF; Triggers</a>
    <a href="confluence.html" class="nav-link" style="color:#8b5cf6;border-color:rgba(139,92,246,.4)">&#x26A1; Confluence</a>
    <button class="theme-btn" id="theme-btn">&#x263D; Theme</button>
  </div>
</div>

${legendHtml('How to use this Techno-Fundamental Command Center (tap to expand)', [
  {
    title: 'Techno-Fundamental Potential Tiers',
    bodyHtml: `<p><b>🚀 Huge Potential</b>: High-growth leader meeting strict fundamental criteria (Multibagger Score &ge; 75, APEX &ge; 75, or Accelerating Growth badge + Stage 2 uptrend).<br>
    <b>🏆 Quality Compounder</b>: Proven balance sheet strength, fortress solvency, high ROE/ROCE, and FCF compounding.<br>
    <b>⚡ Momentum Leader</b>: High relative strength (RS &ge; 80) with heavy institutional volume accumulation.</p>`,
  },
  {
    title: 'Optimal Entry Timing & Buy Zones',
    bodyHtml: `<p><b>🎯 Prime Entry (In Buy Zone)</b>: Price is 0% to +3.5% above pivot with volume confirmation. Optimal risk-to-reward window.<br>
    <b>⏳ Armed (Coiling)</b>: Sitting 0% to -2.5% below pivot with volatility contracting. Set Buy-Stop Limit order.<br>
    <b>🛡️ 50 DMA Pullback</b>: High-momentum Stage 2 stock testing its rising 50-day moving average on low volume.<br>
    <b>⚠️ Extended</b>: Rallied &gt;5% past pivot. High chase risk — wait for consolidation.</p>`,
  },
  {
    title: 'The 200-Day DMA (DMA200) Structural Rule',
    bodyHtml: `<p><b>🔄 200 DMA Reclaim</b>: High-growth stock crossing back above its 200 DMA on volume. Early turnaround entry with tight stop.<br>
    <b>🛡️ 200 DMA Floor</b>: Long-term institutional floor test on rising 200 DMA.<br>
    <b>🛑 Avoid Below 200 DMA</b>: Capital protection guardrail — avoid buying when price is below a declining 200 DMA.</p>`,
  },
])}

${stockActions.bannerHtml}
${stockActions.modalHtml}
${stockActions.researchModalHtml}

<div class="page-hero">
  <h2>Smart Alerts & Techno-Fundamental Timing</h2>
  <p>Continuous monitoring of your watchlist targets, high-growth potential tiers, 200-day moving average health, and precise Buy Zones with Stop Loss &amp; Target execution blueprints.</p>
  <div class="hero-meta">
    <div class="hero-stat">
      <div class="hs-val" id="stat-total">${tickers.length}</div>
      <div class="hs-lbl tip" tabindex="0" data-tip="Total alerted stocks currently monitored.">Configured</div>
    </div>
    <div class="hero-stat">
      <div class="hs-val" style="color:var(--gn)" id="stat-prime">${primeCount}</div>
      <div class="hs-lbl tip" tabindex="0" data-tip="Stocks right now in optimal Buy Zone or Armed coiling for breakout.">🎯 Best Entries</div>
    </div>
    <div class="hero-stat">
      <div class="hs-val" style="color:var(--yw)" id="stat-huge">${hugePotentialCount}</div>
      <div class="hs-lbl tip" tabindex="0" data-tip="Stocks passing strict high-growth & multibagger potential filters.">🚀 Huge Potential</div>
    </div>
    <div class="hero-stat">
      <div class="hs-val" style="color:var(--pp)" id="stat-dma200">${dma200Count}</div>
      <div class="hs-lbl tip" tabindex="0" data-tip="Stocks testing 200 DMA support or completing a fresh 200 DMA reclaim.">🔄 200 DMA Setups</div>
    </div>
    <div class="hero-stat">
      <div class="hs-val" style="color:var(--rd)" id="stat-triggered">${triggeredCount}</div>
      <div class="hs-lbl tip" tabindex="0" data-tip="Alerts where live price crossed your above/below target.">🔔 Targets Crossed</div>
    </div>
  </div>
</div>

<div class="controls-bar">
  <div class="filter-pills" id="filter-pills">
    <button class="filter-pill active" data-filter="all">All <span class="count" id="cnt-all">${tickers.length}</span></button>
    <button class="filter-pill" data-filter="prime">🎯 Best Entries <span class="count" id="cnt-prime">${primeCount}</span></button>
    <button class="filter-pill" data-filter="huge">🚀 Huge Potential <span class="count" id="cnt-huge">${hugePotentialCount}</span></button>
    <button class="filter-pill" data-filter="dma200">🔄 200 DMA Setups <span class="count" id="cnt-dma200">${dma200Count}</span></button>
    <button class="filter-pill" data-filter="pullback">🛡️ 50 DMA Pullbacks <span class="count" id="cnt-pullback">0</span></button>
    <button class="filter-pill" data-filter="triggered">🔔 Targets Hit <span class="count" id="cnt-triggered">${triggeredCount}</span></button>
    <button class="filter-pill" data-filter="extended">⚠️ Extended <span class="count" id="cnt-extended">0</span></button>
    <button class="filter-pill" data-filter="avoid">🛑 Below 200 DMA <span class="count" id="cnt-avoid">0</span></button>
  </div>
  <div class="search-sort-box">
    <input type="text" class="search-input" id="search-input" placeholder="Search ticker or name...">
    <select class="sort-select" id="sort-select">
      <option value="attr">Sort: Highest Potential &amp; Attractiveness (Default)</option>
      <option value="growth">Sort: Anticipated Growth % (High to Low)</option>
      <option value="entry">Sort: Best Entry Timing</option>
      <option value="score">Sort: Potential Tier Score</option>
      <option value="pivot">Sort: Closest to Breakout</option>
      <option value="dma200">Sort: Closest to 200 DMA</option>
      <option value="change">Sort: Day Change %</option>
      <option value="triggered">Sort: Targets Crossed First</option>
      <option value="alpha">Sort: Ticker (A-Z)</option>
    </select>
  </div>
</div>

<div class="content">
  <div class="alerts-grid" id="alerts-container"></div>
</div>

<div class="footer">
  Price Alerts &amp; Techno-Fundamental Entry Timing Engine &nbsp;·&nbsp; Checked continuously during NSE market hours (Mon–Fri, 9:15 AM–3:30 PM IST) &nbsp;·&nbsp;
  <a href="index.html" style="color:var(--ac);text-decoration:none">Dashboard</a>
</div>

<script>
var PAGE_DATA = ${dataJson};
window._GH_ALERTS_REPO = 'amitiyer99/watchlist-app';

function fmt2(n){ return n == null || isNaN(n) ? '—' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtPct(n){ if(n == null || isNaN(n)) return '—'; return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%'; }
function escapeHtml(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function escAttr(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function buildAlertPanel(s){
  var p = s.price;
  var pxStr = (p != null && !isNaN(p)) ? '₹' + Number(p).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
  var m1 = [
    ['Potential Tier', (s.tfTierIcon || '') + ' ' + (s.tfTierLabel || 'Watchlist'), s.sector || '', s.tfTier === 'HUGE_POTENTIAL' ? 'pos' : ''],
    ['Attractiveness Rank', (s.attrScore || 50) + '/100', 'Composite score', (s.attrScore || 0) >= 70 ? 'pos' : ''],
    ['Anticipated Growth', (s.anticipatedGrowthPct ? '+' + s.anticipatedGrowthPct + '%' : '—'), s.epsGwth5Y ? ('5Y EPS CAGR +' + s.epsGwth5Y + '%') : 'Technical target', 'pos'],
    ['Entry Window', s.entryBadge || '—', s.entryAction || '', (s.entryCode === 'PRIME_BUY_ZONE' || s.entryCode === 'ARMED_COILING') ? 'pos' : (s.entryCode === 'AVOID_BELOW_200' ? 'neg' : '')],
    ['200-Day DMA', s.s200 != null ? '₹' + Number(s.s200).toFixed(2) : '—', (s.pctTo200 != null ? (s.pctTo200 >= 0 ? '+' : '') + s.pctTo200.toFixed(1) + '% ' + (s.aboveSma200 ? 'above' : 'below') : '') + (s.sma200Up ? ' · ↗ Rising' : ' · ↘ Declining'), s.aboveSma200 ? 'pos' : 'neg'],
    ['Last Price', pxStr, s.changePct != null ? (s.changePct >= 0 ? '+' : '') + s.changePct.toFixed(2) + '%' : '', s.changePct >= 0 ? 'pos' : 'neg']
  ];
  var m2 = [];
  if(s.buyZoneMin != null || s.pivot != null){
    m2.push(['Buy Zone', s.buyZoneMin != null ? (s.buyZoneMin === s.buyZoneMax ? '₹' + Number(s.buyZoneMin).toFixed(2) : '₹' + Number(s.buyZoneMin).toFixed(2) + ' – ' + Number(s.buyZoneMax).toFixed(2)) : '—', s.pivot ? 'Pivot: ₹' + Number(s.pivot).toFixed(2) : '', '']);
    m2.push(['Stop Loss', s.stopLoss != null ? '₹' + Number(s.stopLoss).toFixed(2) : '—', s.riskPct != null ? '-' + s.riskPct + '%' : '', 'neg']);
    m2.push(['Targets (2R/3R)', s.target1 != null ? '₹' + Number(s.target1).toFixed(2) + (s.target2 ? ' / ' + Number(s.target2).toFixed(2) : '') : '—', '', 'pos']);
    m2.push(['Reward : Risk', s.rr ? String(s.rr) : '1:2.5', '', 'pos']);
  }
  var s1 = [];
  if(s.entrySummary){
    var tone = (s.entryCode === 'PRIME_BUY_ZONE' || s.entryCode === 'ARMED_COILING' || s.entryCode === 'RECLAIM_200') ? 'bull' : (s.entryCode === 'AVOID_BELOW_200' ? 'bear' : 'neut');
    s1.push([tone, s.entryBadge ? s.entryBadge.slice(0, 2) : '◆', s.entrySummary + (s.entryAction ? ' — ' + s.entryAction : '')]);
  }
  if(s.aboveSma200 && s.sma200Up){
    s1.push(['bull', '▲', 'Trading above rising 200-day DMA — structural long-term trend intact']);
  } else if(s.s200 != null && !s.aboveSma200){
    s1.push(['bear', '🛑', 'Trading below 200-day DMA — capital protection alert, wait for reclaim']);
  }
  if(s.stage2){
    s1.push(['bull', '📈', 'Confirmed Stage 2 uptrend with moving averages stacked in bullish alignment']);
  }
  if(s.rsRating && s.rsRating >= 75){
    s1.push(['bull', '⚡', 'Relative Strength rating ' + s.rsRating + '/99 outperforming broader market']);
  }
  (s.badges || []).forEach(function(b){
    s1.push(['bull', b.icon || '✓', b.label + (b.detail ? ' (' + b.detail + ')' : '')]);
  });
  if(s.above != null){
    s1.push([s.aboveHit ? 'bull' : 'neut', s.aboveHit ? '🎯' : '🔔', 'Alert Above ₹' + Number(s.above).toFixed(2) + (s.aboveHit ? ' — TRIGGERED' : '')]);
  }
  if(s.below != null){
    s1.push([s.belowHit ? 'bear' : 'neut', s.belowHit ? '⚠️' : '🔔', 'Alert Below ₹' + Number(s.below).toFixed(2) + (s.belowHit ? ' — TRIGGERED' : '')]);
  }
  var secs = [
    { t: '📊 Techno-Fundamental & Timing', m: m1, s: [] }
  ];
  if(m2.length){
    secs.push({ t: '📐 Trade Plan & Buy Zone', m: m2, s: [] });
  }
  if(s1.length){
    secs.push({ t: '⚡ Technical & Flow Signals', m: [], s: s1 });
  }
  return escAttr(JSON.stringify(secs));
}

var currentFilter = 'all';
var currentSort = 'attr';
var searchQuery = '';

function renderCards(){
  var alerts = window._GA || {};
  var tickers = Object.keys(alerts);
  var byTicker = {};
  PAGE_DATA.stocks.forEach(function(s){ byTicker[s.ticker] = s; });

  // Merge any runtime _GA additions
  tickers.forEach(function(t){
    if(!byTicker[t]){
      byTicker[t] = {
        ticker: t, name: alerts[t].name || t, fullName: alerts[t].name || t, watchlist: '—', sector: '—', stockUrl: '',
        price: null, changePct: null, above: alerts[t].above, below: alerts[t].below, triggered: false,
        tfTier: 'NEUTRAL', tfTierLabel: 'Watchlist Stock', tfTierIcon: '👁️', tfTierBadgeClass: 'tier-neutral', tfScore: 50,
        badges: [], rsRating: null, stage2: false, s50: null, s150: null, s200: null, pctTo200: null,
        entryCode: 'BASE_BUILDING', entryBadge: '💤 Base Forming', entryColor: 'slate',
        entrySummary: 'Newly added alert', entryAction: 'Waiting for market data refresh', entryPriority: 5,
        pivot: null, pctToPivot: null, buyZoneMin: null, buyZoneMax: null, stopLoss: null, target1: null, target2: null, rr: '1:2.5'
      };
    } else {
      byTicker[t].above = alerts[t].above;
      byTicker[t].below = alerts[t].below;
    }
  });

  var allList = Object.values(byTicker);

  // Re-evaluate Triggered status against live price
  var triggeredCount = 0;
  var primeCount = 0;
  var hugeCount = 0;
  var dma200Count = 0;
  var pullbackCount = 0;
  var extendedCount = 0;
  var avoidCount = 0;

  allList.forEach(function(s){
    var p = s.price;
    var ah = s.above != null && p != null && p >= s.above;
    var bh = s.below != null && p != null && p <= s.below;
    s.aboveHit = ah;
    s.belowHit = bh;
    s.triggered = ah || bh;

    if(s.triggered) triggeredCount++;
    if(s.entryCode === 'PRIME_BUY_ZONE' || s.entryCode === 'ARMED_COILING') primeCount++;
    if(s.tfTier === 'HUGE_POTENTIAL') hugeCount++;
    if(s.entryCode === 'RECLAIM_200' || s.entryCode === 'SUPPORT_200DMA') dma200Count++;
    if(s.entryCode === 'PULLBACK_50DMA') pullbackCount++;
    if(s.entryCode === 'EXTENDED') extendedCount++;
    if(s.entryCode === 'AVOID_BELOW_200') avoidCount++;
  });

  // Update hero stats & pill counts
  var setTxt = function(id, v){ var el = document.getElementById(id); if(el) el.textContent = v; };
  setTxt('stat-total', allList.length);
  setTxt('stat-prime', primeCount);
  setTxt('stat-huge', hugeCount);
  setTxt('stat-dma200', dma200Count);
  setTxt('stat-triggered', triggeredCount);

  setTxt('cnt-all', allList.length);
  setTxt('cnt-prime', primeCount);
  setTxt('cnt-huge', hugeCount);
  setTxt('cnt-dma200', dma200Count);
  setTxt('cnt-pullback', pullbackCount);
  setTxt('cnt-triggered', triggeredCount);
  setTxt('cnt-extended', extendedCount);
  setTxt('cnt-avoid', avoidCount);

  // Filter
  var filtered = allList.filter(function(s){
    if(searchQuery){
      var q = searchQuery.toLowerCase();
      var match = s.ticker.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || (s.sector && s.sector.toLowerCase().includes(q));
      if(!match) return false;
    }
    if(currentFilter === 'all') return true;
    if(currentFilter === 'prime') return s.entryCode === 'PRIME_BUY_ZONE' || s.entryCode === 'ARMED_COILING';
    if(currentFilter === 'huge') return s.tfTier === 'HUGE_POTENTIAL';
    if(currentFilter === 'dma200') return s.entryCode === 'RECLAIM_200' || s.entryCode === 'SUPPORT_200DMA';
    if(currentFilter === 'pullback') return s.entryCode === 'PULLBACK_50DMA';
    if(currentFilter === 'triggered') return s.triggered;
    if(currentFilter === 'extended') return s.entryCode === 'EXTENDED';
    if(currentFilter === 'avoid') return s.entryCode === 'AVOID_BELOW_200';
    return true;
  });

  // Sort
  filtered.sort(function(a, b){
    if(currentSort === 'attr'){
      return (b.attrScore || 0) - (a.attrScore || 0);
    }
    if(currentSort === 'growth'){
      return (b.anticipatedGrowthPct || 0) - (a.anticipatedGrowthPct || 0);
    }
    if(currentSort === 'entry'){
      if(a.entryPriority !== b.entryPriority) return a.entryPriority - b.entryPriority;
      return (b.tfScore || 0) - (a.tfScore || 0);
    }
    if(currentSort === 'score') return (b.tfScore || 0) - (a.tfScore || 0);
    if(currentSort === 'pivot'){
      var ap = a.pctToPivot != null ? Math.abs(a.pctToPivot) : 999;
      var bp = b.pctToPivot != null ? Math.abs(b.pctToPivot) : 999;
      return ap - bp;
    }
    if(currentSort === 'dma200'){
      var ad = a.pctTo200 != null ? Math.abs(a.pctTo200) : 999;
      var bd = b.pctTo200 != null ? Math.abs(b.pctTo200) : 999;
      return ad - bd;
    }
    if(currentSort === 'change') return (b.changePct || -999) - (a.changePct || -999);
    if(currentSort === 'triggered'){
      if(a.triggered !== b.triggered) return a.triggered ? -1 : 1;
      return a.ticker.localeCompare(b.ticker);
    }
    if(currentSort === 'alpha') return a.ticker.localeCompare(b.ticker);
    return 0;
  });

  if(!filtered.length){
    document.getElementById('alerts-container').innerHTML =
      '<div class="empty-state"><div class="es-icon">&#x1F50D;</div><h3>No matching stocks found</h3><p>Try adjusting your search query or switching active filter tabs.</p></div>';
    return;
  }

  var html = filtered.map(function(s){
    var p = s.price;
    var isTrig = s.triggered;
    var cardClasses = ['alert-card'];
    if(isTrig) cardClasses.push(s.aboveHit ? 'hit-above' : 'is-triggered');
    if(s.entryCode === 'PRIME_BUY_ZONE') cardClasses.push('card-prime');
    else if(s.entryCode === 'ARMED_COILING') cardClasses.push('card-armed');
    else if(s.entryCode === 'RECLAIM_200') cardClasses.push('card-reversal');
    else if(s.entryCode === 'AVOID_BELOW_200') cardClasses.push('card-avoid');

    // 200 DMA Details
    var dmaStatusText = '—';
    var dmaClass = '';
    if(s.s200 != null && p != null){
      var dist = ((p - s.s200) / s.s200) * 100;
      var slopeText = s.sma200Up ? '↗ Rising' : '↘ Declining';
      dmaStatusText = fmt2(s.s200) + ' (' + (dist >= 0 ? '+' : '') + dist.toFixed(1) + '% ' + (dist >= 0 ? 'above' : 'below') + ') · ' + slopeText;
      dmaClass = dist >= 0 ? 'pos' : 'neg';
    }

    // Trade Plan
    var tpEntry = s.buyZoneMin != null ? (s.buyZoneMin === s.buyZoneMax ? fmt2(s.buyZoneMin) : fmt2(s.buyZoneMin) + ' – ' + fmt2(s.buyZoneMax)) : '—';
    var tpStop = s.stopLoss != null ? fmt2(s.stopLoss) : '—';
    var tpTarget = s.target1 != null ? fmt2(s.target1) + (s.target2 ? ' / ' + fmt2(s.target2) : '') : '—';
    var tpRiskPct = s.riskPct != null ? '-' + s.riskPct + '%' : '';

    // Badges HTML
    var badgesHtml = '';
    if(s.stage2) badgesHtml += '<span class="badge-pill stage2">Stage 2</span>';
    if(s.rsRating) badgesHtml += '<span class="badge-pill rs">RS ' + s.rsRating + '</span>';
    if(s.badges && s.badges.length){
      s.badges.slice(0, 3).forEach(function(b){
        badgesHtml += '<span class="badge-pill">' + escapeHtml(b.icon || '') + ' ' + escapeHtml(b.label || '') + '</span>';
      });
    }

    // User Target rows
    var targetsHtml = '';
    if(s.above != null){
      var hit = s.aboveHit;
      targetsHtml += '<div class="ac-target' + (hit ? ' hit above-hit' : '') + '"><span class="ac-target-label">&#x25B2; Alert Above</span><span class="ac-target-val">' + fmt2(s.above) + (hit ? '<span class="ac-hit-badge above">HIT</span>' : '') + '</span></div>';
    }
    if(s.below != null){
      var hit2 = s.belowHit;
      targetsHtml += '<div class="ac-target' + (hit2 ? ' hit' : '') + '"><span class="ac-target-label">&#x25BC; Alert Below</span><span class="ac-target-val">' + fmt2(s.below) + (hit2 ? '<span class="ac-hit-badge">HIT</span>' : '') + '</span></div>';
    }

    // Range Slider (3M Range, with automatic 52W fallback)
    var rangeHtml = '';
    var rLow = (s.low3m != null && !isNaN(s.low3m)) ? s.low3m : s.low52;
    var rHigh = (s.high3m != null && !isNaN(s.high3m)) ? s.high3m : s.high52;
    var rLabel = (s.low3m != null && !isNaN(s.low3m)) ? '3M' : '52W';

    if(rLow != null && rHigh != null && rHigh > rLow && p != null){
      var rng = rHigh - rLow;
      var pct = Math.max(0, Math.min(100, (p - rLow) / rng * 100));
      var col = pct <= 15 ? 'var(--rd)' : pct <= 40 ? 'var(--yw)' : pct <= 75 ? 'var(--ac)' : 'var(--gn)';
      var abPct = s.above != null ? Math.max(0, Math.min(100, (s.above - rLow) / rng * 100)) : null;
      var blPct = s.below != null ? Math.max(0, Math.min(100, (s.below - rLow) / rng * 100)) : null;

      rangeHtml = '<div style="margin-top:4px">' +
        '<div class="ac-range-row"><span>' + rLabel + ' Low: ' + fmt2(rLow) + '</span><span>' + rLabel + ' High: ' + fmt2(rHigh) + '</span></div>' +
        '<div class="range-bar">' +
        '<div class="fill" style="width:' + pct.toFixed(1) + '%;background:' + col + '"></div>' +
        (abPct != null ? '<div class="marker" style="left:' + abPct.toFixed(1) + '%;background:var(--gn)" title="Above target"></div>' : '') +
        (blPct != null ? '<div class="marker" style="left:' + blPct.toFixed(1) + '%;background:var(--rd)" title="Below target"></div>' : '') +
        '</div></div>';
    }

    var nameLink = s.stockUrl
      ? '<a href="' + escapeHtml(s.stockUrl) + '" target="_blank" title="' + escapeHtml(s.fullName) + '">' + escapeHtml(s.fullName) + '</a>'
      : '<span class="name-txt" title="' + escapeHtml(s.fullName) + '">' + escapeHtml(s.fullName) + '</span>';

    return '<div class="' + cardClasses.join(' ') + '" id="ac-' + escapeHtml(s.ticker) + '">' +
      '<div class="ac-top-ribbon">' +
        '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">' +
          '<span class="tier-badge ' + s.tfTierBadgeClass + '">' + s.tfTierIcon + ' ' + s.tfTierLabel + '</span>' +
          '<span class="attr-score-badge tip" tabindex="0" data-tip="Attractiveness &amp; Opportunity Rank (0-100) combining Potential, Entry Window, and Trend Safety">&#x1F525; ' + (s.attrScore || 50) + '/100</span>' +
          (s.anticipatedGrowthPct ? '<span class="growth-badge tip" tabindex="0" data-tip="Anticipated potential growth based on technical targets &amp; fundamental trajectory">&#x1F680; +' + s.anticipatedGrowthPct + '% Pot. Growth</span>' : '') +
        '</div>' +
        '<div class="ac-meta-tags">' +
          (s.sector && s.sector !== '—' ? '<span class="sector-tag">' + escapeHtml(s.sector) + '</span>' : '') +
          (s.watchlist && s.watchlist !== '—' ? '<span class="wl-tag">' + escapeHtml(s.watchlist) + '</span>' : '') +
        '</div>' +
      '</div>' +

      '<div class="ac-title-row">' +
        '<div class="ac-stock-info">' +
          '<div class="ac-name">' +
            nameLink +
            '<button type="button" class="research-btn" data-r-ticker="' + escapeHtml(s.ticker) + '" data-r-name="' + escapeHtml(s.fullName) + '" data-r-price="' + (p || 0) + '" data-r-panel="' + buildAlertPanel(s) + '" title="AI Deep Research">&#x1F9E0;</button>' +
          '</div>' +
          '<div class="ac-ticker-line"><b>' + escapeHtml(s.ticker) + '</b></div>' +
        '</div>' +
        '<div class="ac-price-info">' +
          '<div class="ac-price ' + (s.changePct >= 0 ? 'pos' : 'neg') + '">' + fmt2(p) + '</div>' +
          '<div class="ac-change ' + (s.changePct >= 0 ? 'pos' : 'neg') + '">' + fmtPct(s.changePct) + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="entry-banner banner-' + s.entryColor + '">' +
        '<div class="banner-title">' + escapeHtml(s.entryBadge) + '</div>' +
        '<div class="banner-text">' + escapeHtml(s.entrySummary) + '</div>' +
        '<div class="banner-action">&#x25B6; ' + escapeHtml(s.entryAction) + '</div>' +
      '</div>' +

      '<div class="trade-plan">' +
        '<div class="tp-item"><div class="tp-lbl">Buy Zone</div><div class="tp-val">' + tpEntry + '</div><div class="tp-sub">Pivot: ' + fmt2(s.pivot) + '</div></div>' +
        '<div class="tp-item"><div class="tp-lbl">Stop Loss</div><div class="tp-val" style="color:var(--rd)">' + tpStop + '</div><div class="tp-sub">' + tpRiskPct + '</div></div>' +
        '<div class="tp-item"><div class="tp-lbl">Targets (2R/3R)</div><div class="tp-val" style="color:var(--gn)">' + tpTarget + '</div><div class="tp-sub">' + (s.epsGwth5Y ? ('5Y EPS: +' + s.epsGwth5Y + '% p.a.') : (s.anticipatedGrowthPct ? ('Upside: +' + s.anticipatedGrowthPct + '%') : ('R:R ' + s.rr))) + '</div></div>' +
        '<div class="tp-item"><div class="tp-lbl">Score / RS</div><div class="tp-val" style="color:var(--ac)">' + (s.tfScore || '—') + '</div><div class="tp-sub">' + (s.rsRating ? 'RS: ' + s.rsRating : 'Stage 2') + '</div></div>' +
      '</div>' +

      '<div class="dma-row">' +
        '<span class="dma-lbl">&#x1F4C8; <b>200 DMA:</b></span>' +
        '<span class="dma-val ' + dmaClass + '">' + dmaStatusText + '</span>' +
      '</div>' +

      (badgesHtml ? '<div class="badges-wrap">' + badgesHtml + '</div>' : '') +

      (targetsHtml ? '<div class="ac-targets">' + targetsHtml + '</div>' : '') +

      rangeHtml +

      '<div class="ac-actions">' +
        '<button class="ac-edit-btn alert-btn" data-alert-ticker="' + escapeHtml(s.ticker) + '" data-alert-price="' + (p || 0) + '" data-alert-name="' + escapeHtml(s.fullName) + '">&#x270F; Edit Target</button>' +
        '<button class="ac-del-btn" onclick="deleteAlert(\\'' + escapeHtml(s.ticker) + '\\')">&#x1F5D1; Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');

  document.getElementById('alerts-container').innerHTML = html;
}

function deleteAlert(ticker){
  if(!confirm('Remove alert for ' + ticker + '?')) return;
  var a = JSON.parse(JSON.stringify(window._GA || {}));
  delete a[ticker];
  if(window._saveAlerts) window._saveAlerts(a, function(){ renderCards(); });
}

window.onAlertChange = function(){ renderCards(); };

// Filter pills click handling
document.getElementById('filter-pills').addEventListener('click', function(e){
  var btn = e.target.closest('.filter-pill');
  if(!btn) return;
  document.querySelectorAll('.filter-pill').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  currentFilter = btn.getAttribute('data-filter') || 'all';
  renderCards();
});

// Search input
document.getElementById('search-input').addEventListener('input', function(e){
  searchQuery = e.target.value.trim();
  renderCards();
});

// Sort select
document.getElementById('sort-select').addEventListener('change', function(e){
  currentSort = e.target.value;
  renderCards();
});

// Theme toggle
(function(){
  var btn = document.getElementById('theme-btn');
  function applyTheme(t){ document.documentElement.setAttribute('data-theme', t); localStorage.setItem('creamy-theme', t); }
  if(btn){
    btn.onclick = function(){
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    };
  }
})();

// Initial populate of _GA
PAGE_DATA.stocks.forEach(function(s){
  window._GA = window._GA || {};
  if(!window._GA[s.ticker] && (s.above != null || s.below != null)){
    window._GA[s.ticker] = { above: s.above, below: s.below, name: s.name };
  }
});

renderCards();
<\/script>
<script>${stockActions.setupScript}<\/script>
<script>${stockActions.js}<\/script>
</body>
</html>`;

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  console.log(`Saved enriched alerts dashboard to ${OUTPUT_PATH}`);
  console.log(`  ${tickers.length} alerts monitored: ${primeCount} in Prime/Armed entry zone, ${hugePotentialCount} Huge Potential, ${dma200Count} 200 DMA setups, ${triggeredCount} targets hit.`);
}

main().catch(err => {
  console.error('Error running generate-alerts.js:', err);
  process.exit(1);
});

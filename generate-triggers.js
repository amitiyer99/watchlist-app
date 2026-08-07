'use strict';

const { HUB_NAV_LINK } = require('./lib/hub-nav');
const stockActions = require('./lib/stock-actions');

// Right-Time Trigger Layer.
//
// Inputs:
//   - docs/regime.json          (bear/bull gate from lib/regime.js)
//   - docs/breakout2-data.json  (primary: pivot, atr14, volSurgeConfirmed, breakoutValid…)
//   - docs/apex-tickers.json    (APEX BUY/BUILD anchor + sector/name fallback)
//   - docs/live-prices.json     (intraday quote for live triggers)
//   - docs/multibagger-tickers.json (optional MBF score)
//   - docs/confluence-data.json / *-tickers.json (optional)
//   - ticker-urls.json          (URL lookup)
//
// Output:
//   - docs/triggers.json   (machine-readable trigger feed used by monitor.js + UIs)
//   - docs/triggers.html   (timestamped, sized, gated entries)
//   - screener-outcomes.json append (signalSource = 'triggers')

const fs   = require('fs');
const path = require('path');
const { loadRegime } = require('./lib/regime');
const { planTrade, suggestSizePct, DEFAULTS: SIG_DEF } = require('./lib/signals');
const { appendOutcomes, todayIST } = require('./lib/outcomes');
const { getMult } = require('./lib/weights');
const { loadEarnings, earningsWithin } = require('./lib/earnings');
const { loadSurveillance, getFlags, isRestricted } = require('./lib/surveillance');
const { loadDeals, hasRecentBulkBuy } = require('./lib/smartmoney');
const { fmtPrice, fmtPct, esc } = require('./lib/format');

const EARNINGS_BLACKOUT_DAYS = 5;   // no fresh entries within N days of results (gap risk)
const MIN_ADV20 = 2e7;              // ₹2 Cr/day median traded value — below this slippage eats the edge
const LIVE_STALE_HOURS = 3;         // live-prices.json older than this can't confirm a LIVE_BREAKOUT
const SURV_STALE_HOURS = 48;        // surveillance.json older than this can't gate (lists change daily)
// Hysteresis so live breakouts don't flicker on/off every 10-min refresh as price
// ticks around the pivot. A NEW live break must clear the pivot by TRIGGER_BUFFER;
// once listed, a name is HELD as long as it stays within HOLD_BAND below the pivot
// (a small pullback is still a valid setup, not a vanished signal).
const TRIGGER_BUFFER = 0.003;       // +0.3% above pivot to first appear
const HOLD_BAND      = 0.02;        // keep listed until >2% back below pivot

// Reliability weights for the composite blend (neutral 1.0 until learned).
const W_BREAKOUT = getMult('breakout2', '*', 1);
const W_APEX     = getMult('apex', '*', 1);

const DOCS         = path.join(__dirname, 'docs');
const B2_PATH      = path.join(DOCS, 'breakout2-data.json');
const APEX_PATH    = path.join(DOCS, 'apex-tickers.json');
const LIVE_PATH    = path.join(DOCS, 'live-prices.json');
const MBF_PATH     = path.join(DOCS, 'multibagger-tickers.json');
const IR_PATH      = path.join(DOCS, 'indianresearch-tickers.json');
const CREAMY_PATH  = path.join(DOCS, 'creamy-tickers.json');
const ROCKET_PATH  = path.join(DOCS, 'rocket-tickers.json');
const TURL_PATH    = path.join(__dirname, 'ticker-urls.json');
const WL_PATH      = path.join(__dirname, 'my-watchlists.json');
const OUT_JSON     = path.join(DOCS, 'triggers.json');
const OUT_HTML     = path.join(DOCS, 'triggers.html');

function readJson(p, fallback = null) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback; }
  catch (e) { console.warn(`  could not read ${path.basename(p)}: ${e.message}`); return fallback; }
}

// fmtPrice, fmtPct, esc now imported from ./lib/format (behaviour-identical)

function loadWatchlistTickers() {
  try {
    if (!fs.existsSync(WL_PATH)) return new Set();
    const arr = JSON.parse(fs.readFileSync(WL_PATH, 'utf8'));
    const out = new Set();
    for (const wl of arr) {
      const data = wl.periods && (wl.periods['3M'] || wl.periods['1M'] || wl.periods['1Y']);
      if (!data || !Array.isArray(data.stocks)) continue;
      for (const s of data.stocks) {
        const parts = (s.name || '').split('\n');
        const t = parts[1];
        if (t) out.add(t);
      }
    }
    return out;
  } catch { return new Set(); }
}

function classifyTier(score) {
  if (score >= 90) return { tier: 'Elite',    cls: 'tier-elite' };
  if (score >= 75) return { tier: 'High',     cls: 'tier-high' };
  if (score >= 60) return { tier: 'Standard', cls: 'tier-mid' };
  return                  { tier: 'Watch',    cls: 'tier-low' };
}

// Timing model. A breakout is event-driven, not calendar-driven, so we don't
// invent exit dates — we surface two honest, computable signals:
//   • freshness / enter-by: how long this name has been an active trigger and
//     the window to act before the entry is "chased" (price/time both matter).
//   • time-to-target: a rough ETA assuming a trending stock advances ~0.4×ATR
//     per trading day toward the objective. Presented as a weeks *range*.
const ENTER_BY_DAYS = 7;          // ~5 trading days to act on a fresh breakout
const DRIFT_ATR_PER_DAY = 0.4;    // assumed favourable advance per trading day

function daysBetween(aIso, bMs) {
  const a = new Date(aIso).getTime();
  if (!isFinite(a)) return null;
  return Math.max(0, Math.round((bMs - a) / 86400000));
}

function computeTiming(t, firstSeenIso, nowMs) {
  const ageDays = daysBetween(firstSeenIso, nowMs);
  const enterBy = new Date(new Date(firstSeenIso).getTime() + ENTER_BY_DAYS * 86400000);
  const freshness = ageDays == null ? 'unknown'
                  : ageDays <= 1 ? 'fresh'
                  : ageDays <= ENTER_BY_DAYS ? 'aging'
                  : 'stale';
  // ETA to target from ATR-based drift (trading days → weeks range).
  let etaWeeksLow = null, etaWeeksHigh = null;
  const perDay = t.atr14 != null ? DRIFT_ATR_PER_DAY * t.atr14 : null;
  if (perDay && perDay > 0 && t.target != null && t.entry != null && t.target > t.entry) {
    const tradingDays = (t.target - t.entry) / perDay;
    const weeksMid = tradingDays / 5;
    etaWeeksLow  = Math.max(1, Math.round(weeksMid * 0.75));
    etaWeeksHigh = Math.max(etaWeeksLow + 1, Math.round(weeksMid * 1.5));
  }
  return { firstSeen: firstSeenIso, ageDays, enterBy: enterBy.toISOString(), freshness, etaWeeksLow, etaWeeksHigh };
}

// Build trigger rows from the breakout2 universe + cross-screener tags.
// ── Ride Score ─────────────────────────────────────────────────────────────────
// 0-100 "can I buy this and ride the wave?" score. Four drivers the user cares about:
//   momentum (RS + volume surge), base quality (Stage-2 + VCP tight base),
//   room to run (headroom from entry to the target), and conviction to hold
//   (confluence with other screens + Screener.in fundamentals + institutional/marquee
//   ownership). Dampened in a bear tape, where breakouts historically fail.
function rideScore({ rsRating, volSurgeConfirmed, volSurgePct, stage2, vcpPass, entry, target, confluence }, { isBear, hasFund, hasInst, hasMarquee }) {
  let momentum = Math.min(20, ((rsRating || 0) / 99) * 20);
  momentum += volSurgeConfirmed ? 10 : ((volSurgePct || 0) >= 120 ? 5 : 0);   // 0-30
  const base = (stage2 ? 10 : 0) + (vcpPass ? 10 : 0);                          // 0-20
  const roomPct = (entry && target && entry > 0) ? ((target - entry) / entry) * 100 : 0;
  const room = Math.max(0, Math.min(25, roomPct));                             // 0-25 (25%+ headroom = full)
  let conviction = Math.min(12, (confluence || 0) * 4);
  if (hasFund) conviction += 5;
  if (hasInst) conviction += 4;
  if (hasMarquee) conviction += 4;
  conviction = Math.min(25, conviction);                                       // 0-25
  let total = momentum + base + room + conviction;
  if (isBear) total *= 0.6;                                                    // breakouts fail in bear
  return {
    score: Math.max(0, Math.min(100, Math.round(total))),
    parts: { momentum: Math.round(momentum), base, room: Math.round(room), conviction: Math.round(conviction) },
  };
}

function buildTriggers({ b2, apex, mbf, ir, creamy, rocket, livePrices, liveFresh, earningsData, surveillance, dealsData, regime, urlMap, watchTickers, prevMap, fundSet, marqueeSet }) {
  prevMap = prevMap || new Map();
  fundSet = fundSet || new Set();
  marqueeSet = marqueeSet || new Set();
  const apexMap   = new Map(apex.map(r => [r.ticker, r]));
  const mbfMap    = new Map(mbf.map(r  => [r.ticker, r]));
  const irMap     = new Map(ir.map(r   => [r.ticker, r]));
  const creamyMap = new Map(creamy.map(r => [r.ticker, r]));
  const rocketMap = new Map(rocket.map(r => [r.ticker, r]));

  const isBear = !!regime.isBearMarket;
  const minScore = isBear ? 70 : 55;

  const triggers = [];
  let skippedEarnings = 0, skippedIlliquid = 0, skippedExtended = 0, skippedSurveillance = 0;
  for (const r of b2) {
    if (r.score == null || r.score < minScore) continue;
    if (!r.stage2 || !r.vcpPass) continue;          // require Minervini setup
    if (r.breakoutFailed) continue;                  // never trigger on a failed break
    if (r.pivot == null || r.price == null) continue;

    // Liquidity floor: paper edge on illiquid names is fake — impact cost eats it.
    if (r.adv20 != null && r.adv20 < MIN_ADV20) { skippedIlliquid++; continue; }

    // Earnings blackout: no fresh entries right before results (binary gap risk).
    if (earningsData && earningsWithin(earningsData, r.ticker, EARNINGS_BLACKOUT_DAYS)) { skippedEarnings++; continue; }

    // Surveillance gate: ASM long-term stage ≥2 or any GSM listing means exchange
    // trading curbs (100% margin, tight price bands) — breakout follow-through
    // is structurally impossible, so never trigger these.
    if (surveillance && isRestricted(surveillance, r.ticker)) { skippedSurveillance++; continue; }

    const live = livePrices[r.ticker] || null;
    const livePx = live && typeof live.p === 'number' ? live.p : null;
    const eod = r.price;
    // Entry priorities:
    //   1. Live trigger      → live close >= pivot AND live > prev close (intraday confirmation)
    //      — only when live-prices.json is fresh; a days-old quote must not "confirm" a breakout
    //   2. EOD valid breakout → r.breakoutValid (2-bar hold)
    //   3. Surge today        → r.volSurgeConfirmed (one-bar surge above pivot)
    let signalType = null, trigPx = null, basis = null;
    // Live break with hysteresis: a NEW break must clear pivot by TRIGGER_BUFFER, but
    // once it was on the list last run we HOLD it while price stays within HOLD_BAND of
    // the pivot — so a small intraday pullback no longer drops the name every refresh.
    if (liveFresh && livePx != null) {
      const wasListed = prevMap.has(r.ticker);
      const newBreak = livePx >= r.pivot * (1 + TRIGGER_BUFFER) && (live.prev == null || livePx > live.prev);
      const holding  = wasListed && livePx >= r.pivot * (1 - HOLD_BAND);
      if (newBreak || holding) { signalType = 'LIVE_BREAKOUT'; trigPx = livePx; basis = 'live'; }
    }
    if (!signalType) {
      if (r.breakoutValid) {
        signalType = 'BREAKOUT_VALID'; trigPx = eod; basis = 'eod';
      } else if (r.volSurgeConfirmed) {
        signalType = 'VOL_SURGE'; trigPx = eod; basis = 'eod';
      } else if (r.dma200Cross === 'RECLAIM') {
        // Fresh reclaim of the 200-DMA — a bullish long-term trend turn, often the
        // earliest entry (before a base breakout). The 200-DMA is the reference level.
        signalType = 'DMA200_RECLAIM'; trigPx = (liveFresh && livePx != null) ? livePx : eod; basis = (liveFresh && livePx != null) ? 'live' : 'eod';
      } else {
        continue; // not yet triggered — still a setup
      }
    }

    // For a 200-DMA reclaim the reference ("pivot") is the 200-DMA line, not the base
    // high — that's what the stop sits under and what "too extended" is measured from.
    const planPivot = (signalType === 'DMA200_RECLAIM' && r.s200 != null) ? r.s200 : r.pivot;

    // Structural target: 52-week high when it sits meaningfully above the pivot,
    // else a measured move (pivot + 1× the base depth proxy). Gives planTrade a
    // real price objective so its R:R gate measures something.
    let structTarget = null;
    if (r.high52 != null && r.high52 > planPivot * 1.03) structTarget = r.high52;
    // A reclaim's first objective is the base high above it, if any.
    if (signalType === 'DMA200_RECLAIM' && r.pivot != null && r.pivot > trigPx * 1.02 && (structTarget == null || r.pivot < structTarget)) structTarget = r.pivot;

    const plan = planTrade({ entry: trigPx, pivot: planPivot, atr14: r.atr14, regime, structTarget });
    if (!plan) continue;
    if (!plan.meetsRR) continue;                     // real filter when structTarget exists
    if (plan.tooExtended) { skippedExtended++; continue; } // don't chase entries far above pivot

    const sizePct = suggestSizePct({ entry: plan.entry, stop: plan.stop });

    // Confluence tags
    const apexRow = apexMap.get(r.ticker);
    const tags = [];
    if (apexRow) {
      if (apexRow.action === 'BUY')   tags.push({ k: 'APEX',  v: 'BUY',  cls: 'tag-buy' });
      else if (apexRow.action === 'BUILD') tags.push({ k: 'APEX', v: 'BUILD', cls: 'tag-build' });
    }
    if (mbfMap.has(r.ticker))    tags.push({ k: 'MBF',     v: '✓', cls: 'tag-mbf' });
    if (irMap.has(r.ticker))     tags.push({ k: 'IR',      v: '✓', cls: 'tag-ir' });
    if (creamyMap.has(r.ticker)) tags.push({ k: 'CREAMY',  v: '✓', cls: 'tag-creamy' });
    if (rocketMap.has(r.ticker)) tags.push({ k: 'ROCKET',  v: '✓', cls: 'tag-rocket' });
    if (watchTickers.has(r.ticker)) tags.push({ k: 'WL',   v: '★', cls: 'tag-wl' });
    if (r.dma200Cross === 'RECLAIM') tags.push({ k: '200DMA', v: '🔄', cls: 'tag-dma' });

    // Milder surveillance flags — restricted names were already skipped above, so
    // anything left here is ASM short-term (any stage) or ASM long-term stage 1:
    // tradeable but volatile, warn instead of blocking. Same for the F&O ban
    // (ban only restricts derivatives; cash is tradeable but unwinding is violent).
    if (surveillance) {
      const sv = getFlags(surveillance, r.ticker);
      if (sv.asmStage != null || sv.asmType != null) {
        const asmLabel = `${sv.asmType === 'shortterm' ? 'ST' : 'LT'}-${sv.asmStage != null ? sv.asmStage : '?'}`;
        tags.push({ k: 'ASM', v: asmLabel, cls: 'tag-asm' });
      }
      if (sv.fnoBan) tags.push({ k: 'F&O BAN', v: '', cls: 'tag-ban' });
    }
    // Smart-money marker: display only — deliberately NOT part of conviction
    // scoring (the learner will decide whether it predicts anything).
    if (hasRecentBulkBuy(dealsData, r.ticker)) tags.push({ k: 'BULK', v: '✓', cls: 'tag-bulk' });

    const breakoutScore = r.score;
    const apexScore     = apexRow ? apexRow.score : null;
    const confluence    = tags.filter(t => ['APEX','MBF','IR','CREAMY','ROCKET'].includes(t.k)).length;

    // Composite conviction score (out of 100). Adaptive layer: the technical and
    // fundamental legs are weighted by each source screener's realized reliability,
    // then the whole score is scaled by this signal type's track record (e.g. live
    // breakouts have historically underperformed valid EOD breaks). All clamped 0.5-1.5.
    let conviction = breakoutScore * 0.5 * W_BREAKOUT;          // technical
    if (apexScore != null) conviction += apexScore * 0.3 * W_APEX; // fundamental
    conviction += confluence * 4;                  // overlap bonus (max +20)
    if (r.breakoutValid) conviction += 5;
    if (r.volSurgeConfirmed) conviction += 5;
    if (isBear) conviction -= 10;                  // global risk discount
    conviction *= getMult('triggers', signalType, 1);
    conviction = Math.max(0, Math.min(100, Math.round(conviction)));

    const tierInfo = classifyTier(conviction);

    // Rideability: how buyable-and-holdable is this breakout wave?
    const ride = rideScore(
      { rsRating: r.rsRating, volSurgeConfirmed: r.volSurgeConfirmed, volSurgePct: r.volSurgePct, stage2: r.stage2, vcpPass: r.vcpPass, entry: plan.entry, target: plan.target, confluence },
      { isBear, hasFund: fundSet.has(r.ticker), hasInst: hasRecentBulkBuy(dealsData, r.ticker), hasMarquee: marqueeSet.has(r.ticker) }
    );

    triggers.push({
      rideScore: ride.score,
      rideParts: ride.parts,
      ticker:    r.ticker,
      name:      r.name || (apexRow && apexRow.name) || r.ticker,
      sector:    r.sector || (apexRow && apexRow.sector) || null,
      url:       urlMap[r.ticker] || (apexRow && apexRow.url) || null,
      signalType,
      basis,
      conviction,
      tier:      tierInfo.tier,
      tierCls:   tierInfo.cls,
      breakoutScore,
      apexScore,
      apexAction: apexRow ? apexRow.action : null,
      rsRating:  r.rsRating ?? null,
      pivot:     planPivot,
      dma200Cross: r.dma200Cross || null,
      eodPrice:  eod,
      livePrice: livePx,
      entry:     plan.entry,
      stop:      plan.stop,
      target:    plan.target,
      targetKind: plan.targetKind,
      rr:        plan.rr,
      riskPct:   plan.riskPct,
      sizePct,
      atr14:     r.atr14,
      atrPct:    r.atrPct,
      pctBelowPivot: r.pctBelowPivot,
      volSurgeConfirmed: !!r.volSurgeConfirmed,
      volSurgePct: r.volSurgePct ?? null,
      breakoutValid: !!r.breakoutValid,
      stage2: !!r.stage2,
      vcpPass: !!r.vcpPass,
      inWatchlist: watchTickers.has(r.ticker),
      tags,
      confluence,
    });
  }

  // Lead with rideability — the whole point is to surface breakouts worth buying and
  // holding — then conviction as the tiebreaker.
  triggers.sort((a, b) => (b.rideScore - a.rideScore) || (b.conviction - a.conviction));
  if (skippedEarnings || skippedIlliquid || skippedExtended || skippedSurveillance) {
    console.log(`  Gates: ${skippedEarnings} earnings-blackout, ${skippedIlliquid} illiquid (<₹${MIN_ADV20 / 1e7} Cr ADV), ${skippedExtended} too extended, ${skippedSurveillance} surveillance-restricted`);
  }
  return triggers;
}

// Best-effort explanation for why a ticker that was on the previous triggers
// snapshot isn't on this one. Walks the same gates buildTriggers() applies, in
// the same order, and reports the first one that now fails. Not authoritative
// (live/EOD signal state can flip within a single refresh) but good enough for
// a human skimming an alert email.
function explainRemoval(ticker, { b2ByTicker, minScore, earningsData, surveillance }) {
  const row = b2ByTicker.get(ticker);
  if (!row) return 'dropped out of the breakout2 scan universe entirely';
  if (row.score == null || row.score < minScore) return `score fell below the bar (${row.score ?? '—'} < ${minScore})`;
  if (!row.stage2 || !row.vcpPass) return 'Stage-2 / VCP setup no longer holds';
  if (row.breakoutFailed) return 'breakout failed — closed back below pivot';
  if (row.adv20 != null && row.adv20 < MIN_ADV20) return `liquidity fell below the ₹${(MIN_ADV20/1e7).toFixed(0)} Cr/day floor`;
  if (earningsData && earningsWithin(earningsData, ticker, EARNINGS_BLACKOUT_DAYS)) return `entered the ${EARNINGS_BLACKOUT_DAYS}-day earnings blackout`;
  if (surveillance && isRestricted(surveillance, ticker)) return 'now surveillance-restricted (ASM long-term / GSM)';
  if (!row.breakoutValid && !row.volSurgeConfirmed) return 'no live/EOD confirmation this run — signal faded';
  return 'no longer clears the trade-plan filter (R:R or over-extension)';
}

// HTML rendering — small, mobile-friendly, dark theme matching the rest of the site.
function buildHtml({ triggers, regime, generatedAt }) {
  const isBear = regime.isBearMarket;
  const banner = isBear
    ? `<div class="regime-bar regime-bear">🐻 <b>BEAR REGIME</b> — Nifty ${regime.price?.toFixed(0)} below EMA26 ${regime.ema26} · 22D ${fmtPct(regime.ret22D)}. Triggers gated tighter (R:R ≥ ${SIG_DEF.minRRBear}, score ≥ 70).</div>`
    : `<div class="regime-bar regime-bull">🐂 <b>BULL REGIME</b> — Nifty ${regime.price?.toFixed(0)} vs EMA26 ${regime.ema26} · 22D ${fmtPct(regime.ret22D)}. Standard gates active.</div>`;

  const TAG_TIPS = {
    APEX:   { BUY: 'APEX fundamental score ≥70 with technical confirmation — passed the deepest quality/growth/valuation check.', BUILD: 'APEX score positive but below the BUY bar — fundamentals still developing, watch not act.' },
    MBF:    'Also flagged by the Multibagger screener — long-term compounder traits: EPS growth, balance-sheet quality, momentum.',
    IR:     'Also flagged by Indian Research — passed the quality + growth + technical-catalyst funnel.',
    CREAMY: 'Also flagged by Creamy Layer — Tickertape’s High-Performance tag plus a growth/quality/momentum composite.',
    ROCKET: 'Also flagged by Rocket — aggressive small/mid-cap momentum scan (higher risk, size smaller).',
    ASM:    'Under NSE Additional Surveillance Measure — the exchange flagged unusual price/volume activity (ST = short-term, LT = long-term, higher stage = tighter curbs like extra margins and price bands). Still tradeable, but expect volatility and slower fills. Worse cases (LT stage ≥2, any GSM) are filtered off this page entirely.',
    'F&O BAN': 'In the NSE F&O ban list — open derivative positions crossed 95% of the market-wide limit. Cash-market buying is still allowed, but expect sharp, forced-unwinding moves while the ban lasts.',
    BULK:   'A bulk/block deal BUY was disclosed on NSE in the last 30 days — institutional money entered. Display only; it does not change the conviction score.',
  };
  const TIER_TIPS = {
    Elite:    'Conviction ≥90 — technical, fundamental and multiple screeners all agree. Highest confidence tier.',
    High:     'Conviction 75–89 — strong setup, most signals confirm.',
    Standard: 'Conviction 60–74 — meets the minimum bar. Worth a closer look before sizing up.',
    Watch:    'Conviction below 60 — shown for visibility only, not a strong signal on its own.',
  };
  const SIG_TIPS = {
    LIVE_BREAKOUT:   'Confirmed against the live intraday price right now — strongest signal, but re-check the price before entry since it can move fast.',
    BREAKOUT_VALID:  'Closed above the pivot yesterday and held for 2 days — more reliable, less time pressure than a live break.',
    VOL_SURGE:       'Today’s volume spiked >1.5× its 50-day average while closing above the pivot — earliest signal, higher false-breakout risk.',
    DMA200_RECLAIM:  'Price reclaimed its 200-day moving average in the last ~5 days — a bullish long-term trend turn. Earliest entry (often before a base breakout); the 200-DMA is the reference/stop level. Give it room and confirm with volume.',
  };

  const rowsHtml = triggers.map(t => {
    const tagsHtml = t.tags.map(g => {
      let tip = TAG_TIPS[g.k];
      if (tip && typeof tip === 'object') tip = tip[g.v] || '';
      if (g.k === 'WL') tip = 'This stock is on your own Tickertape watchlist.';
      return `<span class="tag ${g.cls}${tip ? ' tip' : ''}"${tip ? ` tabindex="0" data-tip="${esc(tip)}"` : ''}>${esc(g.k)}${g.v ? ' ' + esc(g.v) : ''}</span>`;
    }).join('');
    const ttUrl = t.url || `https://www.tickertape.in/stocks/${(t.name || t.ticker).toLowerCase().replace(/\s+ltd$/, '').replace(/\s+/g, '-')}-${t.ticker}`;
    const sigLabel = t.signalType === 'LIVE_BREAKOUT' ? '🟢 LIVE break' : t.signalType === 'BREAKOUT_VALID' ? '✅ Valid EOD' : t.signalType === 'DMA200_RECLAIM' ? '🔄 200-DMA reclaim' : '🌊 Surge';
    const sigCls = t.signalType === 'LIVE_BREAKOUT' ? 'sig-live' : t.signalType === 'BREAKOUT_VALID' ? 'sig-valid' : t.signalType === 'DMA200_RECLAIM' ? 'sig-dma' : 'sig-surge';
    const sigBadge = `<span class="sig ${sigCls} tip" tabindex="0" data-tip="${esc(SIG_TIPS[t.signalType] || '')}">${sigLabel}</span>`;
    const tierTip = TIER_TIPS[t.tier] || '';

    // ── Timing line: freshness / enter-by window + ATR-based time-to-target ──
    const tm = t.timing || {};
    const ageTxt = tm.ageDays == null ? '' : tm.ageDays === 0 ? 'today' : tm.ageDays === 1 ? '1d ago' : `${tm.ageDays}d ago`;
    const enterByTxt = tm.enterBy ? new Date(tm.enterBy).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
    const freshCls = tm.freshness === 'fresh' ? 'fresh-ok' : tm.freshness === 'aging' ? 'fresh-aging' : 'fresh-stale';
    const freshTip = tm.freshness === 'stale'
      ? `First triggered ${ageTxt} — past the ~${ENTER_BY_DAYS}-day action window. Chasing an extended breakout carries worse risk/reward; prefer waiting for the next base.`
      : `First appeared on this list ${ageTxt}. Breakouts are best taken while fresh — act on or before ${enterByTxt} (about ${ENTER_BY_DAYS} days / 5 trading sessions), and only while price is still near the pivot.`;
    const etaTxt = (tm.etaWeeksLow != null && tm.etaWeeksHigh != null) ? `~${tm.etaWeeksLow}–${tm.etaWeeksHigh} wks to target` : '';
    const etaTip = 'Rough estimate only: assumes the stock advances about 0.4×ATR per trading day toward the target. Exits are condition-driven (target/stop/trailing-stop), not this date.';
    const timingHtml = `<div class="timing">`
      + `<span class="clk ${freshCls} tip" tabindex="0" data-tip="${esc(freshTip)}">🕒 ${ageTxt}${enterByTxt ? ` · buy-by ${enterByTxt}` : ''}</span>`
      + (etaTxt ? ` <span class="eta tip" tabindex="0" data-tip="${esc(etaTip)}">⏳ ${etaTxt}</span>` : '')
      + `</div>`;
    const rp = t.rideParts || {};
    const rideCls = t.rideScore >= 70 ? 'ride-hi' : t.rideScore >= 50 ? 'ride-mid' : 'ride-lo';
    const rideTip = `Rideability ${t.rideScore}/100 — momentum ${rp.momentum||0}/30 · base ${rp.base||0}/20 · room-to-run ${rp.room||0}/25 · hold-conviction ${rp.conviction||0}/25${isBear ? ' (bear tape: halved)' : ''}`;
    return `<tr data-ticker="${esc(t.ticker.toLowerCase())}" data-name="${esc((t.name||'').toLowerCase())}" data-tier="${esc(t.tier)}" data-signal="${esc(t.signalType)}" data-wl="${t.inWatchlist?'1':'0'}" data-ride="${t.rideScore||0}">
      <td>
        <div class="stock">
          <div class="name-row">
            <a class="ticker" href="${esc(ttUrl)}" target="_blank" rel="noopener">${esc(t.name)}</a>
            ${stockActions.buttonsHtml({ ticker: t.ticker, name: t.name, price: t.entry || t.livePrice || t.eodPrice })}
          </div>
          <div class="sub">${esc(t.ticker)}${t.sector ? ' · '+esc(t.sector) : ''}${t.inWatchlist?' · <span class="wl tip" tabindex="0" data-tip="On your personal Tickertape watchlist.">★ WL</span>':''}</div>
          <div class="tags">${sigBadge} ${tagsHtml}</div>
          ${timingHtml}
        </div>
      </td>
      <td class="num"><span class="ride ${rideCls} tip" tabindex="0" data-tip="${esc(rideTip)}">${t.rideScore}</span></td>
      <td class="num"><span class="conv ${t.tierCls}">${t.conviction}</span><div class="sub tip" tabindex="0" data-tip="${esc(tierTip)}">${esc(t.tier)}</div></td>
      <td class="num">${fmtPrice(t.entry)}<div class="sub">live ${fmtPrice(t.livePrice ?? t.eodPrice)}</div></td>
      <td class="num">${fmtPrice(t.pivot)}<div class="sub">${t.pctBelowPivot != null && t.pctBelowPivot >= 0 ? fmtPct(-t.pctBelowPivot) : (t.pctBelowPivot != null ? fmtPct(-t.pctBelowPivot) : '—')}</div></td>
      <td class="num stop">${fmtPrice(t.stop)}<div class="sub">-${t.riskPct}%</div></td>
      <td class="num targ">${fmtPrice(t.target)}<div class="sub">R:R ${t.rr}${t.targetKind === 'structural' ? '' : ' <span class="tip tip-r" tabindex="0" data-tip="No prior high was available above the pivot, so this target is a volatility-based estimate rather than a structural level. Manage the exit actively.">*</span>'}</div></td>
      <td class="num">${t.sizePct != null ? t.sizePct + '%' : '—'}<div class="sub">of portfolio</div></td>
      <td class="num">${t.atr14 != null ? fmtPrice(t.atr14) : '—'}<div class="sub">${t.atrPct != null ? t.atrPct.toFixed(1) + '% atr' : ''}</div></td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Triggers — Right-Time Entry</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0c0c10;--s1:#12121a;--s2:#181822;--bd:#23232f;--t1:#e4e4ea;--t2:#9a9aa6;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--am:#f59e0b;--vi:#a855f7;--bl:#60a5fa}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--t1);font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:0;font-size:14px}
.header{background:var(--s1);border-bottom:1px solid var(--bd);padding:18px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.header h1{margin:0;font-size:1.2rem;display:flex;align-items:center;gap:10px}
.header .sub{color:var(--t2);font-size:.78rem}
.nav-links{display:flex;gap:8px;flex-wrap:wrap}
.nav-links a{color:var(--t2);text-decoration:none;font-size:.78rem;padding:4px 10px;border:1px solid var(--bd);border-radius:6px}
.nav-links a:hover{color:var(--t1);background:var(--s2)}
.regime-bar{padding:10px 24px;font-size:.85rem;border-bottom:1px solid var(--bd)}
.regime-bull{background:rgba(34,197,94,.08);color:#bbf7d0}
.regime-bear{background:rgba(239,68,68,.10);color:#fecaca}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;padding:14px 24px;background:var(--s1);border-bottom:1px solid var(--bd)}
.stat{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 12px}
.stat .v{font-size:1.3rem;font-weight:700}
.stat .l{color:var(--t2);font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.controls{padding:12px 24px;background:var(--bg);border-bottom:1px solid var(--bd);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.controls input{background:var(--s2);border:1px solid var(--bd);color:var(--t1);padding:8px 12px;border-radius:8px;font-size:.85rem;flex:1;min-width:200px}
.fbtn{background:var(--s2);border:1px solid var(--bd);color:var(--t1);padding:6px 12px;border-radius:8px;font-size:.78rem;cursor:pointer}
.fbtn.active{background:#0ea5e9;border-color:#0284c7;color:#fff}
.fbtn:hover{background:var(--s1)}
table{width:100%;border-collapse:collapse}
thead{background:var(--s1);position:sticky;top:0;z-index:2}
th{text-align:left;padding:10px 12px;font-size:.7rem;color:#7dd3fc;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--bd);font-weight:700}
td{padding:12px;border-bottom:1px solid var(--bd);vertical-align:top}
tr.hide{display:none}
.num{text-align:right;font-variant-numeric:tabular-nums}
.stop{color:#fca5a5}
.targ{color:#86efac}
.stock .ticker{color:var(--t1);font-weight:700;text-decoration:none;font-size:.95rem}
.stock .sub{color:var(--t2);font-size:.72rem;margin-top:2px}
.stock .tags{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px}
.timing{margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;font-size:.7rem}
.timing .clk,.timing .eta{color:var(--t2)}
.timing .clk.fresh-ok{color:#4ade80}
.timing .clk.fresh-aging{color:#fbbf24}
.timing .clk.fresh-stale{color:#f87171}
.wl{color:var(--am)}
.tag{display:inline-block;font-size:.65rem;font-weight:700;padding:1px 6px;border-radius:4px;letter-spacing:.04em;text-transform:uppercase}
.tag-buy{background:rgba(34,197,94,.18);color:#22c55e;border:1px solid rgba(34,197,94,.4)}
.tag-build{background:rgba(245,158,11,.18);color:#f59e0b;border:1px solid rgba(245,158,11,.4)}
.tag-mbf{background:rgba(96,165,250,.18);color:#60a5fa;border:1px solid rgba(96,165,250,.4)}
.tag-ir{background:rgba(168,85,247,.18);color:#c084fc;border:1px solid rgba(168,85,247,.4)}
.tag-creamy{background:rgba(236,72,153,.18);color:#f9a8d4;border:1px solid rgba(236,72,153,.4)}
.tag-rocket{background:rgba(239,68,68,.18);color:#fca5a5;border:1px solid rgba(239,68,68,.4)}
.tag-wl{background:rgba(245,158,11,.18);color:#fbbf24;border:1px solid rgba(245,158,11,.4)}
.tag-asm{background:rgba(245,158,11,.22);color:#fcd34d;border:1px solid rgba(245,158,11,.55)}
.tag-ban{background:rgba(239,68,68,.22);color:#f87171;border:1px solid rgba(239,68,68,.55)}
.tag-bulk{background:rgba(34,197,94,.18);color:#4ade80;border:1px solid rgba(34,197,94,.45)}
.tag-dma{background:rgba(59,130,246,.18);color:#93c5fd;border:1px solid rgba(59,130,246,.45)}
.sig{display:inline-block;font-size:.65rem;font-weight:700;padding:1px 8px;border-radius:4px;letter-spacing:.04em}
.sig-live{background:#15803d;color:#dcfce7}
.sig-valid{background:#0e7490;color:#cffafe}
.sig-surge{background:#7c2d12;color:#fed7aa}
.sig-dma{background:#1e3a8a;color:#dbeafe}
.conv{display:inline-block;width:42px;text-align:center;padding:4px 0;border-radius:6px;font-weight:800;font-size:1rem}
.ride{display:inline-block;width:42px;text-align:center;padding:4px 0;border-radius:6px;font-weight:800;font-size:1.05rem}
.ride-hi{background:rgba(34,197,94,.18);color:#4ade80;box-shadow:0 0 0 1px rgba(34,197,94,.4) inset}
.ride-mid{background:rgba(234,179,8,.15);color:#facc15}
.ride-lo{background:rgba(148,163,184,.12);color:#94a3b8}
.tier-elite{background:#7c2d12;color:#fbbf24;border:1px solid #f59e0b}
.tier-high{background:#0e7490;color:#7dd3fc;border:1px solid #06b6d4}
.tier-mid{background:#1e3a8a;color:#bfdbfe;border:1px solid #60a5fa}
.tier-low{background:#374151;color:#d1d5db;border:1px solid #6b7280}
.empty{padding:48px 24px;text-align:center;color:var(--t2)}
.footer{padding:16px 24px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd);line-height:1.6}
tbody tr:nth-child(even){background:rgba(255,255,255,.015)}
tbody tr:hover{background:rgba(125,211,252,.05)}
@media (max-width:680px){
  th:nth-child(8),td:nth-child(8),th:nth-child(7),td:nth-child(7){display:none}
}
/* ── Friendly hover tooltips ── */
.tip{position:relative;cursor:help;border-bottom:1px dotted var(--t3);outline:none}
.tip:hover::after,.tip:focus::after,.tip:hover::before,.tip:focus::before{opacity:1;visibility:visible}
.tip::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);background:#1c1c28;color:#e4e4ea;border:1px solid #2f2f42;padding:9px 11px;border-radius:8px;font-size:.72rem;font-weight:500;text-transform:none;letter-spacing:normal;white-space:normal;width:230px;line-height:1.45;box-shadow:0 10px 28px rgba(0,0,0,.5);opacity:0;visibility:hidden;transition:opacity .12s ease,visibility .12s ease;z-index:30;pointer-events:none}
.tip::before{content:'';position:absolute;left:50%;bottom:calc(100% + 3px);transform:translateX(-50%);border:5px solid transparent;border-top-color:#2f2f42;opacity:0;visibility:hidden;transition:opacity .12s ease;z-index:30}
.tip.tip-r::after{left:auto;right:-6px;transform:none}
.tip.tip-r::before{left:auto;right:14px;transform:none}
th .tip{color:inherit;text-transform:inherit;letter-spacing:inherit;font-weight:inherit}
.tip-ic{opacity:.55;font-size:.85em;margin-left:2px}
/* ── Legend / glossary ── */
details.legend{background:var(--s1);border-bottom:1px solid var(--bd)}
details.legend summary{padding:10px 24px;cursor:pointer;color:#7dd3fc;font-size:.8rem;font-weight:600;list-style:none;user-select:none}
details.legend summary::-webkit-details-marker{display:none}
details.legend summary::before{content:'▸ ';display:inline-block;transition:transform .15s}
details.legend[open] summary::before{transform:rotate(90deg)}
.legend-body{padding:4px 24px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;font-size:.78rem;color:var(--t2);line-height:1.55}
.legend-body h4{margin:0 0 6px;color:var(--t1);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.legend-body p{margin:0 0 6px}
.legend-chip{display:inline-block;padding:1px 7px;border-radius:4px;font-size:.68rem;font-weight:700;margin-right:2px}
${stockActions.css}
</style></head>
<body>
<div class="header">
  <h1>🎯 Triggers <span class="sub">Right-Time Entry Layer · ${esc(generatedAt)} IST</span></h1>
  <div class="nav-links">
    ${HUB_NAV_LINK}
    <a href="index.html">Dashboard</a>
    <a href="confluence.html">Confluence</a>
    <a href="breakout2.html">Breakout</a>
    <a href="apex.html">APEX</a>
    <a href="debate.html">Debate</a>
    <a href="prediction.html">Prediction</a>
  </div>
</div>
${banner}
<details class="legend">
  <summary>How to read this page — tiers, signals, tags &amp; the trade math (tap to expand)</summary>
  <div class="legend-body">
    <div>
      <h4>Conviction tiers</h4>
      <p><span class="legend-chip tier-elite">Elite</span> ≥90 — everything lines up: technical, fundamental and multiple screeners agree. Highest confidence.</p>
      <p><span class="legend-chip tier-high">High</span> 75–89 — strong setup, most signals confirm.</p>
      <p><span class="legend-chip tier-mid">Standard</span> 60–74 — meets the minimum bar. Worth a closer look before sizing up.</p>
      <p><span class="legend-chip tier-low">Watch</span> below 60 — shown for visibility only, not a strong signal on its own.</p>
    </div>
    <div>
      <h4>Signal badges</h4>
      <p><span class="sig sig-live">🟢 LIVE break</span> happening right now, intraday. Strongest confirmation — but re-check the live price before entry, it can move fast.</p>
      <p><span class="sig sig-valid">✅ Valid EOD</span> broke out yesterday and held for 2 days. More reliable, less time pressure.</p>
      <p><span class="sig sig-surge">🌊 Surge</span> today's volume spike closed above pivot. Earliest signal, higher chance of a false breakout.</p>
    </div>
    <div>
      <h4>Overlap tags</h4>
      <p><span class="tag tag-buy">APEX BUY</span>/<span class="tag tag-build">BUILD</span> fundamental quality check (profits, growth, debt, promoters) &nbsp; <span class="tag tag-mbf">MBF</span> long-term compounder scan &nbsp; <span class="tag tag-ir">IR</span> quality+growth+catalyst funnel &nbsp; <span class="tag tag-creamy">CREAMY</span> Tickertape High-Performance layer &nbsp; <span class="tag tag-rocket">ROCKET</span> aggressive momentum scan &nbsp; <span class="tag tag-wl">★ WL</span> on your own watchlist.</p>
      <p>More tags = more independent screeners agree on this stock — that's the Conviction overlap bonus.</p>
    </div>
    <div>
      <h4>The trade, in one line</h4>
      <p><b>Entry</b> → buy near here. <b>Stop</b> → set it the moment you buy, this is the whole risk plan. <b>Target</b> → first profit level. <b>Size%</b> → already sized so a stop-out costs ~1% of your portfolio.</p>
      <p>Every row already passed a ₹2 Cr/day liquidity floor and a 5-day earnings blackout — you're not seeing the risky, illiquid, or event-risk names.</p>
    </div>
    <div>
      <h4>Timing — the two clocks</h4>
      <p><span class="clk fresh-ok">🕒 fresh</span> / <span class="clk fresh-aging">aging</span> / <span class="clk fresh-stale">stale</span> shows how long a name has been an active trigger. Breakouts are best taken while fresh — the <b>buy-by</b> date is roughly ${ENTER_BY_DAYS} days (≈5 trading sessions) from when it first appeared. After that you're chasing an extended move.</p>
      <p><b>⏳ weeks to target</b> is a rough ATR-based estimate (assumes ~0.4×ATR of favourable drift per day), not a deadline. <b>Exits are condition-driven</b> — a stop, target, or trailing-stop hit — never a fixed calendar date. Once you enter, the exit engine manages trailing stops and flags a review if the trade stalls past ~60 days.</p>
    </div>
  </div>
</details>
<div class="stats">
  <div class="stat"><div class="v">${triggers.length}</div><div class="l tip" data-tip="Every stock currently on this page — already passed all gates below.">Active triggers</div></div>
  <div class="stat"><div class="v">${triggers.filter(t=>t.signalType==='LIVE_BREAKOUT').length}</div><div class="l tip" data-tip="Confirmed within the last live price update — happening right now.">Live breakouts</div></div>
  <div class="stat"><div class="v">${triggers.filter(t=>t.signalType==='BREAKOUT_VALID').length}</div><div class="l tip" data-tip="Broke out yesterday and held above the pivot for 2 days.">Valid EOD</div></div>
  <div class="stat"><div class="v">${triggers.filter(t=>t.signalType==='VOL_SURGE').length}</div><div class="l tip" data-tip="One-day volume spike above the pivot — earliest but least confirmed signal.">Vol surges</div></div>
  <div class="stat"><div class="v">${triggers.filter(t=>t.apexAction==='BUY').length}</div><div class="l tip" data-tip="Also rated BUY by the APEX fundamental screener — technical + fundamentals agree.">APEX BUY overlap</div></div>
  <div class="stat"><div class="v">${triggers.filter(t=>t.inWatchlist).length}</div><div class="l tip" data-tip="Stocks you're already tracking on your personal Tickertape watchlist.">In watchlist</div></div>
</div>
<div class="controls">
  <input id="q" placeholder="Search ticker or name…">
  <button class="fbtn active" data-f="all">All</button>
  <button class="fbtn" data-f="ride">🌊 Rideable (≥60)</button>
  <button class="fbtn" data-f="LIVE_BREAKOUT">🟢 Live</button>
  <button class="fbtn" data-f="BREAKOUT_VALID">✅ EOD Valid</button>
  <button class="fbtn" data-f="VOL_SURGE">🌊 Surge</button>
  <button class="fbtn" data-f="Elite">Elite tier</button>
  <button class="fbtn" data-f="High">High tier</button>
  <button class="fbtn" data-f="wl">★ My WL</button>
</div>
${triggers.length ? `<table>
  <thead><tr>
    <th>Stock &amp; Signal</th>
    <th class="num"><span class="tip" tabindex="0" data-tip="0-100 &quot;buy &amp; ride the wave&quot; score: momentum (RS + volume surge), base quality (Stage-2 + VCP), room to run (headroom from entry to target), and conviction to hold (screener overlap + Screener.in fundamentals + institutional/marquee ownership). Halved in a bear tape. This is the primary sort.">🌊 Ride</span></th>
    <th class="num"><span class="tip" tabindex="0" data-tip="0-100 score: 50% technical strength + 30% fundamental (APEX, if available) + a bonus for agreement across screeners. Discounted in bear regime.">Conviction</span></th>
    <th class="num"><span class="tip" tabindex="0" data-tip="The price that confirmed the trigger. Buy at or near this — if the stock has already run well past it, the setup is stale, wait for the next one.">Entry</span></th>
    <th class="num"><span class="tip" tabindex="0" data-tip="Top of the base the stock just broke out of (30-day high). Entry should sit at or just above this.">Pivot</span></th>
    <th class="num"><span class="tip" tabindex="0" data-tip="Your exit if the trade goes wrong. Set this as a stop-loss order immediately — it is not optional. = pivot minus 2x ATR(14).">Stop</span></th>
    <th class="num"><span class="tip tip-r" tabindex="0" data-tip="First profit level — a real prior high when available, otherwise a volatility-based estimate. R:R below it is reward vs risk.">Target</span></th>
    <th class="num"><span class="tip tip-r" tabindex="0" data-tip="Suggested % of your total portfolio for this one position, sized so a stop-out costs about 1% of your equity (capped at 5%/name).">Size%</span></th>
    <th class="num"><span class="tip tip-r" tabindex="0" data-tip="Average daily price range over 14 days — how much this stock typically moves. Used to set the stop distance.">ATR14</span></th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>` : `<div class="empty">No active triggers right now. Setups become triggers when the live or EOD price closes above pivot with volume confirmation. Check <a href="breakout2.html" style="color:#7dd3fc">breakout2.html</a> for setups still forming.</div>`}
<div class="footer">
  Entry = first confirmed close above pivot · Stop = pivot − ${SIG_DEF.stopAtrMult}×ATR(14) · Target = prior high when available, else entry + ${SIG_DEF.targetRRMult}×(entry−stop) · Size% = risk budget ${SIG_DEF.riskBudgetPct}% ÷ stop loss% (capped at ${SIG_DEF.maxPctPerName}%/name).
  <br>Every row already passed: liquidity floor (≥₹${(MIN_ADV20/1e7).toFixed(0)} Cr/day traded value), earnings blackout (≥${EARNINGS_BLACKOUT_DAYS} days to results), an over-extension check (entry not chased too far above pivot), and a surveillance gate (no ASM long-term stage ≥2 or GSM-listed names — exchange curbs kill breakout follow-through; milder ASM flags and the F&amp;O ban show as warning tags instead). Bear regime tightens the R:R floor to ${SIG_DEF.minRRBear} and suppresses score &lt; 70.
  <br>Not financial advice. Validate manually before placing orders.
</div>
${stockActions.bannerHtml}
${stockActions.modalHtml}
${stockActions.researchModalHtml}
<script>
${stockActions.setupScript}
${stockActions.js}
(function(){
  var q=document.getElementById('q');
  var rows=Array.from(document.querySelectorAll('tbody tr'));
  var activeF='all';
  function apply(){
    var term=(q.value||'').trim().toLowerCase();
    rows.forEach(function(r){
      var ok=true;
      if(activeF==='all'){} else if(activeF==='wl') ok = r.dataset.wl==='1';
      else if(activeF==='ride') ok = (+r.dataset.ride) >= 60;
      else if(activeF==='Elite'||activeF==='High') ok = r.dataset.tier===activeF;
      else ok = r.dataset.signal===activeF;
      if(ok && term){ ok = r.dataset.ticker.includes(term)||r.dataset.name.includes(term); }
      r.classList.toggle('hide', !ok);
    });
  }
  q && q.addEventListener('input', apply);
  document.querySelectorAll('.fbtn').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('.fbtn').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active'); activeF=b.dataset.f; apply();
    });
  });
})();
</script>
</body></html>`;
}

async function main() {
  console.log('Building triggers...');
  const regime = loadRegime();
  if (!regime.available) console.warn('  regime.json not available — FAIL-CLOSED: bear gates active');
  else if (regime.degraded) console.warn(`  regime.json ${regime.degradedReason} — keeping last known regime (${regime.isBearMarket ? 'BEAR' : 'BULL'})`);

  const b2Raw    = readJson(B2_PATH, []) || [];
  const apex     = readJson(APEX_PATH, []) || [];
  const mbf      = readJson(MBF_PATH, []) || [];
  const ir       = readJson(IR_PATH, []) || [];
  const creamy   = readJson(CREAMY_PATH, []) || [];
  const rocket   = readJson(ROCKET_PATH, []) || [];
  const liveRaw  = readJson(LIVE_PATH, { prices: {} }) || { prices: {} };
  const livePrices = liveRaw.prices || {};
  // Staleness check: a LIVE_BREAKOUT confirmed against a days-old quote is fiction.
  let liveFresh = false;
  const liveTs = liveRaw.ts || (liveRaw.generatedAt ? new Date(liveRaw.generatedAt).getTime() : null);
  if (liveTs) {
    const ageH = (Date.now() - liveTs) / 3.6e6;
    liveFresh = isFinite(ageH) && ageH <= LIVE_STALE_HOURS;
    if (!liveFresh) console.warn(`  live-prices.json is ${ageH.toFixed(1)}h old — LIVE_BREAKOUT confirmation disabled this run`);
  } else {
    console.warn('  live-prices.json has no timestamp — LIVE_BREAKOUT confirmation disabled this run');
  }
  const earningsData = loadEarnings();
  if (!earningsData) console.warn('  earnings-calendar.json not available — earnings blackout inactive');
  let surveillance = loadSurveillance();
  if (!surveillance) {
    console.warn('  surveillance.json not available — surveillance gate inactive');
  } else if (surveillance.ageHours == null || surveillance.ageHours > SURV_STALE_HOURS) {
    console.warn(`  surveillance.json is ${surveillance.ageHours == null ? 'untimestamped' : surveillance.ageHours.toFixed(0) + 'h old'} (>${SURV_STALE_HOURS}h) — surveillance gate inactive this run`);
    surveillance = null;
  }
  const dealsData = loadDeals();
  const urlMap = readJson(TURL_PATH, {}) || {};
  // Conviction-to-hold inputs for the Ride Score: Screener.in fundamental screen +
  // marquee-investor holdings (both optional sidecars; empty sets if absent).
  const _screenerin = readJson(path.join(DOCS, 'screenerin-tickers.json'), null);
  const fundSet = new Set(((_screenerin && _screenerin.rows) || []).map(r => (r.ticker || '').toUpperCase()));
  const _investors = readJson(path.join(DOCS, 'investors-tickers.json'), null);
  const marqueeSet = new Set(((_investors && _investors.rows) || []).map(r => (r.ticker || '').toUpperCase()));
  const watchTickers = loadWatchlistTickers();

  // Detect old (compact) breakout2 sidecars and warn so the operator knows to regen
  if (b2Raw.length && b2Raw[0].pivot === undefined) {
    console.warn('  breakout2-data.json missing pivot/atr14/breakoutValid fields — regenerate via `npm run breakout2` to populate. Skipping trigger build.');
    return { triggers: [], skipped: true };
  }

  // Load the previous snapshot FIRST — buildTriggers uses it for hysteresis (holding a
  // just-broken name through small pullbacks), and the list-diff below uses it too.
  const prevPayload = readJson(OUT_JSON, null);
  const prevTriggers = (prevPayload && Array.isArray(prevPayload.triggers)) ? prevPayload.triggers : [];
  const prevMap = new Map(prevTriggers.map(t => [t.ticker, t]));

  const triggers = buildTriggers({
    b2: b2Raw, apex, mbf, ir, creamy, rocket, livePrices, liveFresh, earningsData,
    surveillance, dealsData, regime, urlMap, watchTickers, prevMap, fundSet, marqueeSet,
  });

  // List-diff: compare against the snapshot this run is about to overwrite so
  // we can flag stocks that just entered or dropped off the trigger list —
  // distinct from checkBreakoutTriggers() in monitor.js, which re-confirms
  // whether an *existing* trigger is still live-actionable.
  const currMap = new Map(triggers.map(t => [t.ticker, t]));

  const added = triggers
    .filter(t => !prevMap.has(t.ticker))
    .map(t => ({ ticker: t.ticker, name: t.name, sector: t.sector, url: t.url, signalType: t.signalType, conviction: t.conviction, tier: t.tier, entry: t.entry }));

  const b2ByTicker = new Map(b2Raw.map(r => [r.ticker, r]));
  const isBearNow = !!regime.isBearMarket;
  const minScoreNow = isBearNow ? 70 : 55;
  const removed = [];
  for (const [ticker, prevT] of prevMap) {
    if (currMap.has(ticker)) continue;
    removed.push({
      ticker, name: prevT.name, sector: prevT.sector,
      lastSignalType: prevT.signalType, lastConviction: prevT.conviction, lastTier: prevT.tier,
      reason: explainRemoval(ticker, { b2ByTicker, minScore: minScoreNow, earningsData, surveillance }),
    });
  }
  if (added.length || removed.length) console.log(`  List diff: +${added.length} entered, -${removed.length} dropped`);

  // Freshness clock: carry forward firstSeen from the previous snapshot (keyed by
  // ticker = "the opportunity"); a name absent last run is treated as newly fresh.
  // Then attach the timing model (enter-by window + ATR-based time-to-target).
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  for (const t of triggers) {
    const prev = prevMap.get(t.ticker);
    const firstSeen = (prev && prev.timing && prev.timing.firstSeen) ? prev.timing.firstSeen : nowIso;
    t.timing = computeTiming(t, firstSeen, nowMs);
  }

  // Persist machine-readable feed
  const payload = {
    generatedAt: nowIso,
    regime: { isBearMarket: regime.isBearMarket, ema26: regime.ema26, price: regime.price, ret22D: regime.ret22D },
    counts: {
      total: triggers.length,
      live: triggers.filter(t => t.signalType === 'LIVE_BREAKOUT').length,
      valid: triggers.filter(t => t.signalType === 'BREAKOUT_VALID').length,
      surge: triggers.filter(t => t.signalType === 'VOL_SURGE').length,
      reclaim: triggers.filter(t => t.signalType === 'DMA200_RECLAIM').length,
    },
    changes: { added, removed },
    triggers,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));

  // HTML
  const generatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  fs.writeFileSync(OUT_HTML, buildHtml({ triggers, regime, generatedAt }));

  // Append to outcome ledger (one row per trigger, deduped per day+ticker+signalType)
  const date = todayIST();
  const rows = triggers.map(t => ({
    date,
    screener: 'triggers',
    signalType: t.signalType,
    ticker: t.ticker,
    name: t.name,
    sector: t.sector,
    entry: t.entry,
    pivot: t.pivot,
    stop: t.stop,
    target: t.target,
    rr: t.rr,
    sizePct: t.sizePct,
    score: t.conviction,
    regime: regime.isBearMarket ? 'BEAR' : 'BULL',
    extras: {
      breakoutScore: t.breakoutScore,
      apexScore: t.apexScore,
      apexAction: t.apexAction,
      rsRating: t.rsRating,
      confluence: t.confluence,
      tier: t.tier,
      basis: t.basis,
    },
  }));
  const lg = appendOutcomes(rows);
  console.log(`  Outcomes: +${lg.added} added (${lg.skipped} dupes/skipped, ${lg.total} total)`);

  console.log(`Triggers: ${triggers.length} total | live:${payload.counts.live} eod-valid:${payload.counts.valid} surge:${payload.counts.surge} 200dma-reclaim:${payload.counts.reclaim}`);
  console.log(`Wrote ${OUT_JSON} and ${OUT_HTML}`);
  return payload;
}

if (require.main === module) main().catch(e => { console.error('Error:', e); process.exit(1); });
module.exports = { main };

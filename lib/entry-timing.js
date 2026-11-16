'use strict';

// Entry-timing classifier used by the Alerts page.
//
// Buy Zone / pivot is the Triggers breakout level (or a 20–40 bar high), NOT
// last price and NOT the user's Alert Below. Those three numbers can diverge
// on a dip, which is expected — but Prime / Armed must still require the live
// price to sit in the pivot window. Sidecar isLive / isArmed flags are hints,
// not overrides: the Triggers "armed" list includes names still 10–20% below
// resistance (AWAITING_BREAK), which must fall through to Base Forming.

const PRIME_MAX_PCT = 3.5;   // 0% to +3.5% of pivot
const ARMED_MIN_PCT = -2.8;  // -2.8% to 0% of pivot

function inPrimeWindow(pctToPivot) {
  return pctToPivot != null && pctToPivot >= 0 && pctToPivot <= PRIME_MAX_PCT;
}

function inArmedWindow(pctToPivot) {
  return pctToPivot != null && pctToPivot >= ARMED_MIN_PCT && pctToPivot < 0;
}

function evaluateEntryTiming(price, tech, trig) {
  const {
    s50, s200, sma200Up, aboveSma200, dma200Cross,
    pivot, atrPct, stage2
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
  // 3. Prime Breakout Entry — live price must be in the pivot window.
  // isLive may confirm a trigger already in-window; it must not force Prime
  // when price has run away or fallen back into the base.
  else if (
    inPrimeWindow(pctToPivot) && (aboveSma200 !== false || stage2 || trig?.isLive)
  ) {
    code = 'PRIME_BUY_ZONE';
    badge = '🎯 PRIME ENTRY · In Buy Zone';
    color = 'green';
    summary = `Trading ${pctToPivot ? '+' + pctToPivot.toFixed(1) + '%' : 'in sweet spot'} around Pivot (₹${effPivot?.toFixed(2)}).`;
    action = `Ideal entry window right now. Accumulate in Buy Zone: ₹${effPivot?.toFixed(2)} – ₹${(effPivot * 1.03).toFixed(2)}.`;
    priority = 1;
  }
  // 4. Armed & Coiling — same: isArmed is not a distance override.
  else if (
    inArmedWindow(pctToPivot) && (aboveSma200 !== false || stage2 || trig?.isArmed)
  ) {
    code = 'ARMED_COILING';
    badge = '⏳ ARMED · Coiling to Break Out';
    color = 'amber';
    summary = `Only ${Math.abs(pctToPivot || 0).toFixed(1)}% below Pivot (₹${effPivot?.toFixed(2)}). Volatility contracting.`;
    action = `Set a Buy-Stop Limit order at ₹${effPivot?.toFixed(2)}. Breakout is imminent.`;
    priority = 1;
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
    const gap = pctToPivot != null ? `${pctToPivot.toFixed(1)}% to Pivot` : 'awaiting pivot';
    code = 'BASE_BUILDING';
    badge = `💤 Base Forming · ${gap}`;
    color = 'slate';
    summary = `Consolidating in base pattern. Resistance at ₹${effPivot?.toFixed(2)} — that is the breakout buy, not today's dip.`;
    action = 'Do not treat last price as the buy. Wait for a coil into the pivot (within ~3%) or a 50-DMA bounce.';
    priority = 5;
  }

  // Trade plan is always the breakout blueprint (pivot / trigger entry), even
  // when last price is a dip far below it. The UI must label that distinction.
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

  const activeBuy = code === 'PRIME_BUY_ZONE' || code === 'ARMED_COILING'
    || code === 'PULLBACK_50DMA' || code === 'SUPPORT_200DMA' || code === 'RECLAIM_200';

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
    activeBuy,
  };
}

module.exports = {
  evaluateEntryTiming,
  inPrimeWindow,
  inArmedWindow,
  PRIME_MAX_PCT,
  ARMED_MIN_PCT,
};

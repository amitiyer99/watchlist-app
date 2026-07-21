'use strict';

// Curated, growing library of candidate features/formulas for the Best Picks
// master score. This is the single source of truth: lib/features.js computes
// each feature's normalized value per ticker, and feature-lab.js back-tests each
// one to decide whether it earns live weight.
//
// To add a "new best formula": append an entry here (and, if it needs a raw
// input not yet produced, compute that input in lib/features.js). It is then
// automatically enrolled in scoring (shadow) and in the walk-forward competition.
//
// Convention: every feature value is oriented so HIGHER = BETTER (more bullish).
// lib/features.js winsorizes + z-scores each across the universe.

const BLOCKS = ['momentum', 'technical', 'quality', 'value', 'conviction'];

const REGISTRY = [
  // ---- Momentum ----
  { id: 'rsRating',    label: 'IBD RS Rating',        block: 'momentum', rationale: '12-month weighted relative strength (1-99).' },
  { id: 'ret126_21',   label: '12-1 Momentum',        block: 'momentum', rationale: 'Jegadeesh-Titman: 12-month return skipping the most recent month.' },
  { id: 'ret63',       label: '3-Month Return',       block: 'momentum', rationale: 'Intermediate-term momentum.' },
  { id: 'high52prox',  label: '52w-High Proximity',   block: 'momentum', rationale: 'Closeness to 52-week high (George-Hwang anchoring).' },
  { id: 'distSma200',  label: 'Extension > SMA200',   block: 'momentum', rationale: 'Primary uptrend participation.' },
  { id: 'riskAdjMom',  label: 'Risk-Adjusted Mom',    block: 'momentum', rationale: 'RS per unit of ATR volatility (Sharpe-like).' },

  // ---- Technical setup quality ----
  { id: 'trendStack',  label: 'SMA Trend Stack',      block: 'technical', rationale: 'Minervini template: price>50>150>200.' },
  { id: 'vcp',         label: 'VCP Pass',             block: 'technical', rationale: 'Volatility contraction pattern.' },
  { id: 'stage2',      label: 'Stage-2 Uptrend',      block: 'technical', rationale: 'Weinstein stage analysis.' },
  { id: 'volSurge',    label: 'Volume Surge',         block: 'technical', rationale: 'Demand confirmation above pivot.' },
  { id: 'nearPivot',   label: 'Near Pivot',           block: 'technical', rationale: 'Proximity to the breakout pivot (low chase risk).' },
  { id: 'rsLineNewHigh', label: 'RS-Line New High',   block: 'technical', rationale: 'Stock/Nifty ratio at 52w high — institutional accumulation signature (IBD).' },
  { id: 'udVolRatio',    label: 'Up/Down Volume',     block: 'technical', rationale: '50d up-day vs down-day volume — accumulation vs churn.' },

  // ---- Quality ----
  { id: 'apexQuality', label: 'Capital Quality',      block: 'quality', rationale: 'APEX pillar 1 (balance-sheet / capital quality).' },
  { id: 'apexGrowth',  label: 'Growth Engine',        block: 'quality', rationale: 'APEX pillar 2 (earnings/sales growth).' },
  { id: 'roe',         label: 'Return on Equity',     block: 'quality', rationale: 'Profitability / quality-minus-junk tilt.' },
  { id: 'epsGwth5Y',   label: 'EPS 5Y CAGR',          block: 'quality', rationale: 'Durable compounding.' },
  { id: 'earnMom',     label: 'Earnings Momentum',    block: 'quality', rationale: 'Surprise + beat streak + estimate revisions (PEAD/SUE literature).' },

  // ---- Value ----
  { id: 'apexValue',   label: 'Valuation Pillar',     block: 'value', rationale: 'APEX pillar 3 (valuation).' },
  { id: 'fcfYield',    label: 'FCF Yield',            block: 'value', rationale: 'Cash generation vs price.' },
  { id: 'pegInv',      label: 'Inverse PEG',          block: 'value', rationale: 'Growth at a reasonable price (lower PEG better).' },

  // ---- Conviction / smart money ----
  { id: 'promoterHolding', label: 'Promoter Holding', block: 'conviction', rationale: 'Insider skin-in-the-game.' },
  { id: 'promoterChg3M',   label: 'Promoter 3M Chg',  block: 'conviction', rationale: 'Insider accumulation.' },
  { id: 'deliverySurge',   label: 'Delivery Surge',   block: 'conviction', rationale: 'NSE delivery% spike = real accumulation.' },
  { id: 'bulkDealBuy',     label: 'Bulk/Block Buy',   block: 'conviction', rationale: 'Disclosed institutional bulk/block BUY in the last 30 days.' },
  { id: 'screenerCount',   label: 'Screener Overlap', block: 'conviction', rationale: 'Independent confirmation across screeners.' },
  { id: 'apexConvergence', label: 'APEX Convergence', block: 'conviction', rationale: 'All APEX pillars aligned.' },
];

const BY_ID = new Map(REGISTRY.map(f => [f.id, f]));
function blockOf(id) { return BY_ID.has(id) ? BY_ID.get(id).block : null; }
function idsByBlock(block) { return REGISTRY.filter(f => f.block === block).map(f => f.id); }

module.exports = { REGISTRY, BLOCKS, blockOf, idsByBlock, BY_ID };

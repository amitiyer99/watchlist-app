'use strict';

const fs = require('fs');
const path = require('path');
const { makeClient, history } = require('./lib/yahoo');   // history() uses chart(); .historical() is deprecated and silently returns nothing
const yf = makeClient();

const { computeRegimeV2, writeRegime, REGIME_PATH } = require('./lib/regime');

const BENCH = '^NSEI';
// Yahoo Finance index symbols for the optional V2 components:
//   '^NSEMDCP50' = Nifty Midcap 50, '^CNXSC' = Nifty Smallcap 100.
// Both are best-effort inputs — if a fetch fails at runtime the component is
// simply null inside computeRegimeV2; the run never crashes because of them.
const MIDCAP   = '^NSEMDCP50';
const SMALLCAP = '^CNXSC';
const LOOKBACK_DAYS = 150; // calendar days ≈ 100 trading bars (63d spread needs 64+)

async function fetchBars(symbol) {
  const p1 = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  const p2 = new Date(Date.now() - 86400000);
  const bars = await history(yf, symbol, { period1: p1, period2: p2, interval: '1d' });
  if (!bars || !bars.length) throw new Error('no bars');
  return bars.filter(b => b.close != null).sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Independently fault-tolerant fetch: any failure -> null (component omitted).
async function fetchOptional(symbol) {
  try {
    const bars = await fetchBars(symbol);
    console.log(`  ${symbol}: ${bars.length} bars`);
    return bars;
  } catch (e) {
    console.warn(`  ${symbol}: fetch failed (${e.message}) — component will be null`);
    return null;
  }
}

// Breadth inputs from the breakout2 sidecar (docs/breakout2-data.json), if present:
//   pctAbove200 = share of sidecar stocks with price > s200
//   pctNearHigh = share within 25% of high52 (price >= 0.75 * high52)
//   netNewHighs = (# price >= 0.99*high52) - (# price <= 1.05*low52), as % of universe
// Any problem (missing file, bad JSON, empty list) -> null, never a crash.
function computeBreadthFromSidecar() {
  try {
    const p = path.join(__dirname, 'docs', 'breakout2-data.json');
    if (!fs.existsSync(p)) return null;
    const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(rows) || !rows.length) return null;
    const univ = rows.filter(r => r && r.price != null);
    if (!univ.length) return null;
    const with200  = univ.filter(r => r.s200 != null);
    const withHigh = univ.filter(r => r.high52 != null);
    const pctAbove200 = with200.length
      ? (with200.filter(r => r.price > r.s200).length / with200.length) * 100 : null;
    const pctNearHigh = withHigh.length
      ? (withHigh.filter(r => r.price >= r.high52 * 0.75).length / withHigh.length) * 100 : null;
    const newHighs = univ.filter(r => r.high52 != null && r.price >= r.high52 * 0.99).length;
    const newLows  = univ.filter(r => r.low52  != null && r.price <= r.low52  * 1.05).length;
    const netNewHighs = ((newHighs - newLows) / univ.length) * 100;
    console.log(`  breadth: ${univ.length} sidecar stocks | above200 ${pctAbove200 != null ? pctAbove200.toFixed(1) + '%' : '—'} | nearHigh ${pctNearHigh != null ? pctNearHigh.toFixed(1) + '%' : '—'} | netNewHighs ${netNewHighs.toFixed(1)}%`);
    return { pctAbove200, pctNearHigh, netNewHighs, universe: univ.length };
  } catch (e) {
    console.warn(`  breadth: sidecar unreadable (${e.message}) — component will be null`);
    return null;
  }
}

async function main() {
  console.log(`Fetching ${BENCH} bars for regime snapshot...`);
  let bars;
  try {
    bars = await fetchBars(BENCH);
  } catch (e) {
    console.error(`Failed to fetch ${BENCH}: ${e.message}`);
    process.exit(1);
  }
  if (!bars || bars.length < 30) {
    console.error('Insufficient Nifty bars for regime.');
    process.exit(1);
  }

  console.log('Fetching optional V2 components (midcap / smallcap / breadth)...');
  const [midcapBars, smallcapBars] = await Promise.all([
    fetchOptional(MIDCAP),
    fetchOptional(SMALLCAP),
  ]);
  const breadth = computeBreadthFromSidecar();

  const regime = computeRegimeV2(bars, { midcapBars, smallcapBars, breadth });
  const written = writeRegime(regime);
  const c = regime.components || {};
  console.log(`Regime: ${regime.isBearMarket ? 'BEAR' : 'BULL'} | Nifty ${regime.price?.toFixed(0)} vs EMA26 ${regime.ema26} | 22D ${regime.ret22D != null ? (regime.ret22D >= 0 ? '+' : '') + regime.ret22D + '%' : '—'}`);
  console.log(`  riskScore ${regime.riskScore}/100 (trend ${c.trendScore} + distDays ${c.ddScore} + breadth ${c.breadthScore} + smallcap ${c.spreadScore})${c.oldRuleBear ? ' | old rule: BEAR' : ''}`);
  console.log(`  distDays ${regime.distributionDays ?? '—'} [${regime.ddBasis ?? '—'}] | breadth200 ${regime.breadthPct200 ?? '—'}% | netNewHighs ${regime.netNewHighsPct ?? '—'}% | smallVsNifty63 ${regime.smallVsNifty63 ?? '—'}%`);
  console.log(`Wrote ${REGIME_PATH} @ ${written.asOf}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

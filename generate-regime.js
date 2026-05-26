'use strict';

const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const { computeMarketRegime, writeRegime, REGIME_PATH } = require('./lib/regime');

const BENCH = '^NSEI';

async function main() {
  console.log(`Fetching ${BENCH} bars for regime snapshot...`);
  const p1 = new Date(Date.now() - 120 * 86400000);
  const p2 = new Date(Date.now() - 86400000);
  let bars;
  try {
    bars = await yf.historical(BENCH, { period1: p1, period2: p2, interval: '1d' });
  } catch (e) {
    console.error(`Failed to fetch ${BENCH}: ${e.message}`);
    process.exit(1);
  }
  if (!bars || bars.length < 30) {
    console.error('Insufficient Nifty bars for regime.');
    process.exit(1);
  }
  bars = bars.filter(b => b.close != null).sort((a, b) => new Date(a.date) - new Date(b.date));
  const regime = computeMarketRegime(bars);
  const written = writeRegime(regime);
  console.log(`Regime: ${regime.isBearMarket ? 'BEAR' : 'BULL'} | Nifty ${regime.price?.toFixed(0)} vs EMA26 ${regime.ema26} | 22D ${regime.ret22D != null ? (regime.ret22D >= 0 ? '+' : '') + regime.ret22D + '%' : '—'}`);
  console.log(`Wrote ${REGIME_PATH} @ ${written.asOf}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

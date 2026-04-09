const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

async function main() {
  const tickers = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS'];

  for (const ticker of tickers) {
    console.log(`\n=== ${ticker} ===`);

    // Test earningsTrend - forward earnings estimates
    try {
      const qs = await yahooFinance.quoteSummary(ticker, { modules: ['earningsTrend'] });
      const et = qs.earningsTrend?.trend || [];
      console.log('  earningsTrend:');
      for (const t of et.slice(0, 3)) {
        console.log(`    ${t.period} ${t.endDate}: epsEstimate=${t.earningsEstimate?.avg} revEstimate=${t.revenueEstimate?.avg} growth=${t.growth?.raw}`);
      }
    } catch (e) { console.log('  earningsTrend: ERROR -', e.message?.slice(0, 80)); }

    // Test upgradeDowngradeHistory - analyst actions
    try {
      const qs = await yahooFinance.quoteSummary(ticker, { modules: ['upgradeDowngradeHistory'] });
      const hist = qs.upgradeDowngradeHistory?.history || [];
      console.log(`  upgradeDowngradeHistory: ${hist.length} records`);
      for (const h of hist.slice(0, 3)) {
        console.log(`    ${h.epochGradeDate ? new Date(h.epochGradeDate * 1000).toLocaleDateString() : '?'} ${h.firm}: ${h.action} ${h.fromGrade} -> ${h.toGrade}`);
      }
    } catch (e) { console.log('  upgradeDowngrade: ERROR -', e.message?.slice(0, 80)); }

    // Test earningsHistory - past earnings surprises
    try {
      const qs = await yahooFinance.quoteSummary(ticker, { modules: ['earningsHistory'] });
      const hist = qs.earningsHistory?.history || [];
      console.log(`  earningsHistory: ${hist.length} records`);
      for (const h of hist.slice(0, 2)) {
        console.log(`    Q${h.quarter?.fmt}: est=${h.epsEstimate?.raw} actual=${h.epsActual?.raw} surprise=${h.surprisePercent?.raw}%`);
      }
    } catch (e) { console.log('  earningsHistory: ERROR -', e.message?.slice(0, 80)); }

    // Test defaultKeyStatistics - beta, forward PE, PEG, short ratio
    try {
      const qs = await yahooFinance.quoteSummary(ticker, { modules: ['defaultKeyStatistics'] });
      const ks = qs.defaultKeyStatistics;
      console.log('  keyStatistics:');
      console.log(`    forwardPE=${ks?.forwardPE} pegRatio=${ks?.pegRatio} beta=${ks?.beta} bookValue=${ks?.bookValue}`);
      console.log(`    enterpriseValue=${ks?.enterpriseValue} profitMargins=${ks?.profitMargins} floatShares=${ks?.floatShares}`);
      console.log(`    earningsGrowthQ=${ks?.earningsQuarterlyGrowth} revenueGrowthQ=${ks?.revenueQuarterlyGrowth}`);
    } catch (e) { console.log('  keyStatistics: ERROR -', e.message?.slice(0, 80)); }

    // Test recommendationTrend - aggregate analyst recommendations over time
    try {
      const qs = await yahooFinance.quoteSummary(ticker, { modules: ['recommendationTrend'] });
      const trends = qs.recommendationTrend?.trend || [];
      console.log(`  recommendationTrend: ${trends.length} periods`);
      for (const t of trends.slice(0, 2)) {
        console.log(`    ${t.period}: strong_buy=${t.strongBuy} buy=${t.buy} hold=${t.hold} sell=${t.sell} strong_sell=${t.strongSell}`);
      }
    } catch (e) { console.log('  recommendationTrend: ERROR -', e.message?.slice(0, 80)); }

    // Summary profile
    try {
      const qs = await yahooFinance.quoteSummary(ticker, { modules: ['summaryProfile'] });
      const sp = qs.summaryProfile;
      console.log(`  summaryProfile: sector=${sp?.sector} industry=${sp?.industry} employees=${sp?.fullTimeEmployees}`);
    } catch (e) { console.log('  summaryProfile: ERROR -', e.message?.slice(0, 80)); }
  }
}

main().catch(console.error);

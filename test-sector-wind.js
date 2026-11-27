'use strict';

const {
  evaluateSectorWind,
  chipHtml,
  chipFor,
  loadSectorTrends,
} = require('./lib/sector-wind');

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const trends = loadSectorTrends();
check('sector heat sidecar loaded', trends.size >= 10, 'got ' + trends.size);

const it = evaluateSectorWind({ ticker: 'TCS', sector: 'Information Technology' }, trends);
check('IT maps to Nifty IT', it.indexName === 'Nifty IT', it.indexName);
check('IT is tailwind (score>=55 or uptrend)', it.wind === 'TAILWIND', JSON.stringify({ wind: it.wind, score: it.score, trend: it.trend }));

const metal = evaluateSectorWind({ ticker: 'TATASTEEL', sector: 'Materials' }, trends);
check('Materials maps to Nifty Metal', metal.indexName === 'Nifty Metal', metal.indexName);
check('Metal is headwind (score<45 or downtrend)', metal.wind === 'HEADWIND', JSON.stringify({ wind: metal.wind, score: metal.score, trend: metal.trend }));

const durables = evaluateSectorWind({ ticker: 'DIXON', sector: 'Consumer Durables' }, trends);
check('Durables maps to Nifty Consumer Durables', durables.indexName === 'Nifty Consumer Durables', durables.indexName);
check('Durables score 54 stays neutral', durables.wind === 'NEUTRAL', JSON.stringify({ wind: durables.wind, score: durables.score, trendClass: durables.trendClass }));

const bank = evaluateSectorWind('HDFCBANK', 'Financial Services', trends);
check('legacy (ticker, sector, trends) still works', bank.sector === 'Banking' && bank.indexName === 'Nifty Bank', JSON.stringify({ sector: bank.sector, index: bank.indexName }));

const empty = evaluateSectorWind({ ticker: 'ZZZNOPE' }, new Map());
check('unknown stock without heat is neutral/broad', empty.wind === 'NEUTRAL' && empty.indexName === 'Broad Market', JSON.stringify(empty));

const chip = chipHtml(it);
check('chip is a wind-badge, not a layout rewrite', /class="[^"]*wind-badge[^"]*wind-tail/.test(chip) && chip.includes('Tailwind'), chip.slice(0, 180));
check('chipFor matches evaluateSectorWind', chipFor({ ticker: 'TCS', sector: 'Information Technology' }, trends).includes('wind-tail'));

const failed = results.filter(r => !r.pass);
results.forEach(r => console.log((r.pass ? 'ok  ' : 'FAIL') + ' ' + r.name + (r.detail ? ' — ' + r.detail : '')));
if (failed.length) {
  console.error('\n' + failed.length + ' failed');
  process.exit(1);
}
console.log('\n' + results.length + ' passed');

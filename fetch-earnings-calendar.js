'use strict';

// Fetch upcoming earnings dates for a focused universe (apex + breakout2 sidecars)
// from Yahoo Finance `calendarEvents.earnings.earningsDate` and persist to
// docs/earnings-calendar.json. Consumers (debate, apex) use this to demote BUY/Hot
// recommendations when an earnings event is within 7 trading days.

const fs   = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const DOCS = path.join(__dirname, 'docs');
const OUT  = path.join(DOCS, 'earnings-calendar.json');
const APEX = path.join(DOCS, 'apex-tickers.json');
const B2   = path.join(DOCS, 'breakout2-data.json');
const MBF  = path.join(DOCS, 'multibagger-tickers.json');

function readArr(p) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : []; } catch { return []; } }

function buildUniverse() {
  const seen = new Set();
  const out = [];
  for (const src of [readArr(APEX), readArr(B2), readArr(MBF)]) {
    for (const r of src) {
      if (r && r.ticker && !seen.has(r.ticker)) { seen.add(r.ticker); out.push(r.ticker); }
    }
  }
  return out;
}

async function main() {
  const universe = buildUniverse();
  if (!universe.length) { console.warn('No tickers found — apex/breakout2/multibagger sidecars are missing.'); return; }
  console.log(`Fetching earnings dates for ${universe.length} tickers...`);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cal = {};
  let withDate = 0;
  for (let i = 0; i < universe.length; i += 15) {
    const batch = universe.slice(i, i + 15);
    const results = await Promise.all(batch.map(async t => {
      try {
        const qs = await yf.quoteSummary(t + '.NS', { modules: ['calendarEvents'] });
        const earnings = qs && qs.calendarEvents && qs.calendarEvents.earnings;
        const arr = (earnings && earnings.earningsDate) || [];
        // If every date in arr is already in the past, there's no known upcoming
        // earnings date — fall back to null rather than a stale past date (arr[0]).
        const nextRaw = arr.find(d => new Date(d) >= today) || null;
        const next = nextRaw ? new Date(nextRaw) : null;
        if (!next || isNaN(next.getTime())) return { t, next: null };
        const ms = next - today;
        const calDays = Math.round(ms / 86400000);
        return { t, next: next.toISOString().slice(0, 10), calDays };
      } catch { return { t, next: null }; }
    }));
    for (const r of results) {
      if (r.next) {
        cal[r.t] = {
          nextEarningsDate: r.next,
          calDays: r.calDays,
          earningsWithin7d: r.calDays >= 0 && r.calDays <= 7,
          earningsWithin14d: r.calDays >= 0 && r.calDays <= 14,
        };
        withDate++;
      }
    }
    process.stdout.write(`  ${Math.min(i + 15, universe.length)}/${universe.length}\r`);
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`\n  ${withDate} tickers with earnings date`);

  const payload = {
    updatedAt: new Date().toISOString(),
    universe: universe.length,
    withDate,
    stocks: cal,
  };
  if (!fs.existsSync(DOCS)) fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${OUT}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main };

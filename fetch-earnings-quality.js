'use strict';

// ── Earnings-quality fetcher ──────────────────────────────────────────────────
// Scrapes each candidate stock's QUARTERLY results table from its Screener.in
// company page (#quarters: Sales / OPM % / Net Profit across ~13 quarters) into
// docs/earnings-quality.json, so the app can score earnings ACCELERATION and run a
// post-results drift window instead of treating results purely as blackout risk.
//
// Results-recency without an extra data source: we remember each ticker's latest
// reported quarter between runs. When that label advances (e.g. Mar 2026 → Jun 2026),
// results just landed — we stamp resultsSeenAt with today's date. The first run only
// seeds the labels (no drift flags), so drift detection starts working from run 2.
//
// Candidate universe is capped and prioritised (breakout setups first, then your
// Screener.in quality names, then watchlist) because each stock is one page load and
// Screener.in rate-limits bursts. Run locally: npm run fetch-earnings-quality

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { chromium } = require('playwright');
const { quarterOrd } = require('./lib/earnings-quality');

const DOCS        = path.join(__dirname, 'docs');
const OUT_PATH    = path.join(DOCS, 'earnings-quality.json');
const SESSION_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'watchlist-app-session');
const HEADLESS    = process.env.HEADLESS === '1';
const MAX_STOCKS  = parseInt(process.env.MAX_STOCKS || '120', 10); // page loads per run
const THROTTLE_MS = 3000;   // polite gap — Screener.in throttles bursts
const KEEP_DAYS   = 200;    // drop rows not refreshed in this long

function readJson(p, fb = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
const toNum = v => {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').replace(/%/g, '').trim();
  if (!s || s === '-') return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
};

// Priority-ordered, de-duplicated candidate list.
function buildCandidates() {
  const seen = new Set();
  const out = [];
  const add = t => {
    const k = String(t || '').trim().toUpperCase();
    if (!k || seen.has(k) || /^\d+$/.test(k)) return; // skip BSE-code-only names
    seen.add(k); out.push(k);
  };
  // 1. Breakout setups (best technical candidates first) — these are what we'd trade.
  const b2 = readJson(path.join(DOCS, 'breakout2-data.json'), []) || [];
  const b2rows = Array.isArray(b2) ? b2 : (b2.rows || []);
  [...b2rows].sort((a, b) => (b.score || b.totalScore || 0) - (a.score || a.totalScore || 0)).forEach(r => add(r.ticker));
  // 2. Your Screener.in quality screen.
  const si = readJson(path.join(DOCS, 'screenerin-tickers.json'), null);
  ((si && si.rows) || []).forEach(r => add(r.ticker));
  // 3. Marquee-investor holdings.
  const inv = readJson(path.join(DOCS, 'investors-tickers.json'), null);
  ((inv && inv.rows) || []).forEach(r => add(r.ticker));
  return out;
}

// Runs in-page: pull the quarterly results table.
async function scrapeQuarters(page) {
  return page.evaluate(() => {
    const sec = document.querySelector('#quarters');
    if (!sec) return null;
    const t = sec.querySelector('table');
    if (!t) return null;
    const heads = [...t.querySelectorAll('thead th')].map(x => x.textContent.trim());
    const quarters = heads.slice(1).filter(Boolean);
    const grab = (re) => {
      for (const tr of t.querySelectorAll('tbody tr')) {
        const tds = [...tr.querySelectorAll('td')];
        if (!tds.length) continue;
        const label = (tds[0].textContent || '').replace(/\s+/g, ' ').trim();
        if (re.test(label)) return tds.slice(1).map(td => td.textContent.trim());
      }
      return null;
    };
    return {
      quarters,
      salesRaw:  grab(/^sales/i),
      opmRaw:    grab(/^opm/i),
      profitRaw: grab(/^net profit/i),
    };
  });
}

async function main() {
  console.log('📈  Earnings-quality fetcher (quarterly acceleration)');
  const prev = readJson(OUT_PATH, null);
  const prevByTicker = new Map(((prev && prev.rows) || []).map(r => [String(r.ticker).toUpperCase(), r]));
  const candidates = buildCandidates().slice(0, MAX_STOCKS);
  if (!candidates.length) { console.warn('  No candidates (run breakout2 first). Nothing to do.'); return; }
  console.log(`  ${candidates.length} candidate stock(s) this run (cap ${MAX_STOCKS}) · ${prevByTicker.size} known from last run`);

  let context;
  try {
    context = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: HEADLESS, viewport: { width: 1300, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    console.warn(`  WARNING: could not launch Chromium (${e.message}). Try: npx playwright install chromium.`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  let ok = 0, missing = 0, newResults = 0, rateLimited = false;
  try {
    const page = context.pages()[0] || await context.newPage();
    for (const ticker of candidates) {
      if (rateLimited) break;
      try {
        await page.goto(`https://www.screener.in/company/${encodeURIComponent(ticker)}/consolidated/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        if (/too many requests/i.test(body)) {
          console.warn(`    rate-limited at ${ticker} — waiting 60s then retrying once…`);
          await page.waitForTimeout(60000);
          await page.goto(`https://www.screener.in/company/${encodeURIComponent(ticker)}/consolidated/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const b2 = await page.evaluate(() => document.body.innerText || '').catch(() => '');
          if (/too many requests/i.test(b2)) { rateLimited = true; console.warn('    still rate-limited — stopping; re-run later to continue.'); break; }
        }
        const q = await scrapeQuarters(page);
        if (!q || !q.quarters || !q.quarters.length || !q.salesRaw) { missing++; }
        else {
          const sales  = q.salesRaw.map(toNum);
          const opm    = (q.opmRaw || []).map(toNum);
          const profit = (q.profitRaw || []).map(toNum);
          const latestQuarter = q.quarters[q.quarters.length - 1] || null;
          const p = prevByTicker.get(ticker);
          // Results-recency: a NEW latest quarter means results just dropped.
          let resultsSeenAt = p && p.resultsSeenAt ? p.resultsSeenAt : null;
          if (p && p.latestQuarter && latestQuarter && quarterOrd(latestQuarter) > quarterOrd(p.latestQuarter)) {
            resultsSeenAt = today; newResults++;
          } else if (!p) {
            resultsSeenAt = null; // seed only — don't fake a drift window on first sight
          }
          rows.push({ ticker, quarters: q.quarters, sales, opm, profit, latestQuarter, resultsSeenAt, refreshedAt: today });
          ok++;
        }
      } catch (e) { missing++; }
      await page.waitForTimeout(THROTTLE_MS);
      if (ok && ok % 25 === 0) process.stdout.write(`    …${ok} scraped\r`);
    }
  } finally {
    await context.close().catch(() => {});
  }

  if (!ok) { console.warn(`  WARNING: nothing scraped — keeping existing ${OUT_PATH}.`); return; }

  // Merge: keep previously-known rows we didn't revisit this run (rolling coverage).
  const merged = new Map(rows.map(r => [r.ticker, r]));
  const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  for (const [t, r] of prevByTicker) {
    if (!merged.has(t) && (r.refreshedAt || '9999') >= cutoff) merged.set(t, r);
  }

  const payload = { updatedAt: new Date().toISOString(), source: 'screener.in/company (#quarters)', scrapedThisRun: ok, newResultsDetected: newResults, rows: [...merged.values()] };
  if (!fs.existsSync(DOCS)) fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`\n  ✅  ${ok} scraped (${missing} no-table/failed) · ${newResults} fresh results detected · ${merged.size} total rows`);
  console.log(`  Wrote ${OUT_PATH}`);
  if (!prev) console.log('  NOTE: first run seeded quarter labels — post-results drift flags start from the next run.');
}

if (require.main === module) {
  main().catch(e => { console.warn(`  WARNING: earnings-quality fetch failed (${e.message}). Keeping old file.`); process.exit(0); });
}
module.exports = { main, buildCandidates };

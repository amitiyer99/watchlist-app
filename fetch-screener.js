'use strict';

// ── Screener.in fetcher ───────────────────────────────────────────────────────
// Pulls one or more Screener.in raw-query screens straight from the site into the
// sidecar docs/screenerin-tickers.json — no CSV export, no manual step.
//
// HOW: Screener.in runs any custom screen via a plain GET on
//   /screen/raw/?query=<encoded>&page=N
// returning a fully server-rendered results table. Public/fundamental screens load
// without login. We drive a real browser (Playwright) so the page renders exactly
// as a human sees it, then read the table straight out of the DOM — including each
// row's /company/<SYMBOL>/ link, which gives the EXACT NSE ticker (no fuzzy name
// matching needed; we keep the name matcher only as a fallback).
//
// The screens + their queries live in screener-config.json so you can tune the
// thesis without touching code. Run locally:  npm run fetch-screener
// (opens a short-lived browser window; commit the sidecar or use fetch-screener.bat).

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { chromium } = require('playwright');
const { detectColumns, buildResolver, resolveTicker, normName } = require('./lib/screener-import');

const CONFIG_PATH = path.join(__dirname, 'screener-config.json');
const OUT_PATH    = path.join(__dirname, 'docs', 'screenerin-tickers.json');
const RAW_URL     = 'https://www.screener.in/screen/raw/';
// Reuse the same persisted browser profile the other fetchers use.
const SESSION_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'watchlist-app-session');
const HEADLESS    = process.env.HEADLESS === '1';

// Two kinds of sources, both fetched from the logged-in session:
//   • raw query   (config.screens[].query)      → /screen/raw/?query=…&page=N
//   • saved screen(config.savedScreens[].id)    → /screens/<id>/?page=N  (private OK)
// The saved-screen form lets you drop in any screen you built in the Screener.in
// UI (e.g. your YouTube-strategy screener) just by pasting its numeric id.
function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const clampPages = n => Math.max(1, Math.min(20, n || 8));
  const raw = (Array.isArray(cfg.screens) ? cfg.screens : [])
    .filter(s => s && s.query)
    .map(s => ({ label: s.label || 'Screen', maxPages: clampPages(s.maxPages), urlFor: p => `${RAW_URL}?query=${encodeURIComponent(s.query)}&page=${p}` }));
  const saved = (Array.isArray(cfg.savedScreens) ? cfg.savedScreens : [])
    .filter(s => s && s.id)
    .map(s => ({ label: s.label || `Screen ${s.id}`, maxPages: clampPages(s.maxPages), urlFor: p => `https://www.screener.in/screens/${String(s.id).replace(/[^0-9]/g, '')}/?page=${p}` }));
  return [...raw, ...saved];
}

function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[,%₹\s]/g, ''));
  return isFinite(n) ? n : null;
}

// Extract the results table from the live DOM: header cells + each data row's
// company symbol (from the /company/<slug>/ link), display name, and cell values.
async function scrapePage(page) {
  return page.evaluate(() => {
    const table = document.querySelector('table.data-table') || document.querySelector('main table');
    if (!table) return { headers: [], rows: [] };
    const headers = [...table.querySelectorAll('thead th, tr:first-child th')].map(th => th.textContent.trim());
    const rows = [];
    for (const tr of table.querySelectorAll('tbody tr')) {
      const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
      if (!cells.length) continue;
      const link = tr.querySelector('a[href*="/company/"]');
      let slug = null, name = null;
      if (link) {
        name = link.textContent.trim();
        const m = link.getAttribute('href').match(/\/company\/([^/]+)\//);
        if (m) slug = decodeURIComponent(m[1]);
      }
      // header/spacer rows repeat the column titles — skip them
      if (!name && (!cells[1] || /^name$/i.test(cells[1]))) continue;
      rows.push({ slug, name: name || cells[1] || '', cells });
    }
    return { headers, rows };
  });
}

async function main() {
  console.log('📊  Screener.in fetcher (live, no CSV)');
  const screens = loadConfig();
  if (!screens.length) { console.warn('  No screens in screener-config.json — nothing to do.'); return; }

  let context;
  try {
    context = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: HEADLESS,
      viewport: { width: 1300, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    console.warn(`  WARNING: could not launch Chromium (${e.message}). Try: npx playwright install chromium. Keeping existing file.`);
    return;
  }

  const resolver = buildResolver();
  const screensMeta = [];
  const byTicker = new Map();
  let anySuccess = false;

  try {
    const page = context.pages()[0] || await context.newPage();
    for (const scr of screens) {
      let matched = 0, unmatched = 0, pagesRead = 0, sawSymbolCol = false;
      const seenThisScreen = new Set();
      let loginNeeded = false;
      for (let p = 1; p <= scr.maxPages; p++) {
        let data;
        try {
          await page.goto(scr.urlFor(p), { waitUntil: 'domcontentloaded', timeout: 45000 });
          // Not logged in? Screener.in bounces custom/private screens to /register or /login.
          if (/\/register\/|\/login\//.test(page.url())) { loginNeeded = true; break; }
          await page.waitForSelector('table.data-table, main table', { timeout: 15000 }).catch(() => {});
          data = await scrapePage(page);
        } catch (e) { console.warn(`    page ${p} failed: ${e.message}`); break; }
        if (!data.rows.length) break;
        pagesRead = p;

        const cols = detectColumns(data.headers);
        const beforeCount = seenThisScreen.size;
        for (const r of data.rows) {
          // 1) exact ticker from the company link; 2) fuzzy name fallback
          let ticker = null, method = 'none';
          if (r.slug && /^[A-Za-z][A-Za-z0-9&._-]*$/.test(r.slug) && !/^\d+$/.test(r.slug)) {
            ticker = r.slug.toUpperCase(); method = 'link';
          } else {
            const res = resolveTicker(r.name, resolver);
            ticker = res.ticker; method = res.method;
          }
          if (!ticker) { unmatched++; continue; }
          if (seenThisScreen.has(ticker)) continue; // pagination overlap guard
          seenThisScreen.add(ticker);
          matched++;

          const metrics = {};
          for (const [concept, ci] of Object.entries(cols)) {
            if (concept === 'name') continue;
            const val = toNum(r.cells[ci]);
            if (val != null) { metrics[concept] = val; sawSymbolCol = true; }
          }
          let rec = byTicker.get(ticker);
          if (!rec) { rec = { ticker, name: r.name, price: null, marketCap: null, screens: [], metrics: {} }; byTicker.set(ticker, rec); }
          if (!rec.screens.includes(scr.label)) rec.screens.push(scr.label);
          if (metrics.price != null) rec.price = metrics.price;
          if (metrics.marketCap != null) rec.marketCap = metrics.marketCap;
          Object.assign(rec.metrics, metrics);
        }
        // Stop when a page adds no NEW tickers — Screener.in wraps out-of-range
        // pages back to page 1 instead of returning empty, so this guards against
        // re-scanning the same rows once we've passed the real last page.
        if (seenThisScreen.size === beforeCount) break;
        if (data.rows.length < 10) break; // partial page = last page
      }
      if (loginNeeded) {
        console.warn(`  • "${scr.label}": NOT LOGGED IN — Screener.in requires a login for this screen.`);
        console.warn('    Run  npm run login-screener  (or login-screener.bat) once, then retry.');
        continue;
      }
      console.log(`  • "${scr.label}": ${matched} stocks over ${pagesRead} page(s)${unmatched ? `, ${unmatched} unresolved` : ''}`);
      screensMeta.push({ name: scr.label, count: matched, unmatched });
      if (matched > 0) anySuccess = true;
    }
  } finally {
    await context.close().catch(() => {});
  }

  if (!anySuccess) {
    console.warn(`  WARNING: no rows scraped (site blocked, query error, or offline). Keeping existing ${OUT_PATH}.`);
    return;
  }

  // Sector from existing sidecars (Screener export carries none).
  const sectorMap = new Map();
  try {
    for (const f of fs.readdirSync(path.join(__dirname, 'docs'))) {
      if (!/-tickers\.json$|-data\.json$/.test(f)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs', f), 'utf8'));
        (Array.isArray(raw) ? raw : (raw.rows || raw.stocks || [])).forEach(r => {
          const t = (r.ticker || r.t || '').toUpperCase();
          if (t && r.sector && !sectorMap.has(t)) sectorMap.set(t, r.sector);
        });
      } catch { /* skip */ }
    }
  } catch { /* none */ }

  const totalScreens = screensMeta.length;
  const { fundScore } = require('./ingest-screener');
  const rows = [...byTicker.values()].map(r => ({
    ticker: r.ticker,
    name: r.name,
    sector: sectorMap.get(r.ticker) || '',
    price: r.price ?? null,
    marketCap: r.marketCap ?? null,
    score: fundScore(r.screens.length, totalScreens, r.metrics),
    screens: r.screens,
    screenCount: r.screens.length,
    metrics: r.metrics,
    url: '',
  }));
  rows.sort((a, b) => (b.screenCount - a.screenCount) || (b.score - a.score));

  const payload = { updatedAt: new Date().toISOString(), source: 'screener.in', totalScreens, screens: screensMeta, rows };
  if (!fs.existsSync(path.dirname(OUT_PATH))) fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`\n  ✅  ${rows.length} unique stocks across ${totalScreens} screen(s) → ${OUT_PATH}`);
  console.log('  Next: commit docs/screenerin-tickers.json (or run fetch-screener.bat) — CI folds it into Confluence + Sniper.');
}

if (require.main === module) {
  main().catch(e => { console.warn(`  WARNING: screener fetch failed (${e.message}). Keeping old file.`); process.exit(0); });
}
module.exports = { main, loadConfig };

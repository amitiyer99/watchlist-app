'use strict';

// ── Marquee-investor fetcher ──────────────────────────────────────────────────
// Pulls the current holdings of India's "superstar" investors from their
// Screener.in shareholder pages (screener.in/people/<id>/) into the sidecar
// docs/investors-tickers.json. Each page has a quarter-by-quarter Shareholding
// matrix (every company where the investor holds >1%); we read the most recent
// stake and whether it rose/fell, then aggregate across investors so a stock held
// by MANY superstars — or freshly added by one — stands out.
//
// Uses the same logged-in Playwright profile as fetch-screener. Run locally:
//   npm run fetch-investors   (or fetch-investors.bat)

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { chromium } = require('playwright');
const { deriveHolding, aggregate, marqueeScore, DEFAULT_CURRENT_WINDOW } = require('./lib/investors');

const CONFIG_PATH = path.join(__dirname, 'investors-config.json');
const OUT_PATH    = path.join(__dirname, 'docs', 'investors-tickers.json');
const SESSION_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'watchlist-app-session');
const HEADLESS    = process.env.HEADLESS === '1';

// Runs in the page: pull the Shareholding matrix as { quarters, rows:[{slug,name,pcts}] }.
async function scrapePeople(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table.data-table'));
    // shareholding matrix = the table whose 2nd header cell is a "Mon YYYY" quarter
    const sh = tables.find(t => {
      const hr = t.querySelector('tr');
      return hr && hr.children[1] && /\w{3}\s+\d{4}/.test(hr.children[1].textContent || '');
    });
    let quarters = [], rows = [];
    if (sh) {
      const headRow = sh.querySelector('tr');
      quarters = Array.from(headRow.children).slice(1).map(c => c.textContent.trim());
      sh.querySelectorAll('tbody tr').forEach(tr => {
        const first = tr.children[0];
        if (!first) return;
        const a = first.querySelector('a[href*="/company/"]');
        const m = a && a.getAttribute('href').match(/\/company\/([^/]+)\//);
        const name = first.textContent.replace(/\s+/g, ' ').trim();
        const pcts = Array.from(tr.children).slice(1).map(c => {
          const v = parseFloat(c.textContent.replace(/,/g, ''));
          return isFinite(v) ? v : null;
        });
        rows.push({ slug: m ? decodeURIComponent(m[1]) : null, name, pcts });
      });
    }
    // Bulk + block deal tables (the non-matrix data-tables): capture BUY dates per slug.
    const buys = {}; // slug -> latest BUY date string (ISO yyyy-mm-dd)
    const MON = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const parseDate = txt => {
      const m = String(txt).match(/(\d{1,2})\s+([A-Za-z]{3}),?\s+(\d{4})/);
      if (!m) return null;
      const mon = MON[m[2].toLowerCase()]; if (mon == null) return null;
      return `${m[3]}-${String(mon+1).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
    };
    tables.filter(t => t !== sh).forEach(t => {
      t.querySelectorAll('tbody tr').forEach(tr => {
        const first = tr.children[0]; if (!first) return;
        const a = first.querySelector('a[href*="/company/"]');
        const m = a && a.getAttribute('href').match(/\/company\/([^/]+)\//);
        if (!m) return;
        const slug = decodeURIComponent(m[1]).toUpperCase();
        const rowTxt = tr.textContent.replace(/\s+/g, ' ');
        const isBuy = /\b(buy|b)\b/i.test((tr.children[1] || {}).textContent || rowTxt);
        if (!isBuy) return;
        const d = parseDate(rowTxt);
        if (d && (!buys[slug] || d > buys[slug])) buys[slug] = d;
      });
    });
    return { quarters, rows, buys };
  });
}

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return {
    window: cfg.currentWindowQuarters || DEFAULT_CURRENT_WINDOW,
    investors: (cfg.investors || []).filter(x => x && x.name && Array.isArray(x.ids) && x.ids.length),
  };
}

async function main() {
  console.log('⭐  Marquee-investor holdings fetcher');
  const { investors, window } = loadConfig();
  if (!investors.length) { console.warn('  No investors in investors-config.json.'); return; }

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

  const perInvestor = [];
  const meta = [];
  let anySuccess = false, loginNeeded = false, rateLimited = false;
  const THROTTLE_MS = 3500; // polite gap between page loads — Screener throttles bursts
  try {
    const page = context.pages()[0] || await context.newPage();
    for (const inv of investors) {
      if (rateLimited) break;
      const bySlug = new Map(); // merge id-variants: keep largest current stake
      for (const id of inv.ids) {
        try {
          // /people/<id>/ 404s without a name-slug, but any placeholder slug (e.g. /x/)
          // 200s and redirects to the canonical page — so we don't need exact slugs.
          await page.goto(`https://www.screener.in/people/${id}/x/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          if (/\/register\/|\/login\//.test(page.url())) { loginNeeded = true; continue; }
          // Screener.in rate-limits rapid requests. If we hit it, back off and retry once.
          let bodyTxt = await page.evaluate(() => document.body.innerText || '').catch(() => '');
          if (/too many requests/i.test(bodyTxt)) {
            console.warn(`    rate-limited on ${inv.name} — waiting 60s then retrying…`);
            await page.waitForTimeout(60000);
            await page.goto(`https://www.screener.in/people/${id}/x/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
            bodyTxt = await page.evaluate(() => document.body.innerText || '').catch(() => '');
            if (/too many requests/i.test(bodyTxt)) { rateLimited = true; console.warn('    still rate-limited — stopping to avoid a longer block. Re-run in a few minutes.'); break; }
          }
          await page.waitForSelector('table.data-table', { timeout: 12000 }).catch(() => {});
          const { quarters, rows, buys } = await scrapePeople(page);
          for (const r of rows) {
            if (!r.slug) continue;
            const d = deriveHolding(r.pcts, { window, quartersCount: quarters.length, quarters });
            if (!d || !d.currentlyHeld) continue;
            const key = r.slug.toUpperCase();
            const cur = bySlug.get(key);
            if (!cur || d.latestPct > cur.latestPct) bySlug.set(key, {
              slug: key, name: r.name, latestPct: d.latestPct, prevPct: d.prevPct, trend: d.trend, currentlyHeld: true,
              latestQuarter: d.latestQuarter, sinceQuarter: d.sinceQuarter, quartersHeld: d.quartersHeld,
              lastBuyDate: (buys && buys[key]) || null,
            });
          }
          anySuccess = true;
        } catch (e) { console.warn(`    ${inv.name} (id ${id}) failed: ${e.message}`); }
        await page.waitForTimeout(THROTTLE_MS); // pace requests to stay under the rate limit
      }
      const holdings = [...bySlug.values()];
      perInvestor.push({ name: inv.name, holdings });
      meta.push({ name: inv.name, ids: inv.ids, holdingsCount: holdings.length });
      console.log(`  • ${inv.name}: ${holdings.length} current holdings`);
    }
  } finally {
    await context.close().catch(() => {});
  }

  if (loginNeeded && !anySuccess) {
    console.warn('  NOT LOGGED IN — run login-screener.bat once, then retry.');
    return;
  }
  if (rateLimited) {
    console.warn(`  WARNING: rate-limited by Screener.in before finishing — NOT writing a partial file. Wait ~5 min and re-run.`);
    return;
  }
  if (!anySuccess) { console.warn(`  WARNING: nothing scraped. Keeping existing ${OUT_PATH}.`); return; }

  const agg = aggregate(perInvestor);
  const rows = agg.map(r => ({ ...r, score: marqueeScore(r.count, r.adds) }));

  const payload = { updatedAt: new Date().toISOString(), source: 'screener.in/people', window, investors: meta, rows };
  if (!fs.existsSync(path.dirname(OUT_PATH))) fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  const multi = rows.filter(r => r.count >= 2).length;
  console.log(`\n  ✅  ${rows.length} stocks held by marquee investors (${multi} held by 2+) → ${OUT_PATH}`);
  console.log('  Next: commit docs/investors-tickers.json (or run fetch-investors.bat) — CI folds it into the Investors page, Confluence & Sniper.');
}

if (require.main === module) {
  main().catch(e => { console.warn(`  WARNING: investor fetch failed (${e.message}). Keeping old file.`); process.exit(0); });
}
module.exports = { main, scrapePeople };

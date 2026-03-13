const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const WATCHLIST_URL = 'https://www.tickertape.in/watchlist';
const SESSION_DIR = path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'watchlist-app-session');
const OUTPUT_HTML = path.join(__dirname, 'my-watchlists.html');
const OUTPUT_JSON = path.join(__dirname, 'my-watchlists.json');
const DEBUG_DIR = path.join(__dirname, 'debug');
const PERIODS = ['1D', '1M', '3M', '6M', '1Y'];

async function main() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR);
  console.log('Opening Tickertape...');

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1300, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(WATCHLIST_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  const needsLogin = await page.locator('text=Log in').or(page.locator('text=Login')).or(page.locator('text=Sign in')).first().isVisible().catch(() => false);
  if (needsLogin) {
    console.log('\n--- LOGIN REQUIRED ---');
    console.log('Log in manually in the browser window (phone/email + OTP).');
    console.log('Waiting for login to complete...\n');
    await page.locator('text=Log in').or(page.locator('text=Login')).first().click().catch(() => {});
    for (let attempt = 0; attempt < 120; attempt++) {
      await page.waitForTimeout(3000);
      const stillLogin = await page.locator('text=Log in').or(page.locator('text=Login')).or(page.locator('text=Sign in')).first().isVisible().catch(() => false);
      const hasOtp = await page.locator('input#phoneNumber').or(page.locator('input[placeholder*="OTP"]')).first().isVisible().catch(() => false);
      if (!stillLogin && !hasOtp) { console.log('Login detected!'); break; }
      if (attempt % 10 === 0 && attempt > 0) console.log('Still waiting for login...');
    }
    await page.goto(WATCHLIST_URL, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(3000);
  }

  console.log('Opening Equity section...');
  const equityHeader = page.locator('text=Equity').first();
  if (await equityHeader.isVisible().catch(() => false)) {
    await equityHeader.click();
    await page.waitForTimeout(1500);
  }

  const sidebarItems = await page.evaluate(() => {
    const items = [];
    const allEls = document.querySelectorAll('a, div, span, li, button');
    for (const el of allEls) {
      const raw = (el.textContent || '').trim();
      if (!/equity watchlist/i.test(raw)) continue;
      if (/create/i.test(raw)) continue;
      if (raw.length > 50) continue;
      const childMatch = el.querySelector('a, div, span, li, button');
      if (childMatch && /equity watchlist/i.test(childMatch.textContent || '')) continue;
      const clean = raw.replace(/[\u{1F1E0}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1FFFF}\u{200D}\u{20E3}]/gu, '').replace(/[⃣️]/g, '').replace(/^\d+\s*/, '').trim();
      if (clean && !items.find(x => x.clean === clean)) {
        items.push({ clean, raw, tag: el.tagName, classes: el.className });
      }
    }
    return items;
  });

  console.log(`Found ${sidebarItems.length} equity watchlists:`);
  sidebarItems.forEach(s => console.log(`  - ${s.clean}`));

  if (sidebarItems.length === 0) {
    console.log('No equity watchlists found!');
    await context.close();
    process.exit(1);
  }

  const allWatchlists = [];

  for (let t = 0; t < sidebarItems.length; t++) {
    const wlName = sidebarItems[t].clean;
    console.log(`\n[${t + 1}/${sidebarItems.length}] "${wlName}"`);

    const clickTarget = page.locator(`text=${wlName}`).first();
    if (await clickTarget.isVisible().catch(() => false)) {
      await clickTarget.click();
    } else {
      console.log(`  Could not find "${wlName}", skipping`);
      continue;
    }

    await page.waitForTimeout(2500);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Find and click the period buttons (1D, 1M, 3M, 6M, 1Y)
    // First, debug what elements exist for these labels
    if (t === 0) {
      const periodDebug = await page.evaluate(() => {
        const results = [];
        const all = document.querySelectorAll('*');
        for (const el of all) {
          if (el.children.length > 0) continue;
          const txt = (el.textContent || '').trim();
          if (/^(1D|1M|3M|6M|1Y)$/.test(txt)) {
            const rect = el.getBoundingClientRect();
            results.push({ txt, tag: el.tagName, cls: (el.className || '').slice(0, 60), top: Math.round(rect.top), left: Math.round(rect.left) });
          }
        }
        return results;
      });
      console.log('  Period button elements:', JSON.stringify(periodDebug));
    }

    const periodData = {};
    for (const period of PERIODS) {
      // Click the period element - find the <P> tag and click its parent (React handler)
      const clickPos = await page.evaluate((p) => {
        const all = document.querySelectorAll('p, span');
        for (const el of all) {
          if (el.children.length > 0) continue;
          const txt = (el.textContent || '').trim();
          if (txt !== p) continue;
          const rect = el.getBoundingClientRect();
          if (rect.top > 100 && rect.top < 300 && rect.left > 250) {
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }
        return null;
      }, period);

      let clicked = false;
      if (clickPos) {
        await page.mouse.click(clickPos.x, clickPos.y);
        clicked = true;
      }

      if (!clicked) {
        console.log(`  ${period}: not found, skipping`);
        continue;
      }

      await page.waitForTimeout(2000);

      const data = await extractStocks(page);
      periodData[period] = data;
      console.log(`  ${period}: ${data.stocks.length} stocks (${data.headers.join(', ')})`);
    }

    allWatchlists.push({ name: wlName, periods: periodData });
  }

  await context.close();

  if (allWatchlists.every(w => Object.values(w.periods).every(p => p.stocks.length === 0))) {
    console.log('\nNo stocks found. Check the debug/ folder for screenshots.');
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(allWatchlists, null, 2), 'utf8');
  console.log('\nSaved to my-watchlists.json');

  const html = buildHtml(allWatchlists);
  fs.writeFileSync(OUTPUT_HTML, html, 'utf8');
  console.log('Saved to my-watchlists.html');
  console.log('\nOpening in browser...');

  const { exec } = require('child_process');
  exec(`start "" "${OUTPUT_HTML}"`);
}

async function extractStocks(page) {
  return page.evaluate(() => {
    const headers = [];
    const stocks = [];

    const headerRow = document.querySelector('tr[class*="list-header"]');
    if (headerRow) {
      for (const child of headerRow.children) {
        const t = (child.innerText || child.textContent || '').trim();
        if (!t) continue;
        const parts = t.split('\n').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2 && /low/i.test(parts[0]) && /high/i.test(parts[1])) {
          headers.push(parts[0], parts[1]);
        } else {
          headers.push(t);
        }
      }
    }

    const rows = document.querySelectorAll('td[class*="watchlist-assetId-row"]');
    for (const row of rows) {
      const cells = [];
      for (const child of row.children) {
        const t = (child.innerText || child.textContent || '').trim();
        if (!t) continue;
        const parts = t.split('\n').map(p => p.trim()).filter(Boolean);
        if (parts.length === 2 && /^[₹\d]/.test(parts[0]) && /^[₹\d]/.test(parts[1]) && cells.length >= 2) {
          cells.push(parts[0], parts[1]);
        } else {
          cells.push(t);
        }
      }
      if (cells.length >= 5) {
        const last = cells[cells.length - 1];
        if (/₹.*₹/.test(last.replace(/\s/g, ''))) cells.pop();
      }
      if (cells.length > 0) {
        stocks.push({ name: cells[0] || '', cells });
      }
    }

    return { headers, stocks };
  });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(watchlists) {
  const wlTabs = watchlists.map((w, i) =>
    `<button class="wl-tab${i === 0 ? ' active' : ''}" onclick="showWl(${i})">${esc(w.name.replace(/^Equity Watchlist\s*/, '') || 'Main')}</button>`
  ).join('');

  const wlPanels = watchlists.map((w, wi) => {
    const periodTabs = PERIODS.map((p, pi) =>
      `<button class="p-tab${pi === 0 ? ' active' : ''}" onclick="showPeriod(${wi},${pi})">${p}</button>`
    ).join('');

    const periodPanels = PERIODS.map((period, pi) => {
      const d = w.periods[period] || { headers: [], stocks: [] };
      let headerHtml = '';
      if (d.headers.length > 0) {
        headerHtml = '<thead><tr>' + d.headers.map(h => `<th>${esc(h).replace(/\\n/g, '<br>')}</th>`).join('') + '</tr></thead>';
      }
      const rows = d.stocks.map(s => {
        return '<tr>' + s.cells.map((c, j) => {
          const val = String(c || '');
          let cls = '';
          if (j === 0) cls = 'stock-name';
          else if (/^-/.test(val) || (/%/.test(val) && parseFloat(val) < 0)) cls = 'neg';
          else if (/^\+/.test(val) || (/%/.test(val) && parseFloat(val) > 0)) cls = 'pos';
          const display = esc(val).replace(/\n/g, '<br>');
          return `<td class="${cls}">${display}</td>`;
        }).join('') + '</tr>';
      }).join('');
      return `<div class="p-panel${pi === 0 ? ' active' : ''}" data-wl="${wi}" data-p="${pi}">
        <p class="count">${d.stocks.length} stocks</p>
        <div class="table-wrap"><table>${headerHtml}<tbody>${rows}</tbody></table></div>
      </div>`;
    }).join('');

    return `<div class="wl-panel${wi === 0 ? ' active' : ''}" id="wl${wi}">
      <div class="p-tabs">${periodTabs}</div>
      ${periodPanels}
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>My Equity Watchlists</title>
<style>
  :root{--bg:#0c0c10;--s1:#16161c;--s2:#1e1e26;--bd:#2a2a34;--ac:#00d4aa;--tx:#e4e4ea;--t2:#9a9aa6;--gn:#22c55e;--rd:#ef4444;--p-ac:#6366f1}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);padding:24px}
  .container{max-width:1100px;margin:0 auto}
  h1{font-size:1.4rem;margin-bottom:16px;color:var(--tx)}
  .wl-tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  .wl-tab{padding:10px 20px;background:var(--s2);border:1px solid var(--bd);border-radius:8px;color:var(--t2);cursor:pointer;font-family:inherit;font-size:0.9rem;font-weight:500;transition:all .2s}
  .wl-tab:hover{color:var(--tx);border-color:var(--t2)}
  .wl-tab.active{background:var(--ac);color:var(--bg);border-color:var(--ac);font-weight:600}
  .wl-panel{display:none}
  .wl-panel.active{display:block}
  .p-tabs{display:flex;gap:6px;margin-bottom:14px}
  .p-tab{padding:7px 18px;background:var(--s2);border:1px solid var(--bd);border-radius:6px;color:var(--t2);cursor:pointer;font-family:inherit;font-size:0.82rem;font-weight:600;letter-spacing:.04em;transition:all .2s}
  .p-tab:hover{color:var(--tx);border-color:var(--t2)}
  .p-tab.active{background:var(--p-ac);color:#fff;border-color:var(--p-ac)}
  .p-panel{display:none}
  .p-panel.active{display:block}
  .count{color:var(--t2);font-size:0.85rem;margin-bottom:12px}
  .table-wrap{overflow-x:auto;border-radius:12px;border:1px solid var(--bd);background:var(--s1)}
  table{width:100%;border-collapse:collapse;font-size:.88rem}
  th,td{padding:11px 16px;text-align:left;border-bottom:1px solid var(--bd);white-space:nowrap}
  th{background:rgba(0,212,170,.08);color:var(--ac);font-weight:600;font-size:.82rem;text-transform:uppercase;letter-spacing:.03em;position:sticky;top:0}
  tr:hover td{background:rgba(255,255,255,.025)}
  .stock-name{font-weight:500}
  .pos{color:var(--gn)}
  .neg{color:var(--rd)}
</style>
</head>
<body>
<div class="container">
  <h1>My Equity Watchlists</h1>
  <div class="wl-tabs">${wlTabs}</div>
  ${wlPanels}
</div>
<script>
function showWl(idx){
  document.querySelectorAll('.wl-tab').forEach(function(t,i){t.classList.toggle('active',i===idx)});
  document.querySelectorAll('.wl-panel').forEach(function(c,i){c.classList.toggle('active',i===idx)});
}
function showPeriod(wlIdx,pIdx){
  var panel=document.getElementById('wl'+wlIdx);
  if(!panel)return;
  panel.querySelectorAll('.p-tab').forEach(function(t,i){t.classList.toggle('active',i===pIdx)});
  panel.querySelectorAll('.p-panel').forEach(function(c,i){c.classList.toggle('active',i===pIdx)});
}
</script>
</body>
</html>`;
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

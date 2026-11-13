'use strict';

// ── One-time Screener.in login & sync ─────────────────────────────────────────
// Opens the persisted Chrome browser profile so you can log into Screener.in ONCE.
// The session cookie is saved in that profile, and every future refresh reuses it.
//
// Automatically detects when you have successfully logged in, saves the session,
// closes the browser, and immediately pulls the latest superstar investor holdings
// and updates the Marquee Investors page!

const path = require('path');
const os   = require('os');
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const SESSION_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'watchlist-app-session');

async function main() {
  console.log('\n===========================================================');
  console.log(' ⭐ Screener.in Login & Marquee Investor Sync');
  console.log('===========================================================');
  console.log(' Opening Chrome browser for Screener.in login...\n');

  let context;
  try {
    context = await chromium.launchPersistentContext(SESSION_DIR, {
      channel: 'chrome',
      headless: false, // visible window so user can enter credentials
      viewport: { width: 1200, height: 850 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (err) {
    if (err.message && err.message.includes('ProcessSingleton')) {
      console.error('\n❌ ERROR: Another Chrome instance is currently locking the session directory.');
      console.error('Please close open background Chrome windows and retry: npm run login-screener\n');
      process.exit(1);
    }
    throw err;
  }

  // Clear any old/stale session cookies so we only accept a fresh, valid login
  try {
    const existing = await context.cookies('https://www.screener.in');
    const sessionCookie = existing.find(c => c.name === 'sessionid');
    if (sessionCookie) {
      // Test if old session is still valid
      const testRes = await context.request.get('https://www.screener.in/people/268/x/', { timeout: 6000 }).catch(() => null);
      if (!testRes || testRes.url().includes('/register/') || testRes.url().includes('/login/')) {
        console.log('  (Clearing stale/expired session cookie...)');
        await context.clearCookies();
      }
    }
  } catch {}

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.screener.in/login/', { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('  → Please enter your Screener.in email and password in the Chrome window.');
  console.log('  → Click the "Login" button on the page.');
  console.log('  → This script will AUTO-DETECT when you are logged in, save your session,');
  console.log('    and automatically fetch all superstar investor portfolios!\n');

  let loggedIn = false;
  let closedByUser = false;

  context.on('close', () => {
    closedByUser = true;
  });

  // Poll every 2 seconds for genuine authentication
  const startTime = Date.now();
  const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes timeout

  while (!loggedIn && !closedByUser && (Date.now() - startTime < TIMEOUT_MS)) {
    try {
      const cookies = await context.cookies('https://www.screener.in');
      const sess = cookies.find(c => c.name === 'sessionid' && c.value);

      if (sess) {
        // Verify genuine authentication by requesting a protected shareholder page
        const checkRes = await context.request.get('https://www.screener.in/people/268/x/', { timeout: 6000 }).catch(() => null);
        if (checkRes && checkRes.status() === 200 && !checkRes.url().includes('/register/') && !checkRes.url().includes('/login/')) {
          loggedIn = true;
          break;
        }
      }
    } catch {
      if (closedByUser) break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (loggedIn) {
    console.log('  ✅ SUCCESS: Screener.in authentication verified!');
    console.log('  Closing Chrome and saving session...');
    await new Promise(r => setTimeout(r, 1500));
    try { await context.close(); } catch {}
  } else if (closedByUser) {
    console.log('  Browser closed by user. Checking if login succeeded before close...');
    try { await context.close(); } catch {}
  } else {
    console.log('  Login timed out. Closing browser.');
    try { await context.close(); } catch {}
    return;
  }

  console.log('\n  Session saved permanently for fetch-screener and fetch-investors!');

  // Now automatically fetch latest marquee investors and regenerate investors.html
  console.log('\n===========================================================');
  console.log(' 🔄 Pulling latest Marquee Investor filings now...');
  console.log('===========================================================');
  try {
    const fetchInvestors = require('./fetch-investors');
    await fetchInvestors.main();

    const generateInvestors = require('./generate-investors');
    generateInvestors.main();
    console.log('\n  🎉 Marquee Investors data & page are now completely up-to-date!');

    // Push the updated sidecar & page
    try {
      console.log('  Pushing updated data to GitHub...');
      execSync('git add -f docs/investors-tickers.json docs/investors.html', { stdio: 'ignore' });
      execSync('git commit -m "data: refresh marquee investor holdings"', { stdio: 'ignore' });
      execSync('git push origin master', { stdio: 'ignore' });
      console.log('  ✅ Pushed updated Marquee Investor data to master!');
    } catch {}
  } catch (e) {
    console.warn(`  Note: fetch encountered: ${e.message}. You can run fetch-investors.bat manually.`);
  }
}

if (require.main === module) main().catch(e => { console.error('login helper failed:', e.message); process.exit(1); });
module.exports = { main };

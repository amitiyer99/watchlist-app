'use strict';

// ── One-time Screener.in login & sync ─────────────────────────────────────────
// Opens the persisted browser profile that fetch-screener.js, fetch-investors.js
// and the NSE deal fetcher use, so you can log into Screener.in ONCE.
// The session cookie is saved in that profile, and every future refresh reuses it.
//
// Automatically detects when you have successfully logged in, saves the session,
// closes the browser, and immediately pulls the latest superstar investor holdings
// and updates the Marquee Investors page!

const path = require('path');
const os   = require('os');
const { chromium } = require('playwright');

const SESSION_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'watchlist-app-session');

async function main() {
  console.log('\n===========================================================');
  console.log(' ⭐ Screener.in Login & Marquee Investor Sync');
  console.log('===========================================================');
  console.log(' Opening Edge browser for Screener.in login...\n');

  let context;
  try {
    context = await chromium.launchPersistentContext(SESSION_DIR, {
      channel: 'msedge',
      headless: false, // visible window so user can enter credentials
      viewport: { width: 1200, height: 850 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (err) {
    if (err.message && err.message.includes('ProcessSingleton')) {
      console.error('\n❌ ERROR: Another Edge process is currently using the session directory.');
      console.error('Please close all open Edge windows and retry: npm run login-screener\n');
      process.exit(1);
    }
    throw err;
  }

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.screener.in/login/', { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('  → Please enter your Screener.in email and password in the browser.');
  console.log('  → Once you log in, this script will AUTO-DETECT your login,');
  console.log('    save the session, and automatically fetch the latest filings!\n');

  let loggedIn = false;
  let closedByUser = false;

  context.on('close', () => {
    closedByUser = true;
  });

  // Poll for successful login
  const startTime = Date.now();
  const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes timeout

  while (!loggedIn && !closedByUser && (Date.now() - startTime < TIMEOUT_MS)) {
    try {
      const cookies = await context.cookies('https://www.screener.in');
      const hasSession = cookies.some(c => c.name === 'sessionid' && c.value);
      
      const currentUrl = page.url();
      const notOnAuthPage = !/\/login\/|\/register\//.test(currentUrl);

      if (hasSession || notOnAuthPage) {
        // Double check by checking page content if available
        const hasUserIndicator = await page.evaluate(() => {
          return !document.querySelector('a[href*="/login/"]') && (
            !!document.querySelector('button[aria-label="User account"]') ||
            !!document.querySelector('a[href*="/account/"]') ||
            document.body.innerText.includes('Feed') ||
            document.body.innerText.includes('Screens')
          );
        }).catch(() => false);

        if (hasSession || hasUserIndicator) {
          loggedIn = true;
          break;
        }
      }
    } catch {
      // Page might be navigating or closed
      if (closedByUser) break;
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  if (loggedIn) {
    console.log('  ✅ SUCCESS: Detected active Screener.in session!');
    console.log('  Closing browser and saving session...');
    await new Promise(r => setTimeout(r, 1500)); // give 1.5s for cookies to persist
    try { await context.close(); } catch {}
  } else if (closedByUser) {
    console.log('  Browser closed by user. Verifying session...');
  } else {
    console.log('  Login timed out. Closing browser.');
    try { await context.close(); } catch {}
    return;
  }

  console.log('\n  Session saved successfully for fetch-screener and fetch-investors!');

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
  } catch (e) {
    console.warn(`  Note: automatic sync encountered: ${e.message}. You can run fetch-investors.bat manually.`);
  }
}

if (require.main === module) main().catch(e => { console.error('login helper failed:', e.message); process.exit(1); });
module.exports = { main };

'use strict';

// ── One-time Screener.in login ────────────────────────────────────────────────
// Opens the SAME persisted browser profile that fetch-screener.js (and the NSE
// deal fetcher) use, so you can log into Screener.in ONCE. The session cookie is
// saved in that profile, and every future `npm run fetch-screener` reuses it —
// including for your PRIVATE custom screens (raw queries + saved screens both
// need login). Run:  npm run login-screener   (or login-screener.bat)
//
// A browser window opens on the Screener.in login page. Log in, then simply CLOSE
// the window — this script detects the close, and your session is persisted.

const path = require('path');
const os   = require('os');
const { chromium } = require('playwright');

const SESSION_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'watchlist-app-session');

async function main() {
  console.log('Opening a browser so you can log into Screener.in…');
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false, // must be visible so you can type credentials
    viewport: { width: 1200, height: 850 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.screener.in/login/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('\n  → Log into Screener.in in the window that opened.');
  console.log('  → When you see you are logged in (your name top-right), CLOSE the window.');
  console.log('    Your session will be saved for fetch-screener.\n');

  // Resolve when the browser is closed by the user.
  await new Promise(resolve => {
    context.on('close', resolve);
    // Fallback safety timeout (10 min) so the script never hangs a terminal forever.
    setTimeout(async () => { try { await context.close(); } catch {} resolve(); }, 10 * 60 * 1000);
  });
  console.log('Session saved. You can now run: npm run fetch-screener');
}

if (require.main === module) main().catch(e => { console.error('login helper failed:', e.message); process.exit(1); });

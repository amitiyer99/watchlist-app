'use strict';

// ── Set Screener.in session cookie directly ───────────────────────────────────
// Usage: node set-screener-cookie.js <sessionid>
// Sets the session cookie in watchlist-app-session, verifies authentication,
// and immediately scrapes all superstar marquee investor filings!

const path = require('path');
const os   = require('os');
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const SESSION_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'watchlist-app-session');

async function main() {
  const sessionId = (process.argv[2] || '').trim();
  if (!sessionId) {
    console.error('Usage: node set-screener-cookie.js <sessionid>');
    console.error('Example: node set-screener-cookie.js abc123xyz...');
    process.exit(1);
  }

  console.log('Setting Screener session cookie in watchlist-app-session...');
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    channel: 'chrome',
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    await context.addCookies([
      {
        name: 'sessionid',
        value: sessionId,
        domain: '.screener.in',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      },
      {
        name: 'sessionid',
        value: sessionId,
        domain: 'www.screener.in',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      }
    ]);

    console.log('Testing authentication with Screener.in...');
    const res = await context.request.get('https://www.screener.in/people/268/x/', { timeout: 10000 }).catch(e => ({ status: () => 500, url: () => e.message }));
    
    if (res.status() === 200 && !res.url().includes('/register/') && !res.url().includes('/login/')) {
      console.log('✅ SUCCESS: Authenticated successfully as Screener user!');
    } else {
      console.warn(`⚠️ Warning: Test request redirected to: ${res.url()}. The cookie might be incorrect or expired.`);
    }
  } finally {
    await context.close();
  }

  console.log('\n===========================================================');
  console.log(' 🔄 Pulling latest Marquee Investor filings now...');
  console.log('===========================================================');
  const fetchInvestors = require('./fetch-investors');
  await fetchInvestors.main();

  const generateInvestors = require('./generate-investors');
  generateInvestors.main();
  console.log('\n  🎉 Marquee Investors data & page are now completely up-to-date!');

  try {
    console.log('  Pushing updated data to GitHub...');
    execSync('git add -f docs/investors-tickers.json docs/investors.html', { stdio: 'ignore' });
    execSync('git commit -m "data: refresh marquee investor holdings"', { stdio: 'ignore' });
    execSync('git push origin master', { stdio: 'ignore' });
    console.log('  ✅ Pushed updated Marquee Investor data to master!');
  } catch (e) {
    console.warn('  Git push skipped/failed:', e.message);
  }
}

if (require.main === module) main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
module.exports = { main };

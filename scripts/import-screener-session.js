'use strict';

// Copy the Screener.in login out of the Chrome profile on this laptop into the
// Playwright session the weekday refresh uses.
//
// Chrome encrypts that login so only Chrome can read it, and only from the
// original profile. This starts a headless Chrome on that profile, reads the
// cookies, and stores them for fetch-screener / fetch-investors. It does this
// only when Chrome is not already open, so it never attaches to a window you
// are using.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const CHROME_USER = path.join(LOCAL, 'Google', 'Chrome', 'User Data');
const SESSION_DIR = path.join(LOCAL, 'watchlist-app-session');
const CHROME_EXE = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
].find(p => fs.existsSync(p));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function chromeIsOpen() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8' });
    return /chrome\.exe/i.test(out);
  } catch { return false; }
}

function profileDirectory() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CHROME_USER, 'Local State'), 'utf8'));
    const name = j && j.profile && j.profile.last_used;
    if (name && fs.existsSync(path.join(CHROME_USER, name))) return name;
  } catch {}
  return 'Default';
}

function removeJunction(link) {
  try { execFileSync('cmd.exe', ['/c', 'rmdir', link], { stdio: 'pipe' }); } catch {}
}

async function readScreenerCookies() {
  if (!CHROME_EXE || !fs.existsSync(path.join(CHROME_USER, 'Local State'))) {
    console.warn('Chrome profile not found — Screener.in login was not copied.');
    return null;
  }
  if (chromeIsOpen()) {
    console.log('Chrome is open, so its Screener.in login stays in that window. It will be copied the next time Chrome is closed.');
    return null;
  }

  const profile = profileDirectory();
  const link = path.join(os.tmpdir(), `watchlist-chrome-${process.pid}`);
  removeJunction(link);
  execFileSync('cmd.exe', ['/c', `mklink /J "${link}" "${CHROME_USER}"`], { stdio: 'pipe' });

  const port = 9300 + (process.pid % 500);
  let stderr = '';
  const child = spawn(CHROME_EXE, [
    `--user-data-dir=${link}`,
    `--profile-directory=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-1500); });

  let browser;
  try {
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        break;
      } catch {}
    }
    if (!browser) {
      console.warn('Could not read the Chrome profile' + (stderr ? ` (${stderr.trim().split('\n').slice(-2).join(' ')})` : '') + '.');
      return null;
    }
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://www.screener.in/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const cookies = await ctx.cookies('https://www.screener.in');
    const keep = cookies.filter(c => (c.name === 'sessionid' || c.name === 'csrftoken') && c.value);
    if (!keep.some(c => c.name === 'sessionid') || /\/(login|register)\//.test(page.url())) {
      console.warn('Screener.in is not logged in inside Chrome. Log in there once, then the weekday refresh can reuse it.');
      return null;
    }
    console.log(`Found the Screener.in login in Chrome ${profile}.`);
    return keep;
  } finally {
    if (browser) await Promise.race([browser.close().catch(() => {}), sleep(3000)]);
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await sleep(700);
    removeJunction(link);
  }
}

async function storeCookies(cookies) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    channel: 'msedge',
    headless: true,
    viewport: { width: 1200, height: 800 },
  });
  try {
    await context.addCookies(cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.screener.in',
      path: c.path || '/',
      expires: c.expires > 0 ? c.expires : undefined,
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite: c.sameSite && c.sameSite !== 'None' ? c.sameSite : 'Lax',
    })));
  } finally {
    await context.close();
  }
}

async function main() {
  const cookies = await readScreenerCookies();
  if (!cookies) return false;
  await storeCookies(cookies);
  console.log(`Copied the Screener.in login into the refresh session (${cookies.map(c => c.name).join(', ')}).`);
  return true;
}

if (require.main === module) {
  main()
    .then(ok => process.exit(ok ? 0 : 2))
    .catch(e => { console.warn(`Could not copy the Screener.in login (${e.message}).`); process.exit(0); });
}

module.exports = { main, chromeIsOpen };

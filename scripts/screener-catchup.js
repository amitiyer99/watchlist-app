'use strict';

// When Chrome is closed, copy its Screener.in login and refresh the two lists
// that need it (Screener.in screens and Marquee Investors), then publish those
// sidecars. One-shot for Task Scheduler. With --wait, keep checking until Chrome
// has been closed (used so a login that is open right now is picked up later
// without touching that window).

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { main, chromeIsOpen } = require('./import-screener-session');

const ROOT = path.join(__dirname, '..');
const LOCK = path.join(process.env.TEMP || require('os').tmpdir(), 'watchlist-screener-catchup.lock');
const FILES = ['docs/screenerin-tickers.json', 'docs/investors-tickers.json'];
const WAIT = process.argv.includes('--wait');

function istDay(ms = Date.now()) {
  return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function alreadyToday() {
  return FILES.every(rel => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      return String(j.updatedAt || '').slice(0, 10) === istDay();
    } catch { return false; }
  });
}

function lockedByOther() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    process.kill(pid, 0);
    return pid !== process.pid;
  } catch { return false; }
}

function run(script) {
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, HEADLESS: '1' },
    stdio: 'inherit',
    timeout: 12 * 60 * 1000,
  });
  if (r.error) console.warn(r.error.message);
  return r.status === 0 || r.status == null;
}

function publish() {
  const changed = FILES.filter(rel => {
    const s = spawnSync('git', ['diff', '--quiet', '--', rel], { cwd: ROOT });
    return s.status === 1;
  });
  if (!changed.length) { console.log('Screener lists already match what is published.'); return; }
  spawnSync('git', ['restore', '--staged', '.'], { cwd: ROOT, stdio: 'inherit' });
  spawnSync('git', ['add', '--', ...changed], { cwd: ROOT, stdio: 'inherit' });
  const commit = spawnSync('git', ['commit', '-m', 'data: refresh Screener.in screens and marquee investors'], { cwd: ROOT, stdio: 'inherit' });
  if (commit.status !== 0) return;
  const push = spawnSync('git', ['push', 'origin', 'master'], { cwd: ROOT, stdio: 'inherit' });
  if (push.status !== 0) console.warn('Push did not land. The next catch-up will try again.');
}

async function once() {
  if (lockedByOther()) { console.log('A Screener catch-up is already running.'); return; }
  if (chromeIsOpen()) {
    console.log('Chrome is open. Leaving it alone.');
    return;
  }
  if (alreadyToday()) { console.log('Screener lists are already from today.'); return; }
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    const ok = await main();
    if (!ok) return;
    run('fetch-screener.js');
    run('fetch-investors.js');
    if (alreadyToday()) publish();
    else console.warn('The lists were not rewritten, so nothing was published.');
  } finally {
    try { fs.unlinkSync(LOCK); } catch {}
  }
}

async function loop() {
  const deadline = Date.now() + 14 * 3600 * 1000;
  let misses = 0;
  while (Date.now() < deadline) {
    if (!chromeIsOpen() && !alreadyToday()) {
      await new Promise(r => setTimeout(r, 45000));
      if (!chromeIsOpen()) {
        await once();
        if (alreadyToday()) return;
        misses += 1;
        if (misses >= 2) {
          console.log('Could not copy the Screener.in login after Chrome closed. The weekday task will try again.');
          return;
        }
      }
    }
    await new Promise(r => setTimeout(r, 60 * 1000));
  }
  console.log('Stopped waiting for Chrome to close. The weekday task will try again.');
}

(WAIT ? loop() : once()).catch(e => { console.warn(e.message); process.exit(0); });

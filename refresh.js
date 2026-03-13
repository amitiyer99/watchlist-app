const { execSync } = require('child_process');
const path = require('path');

const PROJECT_DIR = __dirname;
const GIT = '"C:\\Program Files\\Git\\cmd\\git.exe"';

function run(cmd, label) {
  console.log(`\n>> ${label}`);
  try {
    const output = execSync(cmd, { cwd: PROJECT_DIR, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
    if (output.trim()) console.log(output.trim());
    return true;
  } catch (err) {
    console.error(`   Error: ${(err.stderr || err.message || '').trim()}`);
    return false;
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('  WATCHLIST REFRESH');
  console.log('='.repeat(50));

  // Step 1: Fetch latest watchlists from Tickertape
  console.log('\n[1/3] Fetching watchlists from Tickertape...');
  console.log('      (Browser will open — if already logged in, it runs automatically)\n');

  try {
    execSync('node fetch.js', {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      timeout: 600000,
    });
  } catch (err) {
    console.error('\nFetch failed. Make sure you are logged into Tickertape.');
    console.log('\nPress any key to exit...');
    await waitForKey();
    process.exit(1);
  }

  // Step 2: Check if watchlist data actually changed
  console.log('\n[2/3] Checking for changes...');
  const status = execSync(`${GIT} status --porcelain my-watchlists.json ticker-urls.json`, {
    cwd: PROJECT_DIR, encoding: 'utf8',
  }).trim();

  if (!status) {
    console.log('      No changes detected — your watchlists are already up to date!');
    console.log('\nDone! Press any key to exit...');
    await waitForKey();
    return;
  }

  console.log('      Changes detected, pushing to GitHub...');

  // Step 3: Commit and push
  console.log('\n[3/3] Pushing updated watchlists to GitHub...');
  run(`${GIT} add my-watchlists.json my-watchlists.html ticker-urls.json`, 'Staging files');

  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const ok = run(
    `${GIT} commit -m "Refresh watchlist data — ${timestamp}"`,
    'Committing'
  );

  if (ok) {
    run(`${GIT} push`, 'Pushing to GitHub');
  }

  console.log('\n' + '='.repeat(50));
  console.log('  DONE! Your alerts are now using the latest watchlists.');
  console.log('='.repeat(50));
  console.log('\nPress any key to exit...');
  await waitForKey();
}

function waitForKey() {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) { resolve(); return; }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      resolve();
    });
  });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

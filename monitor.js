const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const WATCHLIST_PATH = path.join(__dirname, 'my-watchlists.json');
const ALERT_LOG_PATH = path.join(__dirname, 'alert-log.json');

const THRESHOLD_ABOVE_LOW = 0.10; // alert if price <= 3M low * 1.10
const CHECK_INTERVAL = '*/5 9-15 * * 1-5'; // every 5 min, Mon-Fri, 9AM-3PM
const COOLDOWN_HOURS = 4; // don't re-alert same stock within this window

// ── Load config (env vars take priority over config.json) ──────────
function loadConfig(isDryRun) {
  if (process.env.EMAIL_FROM && process.env.GMAIL_APP_PASSWORD) {
    return {
      email_from: process.env.EMAIL_FROM,
      email_to: process.env.EMAIL_TO || process.env.EMAIL_FROM,
      gmail_app_password: process.env.GMAIL_APP_PASSWORD,
    };
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    const template = {
      email_from: 'your.email@gmail.com',
      email_to: 'your.email@gmail.com',
      gmail_app_password: 'xxxx xxxx xxxx xxxx',
      _instructions: 'Get an app password at https://myaccount.google.com/apppasswords'
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2), 'utf8');
    if (!isDryRun) {
      console.log(`\nCreated ${CONFIG_PATH} — fill in your email & app password, then re-run.\n`);
      process.exit(0);
    }
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ── Load watchlist & build stock list with 3M ranges ───────────────
function loadStocks() {
  const watchlists = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
  const stocks = [];
  const seen = new Set();

  for (const wl of watchlists) {
    const data3m = wl.periods && wl.periods['3M'];
    if (!data3m) continue;

    for (const s of data3m.stocks) {
      const nameParts = (s.name || '').split('\n');
      const fullName = nameParts[0] || '';
      const ticker = nameParts[1] || '';
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);

      const parsePrice = (v) => parseFloat(String(v || '').replace(/[₹,]/g, ''));
      const low3m = parsePrice(s.cells[3]);
      const high3m = parsePrice(s.cells[4]);

      if (isNaN(low3m) || isNaN(high3m) || high3m <= low3m) continue;

      const range = high3m - low3m;
      const threshold = low3m * (1 + THRESHOLD_ABOVE_LOW);

      stocks.push({
        ticker,
        yahooTicker: ticker + '.NS',
        fullName,
        low3m,
        high3m,
        range,
        threshold,
        watchlist: wl.name,
        stockUrl: s.stockUrl || '',
      });
    }
  }

  return stocks;
}

// ── Fetch live prices from Yahoo Finance ───────────────────────────
async function fetchPrices(stocks) {
  const results = [];
  const batchSize = 10;

  for (let i = 0; i < stocks.length; i += batchSize) {
    const batch = stocks.slice(i, i + batchSize);
    const promises = batch.map(async (stock) => {
      try {
        const quote = await yahooFinance.quote(stock.yahooTicker);
        return { ...stock, price: quote.regularMarketPrice, priceTime: quote.regularMarketTime };
      } catch {
        return { ...stock, price: null, error: true };
      }
    });
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }

  return results;
}

// ── Alert log (cooldown tracking) ──────────────────────────────────
function loadAlertLog() {
  if (fs.existsSync(ALERT_LOG_PATH)) {
    return JSON.parse(fs.readFileSync(ALERT_LOG_PATH, 'utf8'));
  }
  return {};
}

function saveAlertLog(log) {
  fs.writeFileSync(ALERT_LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
}

function isInCooldown(log, ticker) {
  const lastAlert = log[ticker];
  if (!lastAlert) return false;
  const elapsed = Date.now() - new Date(lastAlert).getTime();
  return elapsed < COOLDOWN_HOURS * 60 * 60 * 1000;
}

// ── Send email alert ───────────────────────────────────────────────
async function sendAlert(config, alerts) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.email_from, pass: config.gmail_app_password },
  });

  const rows = alerts.map(a => {
    const pctInRange = ((a.price - a.low3m) / a.range * 100).toFixed(1);
    const ttUrl = a.stockUrl || `https://www.tickertape.in/stocks/${a.fullName.replace(/\s+Ltd$/i, '').replace(/\s+/g, '-').toLowerCase()}-${a.ticker}`;
    return `<tr>
      <td style="padding:8px;border-bottom:1px solid #333"><a href="${ttUrl}" style="color:#e4e4ea;text-decoration:none;border-bottom:1px dashed #00d4aa" target="_blank">${a.fullName}</a><br><small style="color:#9a9aa6">${a.ticker}</small></td>
      <td style="padding:8px;border-bottom:1px solid #333;color:#ef4444;font-weight:600">₹${a.price.toFixed(2)}</td>
      <td style="padding:8px;border-bottom:1px solid #333">₹${a.low3m.toFixed(2)}</td>
      <td style="padding:8px;border-bottom:1px solid #333">₹${a.high3m.toFixed(2)}</td>
      <td style="padding:8px;border-bottom:1px solid #333;color:#ef4444">${pctInRange}%</td>
      <td style="padding:8px;border-bottom:1px solid #333;font-size:12px">${a.watchlist}</td>
    </tr>`;
  }).join('');

  const html = `
    <div style="font-family:system-ui,sans-serif;background:#0c0c10;color:#e4e4ea;padding:24px;border-radius:12px">
      <h2 style="color:#ef4444;margin-bottom:16px">Stock Alert — Near 3M Low</h2>
      <p style="color:#9a9aa6;margin-bottom:16px">${alerts.length} stock(s) trading at or within 10% above their 3-month low.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead>
          <tr style="color:#00d4aa;text-transform:uppercase;font-size:12px">
            <th style="padding:8px;text-align:left">Stock</th>
            <th style="padding:8px;text-align:left">Price</th>
            <th style="padding:8px;text-align:left">3M Low</th>
            <th style="padding:8px;text-align:left">3M High</th>
            <th style="padding:8px;text-align:left">% in Range</th>
            <th style="padding:8px;text-align:left">Watchlist</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#9a9aa6;font-size:12px;margin-top:16px">Generated at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
    </div>`;

  await transporter.sendMail({
    from: config.email_from,
    to: config.email_to,
    subject: `🔴 Stock Alert: ${alerts.length} stock(s) near 3M low`,
    html,
  });

  console.log(`  Email sent to ${config.email_to}`);
}

// ── Main check cycle ───────────────────────────────────────────────
async function runCheck(config, stocks) {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`\n[${now}] Checking ${stocks.length} stocks...`);

  const results = await fetchPrices(stocks);
  const alertLog = loadAlertLog();
  const alerts = [];

  for (const r of results) {
    if (r.price === null) continue;
    if (r.price <= r.threshold) {
      const pct = ((r.price - r.low3m) / r.range * 100).toFixed(1);
      console.log(`  ⚠ ${r.ticker} ₹${r.price.toFixed(2)} — ${pct}% into 3M range (threshold: ₹${r.threshold.toFixed(2)})`);
      if (!isInCooldown(alertLog, r.ticker)) {
        alerts.push(r);
        alertLog[r.ticker] = new Date().toISOString();
      } else {
        console.log(`    (cooldown active, skipping email)`);
      }
    }
  }

  if (alerts.length > 0) {
    try {
      await sendAlert(config, alerts);
      saveAlertLog(alertLog);
    } catch (err) {
      console.error('  Email error:', err.message);
    }
  } else {
    console.log('  No alerts triggered.');
  }
}

// ── Entry point ────────────────────────────────────────────────────
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig(dryRun);
  const stocks = loadStocks();
  console.log(`Loaded ${stocks.length} unique stocks from watchlists.`);
  console.log(`Alert threshold: price <= 110% of 3M low.`);
  console.log(`Email: ${config.email_from} → ${config.email_to}`);
  console.log(`Cooldown: ${COOLDOWN_HOURS}h per stock`);
  console.log(`Schedule: every 5 min, Mon-Fri, 9 AM – 3 PM IST\n`);

  // Show a few thresholds as examples
  stocks.slice(0, 5).forEach(s => {
    console.log(`  ${s.ticker}: 3M range ₹${s.low3m}–₹${s.high3m}, alert below ₹${s.threshold.toFixed(2)}`);
  });

  // Run once immediately
  if (dryRun) {
    console.log('\n--- DRY RUN (no emails) ---');
    const results = await fetchPrices(stocks);
    let nearBottom = 0;
    for (const r of results) {
      if (r.price === null) { console.log(`  ${r.ticker}: price unavailable`); continue; }
      const pct = ((r.price - r.low3m) / r.range * 100).toFixed(1);
      const flag = r.price <= r.threshold ? '⚠ ALERT' : '  ok';
      if (r.price <= r.threshold) nearBottom++;
      console.log(`  ${flag} ${r.ticker.padEnd(15)} ₹${r.price.toFixed(2).padStart(10)} | range ₹${r.low3m}–₹${r.high3m} | ${pct}% into range`);
    }
    console.log(`\n${nearBottom} stock(s) would trigger alerts.`);
    process.exit(0);
  }

  // --once mode: single check then exit (used by GitHub Actions)
  const once = process.argv.includes('--once');

  await runCheck(config, stocks);

  if (once) {
    console.log('\nSingle check complete.');
    process.exit(0);
  }

  // Schedule ongoing checks (local mode)
  cron.schedule(CHECK_INTERVAL, () => runCheck(config, stocks), { timezone: 'Asia/Kolkata' });
  console.log('\nMonitor running. Press Ctrl+C to stop.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

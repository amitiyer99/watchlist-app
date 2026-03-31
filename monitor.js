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
const USER_ALERTS_PATH = path.join(__dirname, 'user-alerts.json');
const SCORECARD_TAGS_PATH = path.join(__dirname, 'scorecard-tags.json');

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
  const scorecardTags = fs.existsSync(SCORECARD_TAGS_PATH)
    ? JSON.parse(fs.readFileSync(SCORECARD_TAGS_PATH, 'utf8'))
    : {};
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
        perfTag:   (scorecardTags[ticker] && scorecardTags[ticker].perfTag)   || null,
        growthTag: (scorecardTags[ticker] && scorecardTags[ticker].growthTag) || null,
        profitTag: (scorecardTags[ticker] && scorecardTags[ticker].profitTag) || null,
      });
    }
  }

  return stocks;
}

// ── Live 3-month range refresh via Yahoo Finance historical ──────────
async function refreshLive3MRanges(stocks) {
  const cutoff    = new Date(Date.now() - 92 * 24 * 60 * 60 * 1000); // ~3 calendar months
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const BATCH = 5;
  let refreshed = 0;
  for (let i = 0; i < stocks.length; i += BATCH) {
    const batch = stocks.slice(i, i + BATCH);
    await Promise.all(batch.map(async s => {
      try {
        const rows = await yahooFinance.historical(s.yahooTicker, { period1: cutoff, period2: yesterday, interval: '1d' });
        if (!rows.length) return;
        const lows  = rows.map(r => r.low).filter(v => v > 0);
        const highs = rows.map(r => r.high).filter(v => v > 0);
        if (!lows.length) return;
        s.low3m     = Math.min(...lows);
        s.high3m    = Math.max(...highs);
        s.range     = s.high3m - s.low3m;
        s.threshold = s.low3m * (1 + THRESHOLD_ABOVE_LOW);
        s.liveRange = true;
        refreshed++;
      } catch { /* keep static fallback */ }
    }));
    await new Promise(r => setTimeout(r, 300)); // gentle rate limit
  }
  console.log(`  Live 3M ranges refreshed for ${refreshed}/${stocks.length} stocks.`);
}

// ── Bounce potential rating (0-100) ────────────────────────────────
function tagScore(tag) { return tag === 'High' ? 2 : tag === 'Avg' ? 1 : 0; }

function rateBounce(stock, quote) {
  let score = 0;

  // 1. Scorecard quality: Perf + Growth + Profit (max 6 → 0–30 pts)
  const qScore = tagScore(stock.perfTag) + tagScore(stock.growthTag) + tagScore(stock.profitTag);
  score += Math.round(qScore / 6 * 30);

  // 2. Position in 52W range — lower = more upside (0–25 pts)
  const p = quote.regularMarketPrice;
  if (p && quote.fiftyTwoWeekLow && quote.fiftyTwoWeekHigh && quote.fiftyTwoWeekHigh > quote.fiftyTwoWeekLow) {
    const pos = (p - quote.fiftyTwoWeekLow) / (quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow);
    score += Math.round((1 - Math.min(1, Math.max(0, pos))) * 25);
  }

  // 3. Dip depth from 3M high — bigger drop = more recovery room (0–25 pts)
  if (p && stock.high3m > 0) {
    const dipPct = (stock.high3m - p) / stock.high3m; // e.g. 0.25 = 25% off high
    score += Math.min(25, Math.round(dipPct * 100));   // 25%+ dip → full 25 pts
  }

  // 4. Relative volume vs 3M avg — high vol = institutional accumulation (0–20 pts)
  const vol    = quote.regularMarketVolume || 0;
  const avgVol = quote.averageDailyVolume3Month || quote.averageDailyVolume10Day || 0;
  if (vol > 0 && avgVol > 0) {
    const rv = vol / avgVol;
    score += rv >= 2.0 ? 20 : rv >= 1.5 ? 15 : rv >= 1.2 ? 10 : rv >= 0.8 ? 5 : 0;
  }

  const rating = score >= 65 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW';
  return { score, rating };
}

// ── Fetch live prices from Yahoo Finance ───────────────────────────
async function fetchPrices(stocks) {
  const results = [];
  const batchSize = 10;

  for (let i = 0; i < stocks.length; i += batchSize) {
    const batch = stocks.slice(i, i + batchSize);
    const promises = batch.map(async (stock) => {
      try {
        const quote = await yahooFinance.quote(stock.yahooTicker, {
          fields: ['regularMarketPrice','regularMarketTime','regularMarketVolume',
                   'averageDailyVolume3Month','averageDailyVolume10Day',
                   'fiftyTwoWeekLow','fiftyTwoWeekHigh'],
        });
        const bounce = rateBounce(stock, quote);
        return {
          ...stock,
          price:       quote.regularMarketPrice,
          priceTime:   quote.regularMarketTime,
          vol:         quote.regularMarketVolume,
          avgVol:      quote.averageDailyVolume3Month || quote.averageDailyVolume10Day,
          wk52Low:     quote.fiftyTwoWeekLow,
          wk52High:    quote.fiftyTwoWeekHigh,
          bounceScore:  bounce.score,
          bounceRating: bounce.rating,
        };
      } catch {
        return { ...stock, price: null, error: true, bounceScore: 0, bounceRating: 'LOW' };
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

// ── Load custom user-defined price alerts ──────────────────────────
function loadUserAlerts() {
  if (!fs.existsSync(USER_ALERTS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(USER_ALERTS_PATH, 'utf8')); }
  catch { return {}; }
}

// ── Check & email custom price alerts ─────────────────────────────
async function checkUserAlerts(config) {
  const userAlerts = loadUserAlerts();
  const tickers = Object.keys(userAlerts);
  if (!tickers.length) return;

  const alertLog = loadAlertLog();
  const triggered = [];

  for (let i = 0; i < tickers.length; i += 10) {
    const batch = tickers.slice(i, i + 10);
    const results = await Promise.all(batch.map(async ticker => {
      try {
        const q = await yahooFinance.quote(ticker + '.NS');
        return { ticker, price: q.regularMarketPrice };
      } catch { return { ticker, price: null }; }
    }));

    for (const r of results) {
      if (!r.price) continue;
      const al = userAlerts[r.ticker];
      const logKey = 'ua_' + r.ticker;
      if (isInCooldown(alertLog, logKey)) continue;
      const hits = [];
      if (al.above && r.price >= al.above) hits.push({ dir: 'above', target: al.above });
      if (al.below && r.price <= al.below) hits.push({ dir: 'below', target: al.below });
      if (hits.length) {
        const isNew = !alertLog[logKey + '_first'];
        if (isNew) alertLog[logKey + '_first'] = new Date().toISOString();
        triggered.push({ ticker: r.ticker, price: r.price, name: al.name || r.ticker, hits, isNew });
        alertLog[logKey] = new Date().toISOString();
      }
    }
  }

  if (!triggered.length) { console.log('  No custom price alerts triggered.'); return; }

  // Sort: new triggers first
  triggered.sort((a, b) => { if (a.isNew !== b.isNew) return a.isNew ? -1 : 1; return 0; });
  const uaNewCount = triggered.filter(t => t.isNew).length;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.email_from, pass: config.gmail_app_password },
  });

  const rows = triggered.map(t => {
    const rowBg = t.isNew ? 'background:#0f1a0f' : '';
    const leftBorder = t.isNew ? 'border-left:3px solid #22c55e' : 'border-left:3px solid transparent';
    const newBadge = t.isNew
      ? '<span style="display:inline-block;background:#22c55e;color:#000;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:middle">NEW</span>'
      : '<span style="display:inline-block;background:#2a2a38;color:#6a6a82;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:middle">REPEAT</span>';
    const hitDesc = t.hits.map(h =>
      h.dir === 'above'
        ? `<span style="color:#22c55e">&#x25B2; &#x20B9;${t.price.toFixed(2)} &ge; target &#x20B9;${h.target}</span>`
        : `<span style="color:#ef4444">&#x25BC; &#x20B9;${t.price.toFixed(2)} &le; target &#x20B9;${h.target}</span>`
    ).join('<br>');
    const ttUrl = `https://www.tickertape.in/stocks/${t.name.replace(/\s+Ltd$/i, '').replace(/\s+/g, '-').toLowerCase()}-${t.ticker}`;
    return `<tr style="${rowBg}" style="${rowBg}">
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;${leftBorder}">
        <a href="${ttUrl}" style="color:#e8e8f0;text-decoration:none;font-weight:700" target="_blank">${t.name}</a>${newBadge}<br>
        <small style="color:#9898b0">${t.ticker} &middot; NSE</small>
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;font-weight:700;color:#e8e8f0;font-size:15px">&#x20B9;${t.price.toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;font-size:13px">${hitDesc}</td>
    </tr>`;
  }).join('');

  const uaSubjectTag = uaNewCount > 0 ? `🆕 ${uaNewCount} new, ` : '';
  const html = `<div style="font-family:system-ui,sans-serif;background:#0c0c10;color:#e4e4ea;padding:24px;border-radius:12px;max-width:600px">
    <h2 style="color:#00d4aa;margin:0 0 4px">&#x1F514; Price Alert Triggered</h2>
    <p style="color:#9898b0;margin:0 0 16px;font-size:13px">
      ${triggered.length} stock${triggered.length > 1 ? 's have' : ' has'} crossed your price threshold &middot; ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
      ${uaNewCount > 0 ? `&nbsp;&middot;&nbsp; <span style="color:#22c55e;font-weight:700">${uaNewCount} newly triggered &#x1F195;</span>` : ''}
    </p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="background:#12121a">
        <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Stock</th>
        <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Live Price</th>
        <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Alert Condition</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid #2a2a38;font-size:12px">
      <a href="https://amitiyer99.github.io/watchlist-app/" style="color:#00d4aa;text-decoration:none">Stock Dashboard</a> &nbsp;&middot;&nbsp;
      <a href="https://amitiyer99.github.io/watchlist-app/creamy.html" style="color:#00d4aa;text-decoration:none">Creamy Layer</a> &nbsp;&middot;&nbsp;
      <a href="https://amitiyer99.github.io/watchlist-app/breakout.html" style="color:#00d4aa;text-decoration:none">Breakout Scanner</a>
    </div>
    <p style="color:#6a6a82;font-size:11px;margin-top:8px">Alert cooldown: ${COOLDOWN_HOURS}h per stock &middot; To update alerts: export from the dashboard and commit user-alerts.json to your repo</p>
  </div>`;

  await transporter.sendMail({
    from: config.email_from,
    to: config.email_to,
    subject: `\uD83D\uDD14 Price Alert: ${uaSubjectTag}${triggered.map(t => t.ticker).join(', ')} crossed threshold`,
    html,
  });
  console.log(`  Custom alert email sent to ${config.email_to}: ${triggered.map(t => t.ticker).join(', ')}`);
  saveAlertLog(alertLog);
}
async function sendAlert(config, alerts) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.email_from, pass: config.gmail_app_password },
  });

  const newCount = alerts.filter(a => a.isNew).length;
  const rows = alerts.map(a => {
    const pctInRange = ((a.price - a.low3m) / a.range * 100).toFixed(1);
    const ttUrl = a.stockUrl || `https://www.tickertape.in/stocks/${a.fullName.replace(/\s+Ltd$/i, '').replace(/\s+/g, '-').toLowerCase()}-${a.ticker}`;
    const rowBg      = a.bounceRating === 'HIGH'   ? 'background:#2a1a00'
                     : a.bounceRating === 'MEDIUM' ? 'background:#220f00'
                     : a.isNew                     ? 'background:#1a0f0f' : '';
    const borderClr  = a.bounceRating === 'HIGH'   ? '#f59e0b'
                     : a.bounceRating === 'MEDIUM' ? '#f97316'
                     : a.isNew                     ? '#ef4444' : 'transparent';
    const leftBorder = `border-left:3px solid ${borderClr}`;
    const newBadge = a.isNew
      ? '<span style="display:inline-block;background:#ef4444;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:middle;letter-spacing:.04em">NEW</span>'
      : '<span style="display:inline-block;background:#2a2a38;color:#6a6a82;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:middle">REPEAT</span>';
    const creamyBadge = a.perfTag === 'High'
      ? '<span style="display:inline-block;background:rgba(168,85,247,.2);color:#c084fc;border:1px solid rgba(168,85,247,.4);font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-left:4px;vertical-align:middle;letter-spacing:.04em">&#x2728; CREAMY</span>'
      : '';
    const bounceBadge = a.bounceRating === 'HIGH'
      ? `<span style="display:inline-block;background:#92400e;color:#fde68a;border:1px solid #f59e0b;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-left:4px;vertical-align:middle">&#x1F4C8; HIGH ${a.bounceScore}</span>`
      : a.bounceRating === 'MEDIUM'
      ? `<span style="display:inline-block;background:#7c2d12;color:#fed7aa;border:1px solid #f97316;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-left:4px;vertical-align:middle">&#x26A1; MED ${a.bounceScore}</span>`
      : '';
    const liveTag = a.liveRange
      ? '<span style="color:#6ee7b7;font-size:10px;margin-left:4px">&#x1F7E2; live 3M</span>'
      : '<span style="color:#6a6a82;font-size:10px;margin-left:4px">&#x26AA; cached</span>';
    return `<tr style="${rowBg}">
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;${leftBorder}">
        <a href="${ttUrl}" style="color:#e4e4ea;text-decoration:none;font-weight:600" target="_blank">${a.fullName}</a>${newBadge}${creamyBadge}${bounceBadge}<br>
        <small style="color:#9a9aa6">${a.ticker} &middot; ${a.watchlist}${liveTag}</small>
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;font-weight:700;font-size:15px;color:${a.isNew ? '#ef4444' : '#e4e4ea'}">&#x20B9;${a.price.toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;color:#9a9aa6">&#x20B9;${a.low3m.toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;color:#9a9aa6">&#x20B9;${a.high3m.toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;font-weight:600;color:${parseFloat(pctInRange) <= 5 ? '#ef4444' : '#eab308'}">${pctInRange}%</td>
    </tr>`;
  }).join('');

  const subjectTag = newCount > 0 ? `🆕 ${newCount} new, ` : '';
  const html = `
    <div style="font-family:system-ui,sans-serif;background:#0c0c10;color:#e4e4ea;padding:24px;border-radius:12px;max-width:620px">
      <h2 style="color:#ef4444;margin:0 0 4px">&#x1F4C9; Stock Alert — Near 3-Month Low</h2>
      <p style="color:#9a9aa6;margin:0 0 16px;font-size:13px">
        ${alerts.length} stock(s) within 10% of 3M low &nbsp;&middot;&nbsp; ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
        ${newCount > 0 ? `&nbsp;&middot;&nbsp; <span style="color:#ef4444;font-weight:700">${newCount} newly triggered &#x1F195;</span>` : ''}
      </p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead>
          <tr style="background:#12121a">
            <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Stock</th>
            <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Price</th>
            <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">3M Low</th>
            <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">3M High</th>
            <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">% in Range</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #2a2a38;font-size:12px">
        <a href="https://amitiyer99.github.io/watchlist-app/" style="color:#00d4aa;text-decoration:none">Stock Dashboard</a> &nbsp;&middot;&nbsp;
        <a href="https://amitiyer99.github.io/watchlist-app/creamy.html" style="color:#00d4aa;text-decoration:none">Creamy Layer</a> &nbsp;&middot;&nbsp;
        <a href="https://amitiyer99.github.io/watchlist-app/breakout.html" style="color:#00d4aa;text-decoration:none">Breakout Scanner</a>
      </div>
      <p style="color:#6a6a82;font-size:11px;margin-top:8px">&#x1F4C8; HIGH potential (score&ge;65) &nbsp;&middot;&nbsp; &#x26A1; MED potential (40–64) &nbsp;&middot;&nbsp; Score = quality(30) + 52W position(25) + dip depth(25) + rel.vol(20) &nbsp;&middot;&nbsp; &#x1F7E2; live = 3M range computed fresh from Yahoo Finance history &nbsp;&middot;&nbsp; &#x26AA; cached = last Tickertape fetch</p>
    </div>`;

  await transporter.sendMail({
    from: config.email_from,
    to: config.email_to,
    subject: `\uD83D\uDCC9 3M Low Alert: ${subjectTag}${alerts.length} stock(s) — ${alerts.slice(0,3).map(a=>a.ticker).join(', ')}${alerts.length > 3 ? '…' : ''}`,
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
        const isNew = !alertLog[r.ticker + '_first'];
        if (isNew) alertLog[r.ticker + '_first'] = new Date().toISOString();
        alerts.push({ ...r, isNew });
        alertLog[r.ticker] = new Date().toISOString();
      } else {
        console.log(`    (cooldown active, skipping email)`);
      }
    }
  }
  // Sort: new alerts first, then by % into range (closest to 3M low first)
  alerts.sort((a, b) => {
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    return ((a.price - a.low3m) / a.range) - ((b.price - b.low3m) / b.range);
  });

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

  // Check custom user-defined price alerts from user-alerts.json
  try { await checkUserAlerts(config); } catch (err) { console.error('  Custom alert error:', err.message); }
}

// ── Entry point ────────────────────────────────────────────────────
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig(dryRun);
  const stocks = loadStocks();
  console.log(`Loaded ${stocks.length} unique stocks from watchlists.`);
  console.log(`Refreshing live 3M ranges from Yahoo Finance historical data...`);
  await refreshLive3MRanges(stocks);
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
    console.log(`\n${nearBottom} stock(s) would trigger 3M-low alerts.`);
    const uaCount = Object.keys(loadUserAlerts()).length;
    if (uaCount > 0) console.log(`${uaCount} custom price alert(s) in user-alerts.json would also be checked against live prices.`);
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

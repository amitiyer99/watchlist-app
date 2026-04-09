'use strict';
// One-time script: send a summary email of ALL configured price alerts with live prices
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const USER_ALERTS_PATH = path.join(__dirname, 'user-alerts.json');

function loadConfig() {
  if (process.env.EMAIL_FROM && process.env.GMAIL_APP_PASSWORD) {
    return { email_from: process.env.EMAIL_FROM, email_to: process.env.EMAIL_TO || process.env.EMAIL_FROM, gmail_app_password: process.env.GMAIL_APP_PASSWORD };
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function main() {
  const config = loadConfig();
  const userAlerts = JSON.parse(fs.readFileSync(USER_ALERTS_PATH, 'utf8'));
  const tickers = Object.keys(userAlerts);
  if (!tickers.length) { console.log('No alerts configured in user-alerts.json'); return; }

  console.log(`Fetching live prices for ${tickers.length} alerted stocks...`);
  const stocks = await Promise.all(tickers.map(async ticker => {
    const al = userAlerts[ticker];
    try {
      const q = await yahooFinance.quote(ticker + '.NS');
      return { ticker, name: al.name || ticker, price: q.regularMarketPrice, above: al.above, below: al.below };
    } catch (e) {
      return { ticker, name: al.name || ticker, price: null, above: al.above, below: al.below };
    }
  }));

  // Determine status for each
  const rows = stocks.map(s => {
    const priceStr = s.price != null ? `&#x20B9;${s.price.toFixed(2)}` : '<span style="color:#6a6a82">N/A</span>';

    let statusParts = [];
    let rowColor = '#e8e8f0';
    let triggered = false;

    if (s.above != null) {
      const hit = s.price != null && s.price >= s.above;
      if (hit) triggered = true;
      statusParts.push(
        `<span style="color:${hit ? '#22c55e' : '#9898b0'}">&#x25B2; Above &#x20B9;${s.above}${hit ? ' <b>&#x2714; HIT</b>' : ''}</span>`
      );
    }
    if (s.below != null) {
      const hit = s.price != null && s.price <= s.below;
      if (hit) triggered = true;
      statusParts.push(
        `<span style="color:${hit ? '#ef4444' : '#9898b0'}">&#x25BC; Below &#x20B9;${s.below}${hit ? ' <b>&#x2714; HIT</b>' : ''}</span>`
      );
    }

    const bgColor = triggered ? (s.above && s.price >= s.above ? '#0f1a12' : '#1a0f0f') : 'transparent';
    const borderLeft = triggered ? `border-left:3px solid ${s.above && s.price >= s.above ? '#22c55e' : '#ef4444'}` : 'border-left:3px solid transparent';
    const triggeredBadge = triggered
      ? '<span style="display:inline-block;background:#ef4444;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:middle">TRIGGERED</span>'
      : '';

    return `<tr style="background:${bgColor}">
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;${borderLeft}">
        <strong style="color:#e8e8f0">${s.name}</strong>${triggeredBadge}<br>
        <small style="color:#9898b0">${s.ticker} &middot; NSE</small>
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;font-weight:700;font-size:15px;color:${triggered ? '#ef4444' : '#e8e8f0'}">${priceStr}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a38;font-size:13px;line-height:1.7">${statusParts.join('<br>')}</td>
    </tr>`;
  }).join('');

  const triggeredCount = stocks.filter(s =>
    (s.above != null && s.price != null && s.price >= s.above) ||
    (s.below != null && s.price != null && s.price <= s.below)
  ).length;

  const html = `<div style="font-family:system-ui,sans-serif;background:#0c0c10;color:#e4e4ea;padding:24px;border-radius:12px;max-width:620px">
    <h2 style="color:#00d4aa;margin:0 0 4px">&#x1F514; Price Alert Summary</h2>
    <p style="color:#9898b0;margin:0 0 4px;font-size:13px">
      ${tickers.length} alert${tickers.length > 1 ? 's' : ''} configured &nbsp;&middot;&nbsp;
      ${triggeredCount > 0
        ? `<span style="color:#ef4444;font-weight:700">${triggeredCount} currently triggered &#x26A0;</span>`
        : '<span style="color:#22c55e">None triggered right now &#x2714;</span>'}
    </p>
    <p style="color:#6a6a82;margin:0 0 16px;font-size:12px">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="background:#12121a">
        <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Stock</th>
        <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Live Price</th>
        <th style="padding:10px 8px;text-align:left;color:#00d4aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Your Alert</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid #2a2a38;font-size:12px">
      <a href="https://amitiyer99.github.io/watchlist-app/" style="color:#00d4aa;text-decoration:none">Stock Dashboard</a> &nbsp;&middot;&nbsp;
      <a href="https://amitiyer99.github.io/watchlist-app/creamy.html" style="color:#00d4aa;text-decoration:none">Creamy Layer</a> &nbsp;&middot;&nbsp;
      <a href="https://amitiyer99.github.io/watchlist-app/breakout.html" style="color:#00d4aa;text-decoration:none">Breakout Scanner</a>
    </div>
    <p style="color:#6a6a82;font-size:11px;margin-top:8px">Going forward, alerts will be emailed automatically during market hours (9:15 AM &ndash; 3:30 PM IST, Mon&ndash;Fri) when a threshold is crossed.</p>
  </div>`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.email_from, pass: config.gmail_app_password },
  });

  const subject = triggeredCount > 0
    ? `🔔 Alert Summary: ${triggeredCount} triggered — ${stocks.filter(s => (s.above!=null&&s.price>=s.above)||(s.below!=null&&s.price<=s.below)).map(s=>s.ticker).join(', ')}`
    : `🔔 Alert Summary: ${tickers.length} configured — none triggered right now`;

  await transporter.sendMail({ from: config.email_from, to: config.email_to, subject, html });
  console.log(`✓ Summary email sent to ${config.email_to}`);
  console.log(`  ${tickers.length} alerts — ${triggeredCount} currently triggered`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });

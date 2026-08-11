const { makeClient } = require('./lib/yahoo');
const yahooFinance = makeClient();
const EX = require('./lib/exchange'); // exchange-aware Yahoo symbols (NSE .NS / BSE .BO)
const { loadLivePrices, livePriceOf, reconcile, loadSidecarPrices } = require('./lib/live-prices');
// Prefer the app's live-prices.json feed so emailed prices EXACTLY match the site.
// Fall back to the per-ticker Yahoo quote only when the feed lacks that ticker.
const nseSym = s => String((s && s.ticker) || String((s && s.yahooTicker) || s || '').replace(/\.NS$/i, '')).toUpperCase();
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { loadRegime } = require('./lib/regime');

// ── Configuration ──────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const WATCHLIST_PATH = path.join(__dirname, 'my-watchlists.json');
const ALERT_LOG_PATH = path.join(__dirname, 'alert-log.json');
const USER_ALERTS_PATH = path.join(__dirname, 'user-alerts.json');
const SCORECARD_TAGS_PATH = path.join(__dirname, 'scorecard-tags.json');
const TICKER_URLS_PATH = path.join(__dirname, 'ticker-urls.json');
const TRIGGERS_PATH = path.join(__dirname, 'docs', 'triggers.json');

const tickerUrls = fs.existsSync(TICKER_URLS_PATH)
  ? JSON.parse(fs.readFileSync(TICKER_URLS_PATH, 'utf8')) : {};

const THRESHOLD_ABOVE_LOW = 0.10; // alert if price <= 3M low * 1.10
const CHECK_INTERVAL = '*/5 9-15 * * 1-5'; // every 5 min, Mon-Fri, 9AM-3PM
const COOLDOWN_HOURS = 4; // don't re-alert same stock within this window
const TRIGGER_COOLDOWN_HOURS = 24; // breakout triggers only once per day per ticker

// ── Load config (env vars take priority over config.json) ──────────
const DEFAULT_ALERTS = { dip3MLow: true, userPriceAlerts: true, breakoutTriggers: true, exitEngine: true, triggerListChanges: true };

function loadConfig(isDryRun) {
  if (process.env.EMAIL_FROM && process.env.GMAIL_APP_PASSWORD) {
    return {
      email_from: process.env.EMAIL_FROM,
      email_to: process.env.EMAIL_TO || process.env.EMAIL_FROM,
      gmail_app_password: process.env.GMAIL_APP_PASSWORD,
      alerts: { ...DEFAULT_ALERTS },
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
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Backwards-compatible defaults for new feature flags
  cfg.alerts = Object.assign({ ...DEFAULT_ALERTS }, cfg.alerts || {});
  return cfg;
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
        yahooTicker: EX.yahooSymbol(ticker),
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
  const LP = loadLivePrices().prices;
  const REF = loadSidecarPrices(); // reliable Tickertape-basis reference to reconcile against

  for (let i = 0; i < stocks.length; i += batchSize) {
    const batch = stocks.slice(i, i + batchSize);
    const promises = batch.map(async (stock) => {
      try {
        const quote = await yahooFinance.quote(stock.yahooTicker, {
          fields: ['regularMarketPrice','regularMarketTime','regularMarketVolume',
                   'averageDailyVolume3Month','averageDailyVolume10Day',
                   'fiftyTwoWeekLow','fiftyTwoWeekHigh'],
        });
        // Use the site's live price, reconciled against the reliable sidecar reference
        // so a bad/misadjusted Yahoo quote (e.g. an SME split) can't email a wrong price.
        const sym = nseSym(stock);
        const px = reconcile(REF[sym], livePriceOf(LP, sym) != null ? livePriceOf(LP, sym) : quote.regularMarketPrice);
        if (px != null) quote.regularMarketPrice = px;
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
  const LP = loadLivePrices().prices;
  const REF = loadSidecarPrices();

  for (let i = 0; i < tickers.length; i += 10) {
    const batch = tickers.slice(i, i + 10);
    const results = await Promise.all(batch.map(async ticker => {
      // Reconcile the live feed against the reliable sidecar reference so the alert
      // fires on — and the email shows — a sane price matching the app.
      const livePx = livePriceOf(LP, ticker);
      if (livePx != null) return { ticker, price: reconcile(REF[String(ticker).toUpperCase()], livePx) };
      try {
        const q = await yahooFinance.quote(EX.yahooSymbol(ticker));
        return { ticker, price: reconcile(REF[String(ticker).toUpperCase()], q.regularMarketPrice) };
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
    const ttUrl = tickerUrls[t.ticker] || `https://www.tickertape.in/stocks/${t.name.replace(/\s+Ltd$/i, '').replace(/\s+/g, '-').toLowerCase()}-${t.ticker}`;
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
// ── Exit-engine alerts: trailing stop / target hit / signal downgrade ─
// Reads docs/trades-data.json for open positions and decides whether to
// suggest "trim", "stop hit", "trail tightened" actions.
async function checkExitConditions(config) {
  const TRADES_PATH = path.join(__dirname, 'docs', 'trades-data.json');
  if (!fs.existsSync(TRADES_PATH)) return;
  let trades;
  try { trades = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8')); }
  catch (e) { console.warn('  trades-data.json parse failed:', e.message); return; }
  const positions = (trades.trades || []).filter(t =>
    t && t.symbol && (t.side === undefined || t.side === 'buy') && !t.exitDate
  );
  if (!positions.length) return;
  console.log(`  Checking ${positions.length} open positions for exit signals...`);

  // Optional: load debate-data.json for downgrade detection
  const debatePath = path.join(__dirname, 'docs', 'debate-data.json');
  let debateMap = new Map();
  if (fs.existsSync(debatePath)) {
    try {
      const dd = JSON.parse(fs.readFileSync(debatePath, 'utf8'));
      if (Array.isArray(dd.stocks)) {
        for (const s of dd.stocks) if (s.ticker) debateMap.set(s.ticker, s.category || null);
      }
    } catch {}
  }

  const alertLog = loadAlertLog();
  const fires = [];
  let stopsChanged = false;

  // Regime-aware tightening: bear market => tighter chandelier multiple.
  const regime = loadRegime();
  const isBear = !!regime.isBearMarket;
  const CHAND_MULT = isBear ? 2.0 : 2.5;   // chandelier = highest high since entry − mult×ATR
  const TIME_STOP_DAYS = 60;               // stagnant-position review threshold
  const EARNINGS_WARN_DAYS = 7;

  // Earnings calendar (already fetched by fetch-earnings-calendar.js) — warn before results.
  let earningsData = null;
  try { earningsData = require('./lib/earnings').loadEarnings(); } catch {}
  const { earningsWithin } = require('./lib/earnings');

  // Helper: fetch daily bars since entry (min 60d window) — EMA10, ATR14, highest high since entry.
  async function fetchExitMetrics(sym, entryDate) {
    try {
      const entryMs = entryDate ? new Date(entryDate).getTime() : NaN;
      const fromMs = Math.min(isNaN(entryMs) ? Infinity : entryMs, Date.now() - 60 * 86400000);
      const p1 = new Date(fromMs - 86400000);
      const p2 = new Date(Date.now() - 86400000);
      const rows = await yahooFinance.historical(EX.yahooSymbol(sym), { period1: p1, period2: p2, interval: '1d' }, { fetchOptions: { signal: AbortSignal.timeout(15000) } });
      if (!rows || rows.length < 15) return null;
      const sorted = rows.filter(r => r.close != null).sort((a, b) => new Date(a.date) - new Date(b.date));
      const closes = sorted.map(r => r.close);
      const highs  = sorted.map(r => r.high);
      const lows   = sorted.map(r => r.low);
      // EMA10
      const k = 2 / (10 + 1);
      let ema = closes[0];
      for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
      // ATR14 (Wilder)
      const trs = [];
      for (let i = 1; i < closes.length; i++) {
        trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
      }
      let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
      for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
      // Highest high since entry (chandelier anchor that ratchets with the trend)
      let hhSinceEntry = null;
      if (!isNaN(entryMs)) {
        for (let i = 0; i < sorted.length; i++) {
          if (new Date(sorted[i].date).getTime() >= entryMs) {
            if (hhSinceEntry == null || highs[i] > hhSinceEntry) hhSinceEntry = highs[i];
          }
        }
      }
      // EMA21 + last close — the validated runner-trail (exit-lab: half-at-target +
      // 21-EMA trail beat the fixed 1.5R exit by ~66% expectancy over 5k trades/8y).
      const k21 = 2 / (21 + 1);
      let ema21 = closes[0];
      for (let i = 1; i < closes.length; i++) ema21 = closes[i] * k21 + ema21 * (1 - k21);
      return { ema10: ema, ema21, lastClose: closes[closes.length - 1], atr14: atr, hhSinceEntry };
    } catch { return null; }
  }

  for (let i = 0; i < positions.length; i += 5) {
    const batch = positions.slice(i, i + 5);
    await Promise.all(batch.map(async pos => {
      try {
        const q = await yahooFinance.quote(EX.yahooSymbol(pos.symbol), { fields: ['regularMarketPrice'] }, { fetchOptions: { signal: AbortSignal.timeout(15000) } });
        const px = q && q.regularMarketPrice;
        if (!px) return;
        const metrics = await fetchExitMetrics(pos.symbol, pos.date);

        // R-multiple (null when no recorded initial stop)
        const hasStop = pos.initialStop && pos.initialStop > 0 && pos.initialStop < pos.price;
        const r = hasStop ? (px - pos.price) / (pos.price - pos.initialStop) : null;

        // ── Trailing stop ──────────────────────────────────────────────
        // Pre-activation: hold the initial stop (no day-1 EMA10 noise).
        // Activation: after +1R (or +8% when no stop recorded), trail with a
        // chandelier from the highest high since entry − CHAND_MULT×ATR, which
        // ratchets with the trend instead of staying anchored at the pivot.
        const trailActive = (r != null && r >= 1) || (r == null && px >= pos.price * 1.08);
        let trail = pos.initialStop || 0;
        if (trailActive && metrics && metrics.atr14 != null && metrics.hhSinceEntry != null) {
          const chandelier = metrics.hhSinceEntry - CHAND_MULT * metrics.atr14;
          if (chandelier > trail) trail = chandelier;
        }
        // Never loosen an existing stop
        if (pos.currentStop != null && pos.currentStop > trail) trail = pos.currentStop;
        if (trail && (pos.currentStop == null || trail > pos.currentStop)) {
          pos.currentStop = +trail.toFixed(2);
          stopsChanged = true;
        }

        const fired = [];
        if (trail && px <= trail) fired.push({ kind: 'STOP_HIT', detail: `Price ₹${px.toFixed(2)} ≤ trailing stop ₹${trail.toFixed(2)}${trailActive ? ' (chandelier)' : ' (initial)'}` });
        // Validated exit plan (exit-lab, 5k trades/8y): at +1.5R SELL HALF, move stop
        // to breakeven, and trail the remaining half on the 21-EMA — this hybrid beat
        // the old full-exit-at-target by ~66% expectancy while keeping the win rate.
        if (r != null && r >= 1.5) {
          fired.push({ kind: 'SELL_HALF', detail: `Reached +${r.toFixed(2)}R — sell HALF here, move stop on the rest to breakeven (₹${pos.price}), then ride the 21-EMA trail` });
        }
        // Runner trail: once in profit (≥1R), a daily CLOSE below the 21-EMA ends the ride.
        if (metrics && metrics.ema21 != null && metrics.lastClose != null && r != null && r >= 1
            && metrics.lastClose < metrics.ema21) {
          fired.push({ kind: 'EMA21_TRAIL', detail: `Closed ₹${metrics.lastClose.toFixed(2)} below the 21-EMA ₹${metrics.ema21.toFixed(2)} — the validated trail says exit the remaining position` });
        }
        // Time stop: capital parked in a stagnant name is dead opportunity cost.
        const ageDays = pos.date ? (Date.now() - new Date(pos.date).getTime()) / 86400000 : null;
        const stagnant = r != null ? r < 0.5 : Math.abs(px / pos.price - 1) < 0.05;
        if (ageDays != null && ageDays > TIME_STOP_DAYS && stagnant) {
          fired.push({ kind: 'TIME_EXIT', detail: `${Math.round(ageDays)}d in trade, ${r != null ? `only +${r.toFixed(2)}R` : `${((px / pos.price - 1) * 100).toFixed(1)}% move`} — review or exit` });
        }
        // Earnings blackout warning: results within N days => elevated gap risk.
        if (earningsData && earningsWithin(earningsData, pos.symbol, EARNINGS_WARN_DAYS)) {
          fired.push({ kind: 'EARNINGS_SOON', detail: `Earnings within ${EARNINGS_WARN_DAYS} days — gap risk; consider trimming or tightening stop` });
        }
        if (pos.signalSource === 'debate' && debateMap.has(pos.symbol)) {
          const cat = debateMap.get(pos.symbol);
          if (cat && cat !== 'hot' && cat !== 'momentum') {
            fired.push({ kind: 'DEBATE_DOWNGRADE', detail: `Debate category now '${cat}' — review thesis` });
          }
        }
        for (const f of fired) {
          const key = 'exit_' + pos.symbol + '_' + f.kind;
          const last = alertLog[key];
          const coolHours = f.kind === 'EARNINGS_SOON' || f.kind === 'TIME_EXIT' ? 48 : 12;
          const cool = last && (Date.now() - new Date(last).getTime()) < coolHours * 3600 * 1000;
          if (cool) continue;
          alertLog[key] = new Date().toISOString();
          fires.push({ pos, livePx: px, kind: f.kind, detail: f.detail, trail });
        }
      } catch (e) { /* ignore individual failures */ }
    }));
    await new Promise(r => setTimeout(r, 250));
  }

  // Persist updated trailing stops FIRST — the old code returned before this on
  // quiet days, silently discarding every trail update the run had computed.
  if (stopsChanged) {
    try {
      trades.updatedAt = new Date().toISOString();
      fs.writeFileSync(TRADES_PATH, JSON.stringify(trades, null, 2));
    } catch (e) { console.warn('  Could not persist trailing stops:', e.message); }
  }

  if (!fires.length) { console.log('  No exit triggers.'); saveAlertLog(alertLog); return; }

  const rows = fires.map(f => {
    const kindColour = f.kind === 'STOP_HIT' ? '#ef4444' : f.kind === 'DEBATE_DOWNGRADE' ? '#f59e0b' : '#22c55e';
    const kindLabel = f.kind === 'STOP_HIT' ? '🛑 STOP HIT'
                    : f.kind === 'TARGET_2R' ? '🎯 +2R BOOK 50%'
                    : f.kind === 'TARGET_1_5R' ? '🎯 +1.5R BOOK 25%'
                    : '⚠️ DEBATE DOWNGRADE';
    return `<tr>
      <td style="padding:12px;border-bottom:1px solid #2a2a38;border-left:3px solid ${kindColour}">
        <b style="color:#e4e4ea">${f.pos.symbol}</b>${f.pos.companyName ? `<br><small style="color:#9a9aa6">${f.pos.companyName}</small>` : ''}<br>
        <small style="color:#7dd3fc">${f.pos.signalSource || 'manual'} · entry ₹${f.pos.price} · ${f.pos.qty} sh</small>
      </td>
      <td style="padding:12px;border-bottom:1px solid #2a2a38;text-align:right;font-weight:700;color:#e4e4ea">₹${f.livePx.toFixed(2)}</td>
      <td style="padding:12px;border-bottom:1px solid #2a2a38;text-align:center;font-weight:700;color:${kindColour}">${kindLabel}</td>
      <td style="padding:12px;border-bottom:1px solid #2a2a38;font-size:12px;color:#9a9aa6">${f.detail}</td>
    </tr>`;
  }).join('');

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: config.email_from, pass: config.gmail_app_password } });
  const stopCt = fires.filter(f => f.kind === 'STOP_HIT').length;
  const subjTag = stopCt > 0 ? `🛑 ${stopCt} stop hit, ` : '';
  const html = `<div style="font-family:system-ui,sans-serif;background:#0c0c10;color:#e4e4ea;padding:24px;border-radius:12px;max-width:700px">
    <h2 style="color:#f59e0b;margin:0 0 4px">🚪 Exit Engine — Position Review</h2>
    <p style="color:#9a9aa6;margin:0 0 16px;font-size:13px">
      ${fires.length} action${fires.length===1?'':'s'} suggested · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
    </p>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr style="background:#12121a">
        <th style="padding:10px 12px;text-align:left;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Position</th>
        <th style="padding:10px 12px;text-align:right;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Live</th>
        <th style="padding:10px 12px;text-align:center;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Action</th>
        <th style="padding:10px 12px;text-align:left;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Detail</th>
      </tr></thead><tbody>${rows}</tbody>
    </table>
    <p style="color:#6a6a82;font-size:11px;margin-top:8px">Trailing stop = initial stop until +1R, then chandelier (highest high since entry − ${isBear ? '2.0' : '2.5'}×ATR${isBear ? ', bear-tightened' : ''}). +1.5R/+2R is based on initial stop distance. Open trades.html to record exits.</p>
  </div>`;
  await transporter.sendMail({
    from: config.email_from, to: config.email_to,
    subject: `🚪 Exit Engine: ${subjTag}${fires.length} signal${fires.length===1?'':'s'} — ${fires.slice(0,3).map(f=>f.pos.symbol).join(', ')}${fires.length>3?'…':''}`,
    html,
  });
  console.log(`  Exit-engine email sent (${fires.length} actions, ${stopCt} stop hits) to ${config.email_to}`);
  saveAlertLog(alertLog);
}

// ── Breakout-trigger alerts (live confirmation of timestamped entries) ─
// Reads docs/triggers.json (produced by generate-triggers.js), re-confirms
// each trigger against live Yahoo quote, and emails fresh triggers.
async function checkBreakoutTriggers(config) {
  if (!fs.existsSync(TRIGGERS_PATH)) { console.log('  No triggers.json — run generate-triggers.js first.'); return; }
  let payload;
  try { payload = JSON.parse(fs.readFileSync(TRIGGERS_PATH, 'utf8')); }
  catch (e) { console.error('  triggers.json parse failed:', e.message); return; }
  const triggers = Array.isArray(payload.triggers) ? payload.triggers : [];
  if (!triggers.length) { console.log('  No active triggers.'); return; }

  const regime = loadRegime();
  if (regime.isBearMarket) {
    console.log('  Regime: BEAR — breakout-trigger alerts suppressed.');
    return;
  }

  const alertLog = loadAlertLog();
  const live = [];
  // Re-quote all triggers in batches of 10 to confirm live break still valid
  for (let i = 0; i < triggers.length; i += 10) {
    const batch = triggers.slice(i, i + 10);
    const quotes = await Promise.all(batch.map(async t => {
      try {
        const q = await yahooFinance.quote(EX.yahooSymbol(t.ticker), {
          fields: ['regularMarketPrice', 'regularMarketVolume', 'averageDailyVolume3Month', 'averageDailyVolume10Day'],
        });
        return { t, q };
      } catch { return { t, q: null }; }
    }));
    for (const { t, q } of quotes) {
      if (!q || !q.regularMarketPrice) continue;
      const price = q.regularMarketPrice;
      const aboveEntry = price >= t.entry;
      const stillAbovePivot = price >= t.pivot;
      const stillAboveStop  = price > t.stop;
      if (!(aboveEntry && stillAbovePivot && stillAboveStop)) continue;

      const logKey = 'trig_' + t.ticker + '_' + t.signalType;
      const last = alertLog[logKey];
      const inCool = last && (Date.now() - new Date(last).getTime()) < TRIGGER_COOLDOWN_HOURS * 3600 * 1000;
      if (inCool) continue;
      const isNew = !alertLog[logKey + '_first'];
      if (isNew) alertLog[logKey + '_first'] = new Date().toISOString();
      alertLog[logKey] = new Date().toISOString();
      live.push({ ...t, livePrice: price, isNew });
    }
  }

  if (!live.length) { console.log('  No breakout triggers confirmed live.'); return; }

  live.sort((a, b) => (b.isNew - a.isNew) || (b.conviction - a.conviction));
  const newCt = live.filter(x => x.isNew).length;

  const rows = live.map(t => {
    const ttUrl = t.url || ('https://www.tickertape.in/stocks/' + (t.name || t.ticker).toLowerCase().replace(/\s+ltd$/, '').replace(/\s+/g, '-') + '-' + t.ticker);
    const tagStrip = (t.tags || []).map(g => `<span style="display:inline-block;background:#1f2937;color:#9ca3af;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-right:3px">${g.k}${g.v?' '+g.v:''}</span>`).join('');
    const rowBg = t.isNew ? 'background:#0f1a0f' : '';
    const borderClr = t.isNew ? '#22c55e' : '#0ea5e9';
    const newBadge = t.isNew
      ? '<span style="display:inline-block;background:#22c55e;color:#000;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:middle">NEW</span>'
      : '<span style="display:inline-block;background:#2a2a38;color:#6a6a82;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:middle">REPEAT</span>';
    const sigBadge = t.signalType === 'LIVE_BREAKOUT'
      ? '<span style="display:inline-block;background:#15803d;color:#dcfce7;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px">🟢 LIVE</span>'
      : t.signalType === 'BREAKOUT_VALID'
        ? '<span style="display:inline-block;background:#0e7490;color:#cffafe;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px">✅ EOD VALID</span>'
        : '<span style="display:inline-block;background:#7c2d12;color:#fed7aa;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px">🌊 SURGE</span>';
    return `<tr style="${rowBg}">
      <td style="padding:12px;border-bottom:1px solid #2a2a38;border-left:3px solid ${borderClr}">
        <a href="${ttUrl}" style="color:#e4e4ea;text-decoration:none;font-weight:700" target="_blank">${t.name || t.ticker}</a>${newBadge}<br>
        <small style="color:#9a9aa6">${t.ticker}${t.sector?' · '+t.sector:''}</small><br>
        <div style="margin-top:6px">${sigBadge} ${tagStrip}</div>
      </td>
      <td style="padding:12px;border-bottom:1px solid #2a2a38;text-align:right;color:#22c55e;font-weight:700">₹${t.livePrice.toFixed(2)}<br><small style="color:#9a9aa6;font-weight:400">entry ₹${t.entry}</small></td>
      <td style="padding:12px;border-bottom:1px solid #2a2a38;text-align:right;color:#9a9aa6">₹${t.pivot}<br><small>stop ₹${t.stop}</small></td>
      <td style="padding:12px;border-bottom:1px solid #2a2a38;text-align:right;color:#86efac">₹${t.target}<br><small style="color:#9a9aa6;font-weight:400">R:R ${t.rr}</small></td>
      <td style="padding:12px;border-bottom:1px solid #2a2a38;text-align:right;color:#fbbf24;font-weight:700">${t.sizePct != null ? t.sizePct + '%' : '—'}<br><small style="color:#9a9aa6;font-weight:400">size</small></td>
    </tr>`;
  }).join('');

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: config.email_from, pass: config.gmail_app_password } });
  const subjTag = newCt > 0 ? `🆕 ${newCt} new, ` : '';
  const html = `<div style="font-family:system-ui,sans-serif;background:#0c0c10;color:#e4e4ea;padding:24px;border-radius:12px;max-width:680px">
    <h2 style="color:#22c55e;margin:0 0 4px">🎯 Right-Time Breakout Trigger</h2>
    <p style="color:#9a9aa6;margin:0 0 16px;font-size:13px">
      ${live.length} timestamped entr${live.length===1?'y':'ies'} confirmed live · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
      ${newCt > 0 ? `· <span style="color:#22c55e;font-weight:700">${newCt} brand-new 🆕</span>` : ''}
    </p>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr style="background:#12121a">
        <th style="padding:10px 12px;text-align:left;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Stock · Signal</th>
        <th style="padding:10px 12px;text-align:right;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Live</th>
        <th style="padding:10px 12px;text-align:right;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Pivot / Stop</th>
        <th style="padding:10px 12px;text-align:right;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Target / R:R</th>
        <th style="padding:10px 12px;text-align:right;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Size</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid #2a2a38;font-size:12px">
      <a href="https://amitiyer99.github.io/watchlist-app/triggers.html" style="color:#22c55e;text-decoration:none">Triggers</a> · 
      <a href="https://amitiyer99.github.io/watchlist-app/confluence.html" style="color:#0ea5e9;text-decoration:none">Confluence</a> · 
      <a href="https://amitiyer99.github.io/watchlist-app/breakout2.html" style="color:#0ea5e9;text-decoration:none">Breakout</a>
    </div>
    <p style="color:#6a6a82;font-size:11px;margin-top:8px">Entry = close above pivot · Stop = pivot − 2×ATR · Size = 1% risk budget / stop loss% (cap 5%). Cooldown: ${TRIGGER_COOLDOWN_HOURS}h per ticker · regime gate: ${regime.isBearMarket?'BEAR (suppressed)':'BULL'}</p>
  </div>`;
  await transporter.sendMail({
    from: config.email_from, to: config.email_to,
    subject: `🎯 Breakout Trigger: ${subjTag}${live.length} entr${live.length===1?'y':'ies'} — ${live.slice(0,3).map(t=>t.ticker).join(', ')}${live.length>3?'…':''}`,
    html,
  });
  console.log(`  Breakout-trigger email sent (${live.length} entries, ${newCt} new) to ${config.email_to}`);
  saveAlertLog(alertLog);
}

// ── Trigger list-diff alerts (list membership changes, not live re-confirmation) ─
// generate-triggers.js attaches a `changes: {added, removed}` block to
// triggers.json each time it rebuilds the list. This just relays that block by
// email, deduped per triggers.json snapshot (keyed off its generatedAt) so a
// monitor.js run that finds no new snapshot doesn't resend the same digest.
async function checkTriggerListChanges(config) {
  if (!fs.existsSync(TRIGGERS_PATH)) { console.log('  No triggers.json — skipping list-diff check.'); return; }
  let payload;
  try { payload = JSON.parse(fs.readFileSync(TRIGGERS_PATH, 'utf8')); }
  catch (e) { console.warn('  triggers.json parse failed for list-diff:', e.message); return; }

  const changes = payload.changes || {};
  const added = Array.isArray(changes.added) ? changes.added : [];
  const removed = Array.isArray(changes.removed) ? changes.removed : [];
  if (!added.length && !removed.length) { console.log('  No trigger list changes.'); return; }

  const alertLog = loadAlertLog();
  const SNAP_KEY = 'trigDelta_lastSnapshot';
  if (payload.generatedAt && alertLog[SNAP_KEY] === payload.generatedAt) {
    console.log('  Trigger list-diff already emailed for this snapshot.');
    return;
  }

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: config.email_from, pass: config.gmail_app_password } });

  const stockUrl = (t) => t.url || `https://www.tickertape.in/stocks/${(t.name || t.ticker).toLowerCase().replace(/\s+ltd$/, '').replace(/\s+/g, '-')}-${t.ticker}`;

  const addedRows = added.map(t => `<tr>
    <td style="padding:10px;border-bottom:1px solid #2a2a38;border-left:3px solid #22c55e">
      <a href="${stockUrl(t)}" style="color:#e4e4ea;text-decoration:none;font-weight:700" target="_blank">${t.name || t.ticker}</a><br>
      <small style="color:#9a9aa6">${t.ticker}${t.sector ? ' · ' + t.sector : ''}</small>
    </td>
    <td style="padding:10px;border-bottom:1px solid #2a2a38;color:#9a9aa6;font-size:12px">${t.signalType || '—'}</td>
    <td style="padding:10px;border-bottom:1px solid #2a2a38;text-align:right;font-weight:700;color:#22c55e">${t.conviction != null ? t.conviction : '—'} <small style="color:#9a9aa6;font-weight:400">${t.tier || ''}</small></td>
  </tr>`).join('');

  const removedRows = removed.map(t => `<tr>
    <td style="padding:10px;border-bottom:1px solid #2a2a38;border-left:3px solid #ef4444">
      <b style="color:#e4e4ea">${t.name || t.ticker}</b><br>
      <small style="color:#9a9aa6">${t.ticker}${t.sector ? ' · ' + t.sector : ''}</small>
    </td>
    <td style="padding:10px;border-bottom:1px solid #2a2a38;color:#9a9aa6;font-size:12px">${t.lastSignalType || '—'}</td>
    <td style="padding:10px;border-bottom:1px solid #2a2a38;font-size:12px;color:#fca5a5">${t.reason || 'no longer meets trigger criteria'}</td>
  </tr>`).join('');

  const html = `<div style="font-family:system-ui,sans-serif;background:#0c0c10;color:#e4e4ea;padding:24px;border-radius:12px;max-width:680px">
    <h2 style="color:#7dd3fc;margin:0 0 4px">&#x1F4CB; Trigger List Changed</h2>
    <p style="color:#9a9aa6;margin:0 0 16px;font-size:13px">
      ${added.length} entered &middot; ${removed.length} dropped &middot; ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
    </p>
    ${added.length ? `<h3 style="color:#22c55e;font-size:13px;margin:0 0 8px">&#x1F195; Entered (${added.length})</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:18px">
      <thead><tr style="background:#12121a">
        <th style="padding:8px 10px;text-align:left;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Stock</th>
        <th style="padding:8px 10px;text-align:left;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Signal</th>
        <th style="padding:8px 10px;text-align:right;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Conviction</th>
      </tr></thead>
      <tbody>${addedRows}</tbody>
    </table>` : ''}
    ${removed.length ? `<h3 style="color:#ef4444;font-size:13px;margin:0 0 8px">&#x274C; Dropped (${removed.length})</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr style="background:#12121a">
        <th style="padding:8px 10px;text-align:left;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Stock</th>
        <th style="padding:8px 10px;text-align:left;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Was</th>
        <th style="padding:8px 10px;text-align:left;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Why</th>
      </tr></thead>
      <tbody>${removedRows}</tbody>
    </table>` : ''}
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid #2a2a38;font-size:12px">
      <a href="https://amitiyer99.github.io/watchlist-app/triggers.html" style="color:#7dd3fc;text-decoration:none">Triggers</a>
    </div>
    <p style="color:#6a6a82;font-size:11px;margin-top:8px">Diffed against the previous triggers.json snapshot (generated ${prevGeneratedNote(payload)}). Separate from the &ldquo;Right-Time Breakout Trigger&rdquo; email above, which re-confirms live entries already on the list.</p>
  </div>`;

  await transporter.sendMail({
    from: config.email_from,
    to: config.email_to,
    subject: `📋 Trigger list: +${added.length} entered${removed.length ? `, -${removed.length} dropped` : ''}`,
    html,
  });

  if (payload.generatedAt) alertLog[SNAP_KEY] = payload.generatedAt;
  saveAlertLog(alertLog);
  console.log(`  Trigger list-diff email sent (+${added.length}/-${removed.length}) to ${config.email_to}`);
}

// ── 200-DMA breakdown exit alert ───────────────────────────────────
// Emails when a stock on your watchlist has just broken DOWN through its 200-day
// moving average (breakout2 dma200Cross === 'BREAKDOWN') — a classic long-term
// trend / exit-risk signal. Once per breakdown per stock (5-day cooldown so the
// 5-bar cross window doesn't re-alert daily).
const DMA200_BD_COOLDOWN_H = 120;
async function checkDma200Breakdowns(config) {
  const B2_PATH = path.join(__dirname, 'docs', 'breakout2-data.json');
  if (!fs.existsSync(B2_PATH)) { console.log('  No breakout2-data.json — skipping 200-DMA breakdown check.'); return; }
  let b2; try { b2 = JSON.parse(fs.readFileSync(B2_PATH, 'utf8')); } catch { return; }
  const rows = Array.isArray(b2) ? b2 : (b2.rows || b2.stocks || []);
  const byTicker = new Map(rows.map(r => [String(r.ticker || '').toUpperCase(), r]));

  let watch = []; try { watch = loadStocks(); } catch { watch = []; }
  const alertLog = loadAlertLog();
  const hits = [];
  for (const s of watch) {
    const r = byTicker.get(String(s.ticker).toUpperCase());
    if (!r || r.dma200Cross !== 'BREAKDOWN') continue;
    const key = 'dma200bd_' + s.ticker;
    const last = alertLog[key];
    if (last && (Date.now() - new Date(last).getTime()) < DMA200_BD_COOLDOWN_H * 3600 * 1000) continue;
    hits.push({ ticker: s.ticker, name: s.fullName || s.ticker, watchlist: s.watchlist, price: r.price, s200: r.s200, url: s.stockUrl });
    alertLog[key] = new Date().toISOString();
  }
  if (!hits.length) { console.log('  No new 200-DMA breakdowns on watchlist.'); return; }

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: config.email_from, pass: config.gmail_app_password } });
  const rowsHtml = hits.map(h => `<tr>
    <td style="padding:10px;border-bottom:1px solid #2a2a38;border-left:3px solid #ef4444">
      <a href="${h.url || 'https://www.tickertape.in/stocks/' + h.ticker}" style="color:#e4e4ea;text-decoration:none;font-weight:700" target="_blank">${h.name}</a><br>
      <small style="color:#9a9aa6">${h.ticker}${h.watchlist ? ' · ' + h.watchlist : ''}</small>
    </td>
    <td style="padding:10px;border-bottom:1px solid #2a2a38;text-align:right;color:#e4e4ea">&#x20B9;${h.price != null ? Number(h.price).toFixed(2) : '—'}</td>
    <td style="padding:10px;border-bottom:1px solid #2a2a38;text-align:right;color:#fca5a5">200-DMA &#x20B9;${h.s200 != null ? Number(h.s200).toFixed(2) : '—'}</td>
  </tr>`).join('');

  const html = `<div style="font-family:system-ui,sans-serif;background:#0c0c10;color:#e4e4ea;padding:24px;border-radius:12px;max-width:640px">
    <h2 style="color:#fca5a5;margin:0 0 4px">&#x1F53B; 200-DMA Breakdown — Exit Risk</h2>
    <p style="color:#9a9aa6;margin:0 0 16px;font-size:13px">${hits.length} watchlist stock(s) closed back below the 200-day moving average — a long-term trend break. Review position sizing / exits. ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr style="background:#12121a">
        <th style="padding:8px 10px;text-align:left;color:#fca5a5;font-size:11px;text-transform:uppercase">Stock</th>
        <th style="padding:8px 10px;text-align:right;color:#fca5a5;font-size:11px;text-transform:uppercase">Price</th>
        <th style="padding:8px 10px;text-align:right;color:#fca5a5;font-size:11px;text-transform:uppercase">Level</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <p style="color:#6a6a82;font-size:11px;margin-top:12px">A break below the 200-DMA is a widely-watched exit/risk-off trigger, not advice. One alert per breakdown (${DMA200_BD_COOLDOWN_H / 24}-day cooldown).</p>
  </div>`;

  await transporter.sendMail({ from: config.email_from, to: config.email_to, subject: `🔻 200-DMA breakdown: ${hits.map(h => h.ticker).slice(0, 5).join(', ')}${hits.length > 5 ? ` +${hits.length - 5}` : ''}`, html });
  saveAlertLog(alertLog);
  console.log(`  200-DMA breakdown email sent (${hits.length}) to ${config.email_to}`);
}
function prevGeneratedNote(payload) {
  try { return new Date(payload.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }); }
  catch { return payload.generatedAt || 'unknown time'; }
}

async function sendAlert(config, alerts) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.email_from, pass: config.gmail_app_password },
  });

  const newCount = alerts.filter(a => a.isNew).length;
  const rows = alerts.map(a => {
    const pctInRange = ((a.price - a.low3m) / a.range * 100).toFixed(1);
    const ttUrl = a.stockUrl || tickerUrls[a.ticker] || `https://www.tickertape.in/stocks/${a.fullName.replace(/\s+Ltd$/i, '').replace(/\s+/g, '-').toLowerCase()}-${a.ticker}`;
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

  // 3M-low dip alerts (gated by config.alerts.dip3MLow)
  if (config.alerts.dip3MLow) {
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
    alerts.sort((a, b) => {
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      return ((a.price - a.low3m) / a.range) - ((b.price - b.low3m) / b.range);
    });
    if (alerts.length > 0) {
      try { await sendAlert(config, alerts); saveAlertLog(alertLog); }
      catch (err) { console.error('  Email error:', err.message); }
    } else {
      console.log('  No 3M-low alerts triggered.');
    }
  } else {
    console.log('  3M-low alerts disabled in config.alerts.dip3MLow.');
  }

  // Custom user-defined price alerts (gated by config.alerts.userPriceAlerts)
  if (config.alerts.userPriceAlerts) {
    try { await checkUserAlerts(config); } catch (err) { console.error('  Custom alert error:', err.message); }
  }

  // Right-time breakout-trigger alerts (gated by config.alerts.breakoutTriggers + regime)
  if (config.alerts.breakoutTriggers) {
    try { await checkBreakoutTriggers(config); } catch (err) { console.error('  Trigger alert error:', err.message); }
  }

  // Trigger list-diff alerts (gated by config.alerts.triggerListChanges) — flags
  // stocks that entered or dropped off docs/triggers.json since the last rebuild.
  if (config.alerts.triggerListChanges) {
    try { await checkTriggerListChanges(config); } catch (err) { console.error('  Trigger list-diff error:', err.message); }
  }

  // Exit engine: trailing-stop / target-hit / debate-downgrade alerts on open positions
  if (config.alerts.exitEngine) {
    try { await checkExitConditions(config); } catch (err) { console.error('  Exit engine error:', err.message); }
  }

  // 200-DMA breakdown exit alerts on watchlist names (default on; opt out via flag).
  if (config.alerts.dma200Breakdown !== false) {
    try { await checkDma200Breakdowns(config); } catch (err) { console.error('  200-DMA breakdown error:', err.message); }
  }
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

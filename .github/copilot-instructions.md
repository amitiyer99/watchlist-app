# GitHub Copilot Instructions

## Project Overview

`watchlist-app` is a Node.js tool for monitoring Indian equity (NSE) stocks. It:

1. **Fetches** watchlist data from [Tickertape.in](https://www.tickertape.in/watchlist) using Playwright (browser automation, requires manual login with persistent session).
2. **Monitors** live stock prices via `yahoo-finance2` and sends Gmail email alerts when a stock trades within 10% above its 3-month low.
3. **Generates** static HTML dashboards deployed to GitHub Pages via GitHub Actions.

## Tech Stack

- **Runtime**: Node.js 20
- **Dependencies**: `playwright`, `yahoo-finance2`, `nodemailer`, `node-cron`
- **CI/CD**: GitHub Actions (`.github/workflows/monitor.yml`) — runs every 10 minutes on market days (Mon–Fri, 9:15 AM–3:30 PM IST)
- **Output**: `my-watchlists.json`, `my-watchlists.html`, `docs/index.html`, `docs/creamy.html`

## Key Files

| File | Purpose |
|------|---------|
| `fetch.js` | Playwright scraper — logs into Tickertape, extracts all equity watchlists across periods (1D/1M/3M/6M/1Y), resolves stock URLs |
| `monitor.js` | Price monitor — loads 3M ranges from JSON, fetches live prices, triggers alerts, runs on cron or `--once` / `--dry-run` |
| `refresh.js` | Lightweight data refresh |
| `dashboard.js` | Generates static dashboard HTML |
| `generate-dashboard.js` | Writes `docs/index.html` for GitHub Pages |
| `generate-creamy.js` | Writes `docs/creamy.html` — "creamy layer" filtered view |
| `generate-breakout.js` | Writes `docs/breakout.html` — VCP/Minervini breakout scanner from watchlist tickers |
| `explore-screener.js` / `explore-sources.js` | Ad-hoc exploration utilities |
| `config.json` | Gmail credentials (email_from, email_to, gmail_app_password) — never commit real values |
| `my-watchlists.json` | Watchlist data produced by `fetch.js` — source of truth for `monitor.js` and `generate-breakout.js` |
| `alert-log.json` | Cooldown tracker — ISO timestamps keyed by ticker |
| `ticker-urls.json` | Cached Tickertape stock URL map |

## Domain Conventions

- **Market**: NSE India. Tickers are NSE symbols (e.g. `RELIANCE`). Yahoo Finance requires `.NS` suffix (`RELIANCE.NS`).
- **Currency**: Indian Rupees (₹). Price strings use `₹` prefix and commas (e.g. `₹1,380.70`). Strip with `parseFloat(String(v).replace(/[₹,]/g, ''))`.
- **Timezone**: All scheduling and display uses `Asia/Kolkata` (IST = UTC+5:30).
- **Alert threshold**: `price <= low3m * 1.10` (within 10% above the 3-month low). Cooldown is 4 hours per ticker.
- **Stock name format** in JSON: `"Full Name Ltd\nTICKER"` — split on `\n` to separate company name from ticker.

## Coding Patterns

- All scripts are standalone CommonJS modules (`require`/`module.exports`), no TypeScript.
- Async/await throughout; batch API calls with `Promise.all` in groups of 5–10 to avoid rate limits.
- HTML generation is done by string interpolation (no template engine). Use `esc()` helper for HTML-escaping user-facing strings.
- UI palette (dark theme): `--bg:#0c0c10`, `--ac:#00d4aa` (teal accent), `--gn:#22c55e` (green), `--rd:#ef4444` (red).
- Config is loaded from `config.json` but environment variables (`EMAIL_FROM`, `EMAIL_TO`, `GMAIL_APP_PASSWORD`) take priority — used by GitHub Actions secrets.

## npm Scripts

```
npm run fetch       # Scrape Tickertape (opens browser, may require login)
npm run monitor     # Start continuous monitor (cron, local)
npm run dry-run     # Single check, no emails sent
npm start           # Alias for monitor
npm run refresh     # Refresh watchlist data
npm run dashboard   # Generate dashboard HTML
npm run creamy      # Generate creamy layer HTML
npm run breakout    # Generate VCP breakout scanner HTML
```

## Important Notes

- `fetch.js` uses a **persistent Playwright session** stored in `%LOCALAPPDATA%\watchlist-app-session` so login survives restarts.
- `monitor.js --once` is used by GitHub Actions for a single check-and-exit run.
- The `debug/` directory holds Playwright screenshots captured during scraping failures — useful for diagnosing extraction issues.
- **Never hardcode or expose** Gmail app passwords. Use `config.json` locally (gitignored) or GitHub Actions secrets.
- Tickertape DOM selectors (class names like `watchlist-assetId-row`) are fragile — if scraping breaks, inspect the page and update selectors in `extractStocks()`.

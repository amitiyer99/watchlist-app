'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
const alertSystem = require('./alert-system');

const WATCHLIST_PATH = path.join(__dirname, 'my-watchlists.json');
const OUTPUT_PATH    = path.join(__dirname, 'docs', 'breakout2.html');
const BATCH_SIZE     = 10;
const HISTORY_DAYS   = 370;  // ~260 trading bars — enough for 12-month RS + SMA200
const SCREENER_CAP   = 800;  // max stocks from Tickertape screener

// ── Tickertape API helpers ────────────────────────────────────────────

function apiPostOnce(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 15000,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://www.tickertape.in',
        'Referer': 'https://www.tickertape.in/'
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse error')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(data);
  });
}

async function apiPost(url, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await apiPostOnce(url, body); }
    catch (e) { if (i === retries - 1) throw e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
}

// ── Utility helpers ───────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function avg(arr) { if (!arr.length) return 0; return arr.reduce((a, b) => a + b, 0) / arr.length; }
function sma(closes, n) { const s = closes.slice(-n); if (s.length < n) return null; return avg(s); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n, dec = 2) { if (n == null || isNaN(n)) return '—'; return Number(n).toFixed(dec); }
function fmtPrice(p) { if (p == null) return '—'; return '₹' + Number(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function ringClass(score) { if (score >= 65) return 's-high'; if (score >= 40) return 's-med'; return 's-low'; }

// ── Load watchlist stocks ─────────────────────────────────────────────

function loadWatchlistStocks() {
  const watchlists = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
  const seen = new Set();
  const stocks = [];
  for (const wl of watchlists) {
    for (const period of Object.values(wl.periods || {})) {
      for (const s of (period.stocks || [])) {
        const parts = (s.name || '').split('\n');
        const ticker = (parts[1] || '').trim();
        const name   = (parts[0] || '').trim();
        if (!ticker || seen.has(ticker)) continue;
        seen.add(ticker);
        stocks.push({ ticker, name, stockUrl: s.stockUrl || '', inWatchlist: true, sector: '' });
      }
    }
  }
  return stocks;
}

// ── Fetch quality universe from Tickertape screener ───────────────────

async function fetchScreenerUniverse() {
  const PAGE = 500;
  const allStocks = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total && allStocks.length < SCREENER_CAP) {
    const toFetch = Math.min(PAGE, SCREENER_CAP - allStocks.length);
    const body = {
      match: {},  // top 800 by mcap sort gives the quality universe we need
      sortBy: 'mrktCapf', sortOrder: -1,
      project: ['ticker', 'name', 'sector', 'mrktCapf'],
      offset, count: toFetch,
    };
    try {
      const r = await apiPost('https://api.tickertape.in/screener/query', body);
      if (!r.success) { console.log('  Screener returned success:false'); break; }
      total = r.data.stats.count;
      const results = r.data.results || [];
      if (!results.length) break;
      for (const item of results) {
        const ticker = item.stock?.info?.ticker || '';
        if (!ticker) continue;
        const slug = item.stock?.slug || '';
        allStocks.push({
          ticker,
          name:     item.stock?.info?.name   || ticker,
          sector:   item.stock?.info?.sector || '',
          stockUrl: slug ? `https://www.tickertape.in${slug}` : '',
          inWatchlist: false,
        });
      }
      offset += results.length;
      process.stdout.write(`  Screener: ${allStocks.length}/${Math.min(total, SCREENER_CAP)} fetched\r`);
      if (results.length < toFetch) break;
    } catch (e) {
      console.error(`  Screener error (offset=${offset}):`, e.message); break;
    }
  }
  console.log(`\n  Screener: ${allStocks.length} stocks (top ${SCREENER_CAP} by market cap)`);
  return allStocks;
}
// ── Fetch OHLCV history from Yahoo Finance ────────────────────────────

async function fetchHistory(ticker) {
  const period1 = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const period2 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    const rows = await yahooFinance.historical(ticker + '.NS', { period1, period2, interval: '1d' });
    if (!rows || rows.length < 60) return null;
    return rows
      .filter(r => r.close != null && r.volume != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch { return null; }
}

// ── IBD-style RS Value (weighted 4-quarter return) ────────────────────

function computeRSValue(closes) {
  const n = closes.length;
  if (n < 63) return 0;
  const p0 = closes[n - 1];
  const p1 = closes[n - 1 - Math.min(63,  n - 1)];
  const p2 = closes[n - 1 - Math.min(126, n - 1)];
  const p3 = closes[n - 1 - Math.min(189, n - 1)];
  const p4 = closes[n - 1 - Math.min(252, n - 1)];
  if (!p1 || p1 <= 0) return 0;
  const q4 = p1 > 0 ? p0 / p1 - 1 : 0;
  const q3 = p2 > 0 ? p1 / p2 - 1 : q4;
  const q2 = p3 > 0 ? p2 / p3 - 1 : q4;
  const q1 = p4 > 0 ? p3 / p4 - 1 : q4;
  return 0.4 * q4 + 0.2 * q3 + 0.2 * q2 + 0.2 * q1;
}

// ── Analyse a stock ───────────────────────────────────────────────────

function analyzeStock(bars) {
  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const price   = closes[closes.length - 1];
  const n       = closes.length;

  const s50  = sma(closes, 50);
  const s150 = sma(closes, 150);
  const s200 = sma(closes, 200);
  const s200_20ago = n >= 220
    ? avg(closes.slice(n - 220, n - 20))
    : (n >= 170 ? avg(closes.slice(0, n - 20)) : null);

  const high52 = Math.max(...highs);
  const low52  = Math.min(...lows);

  // ── Stage 2 (8 pts each, max 48) ──
  const stageChecks = {
    aboveSma50:  s50  != null && price > s50,
    aboveSma150: s150 != null && price > s150,
    aboveSma200: s200 != null && price > s200,
    maStacked:   s50 != null && s150 != null && s200 != null && s50 > s150 && s150 > s200,
    sma200Up:    s200 != null && s200_20ago != null && s200 > s200_20ago,
    nearHigh:    price >= high52 * 0.75,
  };
  const aboveLow30 = price >= low52 * 1.30;
  const stageScore = Object.values(stageChecks).filter(Boolean).length * 8;
  const stage2Pass = Object.values(stageChecks).filter(Boolean).length >= 5;

  // ── VCP (15 pts each, max 30) ──
  let progressivePullback = false;
  if (n >= 60) {
    const w1 = bars.slice(n - 60, n - 40), w2 = bars.slice(n - 40, n - 20), w3 = bars.slice(n - 20, n);
    const dd = w => { const h = Math.max(...w.map(b => b.high)), l = Math.min(...w.map(b => b.low)); return (h - l) / h; };
    progressivePullback = dd(w1) > dd(w2) && dd(w2) > dd(w3);
  }
  let tightRightSide = false;
  if (n >= 20) {
    const range5  = bars.slice(n - 5, n).map(b => (b.high - b.low) / b.close);
    const range15 = bars.slice(n - 20, n - 5).map(b => (b.high - b.low) / b.close);
    tightRightSide = avg(range5) < avg(range15) * 0.75;
  }
  const vcpScore_raw = (progressivePullback ? 15 : 0) + (tightRightSide ? 15 : 0);
  const vcpPass = progressivePullback || tightRightSide;

  // ── Volume ──
  const vol5  = n >= 5  ? avg(volumes.slice(n - 5,  n)) : null;
  const vol50 = n >= 50 ? avg(volumes.slice(n - 50, n)) : null;
  const vol1d = volumes[n - 1];
  const volDryUp = vol5  != null && vol50 != null && vol5  < vol50 * 0.70;
  const volPct   = vol5  != null && vol50 != null ? Math.round((vol5  / vol50) * 100) : null;
  const volScore = volDryUp ? 22 : 0;

  // ── Pivot ──
  const pivot         = n >= 10 ? Math.max(...highs.slice(n - 10)) : Math.max(...highs);
  const pctBelowPivot = ((pivot - price) / pivot) * 100;

  // ── Volume Surge (yesterday bar > 1.5x 50-day avg AND above pivot) ──
  const volSurgeConfirmed = vol50 != null && vol1d > vol50 * 1.5 && closes[n - 1] >= pivot;
  const volSurgePct       = vol50 != null ? Math.round((vol1d / vol50) * 100) : null;

  // ── RS Value ──
  const rsValue = computeRSValue(closes);

  // ── Total score (max 100) ──
  const totalScore = stageScore + vcpScore_raw + volScore;

  let tag, tagClass;
  if      (totalScore >= 85) { tag = '🔥 Prime';      tagClass = 'prime'; }
  else if (totalScore >= 65) { tag = '✅ Developing';  tagClass = 'developing'; }
  else if (totalScore >= 40) { tag = '🔶 Partial';    tagClass = 'partial'; }
  else                       { tag = '⬜ Not Ready';   tagClass = 'notready'; }

  return {
    price, s50, s150, s200, high52, low52, aboveLow30,
    stageChecks, stageScore, stage2Pass,
    progressivePullback, tightRightSide, vcpPass,
    vol5: vol5 ? Math.round(vol5) : null,
    vol50: vol50 ? Math.round(vol50) : null,
    volDryUp, volPct, volSurgeConfirmed, volSurgePct,
    totalScore, tag, tagClass,
    pivot, pctBelowPivot,
    rsValue,
    rsRating: 50,  // placeholder — overwritten after ranking
  };
}

// ── Compute RS Ratings (percentile rank within analyzed universe) ─────

function computeRSRatings(results) {
  const valid = [...results].filter(r => r.rsValue != null);
  valid.sort((a, b) => a.rsValue - b.rsValue);
  const n = valid.length;
  const ranks = {};
  valid.forEach((r, i) => {
    ranks[r.ticker] = Math.max(1, Math.min(99, Math.round((i / Math.max(n - 1, 1)) * 98) + 1));
  });
  return ranks;
}

// ── Build result list ─────────────────────────────────────────────────

async function buildResults(stocks) {
  const results = [];
  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = stocks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async s => {
      const bars = await fetchHistory(s.ticker);
      if (!bars) return null;
      return { ...s, ...analyzeStock(bars) };
    }));
    for (const r of batchResults) { if (r) results.push(r); }
    process.stdout.write(`  Analyzed ${Math.min(i + BATCH_SIZE, stocks.length)}/${stocks.length} stocks\r`);
    if (i + BATCH_SIZE < stocks.length) await sleep(200);
  }
  console.log(`  Analyzed ${results.length}/${stocks.length} stocks (${stocks.length - results.length} skipped)`);
  return results;
}

// ── Render helpers ────────────────────────────────────────────────────

function checkBadge(pass, label) {
  if (pass) return `<span class="chk chk-pass">${esc(label)} ✓</span>`;
  return `<span class="chk chk-fail">${esc(label)} ✗</span>`;
}

function rsHtml(rs) {
  if (!rs) return '<span class="dim">—</span>';
  const cls = rs >= 90 ? 'rs-elite' : rs >= 80 ? 'rs-high' : rs >= 60 ? 'rs-mid' : 'rs-low';
  return `<span class="rs-badge ${cls}">${rs}</span>`;
}

function volHtml(r) {
  if (r.volSurgeConfirmed) return `<span class="vol-surge">&#x1F30A; ${r.volSurgePct}% surge!</span>`;
  if (r.volDryUp) return `<span class="pos">${r.volPct}% dry-up</span>`;
  return `<span class="dim">${r.volPct != null ? r.volPct + '% of avg' : '—'}</span>`;
}
// ── Build table row ──────────────────────────────────────────────────

function buildTableRow(r) {
  const ttUrl = r.stockUrl || `https://www.tickertape.in/stocks/${r.name.replace(/\s+/g, '-').toLowerCase()}-${r.ticker}`;
  const pivotStr = r.pctBelowPivot != null ? `${fmt(r.pctBelowPivot, 1)}% below` : '—';
  const awayHigh = r.high52 ? fmt(((r.high52 - r.price) / r.high52) * 100, 1) + '%' : '—';
  const awayLow  = r.low52  ? fmt(((r.price  - r.low52) / r.low52)  * 100, 1) + '%' : '—';

  return `<tr
    data-score="${r.totalScore}"
    data-rs="${r.rsRating}"
    data-stage="${r.stage2Pass ? '1' : '0'}"
    data-vcp="${r.vcpPass ? '1' : '0'}"
    data-vol="${r.volDryUp ? '1' : '0'}"
    data-surge="${r.volSurgeConfirmed ? '1' : '0'}"
    data-prime="${r.totalScore >= 85 ? '1' : '0'}"
    data-wl="${r.inWatchlist ? '1' : '0'}"
    data-name="${esc(r.name.toLowerCase())}"
    data-ticker="${esc(r.ticker.toLowerCase())}">
    <td>
      <div class="stock-name">
        <a href="${esc(ttUrl)}" target="_blank" rel="noopener">${esc(r.name)}</a>
        <div class="ticker">${esc(r.ticker)}${r.inWatchlist ? '<span class="wl-dot" title="In your watchlist"> ★</span>' : ''}</div>
      </div>
      <button class="alert-btn" data-alert-ticker="${esc(r.ticker)}" data-alert-price="${r.price || 0}" data-alert-name="${esc(r.name)}">&#x1F514;</button>
      <button class="research-btn" data-r-ticker="${esc(r.ticker)}" title="AI Deep Research">&#x1F9E0;</button>
    </td>
    <td class="num">${fmtPrice(r.price)}</td>
    <td>
      <div class="bo-score">
        <span class="bo-ring ${ringClass(r.totalScore)}">${r.totalScore}</span>
        <span class="tag-vcp tag-vcp-${r.tagClass}">${r.tag}</span>
      </div>
    </td>
    <td>${rsHtml(r.rsRating)}</td>
    <td>
      ${checkBadge(r.stageChecks.aboveSma50 && r.stageChecks.aboveSma150 && r.stageChecks.aboveSma200, 'Trend')}
      ${checkBadge(r.stageChecks.maStacked, 'MA Stack')}
      ${checkBadge(r.stageChecks.nearHigh, 'Near High')}
      ${checkBadge(r.stageChecks.sma200Up, '200↑')}
    </td>
    <td>
      ${checkBadge(r.progressivePullback, 'Pullback')}
      ${checkBadge(r.tightRightSide, 'Tight')}
    </td>
    <td>${volHtml(r)}</td>
    <td>
      <span class="pivot-price">${fmtPrice(r.pivot)}</span>
      <span class="pivot-pct ${r.pctBelowPivot <= 3 ? 'pos' : 'dim'}">${pivotStr}</span>
    </td>
    <td>
      <span class="dim">${awayHigh} off high</span><br>
      <span class="${r.aboveLow30 ? 'pos' : 'dim'}">${awayLow} off low</span>
    </td>
  </tr>`;
}

// ── Build card row (mobile) ───────────────────────────────────────────

function buildCardRow(r) {
  const ttUrl = r.stockUrl || `https://www.tickertape.in/stocks/${r.name.replace(/\s+/g, '-').toLowerCase()}-${r.ticker}`;
  const awayHigh = r.high52 ? fmt(((r.high52 - r.price) / r.high52) * 100, 1) + '%' : '—';

  return `<div class="stock-card"
    data-score="${r.totalScore}"
    data-rs="${r.rsRating}"
    data-stage="${r.stage2Pass ? '1' : '0'}"
    data-vcp="${r.vcpPass ? '1' : '0'}"
    data-vol="${r.volDryUp ? '1' : '0'}"
    data-surge="${r.volSurgeConfirmed ? '1' : '0'}"
    data-prime="${r.totalScore >= 85 ? '1' : '0'}"
    data-wl="${r.inWatchlist ? '1' : '0'}"
    data-name="${esc(r.name.toLowerCase())}"
    data-ticker="${esc(r.ticker.toLowerCase())}">
    <div class="card-header">
      <div>
        <div class="card-name"><a href="${esc(ttUrl)}" target="_blank">${esc(r.name)}</a></div>
        <div class="card-ticker">${esc(r.ticker)}${r.inWatchlist ? ' <span class="wl-dot">★ WL</span>' : ''}
          <button class="alert-btn" data-alert-ticker="${esc(r.ticker)}" data-alert-price="${r.price || 0}" data-alert-name="${esc(r.name)}">&#x1F514;</button>
          <button class="research-btn" data-r-ticker="${esc(r.ticker)}" title="AI Deep Research">&#x1F9E0;</button>
        </div>
      </div>
      <div class="card-price">
        <div class="price">${fmtPrice(r.price)}</div>
        <div><span class="bo-ring ${ringClass(r.totalScore)}" style="width:32px;height:32px;font-size:.78rem">${r.totalScore}</span></div>
      </div>
    </div>
    <div class="card-row"><span class="card-label">Tag</span><span>${r.tag}</span></div>
    <div class="card-row"><span class="card-label">RS Rating</span><span>${rsHtml(r.rsRating)}</span></div>
    <div class="card-row"><span class="card-label">Stage 2</span><span>
      ${checkBadge(r.stageChecks.aboveSma50 && r.stageChecks.aboveSma150 && r.stageChecks.aboveSma200, 'Trend')}
      ${checkBadge(r.stageChecks.maStacked, 'MA Stack')}
      ${checkBadge(r.stageChecks.nearHigh, 'Near High')}
    </span></div>
    <div class="card-row"><span class="card-label">VCP Pattern</span><span>
      ${checkBadge(r.progressivePullback, 'Pullback')} ${checkBadge(r.tightRightSide, 'Tight')}
    </span></div>
    <div class="card-row"><span class="card-label">Volume</span><span>${volHtml(r)}</span></div>
    <div class="card-row"><span class="card-label">Pivot</span><span>${fmtPrice(r.pivot)}</span></div>
    <div class="card-row"><span class="card-label">% off 52W High</span><span>${awayHigh}</span></div>
  </div>`;
}
// ── Build HTML ───────────────────────────────────────────────────────

function buildHtml(results, generatedAt) {
  const total     = results.length;
  const stage2Cnt = results.filter(r => r.stage2Pass).length;
  const vcpCnt    = results.filter(r => r.vcpPass).length;
  const volDryCnt = results.filter(r => r.volDryUp).length;
  const surgeCnt  = results.filter(r => r.volSurgeConfirmed).length;
  const rs80Cnt   = results.filter(r => r.rsRating >= 80).length;
  const primeCnt  = results.filter(r => r.totalScore >= 85).length;
  const fullSetup = results.filter(r => r.stage2Pass && r.vcpPass && r.volDryUp).length;
  const wlCnt     = results.filter(r => r.inWatchlist).length;

  const tableRows = results.map(buildTableRow).join('');
  const cardRows  = results.map(buildCardRow).join('');
  const drStocksJson = JSON.stringify(results.map(r => ({
    ticker: r.ticker, name: r.name, price: r.price, totalScore: r.totalScore,
    rsRating: r.rsRating, stage2: r.stage2Pass, vcpPass: r.vcpPass,
    volDryUp: r.volDryUp, volPct: r.volPct,
    volSurgeConfirmed: r.volSurgeConfirmed, volSurgePct: r.volSurgePct,
    pivot: r.pivot, high52: r.high52,
    stockUrl: r.stockUrl || '', inWatchlist: r.inWatchlist, sector: r.sector || '',
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Breakout Scanner Gen2 · NSE Universe</title>
<script>
(function(){var s=localStorage.getItem('creamy-theme');var p=s||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',p)})();
<\/script>
<style>
:root,html[data-theme="dark"]{
  --bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;
  --ac:#00d4aa;--tx:#e8e8f0;--t2:#9898b0;--t3:#6a6a82;
  --gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a78bfa;--or:#f97316;
  --hdr-bg:linear-gradient(135deg,#0d1a18,#12121a);
  --shadow:0 8px 24px rgba(0,0,0,.4);--row-hover:rgba(0,212,170,.04);--card-border:rgba(42,42,56,.4)
}
html[data-theme="light"]{
  --bg:#f8f9fc;--s1:#fff;--s2:#fff;--s3:#eef0f5;--bd:#d5d8e0;
  --ac:#0d9e82;--tx:#1e1e32;--t2:#44495e;--t3:#6b7188;
  --gn:#15803d;--rd:#b91c1c;--yw:#a16207;--bl:#1d4ed8;--pp:#7c3aed;--or:#c2410c;
  --hdr-bg:linear-gradient(135deg,#e6f7f4,#eaecf2);
  --shadow:0 4px 16px rgba(0,0,0,.07);--row-hover:rgba(13,158,130,.03);--card-border:rgba(0,0,0,.08)
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);overflow-x:hidden;line-height:1.55;transition:background .3s,color .3s}
.header{background:var(--hdr-bg);border-bottom:1px solid var(--bd);padding:18px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.35rem;font-weight:700;background:linear-gradient(90deg,var(--ac),#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .subtitle{font-size:.76rem;color:var(--t2);margin-top:3px}
.header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.back-link{color:var(--t2);text-decoration:none;font-size:.82rem;padding:7px 14px;border:1px solid var(--bd);border-radius:6px;transition:all .2s}
.back-link:hover{color:var(--ac);border-color:var(--ac)}
.theme-toggle{width:42px;height:24px;border-radius:12px;border:1px solid var(--bd);background:var(--s3);cursor:pointer;position:relative;transition:all .3s;flex-shrink:0}
.theme-toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--ac);transition:transform .3s}
html[data-theme="light"] .theme-toggle::after{transform:translateX(18px)}
.theme-label{font-size:.68rem;color:var(--t3);white-space:nowrap}
.gen2-badge{display:inline-block;background:linear-gradient(90deg,#a855f7,#3b82f6);color:#fff;font-size:.64rem;font-weight:700;padding:2px 7px;border-radius:4px;vertical-align:middle;margin-left:6px;letter-spacing:.04em}
.stats-bar{display:flex;gap:12px;padding:16px 28px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap}
.stat-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:12px 18px;min-width:100px}
.stat-card .label{font-size:.7rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.stat-card .value{font-size:1.2rem;font-weight:700}
.stat-card .value.teal{color:var(--ac)}.stat-card .value.green{color:var(--gn)}.stat-card .value.blue{color:var(--bl)}.stat-card .value.yellow{color:var(--yw)}.stat-card .value.red{color:var(--rd)}.stat-card .value.purple{color:var(--pp)}.stat-card .value.orange{color:var(--or)}
.controls{display:flex;gap:10px;padding:16px 28px;flex-wrap:wrap;align-items:center}
.filter-group{display:flex;gap:4px;align-items:center;border:1px solid var(--bd);border-radius:8px;padding:3px;background:var(--s1);flex-wrap:wrap}
.filter-group .fg-label{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.04em;padding:0 8px;white-space:nowrap;font-weight:600}
.btn{padding:6px 14px;border-radius:5px;border:1px solid transparent;background:transparent;color:var(--t2);cursor:pointer;font-size:.8rem;font-family:inherit;transition:all .2s}
.btn:hover{color:var(--tx);background:var(--s3)}
.btn.active{background:var(--ac);color:#fff;border-color:var(--ac);font-weight:600}
html[data-theme="light"] .btn.active{color:#fff}
.search{padding:8px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.88rem;font-family:inherit;width:230px;outline:none}
.search:focus{border-color:var(--ac)}
.table-container{padding:8px 28px 28px;overflow-x:auto}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:.84rem}
thead{position:sticky;top:0;z-index:10}
th{background:var(--s1);color:var(--ac);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;padding:12px;text-align:left;border-bottom:2px solid var(--bd);cursor:pointer;white-space:nowrap;user-select:none}
th:hover{color:var(--tx)}
th .arrow{margin-left:4px;font-size:.6rem;opacity:.5}
th.sorted .arrow{opacity:1;color:var(--ac)}
.tip-icon{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:rgba(0,212,170,.18);color:var(--ac);font-size:.56rem;font-weight:800;margin-left:3px;cursor:help;line-height:1;vertical-align:middle;flex-shrink:0}
.tt{position:fixed;z-index:9999;background:#1e1e2e;color:#e8e8f0;font-size:.7rem;font-weight:400;line-height:1.55;padding:8px 11px;border-radius:8px;border:1px solid rgba(0,212,170,.28);white-space:normal;width:220px;text-align:left;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.55);opacity:0;transition:opacity .15s .05s}
html[data-theme="light"] .tt{background:#1e1e32;color:#f0f0f8;border-color:rgba(13,158,130,.35)}
.tt.tt-vis{opacity:1}
th{position:relative}
td{padding:10px 12px;border-bottom:1px solid var(--card-border);white-space:nowrap;vertical-align:middle}
tr:hover td{background:var(--row-hover)}
.stock-name a{color:var(--tx);text-decoration:none;font-weight:600;font-size:.88rem}
.stock-name a:hover{color:var(--ac)}
.stock-name .ticker{color:var(--t2);font-size:.74rem;margin-top:1px}
.wl-dot{color:var(--yw);font-size:.78rem}
.num{font-variant-numeric:tabular-nums}
.pos{color:var(--gn)}.neg{color:var(--rd)}.dim{color:var(--t3)}
.vol-surge{color:var(--gn);font-weight:700}
.chk{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600;margin:2px 2px 2px 0;white-space:nowrap}
.chk-pass{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.chk-fail{background:rgba(239,68,68,.07);color:var(--t3);border:1px solid rgba(100,100,120,.2)}
html[data-theme="light"] .chk-pass{background:rgba(21,128,61,.08);color:#15803d;border-color:rgba(21,128,61,.2)}
html[data-theme="light"] .chk-fail{background:rgba(0,0,0,.03);color:#9ca3af;border-color:#e5e7eb}
.bo-ring{width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:.84rem;font-weight:800;border:3px solid;flex-shrink:0}
.bo-ring.s-high{border-color:var(--gn);color:var(--gn);background:rgba(34,197,94,.08)}
.bo-ring.s-med{border-color:var(--yw);color:var(--yw);background:rgba(234,179,8,.06)}
.bo-ring.s-low{border-color:var(--t3);color:var(--t3);background:rgba(90,90,112,.06)}
.bo-score{display:inline-flex;align-items:center;gap:8px}
.tag-vcp{display:inline-block;padding:3px 9px;border-radius:5px;font-size:.7rem;font-weight:700;white-space:nowrap}
.tag-vcp-prime{background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.3)}
.tag-vcp-developing{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.tag-vcp-partial{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.25)}
.tag-vcp-notready{background:rgba(100,100,130,.08);color:var(--t3);border:1px solid rgba(100,100,130,.15)}
.rs-badge{display:inline-block;padding:3px 9px;border-radius:5px;font-size:.78rem;font-weight:800;font-variant-numeric:tabular-nums}
.rs-elite{background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.3)}
.rs-high{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.rs-mid{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.2)}
.rs-low{background:rgba(100,100,130,.07);color:var(--t3);border:1px solid rgba(100,100,130,.15)}
.pivot-price{font-weight:600;margin-right:4px}
.pivot-pct{font-size:.75rem}
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.76rem;border-top:1px solid var(--bd)}
#no-results{display:none;padding:40px;text-align:center;color:var(--t2)}
.hidden{display:none!important}
#cards-container{display:none;padding:0 14px 24px}
.stock-card{background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:12px}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.card-name{font-weight:600;font-size:.9rem}.card-name a{color:var(--tx);text-decoration:none}
.card-ticker{color:var(--t2);font-size:.74rem;margin-top:2px}
.card-price .price{font-size:1.1rem;font-weight:700}
.card-row{display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--card-border);font-size:.8rem}
.card-label{color:var(--t2)}
.sort-select{display:none}
@media(max-width:768px){
  .header{padding:14px 16px}.header h1{font-size:1.1rem}
  .stats-bar{padding:12px 14px;gap:8px}
  .stat-card{min-width:0;flex:1 1 calc(33% - 8px);padding:10px 12px}.stat-card .value{font-size:1rem}
  .controls{padding:12px 14px;gap:8px}
  .filter-group{flex-wrap:wrap;width:100%}
  .filter-group .fg-label{width:100%;padding:2px 6px}
  .search{width:100%;font-size:16px}
  .table-container{display:none}
  #cards-container{display:block}
  .sort-select{display:block;width:100%;margin-top:4px}
  .back-link{font-size:.72rem;padding:5px 10px}
  .theme-label{display:none}
}
${alertSystem.css}
.research-btn{background:none;border:none;cursor:pointer;padding:1px 4px;border-radius:4px;font-size:.82rem;color:var(--t3);transition:color .15s;vertical-align:middle;margin-left:2px;line-height:1;flex-shrink:0}.research-btn:hover{color:var(--pp)}
#dr-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9991;overflow-y:auto;padding:20px 12px}
#dr-modal{background:var(--s2);border:1px solid var(--bd);border-radius:14px;max-width:640px;margin:20px auto;padding:22px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.dr-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--bd)}
.dr-title{font-size:1.1rem;font-weight:700;color:var(--tx)}.dr-subtitle{font-size:.75rem;color:var(--t2);margin-top:3px}
#dr-close{background:none;border:none;cursor:pointer;color:var(--t3);font-size:1.2rem;padding:0;line-height:1;flex-shrink:0}
.dr-section{margin-bottom:18px}.dr-section-title{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ac);font-weight:700;margin-bottom:8px}
.dr-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dr-metric{background:var(--s1);border:1px solid var(--bd);border-radius:8px;padding:10px 12px}.dr-metric .dm-label{font-size:.65rem;color:var(--t2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}.dr-metric .dm-val{font-size:.9rem;font-weight:600}.dr-metric .dm-sub{font-size:.65rem;color:var(--t3);margin-top:2px}
.dr-signal{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:7px;margin-bottom:5px;font-size:.8rem;line-height:1.4}.dr-signal.bull{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.18);color:var(--gn)}.dr-signal.bear{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);color:var(--rd)}.dr-signal.neut{background:rgba(234,179,8,.07);border:1px solid rgba(234,179,8,.18);color:var(--yw)}.dr-signal .ds-icon{flex-shrink:0;margin-top:1px}
.dr-ai-box{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:14px;font-size:.82rem;line-height:1.7;color:var(--tx);min-height:80px}.dr-ai-box.loading{color:var(--t2);font-style:italic}
.dr-ai-error{color:var(--rd);font-size:.78rem;padding:6px 0}.dr-ai-key-row{display:flex;gap:8px;margin-top:10px;align-items:center}
.dr-ai-key-input{flex:1;padding:7px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--s3);color:var(--tx);font-size:.78rem;font-family:inherit;outline:none}
.dr-ai-key-btn{padding:7px 14px;border:none;border-radius:6px;background:var(--pp);color:#fff;cursor:pointer;font-size:.78rem;font-weight:700;font-family:inherit;white-space:nowrap}.dr-ai-key-btn:hover{background:#9061f9}
@media(max-width:768px){#dr-overlay{padding:0}#dr-modal{border-radius:0;min-height:100dvh;margin:0;max-width:100%}.dr-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>Breakout Scanner <span class="gen2-badge">GEN 2</span></h1>
    <div class="subtitle">NSE Top-800 Universe by Mcap &middot; Stage 2 + VCP + RS Rating + Volume Surge &middot; ${total} stocks analyzed</div>
  </div>
  <div class="header-right">
    <span class="theme-label" id="theme-label">Dark</span>
    <div class="theme-toggle" id="theme-toggle" title="Toggle theme"></div>
    <a href="alerts.html" class="back-link" style="color:var(--yw);border-color:rgba(234,179,8,.4)">&#x1F514; Alerts</a>
    <a href="potential.html" class="back-link" style="color:var(--pp);border-color:rgba(168,85,247,.4)">&#x1F31F; Potential</a>
    <a href="multibagger.html" class="back-link" style="color:#f59e0b;border-color:rgba(245,158,11,.4)">&#x1F3C6; Multibagger</a>
    <a href="breakout.html" class="back-link">Breakout v1</a>
    <a href="apex.html" class="back-link" style="color:#6366f1;border-color:rgba(99,102,241,.4)">&#x1F52E; APEX</a>
    <a href="creamy.html" class="back-link">Creamy Layer</a>
    <a href="trades.html" class="back-link" style="color:#22c55e;border-color:rgba(34,197,94,.4)">&#x1F4C8; Trades</a>
    <a href="index.html" class="back-link">My Watchlist</a>
  </div>
</div>

<div class="stats-bar">
  <div class="stat-card"><div class="label">Universe</div><div class="value teal">${total}</div></div>
  <div class="stat-card"><div class="label">Stage 2</div><div class="value green">${stage2Cnt}</div></div>
  <div class="stat-card"><div class="label">Full Setup</div><div class="value blue">${fullSetup}</div></div>
  <div class="stat-card"><div class="label">&#x1F30A; Surge</div><div class="value orange">${surgeCnt}</div></div>
  <div class="stat-card"><div class="label">&#x2B50; RS&#x2265;80</div><div class="value purple">${rs80Cnt}</div></div>
  <div class="stat-card"><div class="label">&#x1F525; Prime</div><div class="value red">${primeCnt}</div></div>
  <div class="stat-card"><div class="label">&#x2605; Watchlist</div><div class="value yellow">${wlCnt}</div></div>
  <div class="stat-card" style="margin-left:auto"><div class="label">Generated</div><div class="value" style="font-size:.8rem;color:var(--t2)">${esc(generatedAt)}</div></div>
</div>

${alertSystem.bannerHtml}
${alertSystem.modalHtml}

<div id="dr-overlay">
  <div id="dr-modal">
    <div class="dr-header">
      <div><div class="dr-title" id="dr-title">Deep Research</div><div class="dr-subtitle" id="dr-subtitle"></div></div>
      <button id="dr-close">&#x2715;</button>
    </div>
    <div id="dr-content"></div>
  </div>
</div>

<div class="controls">
  <div class="filter-group">
    <span class="fg-label">Filter</span>
    <button class="btn filter-btn active" data-filter="all">All</button>
    <button class="btn filter-btn" data-filter="stage2">Stage 2</button>
    <button class="btn filter-btn" data-filter="vcp">Full VCP</button>
    <button class="btn filter-btn" data-filter="vol">Vol Dry-Up</button>
    <button class="btn filter-btn" data-filter="surge">&#x1F30A; Surge</button>
    <button class="btn filter-btn" data-filter="prime">&#x1F525; Prime</button>
    <button class="btn filter-btn" data-filter="rs80">&#x2B50; RS&#x2265;80</button>
    <button class="btn filter-btn" data-filter="watchlist">&#x2605; My WL</button>
  </div>
  <input type="text" class="search" id="search" placeholder="Search ticker or name...">
  <select id="sort-select" class="search sort-select">
    <option value="score:desc">Sort: VCP Score (best)</option>
    <option value="rs:desc">Sort: RS Rating (best)</option>
    <option value="price:asc">Sort: Price (low-high)</option>
    <option value="pivot:asc">Sort: Closest to Pivot</option>
    <option value="vol:asc">Sort: Vol Dry-Up (lowest %)</option>
  </select>
</div>

<div class="table-container">
  <table id="main-table">
    <thead><tr>
      <th data-col="name">Stock <span class="arrow">&#x21C5;</span></th>
      <th data-col="price">Price <span class="arrow">&#x21C5;</span></th>
      <th data-col="score" class="sorted" data-tip="Composite score 0-100: Stage 2 trend (48pts) + Volatility Contraction pattern (30pts) + Volume Dry-Up (22pts). Prime >= 85, Developing >= 65, Partial >= 40.">VCP Score <span class="arrow">&#x2193;</span> <span class="tip-icon">?</span></th>
      <th data-col="rs" data-tip="Relative Strength Rating 1-99 (IBD-style): percentile rank of weighted 12-month price performance vs all NSE stocks in this scan. RS >= 80 = top 20% performers. Strong breakout stocks usually have RS >= 80 before they break out.">RS Rating <span class="arrow">&#x21C5;</span> <span class="tip-icon">?</span></th>
      <th data-tip="Minervini Stage 2 uptrend: Trend = above SMA50/150/200. MA Stack = SMA50 > 150 > 200. Near High = within 25% of 52W high. 200-Up = SMA200 rising. Need 5 of 6 checks for confirmed Stage 2.">Stage 2 Checks <span class="tip-icon">?</span></th>
      <th data-tip="Volatility Contraction Pattern (Minervini): Progressive Pullback = each 20-bar drawdown is smaller than the last. Tight Right Side = final 5 bars have 25% narrower range than the prior 15 (base completing on low volatility).">VCP Pattern <span class="tip-icon">?</span></th>
      <th data-col="vol" data-tip="Volume vs 50-day average. Surge = yesterday vol >1.5x avg AND above pivot (high-volume breakout). Dry-Up = 5-day avg &lt;70% of 50-day (base forming quietly - bullish). Normal = no signal yet.">Volume <span class="arrow">&#x21C5;</span> <span class="tip-icon">?</span></th>
      <th data-col="pivot" data-tip="Pivot = 10-day highest high, the breakout trigger price. Ideal buy is within 5% above pivot on heavy volume. Shows how close the stock is to its breakout point.">Pivot <span class="arrow">&#x21C5;</span> <span class="tip-icon">?</span></th>
      <th data-tip="52-Week context. Off high = distance from 52W peak (lower is better for Stage 2). Off low = gain from 52W trough.">52W Range <span class="tip-icon">?</span></th>
    </tr></thead>
    <tbody id="table-body">${tableRows}</tbody>
  </table>
  <div id="no-results">No stocks match the current filter.</div>
</div>

<div id="cards-container">${cardRows}</div>

<div class="footer">
  Breakout Scanner Gen2 &middot; NSE Quality Universe &middot; RS Rating = IBD-style percentile rank within analyzed universe
  &middot; Volume Surge = yesterday vol &gt;1.5&times; 50-day avg above pivot
  <br>Generated ${esc(generatedAt)} IST &nbsp;&middot;&nbsp; Not financial advice. Always do your own research.
</div>
<script>
(function(){
  var toggle=document.getElementById('theme-toggle');
  var label=document.getElementById('theme-label');
  function applyTheme(t){document.documentElement.setAttribute('data-theme',t);if(label)label.textContent=t==='dark'?'Dark':'Light';localStorage.setItem('creamy-theme',t);}
  if(toggle)toggle.addEventListener('click',function(){applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');});
  applyTheme(document.documentElement.getAttribute('data-theme')||'dark');

  var activeFilter='all', searchTerm='';
  function rowVisible(el){
    if(activeFilter==='stage2'    && el.dataset.stage!=='1')         return false;
    if(activeFilter==='vcp'       && el.dataset.vcp!=='1')           return false;
    if(activeFilter==='vol'       && el.dataset.vol!=='1')           return false;
    if(activeFilter==='surge'     && el.dataset.surge!=='1')         return false;
    if(activeFilter==='prime'     && el.dataset.prime!=='1')         return false;
    if(activeFilter==='rs80'      && (+el.dataset.rs||0)<80)         return false;
    if(activeFilter==='watchlist' && el.dataset.wl!=='1')            return false;
    if(searchTerm){var q=searchTerm.toLowerCase();if(!el.dataset.name.includes(q)&&!el.dataset.ticker.includes(q))return false;}
    return true;
  }
  function applyFilters(){
    var rows=document.querySelectorAll('#table-body tr');
    var cards=document.querySelectorAll('#cards-container .stock-card');
    var visible=0;
    rows.forEach(function(r){var v=rowVisible(r);r.classList.toggle('hidden',!v);if(v)visible++;});
    cards.forEach(function(c){c.classList.toggle('hidden',!rowVisible(c));});
    document.getElementById('no-results').style.display=visible===0?'block':'none';
  }
  document.querySelectorAll('.filter-btn').forEach(function(btn){
    btn.addEventListener('click',function(){
      document.querySelectorAll('.filter-btn').forEach(function(b){b.classList.remove('active');});
      btn.classList.add('active');activeFilter=btn.dataset.filter;applyFilters();
    });
  });
  var searchEl=document.getElementById('search');
  if(searchEl)searchEl.addEventListener('input',function(){searchTerm=this.value.trim();applyFilters();});

  var sortCol='score', sortDir=-1;
  var tbody=document.getElementById('table-body');
  function sortTable(col,dir){
    var rows=Array.from(tbody.querySelectorAll('tr'));
    rows.sort(function(a,b){
      var av,bv;
      if(col==='score') {av=+a.dataset.score;bv=+b.dataset.score;}
      else if(col==='rs')    {av=+a.dataset.rs||0;bv=+b.dataset.rs||0;}
      else if(col==='name')  {av=a.dataset.name;bv=b.dataset.name;return dir*(av<bv?-1:av>bv?1:0);}
      else if(col==='price') {av=+a.querySelector('td:nth-child(2)').textContent.replace(/[^\d.]/g,'');bv=+b.querySelector('td:nth-child(2)').textContent.replace(/[^\d.]/g,'');}
      else if(col==='vol')   {av=+a.querySelector('td:nth-child(7)').textContent.replace(/[^\d.]/g,'')||999;bv=+b.querySelector('td:nth-child(7)').textContent.replace(/[^\d.]/g,'')||999;}
      else if(col==='pivot') {av=+a.querySelector('td:nth-child(8) .pivot-pct').textContent.replace(/[^\d.]/g,'')||999;bv=+b.querySelector('td:nth-child(8) .pivot-pct').textContent.replace(/[^\d.]/g,'')||999;}
      else{return 0;}
      return dir*(av-bv);
    });
    rows.forEach(function(r){tbody.appendChild(r);});
  }
  document.querySelectorAll('th[data-col]').forEach(function(th){
    th.addEventListener('click',function(){
      var col=th.dataset.col;
      if(sortCol===col)sortDir=-sortDir;else{sortCol=col;sortDir=-1;}
      document.querySelectorAll('th').forEach(function(t){t.classList.remove('sorted');t.querySelector('.arrow')&&(t.querySelector('.arrow').textContent='\u21C5');});
      th.classList.add('sorted');th.querySelector('.arrow').textContent=sortDir===-1?'\u2193':'\u2191';
      sortTable(sortCol,sortDir);
    });
  });
  var sortSel=document.getElementById('sort-select');
  if(sortSel)sortSel.addEventListener('change',function(){
    var parts=this.value.split(':');sortCol=parts[0];sortDir=parts[1]==='desc'?-1:1;
    sortTable(sortCol,sortDir);
  });
})();

window._GH_ALERTS_REPO='amitiyer99/watchlist-app';
${alertSystem.js}// ─────── Deep Research AI ───────
(function(){
  var DR_PROV_KEY='dr_provider';
  var DR_PROVIDERS={groq:{label:'Groq (Llama/Mixtral) \u2014 30 req/min free \u2605',keyName:'dr_groq_key',keyPlaceholder:'Paste Groq API key (console.groq.com)',keyLink:'https://console.groq.com/keys',keyLinkLabel:'console.groq.com',models:[{id:'llama-3.3-70b-versatile',label:'Llama 3.3 70B \u2014 best quality'},{id:'llama3-8b-8192',label:'Llama 3 8B \u2014 fastest'},{id:'mixtral-8x7b-32768',label:'Mixtral 8x7B'}]},openrouter:{label:'OpenRouter \u2014 free tier models',keyName:'dr_openrouter_key',keyPlaceholder:'Paste OpenRouter API key (openrouter.ai/keys)',keyLink:'https://openrouter.ai/keys',keyLinkLabel:'openrouter.ai',models:[{id:'meta-llama/llama-3.1-8b-instruct:free',label:'Llama 3.1 8B (free)'},{id:'mistralai/mistral-7b-instruct:free',label:'Mistral 7B (free)'},{id:'google/gemma-3-27b-it:free',label:'Gemma 3 27B (free)'}]},gemini:{label:'Google Gemini',keyName:'dr_gemini_key',keyPlaceholder:'Paste Gemini API key (aistudio.google.com)',keyLink:'https://aistudio.google.com/app/apikey',keyLinkLabel:'aistudio.google.com',models:[{id:'gemini-2.0-flash-lite',label:'Gemini 2.0 Flash Lite \u2014 30 req/min'},{id:'gemini-2.0-flash',label:'Gemini 2.0 Flash \u2014 15 req/min'},{id:'gemini-1.5-flash-8b',label:'Gemini 1.5 Flash 8B'}]}};
  var DR_STOCKS=${drStocksJson};
  var drCur=null;
  document.addEventListener('click',function(e){
    var btn=e.target.closest('.research-btn');if(!btn)return;e.stopPropagation();
    var ticker=btn.dataset.rTicker;
    var s=DR_STOCKS.find(function(x){return x.ticker===ticker;});if(!s)return;
    drCur=s;
    document.getElementById('dr-title').textContent=s.name;
    document.getElementById('dr-subtitle').textContent=s.ticker+' \u00b7 NSE India \u00b7 VCP: '+s.totalScore+' \u00b7 RS: '+s.rsRating+(s.inWatchlist?' \u00b7 \u2605 WL':'');
    document.getElementById('dr-content').innerHTML=buildDrContent(s);
    document.getElementById('dr-overlay').style.display='block';document.body.style.overflow='hidden';
    var sp=localStorage.getItem(DR_PROV_KEY)||'groq';var psel=document.getElementById('dr-provider-select');if(psel)psel.value=sp;
    drChangeProvider();
    var sprov=DR_PROVIDERS[sp];var key=sprov?localStorage.getItem(sprov.keyName):null;
    if(key){var inp=document.getElementById('dr-key-input');if(inp)inp.value='\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';var msel=document.getElementById('dr-model-select');runAIAnalysis(s,key,sp,msel?msel.value:null);}
  });
  document.getElementById('dr-close').addEventListener('click',closeDr);
  document.getElementById('dr-overlay').addEventListener('click',function(e){if(e.target===document.getElementById('dr-overlay'))closeDr();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDr();});
  function closeDr(){document.getElementById('dr-overlay').style.display='none';document.body.style.overflow='';}
  window.drRunWithKey=function(){
    var inp=document.getElementById('dr-key-input');if(!inp)return;
    var psel=document.getElementById('dr-provider-select');var pid=(psel&&psel.value)||localStorage.getItem(DR_PROV_KEY)||'groq';var prov=DR_PROVIDERS[pid]||DR_PROVIDERS.groq;
    var typedKey=inp.value.trim().replace(/[^\x20-\x7E]/g,'');
    var key=typedKey||localStorage.getItem(prov.keyName)||'';
    if(!key){inp.focus();return;}
    localStorage.setItem(DR_PROV_KEY,pid);localStorage.setItem(prov.keyName,key);inp.value='\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    var msel=document.getElementById('dr-model-select');var model=msel?msel.value:prov.models[0].id;
    if(drCur)runAIAnalysis(drCur,key,pid,model);
  };
  window.drChangeProvider=function(){
    var psel=document.getElementById('dr-provider-select');var msel=document.getElementById('dr-model-select');var inp=document.getElementById('dr-key-input');var link=document.getElementById('dr-key-link');
    if(!psel)return;var prov=DR_PROVIDERS[psel.value];if(!prov)return;
    if(msel){msel.innerHTML=prov.models.map(function(m){return'<option value="'+m.id+'">'+m.label+'</option>';}).join('');var sm=localStorage.getItem('dr_model.'+psel.value);if(sm)msel.value=sm;}
    var sk=localStorage.getItem(prov.keyName);if(inp){inp.value=sk?'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022':'';inp.placeholder=prov.keyPlaceholder;}
    if(link){link.href=prov.keyLink;link.textContent=prov.keyLinkLabel;}
  };
  function buildDrContent(s){
    var signals=[];
    if(s.stage2)signals.push({type:'bull',icon:'\u25b2',text:'Stage 2 confirmed \u2014 price above all key moving averages with upward trend.'});
    if(s.vcpPass)signals.push({type:'bull',icon:'\u25b2',text:'VCP pattern detected \u2014 volatility contraction with progressive pullbacks.'});
    if(s.volSurgeConfirmed)signals.push({type:'bull',icon:'\ud83c\udf0a',text:'Volume SURGE: '+s.volSurgePct+'% of 50-day avg \u2014 high-volume breakout signal!'});
    else if(s.volDryUp)signals.push({type:'bull',icon:'\u25b2',text:'Volume dry-up: '+s.volPct+'% of average \u2014 base forming on light volume.'});
    if(s.rsRating>=80)signals.push({type:'bull',icon:'\u2b50',text:'RS Rating '+s.rsRating+' \u2014 top '+(100-s.rsRating)+'% relative strength. IBD-style leaders tend to score RS 80+.'});
    else if(s.rsRating>=60)signals.push({type:'neut',icon:'\u25c6',text:'RS Rating '+s.rsRating+' \u2014 above-average relative strength vs NSE universe.'});
    else signals.push({type:'neut',icon:'\u25c6',text:'RS Rating '+s.rsRating+' \u2014 below-average price strength. Wait for RS improvement before committing.'});
    var pivotPct=s.price&&s.pivot?((s.price-s.pivot)/s.pivot*100):null;
    if(pivotPct!=null&&pivotPct<3&&pivotPct>=-5)signals.push({type:'bull',icon:'\u25b2',text:'Near pivot: '+(pivotPct>=0?'+':'')+pivotPct.toFixed(1)+'% from \u20b9'+s.pivot.toFixed(2)+' \u2014 ideal entry zone.'});
    if(!signals.length)signals.push({type:'neut',icon:'\u25c6',text:'Partial setup \u2014 monitor for confirmation.'});
    var awayHigh=s.high52&&s.price?((s.high52-s.price)/s.high52*100).toFixed(1)+'% off high':'\u2014';
    function dm(lbl,val,sub,cls){return'<div class="dr-metric"><div class="dm-label">'+lbl+'</div><div class="dm-val'+(cls?' '+cls:'')+'">'+(val||'\u2014')+'</div>'+(sub?'<div class="dm-sub">'+sub+'</div>':'')+'</div>';}
    var html='<div class="dr-section"><div class="dr-section-title">\ud83d\udcca Price &amp; Setup</div><div class="dr-grid">'
      +dm('Current Price',s.price?'\u20b9'+s.price.toFixed(2):'\u2014','','')
      +dm('VCP Score',s.totalScore+'/100',s.stage2?'Stage 2 \u2713':'Stage 2 \u2717',s.totalScore>=65?'pos':s.totalScore>=40?'':'neg')
      +dm('RS Rating',s.rsRating+' / 99',s.rsRating>=80?'Top '+(100-s.rsRating)+'% strength':'RS in universe',s.rsRating>=80?'pos':s.rsRating>=60?'':'')
      +dm('Pivot',s.pivot?'\u20b9'+s.pivot.toFixed(2):'\u2014',pivotPct!=null?(pivotPct>=0?'+':'')+pivotPct.toFixed(1)+'%':'',pivotPct!=null&&pivotPct<3?'pos':'')
      +dm('Volume',s.volSurgeConfirmed?'\ud83c\udf0a Surge '+s.volSurgePct+'%':s.volDryUp?'Dry-Up '+s.volPct+'%':'Normal '+s.volPct+'%',s.volSurgeConfirmed?'Breakout signal':'',s.volSurgeConfirmed?'pos':s.volDryUp?'pos':'')
      +dm('Pattern',s.vcpPass?'VCP \u2713':'Partial',s.stage2?'Stage 2':'',s.vcpPass?'pos':'')
      +'</div></div>';
    html+='<div class="dr-section"><div class="dr-section-title">\ud83d\udcc8 Breakout Signals</div>';
    for(var i=0;i<signals.length;i++)html+='<div class="dr-signal '+signals[i].type+'"><span class="ds-icon">'+signals[i].icon+'</span><span>'+signals[i].text+'</span></div>';
    html+='</div>';
    html+='<div class="dr-section"><div class="dr-section-title">\ud83e\udde0 AI Deep Analysis</div>'
      +'<div id="dr-ai-box" class="dr-ai-box loading">Enter your API key below for AI-powered VCP analysis \u2014 setup quality, entry zone, catalyst &amp; verdict.</div>'
      +'<div id="dr-ai-error" class="dr-ai-error" style="display:none"></div>'
      +'<div style="margin-bottom:6px"><select id="dr-provider-select" onchange="drChangeProvider()" style="width:100%;background:var(--s3);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;font-size:.78rem;cursor:pointer">'
      +Object.keys(DR_PROVIDERS).map(function(k){return'<option value="'+k+'">'+DR_PROVIDERS[k].label+'</option>';}).join('')
      +'</select></div>'
      +'<div style="margin-bottom:6px"><select id="dr-model-select" style="width:100%;background:var(--s3);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;font-size:.78rem;cursor:pointer"></select></div>'
      +'<div class="dr-ai-key-row"><input type="password" class="dr-ai-key-input" id="dr-key-input" placeholder="Paste API key"><button class="dr-ai-key-btn" onclick="drRunWithKey()">Analyse \u2726</button></div>'
      +'<div style="font-size:.62rem;color:var(--t3);margin-top:5px">Get free key at <a id="dr-key-link" href="https://console.groq.com/keys" target="_blank" rel="noopener" style="color:var(--ac)">console.groq.com</a> \u00b7 Stored only in your browser</div>'
      +'</div>';
    return html;
  }
  function runAIAnalysis(s,apiKey,provId,model){
    var prov=DR_PROVIDERS[provId]||DR_PROVIDERS.groq;
    if(!model)model=prov.models[0].id;
    localStorage.setItem('dr_model.'+provId,model);
    var box=document.getElementById('dr-ai-box'),errEl=document.getElementById('dr-ai-error');
    if(!box)return;
    box.className='dr-ai-box loading';box.textContent='\u23f3 Analysing '+s.name+'\u2026';errEl.style.display='none';
    var prompt='You are a professional Indian stock market analyst specialising in Minervini VCP breakout setups.\\n\\n'
      +'STOCK: '+s.name+' ('+s.ticker+') | NSE India | Sector: '+(s.sector||'N/A')+'\\n\\n'
      +'TECHNICAL DATA:\\n'
      +'- Price: \\u20b9'+(s.price?s.price.toFixed(2):'N/A')+'\\n'
      +'- VCP Score: '+s.totalScore+'/100\\n'
      +'- RS Rating: '+s.rsRating+'/99 (IBD-style percentile within NSE universe)\\n'
      +'- Stage 2 Uptrend: '+(s.stage2?'YES':'NO')+'\\n'
      +'- VCP Pattern: '+(s.vcpPass?'YES':'Partial')+'\\n'
      +'- Volume: '+(s.volSurgeConfirmed?'SURGE '+s.volSurgePct+'% of avg (breakout!)':s.volDryUp?'Dry-Up '+s.volPct+'%':'Normal '+s.volPct+'%')+'\\n'
      +'- Pivot: \\u20b9'+(s.pivot?s.pivot.toFixed(2):'N/A')+'\\n'
      +'- 52W High: \\u20b9'+(s.high52?s.high52.toFixed(2):'N/A')+'\\n\\n'
      +'Write a concise breakout research note:\\n\\n'
      +'**TECHNICAL OUTLOOK**\\nDescribe VCP setup quality, Stage 2 status, and RS rating significance.\\n\\n'
      +'**ENTRY & RISK**\\nOptimal entry zone, stop-loss level, and position sizing guidance.\\n\\n'
      +'**FUNDAMENTAL VIEW**\\nBrief view on business quality for '+s.name+' and sector tailwinds.\\n\\n'
      +'**KEY RISKS**\\nTop 2 risks that could invalidate this setup.\\n\\n'
      +'**VERDICT**: [ACTIONABLE / WATCHLIST / AVOID] \\u2014 [one sentence]';
    apiKey=String(apiKey).replace(/[^\\x20-\\x7E]/g,'');
    if(!apiKey){box.className='dr-ai-box';errEl.style.display='block';errEl.textContent='\u26a0\ufe0f Invalid API key.';return;}
    var fUrl,fBody,fH={'Content-Type':'application/json'};
    if(provId==='gemini'){fUrl='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(apiKey);fBody=JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.65,maxOutputTokens:1024}});}
    else if(provId==='openrouter'){fUrl='https://openrouter.ai/api/v1/chat/completions';fH['Authorization']='Bearer '+apiKey;fH['HTTP-Referer']='https://amitiyer99.github.io/watchlist-app/';fBody=JSON.stringify({model:model,messages:[{role:'user',content:prompt}],temperature:0.65,max_tokens:1024});}
    else{fUrl='https://api.groq.com/openai/v1/chat/completions';fH['Authorization']='Bearer '+apiKey;fBody=JSON.stringify({model:model,messages:[{role:'user',content:prompt}],temperature:0.65,max_tokens:1024});}
    fetch(fUrl,{method:'POST',headers:fH,body:fBody})
    .then(function(r){if(!r.ok)return r.json().then(function(e){throw new Error((e.error&&(e.error.message||JSON.stringify(e.error)))||'API error '+r.status);});return r.json();})
    .then(function(data){
      var text=provId==='gemini'?(data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts&&data.candidates[0].content.parts[0]&&data.candidates[0].content.parts[0].text):(data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content);
      if(!text)throw new Error('Empty response');
      box.className='dr-ai-box';
      box.innerHTML=text.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong style="color:var(--ac);display:block;margin-top:12px;margin-bottom:4px">$1</strong>').replace(/\\n\\n/g,'</p><p style="margin:4px 0">').replace(/\\n/g,'<br>').replace(/^/,'<p style="margin:0">').replace(/$/,'</p>');
    }).catch(function(err){box.className='dr-ai-box';box.innerHTML='<span style="opacity:.5">Could not generate analysis.</span>';errEl.style.display='block';errEl.textContent='\u26a0\ufe0f '+err.message;});
  }
})();
// ─────── Column header tooltips ───────
(function(){
  var tip=document.createElement('div');tip.className='tt';document.body.appendChild(tip);
  function show(el){var txt=el.getAttribute('data-tip');if(!txt)return;tip.textContent=txt;tip.classList.add('tt-vis');var r=el.getBoundingClientRect();tip.style.top=(r.bottom+6)+'px';var left=r.left+r.width/2-110;left=Math.max(8,Math.min(left,window.innerWidth-228));tip.style.left=left+'px';}
  function hide(){tip.classList.remove('tt-vis');}
  document.querySelectorAll('th[data-tip]').forEach(function(th){th.addEventListener('mouseenter',function(){show(th);});th.addEventListener('mouseleave',hide);});
})();
<\/script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('Step 1: Loading watchlist stocks...');
  const watchlistStocks = loadWatchlistStocks();
  console.log(`  ${watchlistStocks.length} watchlist stocks loaded`);

  console.log('Step 2: Fetching NSE quality universe from Tickertape screener...');
  const screenerStocks = await fetchScreenerUniverse();

  // Merge — watchlist entries take priority (preserve stockUrl, inWatchlist flag)
  const allStocksMap = new Map();
  for (const s of watchlistStocks) allStocksMap.set(s.ticker, s);
  for (const s of screenerStocks) { if (!allStocksMap.has(s.ticker)) allStocksMap.set(s.ticker, s); }
  const allStocks = Array.from(allStocksMap.values());
  console.log(`  Total: ${allStocks.length} unique stocks (${watchlistStocks.length} WL + ${allStocks.length - watchlistStocks.length} screener)`);

  console.log('Step 3: Fetching OHLCV history and running analysis...');
  const results = await buildResults(allStocks);

  console.log('Step 4: Computing RS Ratings across full universe...');
  const rsRanks = computeRSRatings(results);
  results.forEach(r => { r.rsRating = rsRanks[r.ticker] || 50; });

  // Sort: VCP score desc, RS desc as tiebreaker
  results.sort((a, b) => b.totalScore !== a.totalScore ? b.totalScore - a.totalScore : b.rsRating - a.rsRating);

  const surgeCnt  = results.filter(r => r.volSurgeConfirmed).length;
  const primeCnt  = results.filter(r => r.totalScore >= 85).length;
  const fullSetup = results.filter(r => r.stage2Pass && r.vcpPass && r.volDryUp).length;
  const rs80Cnt   = results.filter(r => r.rsRating >= 80).length;
  console.log(`\nSummary: ${results.length} stocks | ${fullSetup} full setups | ${primeCnt} Prime | ${surgeCnt} Surge | ${rs80Cnt} RS>=80`);

  const generatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  if (!require('fs').existsSync(require('path').join(__dirname, 'docs'))) require('fs').mkdirSync(require('path').join(__dirname, 'docs'));
  require('fs').writeFileSync(OUTPUT_PATH, buildHtml(results, generatedAt), 'utf8');
  console.log(`Saved to ${OUTPUT_PATH}`);

  // Write compact sidecar JSON for cross-referencing with Creamy Layer page
  const sidecar = results
    .filter(r => r.totalScore >= 40)
    .map(r => ({ ticker: r.ticker, score: r.totalScore, stage2: r.stage2Pass || false, vcpPass: r.vcpPass || false, rsRating: r.rsRating || 50 }));
  require('fs').writeFileSync(require('path').join(__dirname, 'docs', 'breakout2-data.json'), JSON.stringify(sidecar));
  console.log(`  Sidecar: ${sidecar.length} stocks (score>=40) → docs/breakout2-data.json`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
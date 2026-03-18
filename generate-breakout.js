'use strict';

const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
const alertSystem = require('./alert-system');

const WATCHLIST_PATH = path.join(__dirname, 'my-watchlists.json');
const OUTPUT_PATH = path.join(__dirname, 'docs', 'breakout.html');
const BATCH_SIZE = 10;
const HISTORY_DAYS = 295; // ~295 calendar days ≈ 200+ trading bars (needed for SMA200)

// ── Helpers ─────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sma(closes, n) {
  const slice = closes.slice(-n);
  if (slice.length < n) return null;
  return avg(slice);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: Extract tickers from my-watchlists.json ─────────────────

function loadTickers() {
  const watchlists = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
  const seen = new Set();
  const stocks = [];
  for (const wl of watchlists) {
    for (const period of Object.values(wl.periods || {})) {
      for (const s of (period.stocks || [])) {
        const parts = (s.name || '').split('\n');
        const ticker = (parts[1] || '').trim();
        const name = (parts[0] || '').trim();
        if (!ticker || seen.has(ticker)) continue;
        seen.add(ticker);
        stocks.push({ ticker, name, stockUrl: s.stockUrl || '' });
      }
    }
  }
  return stocks;
}

// ── Step 2: Fetch OHLCV history from Yahoo Finance ──────────────────

async function fetchHistory(ticker) {
  const period1 = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const period2 = new Date(Date.now() - 24 * 60 * 60 * 1000); // yesterday — avoids today's null-close intraday bar
  try {
    const rows = await yahooFinance.historical(ticker + '.NS', { period1, period2, interval: '1d' });
    if (!rows || rows.length < 60) return null;
    return rows
      .filter(r => r.close != null && r.volume != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch {
    return null;
  }
}

// ── Step 3: Analyse a stock — returns signal object ─────────────────

function analyzeStock(bars) {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);

  const price = closes[closes.length - 1];
  const n = closes.length;

  // SMAs
  const s50 = sma(closes, 50);
  const s150 = sma(closes, 150);
  const s200 = sma(closes, 200);
  // 200 SMA 20 bars ago — use bars[n-220..n-20] if enough data
  const s200_20ago = n >= 220
    ? avg(closes.slice(n - 220, n - 20))
    : (n >= 170 ? avg(closes.slice(0, n - 20)) : null);

  // 52-week hi/low (last ~252 bars, but we only have ~160, so use what we have)
  const high52 = Math.max(...highs);
  const low52 = Math.min(...lows);

  // ── Stage 2 checks (8 pts each, max 48) ──
  const stageChecks = {
    aboveSma50:  s50  != null && price > s50,
    aboveSma150: s150 != null && price > s150,
    aboveSma200: s200 != null && price > s200,
    maStacked:   s50 != null && s150 != null && s200 != null && s50 > s150 && s150 > s200,
    sma200Up:    s200 != null && s200_20ago != null && s200 > s200_20ago,
    nearHigh:    price >= high52 * 0.75,
  };
  const aboveLow30 = price >= low52 * 1.30; // bonus flag only
  const stageScore = Object.values(stageChecks).filter(Boolean).length * 8;
  const stage2Pass = Object.values(stageChecks).filter(Boolean).length >= 5;

  // ── Volatility Contraction checks (15 pts each, max 30) ──
  // 1. Progressive pullback: 3 windows of 20 bars over last 60 bars
  let progressivePullback = false;
  if (n >= 60) {
    const w1 = bars.slice(n - 60, n - 40);
    const w2 = bars.slice(n - 40, n - 20);
    const w3 = bars.slice(n - 20, n);
    const dd = w => {
      const wHigh = Math.max(...w.map(b => b.high));
      const wLow  = Math.min(...w.map(b => b.low));
      return (wHigh - wLow) / wHigh;
    };
    progressivePullback = dd(w1) > dd(w2) && dd(w2) > dd(w3);
  }

  // 2. Tight right side: avg daily range last 5 bars < 75% of avg for bars[-20..-5]
  let tightRightSide = false;
  if (n >= 20) {
    const range5  = bars.slice(n - 5, n).map(b => (b.high - b.low) / b.close);
    const range15 = bars.slice(n - 20, n - 5).map(b => (b.high - b.low) / b.close);
    tightRightSide = avg(range5) < avg(range15) * 0.75;
  }

  const vcpScore_raw = (progressivePullback ? 15 : 0) + (tightRightSide ? 15 : 0);
  const vcpPass = progressivePullback || tightRightSide; // either contraction signal qualifies

  // ── Volume Dry-Up (22 pts) ──
  const vol5  = n >= 5  ? avg(volumes.slice(n - 5,  n))  : null;
  const vol50 = n >= 50 ? avg(volumes.slice(n - 50, n)) : null;
  const volDryUp = vol5 != null && vol50 != null && vol5 < vol50 * 0.70;
  const volPct   = vol5 != null && vol50 != null ? Math.round((vol5 / vol50) * 100) : null;
  const volScore = volDryUp ? 22 : 0;

  // ── Total score (max 100) ──
  const totalScore = stageScore + vcpScore_raw + volScore;

  // ── Pivot point ──
  const pivot = n >= 10 ? Math.max(...highs.slice(n - 10)) : Math.max(...highs);
  const pctBelowPivot = ((pivot - price) / pivot) * 100;

  // ── Score tag ──
  let tag, tagClass;
  if (totalScore >= 85)      { tag = '🔥 Prime';      tagClass = 'prime'; }
  else if (totalScore >= 65) { tag = '✅ Developing';  tagClass = 'developing'; }
  else if (totalScore >= 40) { tag = '🔶 Partial';    tagClass = 'partial'; }
  else                       { tag = '⬜ Not Ready';   tagClass = 'notready'; }

  return {
    price,
    s50, s150, s200,
    high52, low52, aboveLow30,
    stageChecks, stageScore, stage2Pass,
    progressivePullback, tightRightSide, vcpPass,
    vol5: vol5 ? Math.round(vol5) : null,
    vol50: vol50 ? Math.round(vol50) : null,
    volDryUp, volPct,
    totalScore, tag, tagClass,
    pivot, pctBelowPivot,
  };
}

// ── Step 4: Build stock result list ─────────────────────────────────

async function buildResults(stocks) {
  const results = [];
  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = stocks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async s => {
      const bars = await fetchHistory(s.ticker);
      if (!bars) return null;
      const analysis = analyzeStock(bars);
      return { ...s, ...analysis };
    }));
    for (const r of batchResults) { if (r) results.push(r); }
    process.stdout.write(`  Analyzed ${Math.min(i + BATCH_SIZE, stocks.length)}/${stocks.length} stocks\r`);
    if (i + BATCH_SIZE < stocks.length) await sleep(200);
  }
  console.log(`  Analyzed ${results.length}/${stocks.length} stocks (${stocks.length - results.length} skipped — insufficient history)`);
  results.sort((a, b) => b.totalScore - a.totalScore);
  return results;
}

// ── Step 5: Render HTML ──────────────────────────────────────────────

function checkBadge(pass, label) {
  if (pass) return `<span class="chk chk-pass">${esc(label)} ✓</span>`;
  return `<span class="chk chk-fail">${esc(label)} ✗</span>`;
}

function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(dec);
}

function fmtPrice(p) {
  if (p == null) return '—';
  return '₹' + Number(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ringClass(score) {
  if (score >= 65) return 's-high';
  if (score >= 40) return 's-med';
  return 's-low';
}

function buildTableRow(r) {
  const ttUrl = r.stockUrl || `https://www.tickertape.in/stocks/${r.name.replace(/\s+/g, '-').toLowerCase()}-${r.ticker}`;
  const volStr = r.volPct != null ? `${r.volPct}% of avg` : '—';
  const pivotStr = r.pctBelowPivot != null ? `${fmt(r.pctBelowPivot, 1)}% below` : '—';
  const awayHigh = r.high52 ? fmt(((r.high52 - r.price) / r.high52) * 100, 1) + '%' : '—';
  const awayLow  = r.low52  ? fmt(((r.price - r.low52) / r.low52) * 100, 1) + '%' : '—';

  return `<tr
    data-score="${r.totalScore}"
    data-stage="${r.stage2Pass ? '1' : '0'}"
    data-vcp="${r.vcpPass ? '1' : '0'}"
    data-vol="${r.volDryUp ? '1' : '0'}"
    data-prime="${r.totalScore >= 85 ? '1' : '0'}"
    data-name="${esc(r.name.toLowerCase())}"
    data-ticker="${esc(r.ticker.toLowerCase())}">
    <td>
      <div class="stock-name">
        <a href="${esc(ttUrl)}" target="_blank" rel="noopener">${esc(r.name)}</a>
        <div class="ticker">${esc(r.ticker)}</div>
      </div>
      <button class="alert-btn" data-alert-ticker="${esc(r.ticker)}" data-alert-price="${r.price||0}" data-alert-name="${esc(r.name)}">&#x1F514;</button>
    </td>
    <td class="num">${fmtPrice(r.price)}</td>
    <td>
      <div class="bo-score">
        <span class="bo-ring ${ringClass(r.totalScore)}">${r.totalScore}</span>
        <span class="tag-vcp tag-vcp-${r.tagClass}">${r.tag}</span>
      </div>
    </td>
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
    <td class="${r.volDryUp ? 'pos' : 'dim'}">${volStr}</td>
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

function buildCardRow(r) {
  const ttUrl = r.stockUrl || `https://www.tickertape.in/stocks/${r.name.replace(/\s+/g, '-').toLowerCase()}-${r.ticker}`;
  const volStr = r.volPct != null ? `${r.volPct}% of avg` : '—';
  const awayHigh = r.high52 ? fmt(((r.high52 - r.price) / r.high52) * 100, 1) + '%' : '—';
  return `<div class="stock-card"
    data-score="${r.totalScore}"
    data-stage="${r.stage2Pass ? '1' : '0'}"
    data-vcp="${r.vcpPass ? '1' : '0'}"
    data-vol="${r.volDryUp ? '1' : '0'}"
    data-prime="${r.totalScore >= 85 ? '1' : '0'}"
    data-name="${esc(r.name.toLowerCase())}"
    data-ticker="${esc(r.ticker.toLowerCase())}">
    <div class="card-header">
      <div>
        <div class="card-name"><a href="${esc(ttUrl)}" target="_blank">${esc(r.name)}</a></div>
        <div class="card-ticker">${esc(r.ticker)} <button class="alert-btn" data-alert-ticker="${esc(r.ticker)}" data-alert-price="${r.price||0}" data-alert-name="${esc(r.name)}">&#x1F514;</button></div>
      </div>
      <div class="card-price">
        <div class="price">${fmtPrice(r.price)}</div>
        <div><span class="bo-ring ${ringClass(r.totalScore)}" style="width:32px;height:32px;font-size:.78rem">${r.totalScore}</span></div>
      </div>
    </div>
    <div class="card-row"><span class="card-label">Tag</span><span>${r.tag}</span></div>
    <div class="card-row"><span class="card-label">Stage 2</span><span>
      ${checkBadge(r.stageChecks.aboveSma50 && r.stageChecks.aboveSma150 && r.stageChecks.aboveSma200, 'Trend')}
      ${checkBadge(r.stageChecks.maStacked, 'MA Stack')}
      ${checkBadge(r.stageChecks.nearHigh, 'Near High')}
    </span></div>
    <div class="card-row"><span class="card-label">VCP Pattern</span><span>
      ${checkBadge(r.progressivePullback, 'Pullback')} ${checkBadge(r.tightRightSide, 'Tight')}
    </span></div>
    <div class="card-row"><span class="card-label">Vol Dry-Up</span><span class="${r.volDryUp ? 'pos' : ''}">${volStr}</span></div>
    <div class="card-row"><span class="card-label">Pivot</span><span>${fmtPrice(r.pivot)}</span></div>
    <div class="card-row"><span class="card-label">% off 52W High</span><span>${awayHigh}</span></div>
  </div>`;
}

function buildHtml(results, generatedAt) {
  const total     = results.length;
  const stage2Cnt = results.filter(r => r.stage2Pass).length;
  const vcpCnt    = results.filter(r => r.vcpPass).length;
  const volDryCnt = results.filter(r => r.volDryUp).length;
  const primeCnt  = results.filter(r => r.totalScore >= 85).length;
  const fullSetup = results.filter(r => r.stage2Pass && r.vcpPass && r.volDryUp).length;

  const tableRows = results.map(buildTableRow).join('');
  const cardRows  = results.map(buildCardRow).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Breakout Scanner · VCP - India</title>
<script>
(function(){var s=localStorage.getItem('creamy-theme');var p=s||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',p)})();
</script>
<style>
:root,html[data-theme="dark"]{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--s3:#22222e;--bd:#2a2a38;--ac:#00d4aa;--tx:#e8e8f0;--t2:#9898b0;--t3:#6a6a82;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--hdr-bg:linear-gradient(135deg,#0d1a18,#12121a);--shadow:0 8px 24px rgba(0,0,0,.4);--row-hover:rgba(0,212,170,.04);--card-border:rgba(42,42,56,.4)}
html[data-theme="light"]{--bg:#f8f9fc;--s1:#ffffff;--s2:#ffffff;--s3:#eef0f5;--bd:#d5d8e0;--ac:#0d9e82;--tx:#1e1e32;--t2:#44495e;--t3:#6b7188;--gn:#15803d;--rd:#b91c1c;--yw:#a16207;--bl:#1d4ed8;--hdr-bg:linear-gradient(135deg,#e6f7f4,#eaecf2);--shadow:0 4px 16px rgba(0,0,0,.07);--row-hover:rgba(13,158,130,.03);--card-border:rgba(0,0,0,.08)}
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
.stats-bar{display:flex;gap:12px;padding:16px 28px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap}
.stat-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:12px 18px;min-width:120px}
.stat-card .label{font-size:.7rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.stat-card .value{font-size:1.3rem;font-weight:700}
.stat-card .value.teal{color:var(--ac)}
.stat-card .value.green{color:var(--gn)}
.stat-card .value.blue{color:var(--bl)}
.stat-card .value.yellow{color:var(--yw)}
.stat-card .value.red{color:var(--rd)}
.controls{display:flex;gap:10px;padding:16px 28px;flex-wrap:wrap;align-items:center}
.filter-group{display:flex;gap:4px;align-items:center;border:1px solid var(--bd);border-radius:8px;padding:3px;background:var(--s1)}
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
td{padding:10px 12px;border-bottom:1px solid var(--card-border);white-space:nowrap;vertical-align:middle}
tr:hover td{background:var(--row-hover)}
.stock-name a{color:var(--tx);text-decoration:none;font-weight:600;font-size:.88rem}
.stock-name a:hover{color:var(--ac)}
.stock-name .ticker{color:var(--t2);font-size:.74rem;margin-top:1px}
.num{font-variant-numeric:tabular-nums}
.pos{color:var(--gn)}
.neg{color:var(--rd)}
.dim{color:var(--t3)}
.chk{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600;margin:2px 2px 2px 0;white-space:nowrap}
.chk-pass{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.chk-fail{background:rgba(239,68,68,.07);color:var(--t3);border:1px solid rgba(100,100,120,.2)}
html[data-theme="light"] .chk-pass{background:rgba(21,128,61,.08);color:#15803d;border-color:rgba(21,128,61,.2)}
html[data-theme="light"] .chk-fail{background:rgba(0,0,0,.03);color:#9ca3af;border-color:#e5e7eb}
.bo-ring{width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:.84rem;font-weight:800;border:3px solid;flex-shrink:0}
.bo-ring.s-high{border-color:var(--gn);color:var(--gn);background:rgba(34,197,94,.08)}
.bo-ring.s-med{border-color:var(--yw);color:var(--yw);background:rgba(234,179,8,.06)}
.bo-ring.s-low{border-color:var(--t3);color:var(--t3);background:rgba(90,90,112,.06)}
html[data-theme="light"] .bo-ring.s-high{background:rgba(21,128,61,.08)}
html[data-theme="light"] .bo-ring.s-med{background:rgba(161,98,7,.07)}
html[data-theme="light"] .bo-ring.s-low{background:rgba(107,113,136,.08)}
.bo-score{display:inline-flex;align-items:center;gap:8px}
.tag-vcp{display:inline-block;padding:3px 9px;border-radius:5px;font-size:.7rem;font-weight:700;white-space:nowrap}
.tag-vcp-prime{background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.3)}
.tag-vcp-developing{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.25)}
.tag-vcp-partial{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.25)}
.tag-vcp-notready{background:rgba(100,100,130,.08);color:var(--t3);border:1px solid rgba(100,100,130,.15)}
html[data-theme="light"] .tag-vcp-prime{background:rgba(220,38,38,.07);color:#b91c1c;border-color:rgba(220,38,38,.2)}
html[data-theme="light"] .tag-vcp-developing{background:rgba(21,128,61,.07);color:#15803d;border-color:rgba(21,128,61,.2)}
html[data-theme="light"] .tag-vcp-partial{background:rgba(161,98,7,.07);color:#92400e;border-color:rgba(161,98,7,.18)}
html[data-theme="light"] .tag-vcp-notready{background:rgba(0,0,0,.03);color:#9ca3af;border-color:#e5e7eb}
.pivot-price{font-weight:600;margin-right:4px}
.pivot-pct{font-size:.75rem}
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.76rem;border-top:1px solid var(--bd)}
#no-results{display:none;padding:40px;text-align:center;color:var(--t2)}
.hidden{display:none!important}
/* Cards (mobile) */
#cards-container{display:none;padding:0 14px 24px}
.stock-card{background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:12px}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.card-name{font-weight:600;font-size:.9rem}
.card-name a{color:var(--tx);text-decoration:none}
.card-ticker{color:var(--t2);font-size:.74rem;margin-top:2px}
.card-price .price{font-size:1.1rem;font-weight:700}
.card-row{display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--card-border);font-size:.8rem}
.card-label{color:var(--t2)}
.sort-select{display:none}
@media(max-width:768px){
  .header{padding:14px 16px}
  .header h1{font-size:1.1rem}
  .stats-bar{padding:12px 14px;gap:8px}
  .stat-card{min-width:0;flex:1 1 calc(33% - 8px);padding:10px 12px}
  .stat-card .value{font-size:1.05rem}
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
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>Breakout Scanner · VCP</h1>
    <div class="subtitle">Minervini Stage 2 + Volatility Contraction Pattern + Volume Dry-Up · My Watchlist</div>
  </div>
  <div class="header-right">
    <span class="theme-label" id="theme-label">Dark</span>
    <div class="theme-toggle" id="theme-toggle" title="Toggle theme"></div>
    <a href="creamy.html" class="back-link">Creamy Layer</a>
    <a href="index.html" class="back-link">My Watchlist</a>
  </div>
</div>

<div class="stats-bar">
  <div class="stat-card"><div class="label">Analyzed</div><div class="value teal">${total}</div></div>
  <div class="stat-card"><div class="label">Stage 2</div><div class="value green">${stage2Cnt}</div></div>
  <div class="stat-card"><div class="label">Full Setup</div><div class="value blue">${fullSetup}</div></div>
  <div class="stat-card"><div class="label">Vol Dry-Up</div><div class="value yellow">${volDryCnt}</div></div>
  <div class="stat-card"><div class="label">🔥 Prime</div><div class="value red">${primeCnt}</div></div>
  <div class="stat-card" style="margin-left:auto"><div class="label">Generated</div><div class="value" style="font-size:.85rem;color:var(--t2)">${esc(generatedAt)}</div></div>
</div>

${alertSystem.bannerHtml}
${alertSystem.modalHtml}

<div class="controls">
  <div class="filter-group">
    <span class="fg-label">Filter</span>
    <button class="btn filter-btn active" data-filter="all">All</button>
    <button class="btn filter-btn" data-filter="stage2">Stage 2</button>
    <button class="btn filter-btn" data-filter="vcp">Full VCP</button>
    <button class="btn filter-btn" data-filter="vol">Vol Dry-Up</button>
    <button class="btn filter-btn" data-filter="prime">🔥 Prime</button>
  </div>
  <input type="text" class="search" id="search" placeholder="Search ticker or name...">
  <select id="sort-select" class="search sort-select">
    <option value="score:desc">Sort: VCP Score (best)</option>
    <option value="price:asc">Sort: Price (low-high)</option>
    <option value="pivot:asc">Sort: Closest to Pivot</option>
    <option value="vol:asc">Sort: Vol Dry-Up (lowest %)</option>
  </select>
</div>

<div class="table-container">
  <table id="main-table">
    <thead><tr>
      <th data-col="name">Stock <span class="arrow">↕</span></th>
      <th data-col="price">Price <span class="arrow">↕</span></th>
      <th data-col="score" class="sorted">VCP Score <span class="arrow">↓</span></th>
      <th>Stage 2 Checks</th>
      <th>VCP Pattern</th>
      <th data-col="vol">Vol Dry-Up <span class="arrow">↕</span></th>
      <th data-col="pivot">Pivot <span class="arrow">↕</span></th>
      <th>52W Range</th>
    </tr></thead>
    <tbody id="table-body">${tableRows}</tbody>
  </table>
  <div id="no-results">No stocks match the current filter.</div>
</div>

<div id="cards-container">${cardRows}</div>

<div class="footer">
  Breakout Scanner · VCP Methodology (Minervini / O'Neil) · Data via Yahoo Finance · Generated ${esc(generatedAt)} IST
  <br>Not financial advice. Always do your own research before trading.
</div>

<script>
(function(){
  // Theme toggle
  var toggle = document.getElementById('theme-toggle');
  var label = document.getElementById('theme-label');
  function applyTheme(t){ document.documentElement.setAttribute('data-theme',t); label.textContent = t==='dark'?'Dark':'Light'; localStorage.setItem('creamy-theme',t); }
  toggle.addEventListener('click',function(){ applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark'); });
  applyTheme(document.documentElement.getAttribute('data-theme')||'dark');

  // Filter + search
  var activeFilter = 'all';
  var searchTerm = '';

  function rowVisible(el){
    if (activeFilter === 'stage2' && el.dataset.stage !== '1') return false;
    if (activeFilter === 'vcp'    && (el.dataset.vcp !== '1')) return false;
    if (activeFilter === 'vol'    && el.dataset.vol !== '1')   return false;
    if (activeFilter === 'prime'  && el.dataset.prime !== '1') return false;
    if (searchTerm){
      var q = searchTerm.toLowerCase();
      if (!el.dataset.name.includes(q) && !el.dataset.ticker.includes(q)) return false;
    }
    return true;
  }

  function applyFilters(){
    var rows = document.querySelectorAll('#table-body tr');
    var cards = document.querySelectorAll('#cards-container .stock-card');
    var visible = 0;
    rows.forEach(function(r){ var v = rowVisible(r); r.classList.toggle('hidden', !v); if(v) visible++; });
    cards.forEach(function(c){ c.classList.toggle('hidden', !rowVisible(c)); });
    document.getElementById('no-results').style.display = visible === 0 ? 'block' : 'none';
  }

  document.querySelectorAll('.filter-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.filter-btn').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      applyFilters();
    });
  });

  document.getElementById('search').addEventListener('input', function(){ searchTerm = this.value.trim(); applyFilters(); });

  // Sort (table only)
  var sortCol = 'score', sortDir = -1;
  var tbody = document.getElementById('table-body');

  function sortTable(col, dir){
    var rows = Array.from(tbody.querySelectorAll('tr'));
    rows.sort(function(a, b){
      var av, bv;
      if (col === 'score')  { av = +a.dataset.score; bv = +b.dataset.score; }
      else if (col === 'name')   { av = a.dataset.name; bv = b.dataset.name; return dir * (av < bv ? -1 : av > bv ? 1 : 0); }
      else if (col === 'price')  { av = +a.querySelector('td:nth-child(2)').textContent.replace(/[₹,]/g,''); bv = +b.querySelector('td:nth-child(2)').textContent.replace(/[₹,]/g,''); }
      else if (col === 'vol')    { av = +a.querySelector('td:nth-child(6)').textContent.replace(/[^0-9.]/g,'') || 999; bv = +b.querySelector('td:nth-child(6)').textContent.replace(/[^0-9.]/g,'') || 999; }
      else if (col === 'pivot')  { av = +a.querySelector('td:nth-child(7) .pivot-pct').textContent.replace(/[^0-9.]/g,'') || 999; bv = +b.querySelector('td:nth-child(7) .pivot-pct').textContent.replace(/[^0-9.]/g,'') || 999; }
      else { return 0; }
      return dir * (av - bv);
    });
    rows.forEach(function(r){ tbody.appendChild(r); });
  }

  document.querySelectorAll('th[data-col]').forEach(function(th){
    th.addEventListener('click', function(){
      var col = th.dataset.col;
      if (sortCol === col) sortDir = -sortDir; else { sortCol = col; sortDir = -1; }
      document.querySelectorAll('th').forEach(function(t){ t.classList.remove('sorted'); t.querySelector('.arrow') && (t.querySelector('.arrow').textContent='↕'); });
      th.classList.add('sorted'); th.querySelector('.arrow').textContent = sortDir === -1 ? '↓' : '↑';
      sortTable(sortCol, sortDir);
    });
  });

  // Mobile sort select
  document.getElementById('sort-select').addEventListener('change', function(){
    var parts = this.value.split(':');
    sortCol = parts[0]; sortDir = parts[1] === 'desc' ? -1 : 1;
    sortTable(sortCol, sortDir);
  });

})();
${alertSystem.js}
</script>
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading tickers from my-watchlists.json...');
  const stocks = loadTickers();
  console.log(`Found ${stocks.length} unique tickers.`);

  console.log('Fetching OHLCV history from Yahoo Finance...');
  const results = await buildResults(stocks);

  const primeCnt  = results.filter(r => r.totalScore >= 85).length;
  const fullSetup = results.filter(r => r.stage2Pass && r.vcpPass && r.volDryUp).length;
  console.log(`\nSummary: ${results.length} stocks scored | ${fullSetup} full setups | ${primeCnt} Prime`);

  const generatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  if (!fs.existsSync(path.join(__dirname, 'docs'))) fs.mkdirSync(path.join(__dirname, 'docs'));
  const html = buildHtml(results, generatedAt);
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  console.log(`Saved to ${OUTPUT_PATH}`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });

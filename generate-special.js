#!/usr/bin/env node
'use strict';

// Special Stocks — one dashboard card per name Amit asked for.
// Technicals are computed from Yahoo daily bars. Headlines come from Yahoo
// search. The buy / hold / sell badge is a transparent rules score on those
// inputs, not a recommendation.

const fs = require('fs');
const path = require('path');
const { makeClient, history } = require('./lib/yahoo');
const { yahooSymbol } = require('./lib/exchange');
const { esc, fmtPrice, fmtPct } = require('./lib/format');
const { tickertapeUrl } = require('./lib/tickertape');
const { HUB_BACK_LINK } = require('./lib/hub-nav');
const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');
const stockActions = require('./lib/stock-actions');
const { loadLivePrices, livePriceOf, dayChangePct, reconcile } = require('./lib/live-prices');

const LIST_PATH = path.join(__dirname, 'special-stocks.json');
const OUT_HTML = path.join(__dirname, 'docs', 'special.html');
const OUT_JSON = path.join(__dirname, 'docs', 'special-data.json');
const NAMES_PATH = path.join(__dirname, 'docs', 'nse-tickers.json');

const yahoo = makeClient();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sma(arr, n) {
  if (!arr || arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

function emaLast(arr, n) {
  if (!arr || arr.length < n) return null;
  const k = 2 / (n + 1);
  let e = arr[0];
  for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function emaSeries(arr, n) {
  if (!arr.length) return [];
  const k = 2 / (n + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function macd(closes) {
  if (closes.length < 35) return { macd: null, signal: null, hist: null };
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const line = e12.map((v, i) => v - e26[i]).slice(26);
  const signal = emaLast(line, 9);
  const last = line[line.length - 1];
  return { macd: last, signal, hist: signal == null ? null : last - signal };
}

function bollinger(closes, n = 20) {
  if (closes.length < n) return { mid: null, upper: null, lower: null, pctB: null };
  const slice = closes.slice(-n);
  const mid = slice.reduce((a, b) => a + b, 0) / n;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const upper = mid + 2 * sd;
  const lower = mid - 2 * sd;
  const price = closes[closes.length - 1];
  const pctB = upper === lower ? null : (price - lower) / (upper - lower);
  return { mid, upper, lower, pctB };
}

function atrAdx(bars, n = 14) {
  if (bars.length < n * 2 + 2) return { atr: null, adx: null, plusDI: null, minusDI: null };
  const trs = [];
  const plus = [];
  const minus = [];
  for (let i = 1; i < bars.length; i++) {
    const hi = bars[i].high;
    const lo = bars[i].low;
    const pc = bars[i - 1].close;
    const up = hi - bars[i - 1].high;
    const down = bars[i - 1].low - lo;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  const smooth = (arr) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += arr[i];
    const out = [s];
    for (let i = n; i < arr.length; i++) out.push(out[out.length - 1] - out[out.length - 1] / n + arr[i]);
    return out;
  };
  const trS = smooth(trs);
  const pS = smooth(plus);
  const mS = smooth(minus);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    if (!trS[i]) continue;
    const pdi = 100 * pS[i] / trS[i];
    const mdi = 100 * mS[i] / trS[i];
    const den = pdi + mdi;
    dx.push(den ? 100 * Math.abs(pdi - mdi) / den : 0);
  }
  if (dx.length < n) return { atr: trS[trS.length - 1] / n, adx: null, plusDI: null, minusDI: null };
  let adx = 0;
  for (let i = 0; i < n; i++) adx += dx[i];
  adx /= n;
  for (let i = n; i < dx.length; i++) adx = (adx * (n - 1) + dx[i]) / n;
  const last = trS.length - 1;
  return {
    atr: trS[last] / n,
    adx,
    plusDI: 100 * pS[last] / trS[last],
    minusDI: 100 * mS[last] / trS[last],
  };
}

function stochastic(bars, n = 14) {
  if (bars.length < n) return null;
  const slice = bars.slice(-n);
  const hi = Math.max(...slice.map(b => b.high));
  const lo = Math.min(...slice.map(b => b.low));
  if (hi === lo) return 50;
  return 100 * (slice[slice.length - 1].close - lo) / (hi - lo);
}

function ret(closes, days) {
  if (closes.length <= days) return null;
  const prev = closes[closes.length - 1 - days];
  if (!prev) return null;
  return closes[closes.length - 1] / prev - 1;
}

function loadNames() {
  const map = {};
  try {
    for (const row of JSON.parse(fs.readFileSync(NAMES_PATH, 'utf8'))) map[row.t] = row.n;
  } catch { /* page still renders */ }
  return map;
}

function loadScreenerHits() {
  const hits = {};
  const files = [
    ['India Research', 'indianresearch-tickers.json', r => ({
      roe: num(r.roe), de: num(r.debtEquity), promoter: num(r.promoterHolding), growth: num(r.epsGrowth5Y),
    })],
    ['APEX', 'apex-tickers.json', r => ({ score: num(r.total ?? r.score) })],
    ['Creamy', 'creamy-tickers.json', r => ({ score: num(r.breakoutTotal ?? r.score) })],
    ['Multibagger', 'multibagger-tickers.json', r => ({ score: num(r.score ?? r.total) })],
    ['Trending Value', 'trendingvalue-tickers.json', r => ({ score: num(r.score ?? r.rank) })],
    ['Investors', 'investors-tickers.json', r => ({ holders: num(r.holders ?? r.count) })],
  ];
  for (const [label, file, pick] of files) {
    const p = path.join(__dirname, 'docs', file);
    try {
      if (fs.statSync(p).size > 8_000_000) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const rows = Array.isArray(raw) ? raw : (raw.rows || raw.picks || raw.tickers || []);
      for (const r of rows) {
        const t = String(r.ticker || r.t || r.symbol || '').toUpperCase();
        if (!t) continue;
        if (!hits[t]) hits[t] = { screens: [], extra: {} };
        hits[t].screens.push(label);
        Object.assign(hits[t].extra, pick(r));
      }
    } catch { /* sidecar missing is fine */ }
  }
  return hits;
}

function toneOf(title) {
  const pos = /\b(beat|upgrade|record|order|wins?|profit|surge|growth|buyback|dividend|jump|rally|gain|strong|expand|approval|contract|raised|high)\b/i;
  const neg = /\b(fall|falls|drop|drops|slump|loss|fraud|probe|penalty|downgrade|miss|weak|cut|decline|crash|default|resign|slip|plunge|fine|raid|selloff|delay)\b/i;
  const p = pos.test(title);
  const n = neg.test(title);
  if (p && !n) return 'positive';
  if (n && !p) return 'negative';
  return 'neutral';
}

function newsLean(items) {
  if (!items || !items.length) return 'none';
  const counts = { positive: 0, negative: 0, neutral: 0 };
  for (const n of items) counts[n.tone] = (counts[n.tone] || 0) + 1;
  if (counts.positive > counts.negative) return 'positive';
  if (counts.negative > counts.positive) return 'negative';
  return 'mixed';
}

function assessNews(items) {
  if (!items.length) return 'No recent headlines came back for this name.';
  const counts = { positive: 0, negative: 0, neutral: 0 };
  for (const n of items) counts[n.tone] += 1;
  const lean = newsLean(items);
  return `${items.length} recent headline${items.length === 1 ? '' : 's'}: ${counts.positive} positive, ${counts.negative} negative, ${counts.neutral} neutral. The set leans ${lean}. This is a keyword read of the titles, not a full article review.`;
}

function stanceOf(m) {
  let score = 0;
  const reasons = [];
  const add = (pts, text) => { score += pts; reasons.push(text); };
  if (m.sma200 == null || m.price == null) {
    return { stance: 'HOLD', score: 0, reasons: ['Not enough price history to score a trend.'] };
  }
  if (m.price > m.sma200) add(2, 'Price is above the 200-day average, so the longer trend is up.');
  else add(-2, 'Price is below the 200-day average, so the longer trend is down.');
  if (m.sma50 != null) {
    if (m.price > m.sma50) add(1, 'Price is above the 50-day average.');
    else add(-1, 'Price is below the 50-day average.');
    if (m.sma50 > m.sma200) add(1, 'The 50-day average sits above the 200-day average.');
    else add(-1, 'The 50-day average sits below the 200-day average.');
  }
  if (m.macdHist != null) {
    if (m.macdHist > 0) add(1, 'MACD histogram is positive.');
    else add(-1, 'MACD histogram is negative.');
  }
  if (m.rsi != null) {
    if (m.rsi >= 45 && m.rsi <= 68) add(1, `RSI ${m.rsi.toFixed(0)} is in a healthy trend band (45–68).`);
    else if (m.rsi > 75) add(-1, `RSI ${m.rsi.toFixed(0)} is stretched above 75.`);
    else if (m.rsi < 35) add(-1, `RSI ${m.rsi.toFixed(0)} is weak, below 35.`);
    else reasons.push(`RSI ${m.rsi.toFixed(0)} is outside the healthy band but not extreme, so it does not move the score.`);
  }
  if (m.adx != null && m.adx >= 25 && m.price > m.sma200) add(1, `ADX ${m.adx.toFixed(0)} says the uptrend has strength.`);
  if (m.ret63 != null && m.nifty63 != null) {
    if (m.ret63 > m.nifty63) add(1, 'It beat Nifty over the last 3 months.');
    else add(-1, 'It lagged Nifty over the last 3 months.');
  }
  if (m.pe != null && m.pe > 0 && m.pe < 35) add(1, `Trailing P/E ${m.pe.toFixed(1)} is under 35.`);
  else if (m.pe != null && m.pe >= 60) add(-1, `Trailing P/E ${m.pe.toFixed(1)} is rich (60+).`);
  let stance = 'HOLD';
  if (score >= 4) stance = 'BUY';
  else if (score <= -2) stance = 'SELL';
  return { stance, score, reasons };
}

function chartSvg(closes) {
  const data = closes.slice(-126).filter(v => v != null);
  if (data.length < 2) return '<div class="muted">Not enough bars for a chart.</div>';
  const w = 680;
  const h = 168;
  const pad = 10;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const x = i => pad + (i / (data.length - 1)) * (w - pad * 2);
  const y = v => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  const up = data[data.length - 1] >= data[0];
  const color = up ? '#00d4aa' : '#f87171';
  const smaArr = [];
  for (let i = 0; i < data.length; i++) {
    if (i < 19) smaArr.push(null);
    else smaArr.push(data.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20);
  }
  const smaLine = smaArr.map((v, i) => v == null ? '' : `${smaArr[i - 1] == null ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Six-month price">
    <path d="${area}" fill="${color}" opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2"/>
    <path d="${smaLine}" fill="none" stroke="#7dd3fc" stroke-width="1.4" stroke-dasharray="4 3"/>
  </svg>`;
}

function fmtCr(mcap) {
  if (mcap == null) return '—';
  const cr = mcap / 1e7;
  if (cr >= 100000) return `₹${(cr / 100000).toFixed(2)}L cr`;
  if (cr >= 100) return `₹${Math.round(cr).toLocaleString('en-IN')} cr`;
  return `₹${cr.toFixed(1)} cr`;
}

function tile(label, value, tip, cls) {
  return `<div class="tile ${cls || ''}"><div class="k"><span class="tip" tabindex="0" data-tip="${esc(tip)}">${esc(label)}</span></div><div class="v">${value}</div></div>`;
}

function signed(v, text) {
  if (v == null || !Number.isFinite(v)) return '—';
  const cls = v > 0 ? 'up' : v < 0 ? 'dn' : '';
  return `<span class="${cls}">${text}</span>`;
}

function pctRatio(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return fmtPct(v * 100);
}

function newsTime(t) {
  const n = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(n)) return '';
  const ms = n < 1e12 ? n * 1000 : n;
  const days = Math.round((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 14) return `${days}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function renderCard(s) {
  const link = s.ticker ? tickertapeUrl(s.ticker, { name: s.name }) : '';
  const title = s.ticker
    ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(s.name)}</a>`
    : esc(s.name);
  const buttons = s.ticker && s.price != null
    ? stockActions.buttonsHtml({ ticker: s.ticker, name: s.name, price: s.price, research: true })
    : '';
  if (!s.ok) {
    return `<article class="stock" data-stance="HOLD" id="${esc(s.anchor)}">
      <header class="stock-head"><div><div class="asked">${esc(s.asked)}</div><h2>${title}</h2><div class="sub">${esc(s.note || 'No listed quote found.')}</div></div>
      <div class="badge hold">HOLD</div></header>
      <p class="muted">${esc(s.error || 'This name is not a listed equity in the local universe, so there is no chart or indicator set.')}</p>
    </article>`;
  }
  const m = s.metrics;
  const cls = m.stance.toLowerCase();
  const news = s.news.map(n => `<li class="tone-${n.tone}"><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a><span class="src">${esc(n.publisher || '')}${n.when ? ' · ' + esc(n.when) : ''}</span></li>`).join('');
  const reasons = m.reasons.map(r => `<li>${esc(r)}</li>`).join('');
  const screens = s.screens.length
    ? s.screens.map(x => `<span class="chip">${esc(x)}</span>`).join('')
    : '<span class="muted">Not on the current screener pages.</span>';
  return `<article class="stock" data-stance="${m.stance}" id="${esc(s.anchor)}">
    <header class="stock-head">
      <div>
        <div class="asked">${esc(s.asked)}${s.resolved ? ` · ${esc(s.resolved)}` : ''}</div>
        <h2>${title} <span class="ticker">${esc(s.ticker)}</span></h2>
        <div class="px" data-live-px="${esc(s.ticker)}">${fmtPrice(s.price)}</div>
        <div class="sub">${signed(s.dayPct, s.dayPct == null ? '—' : fmtPct(s.dayPct))} today · ${esc(fmtCr(s.mcap))} · ${buttons}</div>
      </div>
      <div class="stance">
        <div class="badge ${cls}">${m.stance}</div>
        <div class="score">score ${m.score > 0 ? '+' : ''}${m.score}</div>
      </div>
    </header>
    <div class="dash">
      <div class="chart-wrap">
        <div class="chart-label">6-month close <span class="swatch price"></span> price <span class="swatch sma"></span> 20-day average</div>
        ${chartSvg(s.closes)}
      </div>
      <div class="call">
        <h3>Why ${m.stance}</h3>
        <ul>${reasons}</ul>
        <h3>News read</h3>
        <p>${esc(s.newsRead)}</p>
      </div>
    </div>
    <div class="tiles">
      ${tile('RSI 14', m.rsi == null ? '—' : m.rsi.toFixed(1), 'Wilder RSI. 45–68 is treated as a healthy trend. Above 75 is stretched. Below 35 is weak.', m.rsi > 75 || m.rsi < 35 ? 'warn' : '')}
      ${tile('MACD hist', m.macdHist == null ? '—' : signed(m.macdHist, m.macdHist.toFixed(2)), 'MACD line minus its 9-day signal. Positive means short momentum is up.', '')}
      ${tile('ADX 14', m.adx == null ? '—' : m.adx.toFixed(1), 'Trend strength. Above 25 means the trend is established. Direction comes from price versus the moving averages.', '')}
      ${tile('+DI / −DI', m.plusDI == null ? '—' : `${m.plusDI.toFixed(0)} / ${m.minusDI.toFixed(0)}`, 'Directional movement. +DI above −DI means buyers have the edge.', '')}
      ${tile('Stoch %K', m.stoch == null ? '—' : m.stoch.toFixed(0), '14-day stochastic. Where the close sits inside the recent high-low range. 100 is at the high.', '')}
      ${tile('Bollinger %B', m.pctB == null ? '—' : m.pctB.toFixed(2), '0 is the lower band, 1 is the upper band, 0.5 is the 20-day average. Above 1 is outside the upper band.', '')}
      ${tile('ATR 14', m.atr == null ? '—' : fmtPrice(m.atr), 'Average true range in rupees. A rough daily swing size.', '')}
      ${tile('ATR %', m.atrPct == null ? '—' : (m.atrPct * 100).toFixed(1) + '%', 'ATR divided by price. Higher means a wilder stock.', '')}
      ${tile('SMA 20', m.sma20 == null ? '—' : fmtPrice(m.sma20), '20-day simple average.', '')}
      ${tile('SMA 50', m.sma50 == null ? '—' : fmtPrice(m.sma50), '50-day simple average.', '')}
      ${tile('SMA 200', m.sma200 == null ? '—' : fmtPrice(m.sma200), '200-day simple average. The longer trend line used in the score.', '')}
      ${tile('vs SMA 200', signed(m.vs200, pctRatio(m.vs200)), 'How far the price sits above or below the 200-day average.', '')}
      ${tile('52w high', m.high52 == null ? '—' : fmtPrice(m.high52), 'Highest daily high in the last year of bars, or the quote field when bars are shorter.', '')}
      ${tile('52w low', m.low52 == null ? '—' : fmtPrice(m.low52), 'Lowest daily low in the last year of bars.', '')}
      ${tile('Off high', signed(m.offHigh, pctRatio(m.offHigh)), 'Distance from the 52-week high. Zero means it is at the high.', '')}
      ${tile('Off low', signed(m.offLow, pctRatio(m.offLow)), 'Distance above the 52-week low.', '')}
      ${tile('1 week', signed(m.ret5, pctRatio(m.ret5)), 'Close-to-close return over 5 trading days.', '')}
      ${tile('1 month', signed(m.ret21, pctRatio(m.ret21)), 'Close-to-close return over 21 trading days.', '')}
      ${tile('3 month', signed(m.ret63, pctRatio(m.ret63)), 'Close-to-close return over 63 trading days. Compared with Nifty in the score.', '')}
      ${tile('6 month', signed(m.ret126, pctRatio(m.ret126)), 'Close-to-close return over 126 trading days.', '')}
      ${tile('1 year', signed(m.ret252, pctRatio(m.ret252)), 'Close-to-close return over 252 trading days.', '')}
      ${tile('vs Nifty 3m', signed(m.vsNifty, pctRatio(m.vsNifty)), 'This stock’s 3-month return minus Nifty’s 3-month return.', '')}
      ${tile('Vol vs 20d', m.volRatio == null ? '—' : m.volRatio.toFixed(2) + '×', 'Latest volume divided by the 20-day average volume.', '')}
      ${tile('Pivot', m.pivot == null ? '—' : fmtPrice(m.pivot), 'Classic pivot from the previous day’s high, low, and close.', '')}
      ${tile('R1 / S1', m.r1 == null ? '—' : `${fmtPrice(m.r1)} / ${fmtPrice(m.s1)}`, 'First resistance and support off that pivot.', '')}
      ${tile('P/E', m.pe == null ? '—' : m.pe.toFixed(1), 'Trailing price to earnings from the Yahoo quote.', '')}
      ${tile('P/B', m.pb == null ? '—' : m.pb.toFixed(2), 'Price to book from the Yahoo quote.', '')}
      ${tile('Div yield', m.divPct == null ? '—' : m.divPct.toFixed(2) + '%', 'Dividend yield from the Yahoo quote. Yahoo publishes this in percent already.', '')}
      ${tile('ROE', s.extra.roe == null ? '—' : s.extra.roe.toFixed(1) + '%', 'Return on equity from the India Research sidecar, when this name is on that page.', '')}
      ${tile('D/E', s.extra.de == null ? '—' : s.extra.de.toFixed(2), 'Debt to equity from the India Research sidecar, when present.', '')}
      ${tile('Promoter', s.extra.promoter == null ? '—' : s.extra.promoter.toFixed(1) + '%', 'Promoter holding from the India Research sidecar, when present.', '')}
    </div>
    <div class="foot">
      <div>
        <h3>On our pages</h3>
        <div class="chips">${screens}</div>
      </div>
      <div>
        <h3>Latest headlines</h3>
        ${news ? `<ul class="news">${news}</ul>` : '<p class="muted">No headlines returned.</p>'}
      </div>
    </div>
  </article>`;
}

function renderPair(s) {
  const stance = s.metrics ? s.metrics.stance : 'HOLD';
  const m = s.metrics || {};
  const lean = newsLean(s.news);
  const leanLabel = { positive: 'Positive', negative: 'Negative', mixed: 'Mixed', none: '—' }[lean];
  const id = esc(s.anchor);
  return `<tr class="sum" data-id="${id}" data-stance="${stance}" tabindex="0" role="button" aria-expanded="false">
    <td><div class="nm">${esc(s.name)}</div><div class="tk">${esc(s.ticker || s.asked)}</div></td>
    <td class="num">${s.price != null ? fmtPrice(s.price) : '—'}${s.dayPct != null ? `<div class="tk">${signed(s.dayPct, fmtPct(s.dayPct))}</div>` : ''}</td>
    <td><span class="badge sm ${stance.toLowerCase()}">${stance}</span></td>
    <td class="num">${m.rsi == null ? '—' : m.rsi.toFixed(0)}</td>
    <td class="num">${signed(m.vs200, pctRatio(m.vs200))}</td>
    <td class="num">${signed(m.ret63, pctRatio(m.ret63))}</td>
    <td class="lean-${lean}">${leanLabel}</td>
  </tr>
  <tr class="detail" id="detail-${id}" hidden>
    <td colspan="7">${renderCard(s)}</td>
  </tr>`;
}

function buildHtml(cards, generated) {
  const buys = cards.filter(c => c.metrics && c.metrics.stance === 'BUY').length;
  const holds = cards.filter(c => !c.metrics || c.metrics.stance === 'HOLD').length;
  const sells = cards.filter(c => c.metrics && c.metrics.stance === 'SELL').length;
  const legend = legendHtml('How to read this page', [
    { title: 'What this is', bodyHtml: '<p>A comparison table of the fixed list. Click a row to open that stock’s dashboard under it. Only one dashboard is open at a time. The readings are a model score, not investment advice.</p>' },
    { title: 'Buy / Hold / Sell', bodyHtml: '<p>A points score. Above the 200-day average is +2, below is −2. The 50-day stack, MACD, RSI band, ADX, 3-month return versus Nifty, and a simple P/E check add or subtract 1. Score 4 or more is Buy. Score −2 or less is Sell. Everything else is Hold.</p>' },
    { title: 'News', bodyHtml: '<p>Headlines are recent Google News results, filled in from Yahoo when that set is thin. The assessment counts positive and negative words in the titles. It does not read the articles and it does not change the badge.</p>' },
    { title: 'Chart', bodyHtml: '<p>The line is the last six months of daily closes. The dashed line is the 20-day average. Green means the window ended higher than it started.</p>' },
  ]);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Special Stocks</title>
<style>
:root{--bg:#0a0a0f;--s1:#12121a;--s2:#1a1a24;--bd:#23232f;--ac:#00d4aa;--t1:#e4e4ea;--t2:#9a9aa6;--t3:#6a6a82;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--t1);font-family:var(--font)}
a{color:var(--ac);text-decoration:none}
.wrap{max-width:1180px;margin:0 auto;padding:20px 18px 60px}
.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:8px}
h1{margin:0 0 6px;font-size:1.45rem}
.meta{color:var(--t3);font-size:.78rem}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.filters button{background:var(--s2);color:var(--t1);border:1px solid var(--bd);border-radius:999px;padding:6px 12px;cursor:pointer;font-weight:650}
.filters button.on{border-color:var(--ac);color:var(--ac)}
.stock{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:16px;margin:0 0 16px}
.stock-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.asked{color:var(--t3);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
h2{margin:2px 0 4px;font-size:1.15rem}
.ticker{color:var(--t3);font-size:.8rem;font-weight:600}
.px{font-size:1.35rem;font-weight:750}
.sub{color:var(--t2);font-size:.82rem;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.stance{text-align:right}
.badge{font-weight:800;letter-spacing:.04em;padding:8px 14px;border-radius:10px;font-size:.95rem}
.badge.buy{background:rgba(0,212,170,.15);color:#00d4aa}
.badge.hold{background:rgba(234,179,8,.15);color:#eab308}
.badge.sell{background:rgba(248,113,113,.15);color:#f87171}
.score{color:var(--t3);font-size:.75rem;margin-top:4px}
.dash{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.8fr);gap:16px;margin-top:12px}
.chart{width:100%;height:auto;display:block;background:#0e0e16;border-radius:10px}
.chart-label{color:var(--t3);font-size:.72rem;margin-bottom:6px}
.swatch{display:inline-block;width:14px;height:3px;margin:0 4px 0 10px;vertical-align:middle}
.swatch.price{background:#00d4aa}
.swatch.sma{background:#7dd3fc}
.call h3,.foot h3{margin:0 0 6px;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--t2)}
.call ul,.news{margin:0;padding-left:18px}
.call li,.news li{margin:0 0 6px;font-size:.84rem;line-height:1.4}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:8px;margin-top:14px}
.tile{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:8px 10px}
.tile .k{color:var(--t3);font-size:.68rem;text-transform:uppercase;letter-spacing:.03em}
.tile .v{font-weight:700;margin-top:3px;font-size:.92rem}
.tile.warn{border-color:rgba(234,179,8,.45)}
.up{color:#00d4aa}.dn{color:#f87171}
.foot{display:grid;grid-template-columns:220px 1fr;gap:16px;margin-top:14px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{background:#1c2430;color:#7dd3fc;border-radius:999px;padding:3px 8px;font-size:.72rem;font-weight:700}
.news a{color:var(--t1);font-weight:600}
.news .src{display:block;color:var(--t3);font-size:.72rem}
.tone-positive{border-left:3px solid #00d4aa;padding-left:8px}
.tone-negative{border-left:3px solid #f87171;padding-left:8px}
.tone-neutral{border-left:3px solid #3a3a4a;padding-left:8px}
.muted{color:var(--t3);font-size:.84rem}
.note{color:var(--t2);font-size:.84rem;max-width:760px}
.table-wrap{overflow-x:auto;border:1px solid var(--bd);border-radius:12px}
table.cmp{width:100%;border-collapse:collapse;min-width:720px}
table.cmp th{text-align:left;font-size:.68rem;letter-spacing:.04em;text-transform:uppercase;color:var(--t3);padding:10px 12px;background:#0e0e16;position:sticky;top:0}
table.cmp td{padding:10px 12px;border-top:1px solid var(--bd);vertical-align:middle}
tr.sum{cursor:pointer}
tr.sum:hover td{background:#16161f}
tr.sum.open td{background:#12121c}
tr.sum:focus-visible{outline:1px solid var(--ac);outline-offset:-1px}
.nm{font-weight:700}
.tk{color:var(--t3);font-size:.72rem;margin-top:2px}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.badge.sm{padding:3px 8px;font-size:.72rem;border-radius:6px}
.lean-positive{color:#00d4aa;font-weight:700}
.lean-negative{color:#f87171;font-weight:700}
.lean-mixed{color:#eab308;font-weight:700}
.lean-none{color:var(--t3)}
tr.detail td{padding:0 8px 12px;background:#0e0e16}
tr.detail .stock{margin:0;border-radius:10px}
${TOOLTIP_CSS}
${stockActions.css}
@media(max-width:800px){.dash,.foot{grid-template-columns:1fr}}
</style>
</head>
<body>
${stockActions.bannerHtml || ''}
<div class="wrap">
  <div class="top">
    <div>
      <h1>Special Stocks</h1>
      <p class="note">Click a row to open that stock’s chart, indicators, and headlines. Click it again, or another row, and only one dashboard stays open. The badge is a rules score, not investment advice.</p>
      <div class="meta">Built ${esc(generated)} · ${cards.length} names · ${buys} buy · ${holds} hold · ${sells} sell</div>
    </div>
    ${HUB_BACK_LINK}
  </div>
  ${legend}
  <div class="filters">
    <button class="on" data-filter="all">All ${cards.length}</button>
    <button data-filter="BUY">Buy ${buys}</button>
    <button data-filter="HOLD">Hold ${holds}</button>
    <button data-filter="SELL">Sell ${sells}</button>
  </div>
  <div class="table-wrap">
  <table class="cmp">
    <thead><tr>
      <th>Stock</th><th>Price</th><th>Read</th><th>RSI</th><th>vs 200-day</th><th>3 month</th><th>News</th>
    </tr></thead>
    <tbody>
    ${cards.map(renderPair).join('\n')}
    </tbody>
  </table>
  </div>
</div>
${stockActions.modalHtml || ''}
${stockActions.researchModalHtml || ''}
<script>${stockActions.setupScript || ''}</script>
<script>${stockActions.js}</script>
<script>
function closeRows(){
  document.querySelectorAll('tr.detail').forEach(function(r){ r.hidden = true; });
  document.querySelectorAll('tr.sum').forEach(function(r){
    r.classList.remove('open');
    r.setAttribute('aria-expanded','false');
  });
}
function toggleRow(row){
  if (!row || row.hidden) return;
  var id = row.getAttribute('data-id');
  var detail = document.getElementById('detail-' + id);
  var wasOpen = row.classList.contains('open');
  closeRows();
  if (!wasOpen && detail) {
    detail.hidden = false;
    row.classList.add('open');
    row.setAttribute('aria-expanded','true');
    detail.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
}
document.querySelectorAll('tr.sum').forEach(function(row){
  row.addEventListener('click', function(){ toggleRow(row); });
  row.addEventListener('keydown', function(e){
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(row); }
  });
});
document.querySelectorAll('.filters button').forEach(function(btn){
  btn.addEventListener('click', function(){
    document.querySelectorAll('.filters button').forEach(function(b){ b.classList.remove('on'); });
    btn.classList.add('on');
    var f = btn.getAttribute('data-filter');
    closeRows();
    document.querySelectorAll('tr.sum').forEach(function(row){
      var show = f === 'all' || row.getAttribute('data-stance') === f;
      row.hidden = !show;
      var detail = document.getElementById('detail-' + row.getAttribute('data-id'));
      if (detail) detail.hidden = true;
    });
  });
});
</script>
</body>
</html>`;
}

async function quoteOf(symbol) {
  try {
    return await yahoo.quote(symbol);
  } catch {
    return null;
  }
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGoogleNews(xml) {
  const items = [];
  for (const block of String(xml || '').split('<item>').slice(1)) {
    const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    const when = decodeXml((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
    const publisher = decodeXml((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]);
    if (!title || /stock price|share price|quote (&|and) history|google news/i.test(title)) continue;
    items.push({ title, publisher, link, when: newsTime(when), tone: toneOf(title) });
    if (items.length >= 5) break;
  }
  return items;
}

async function googleNews(name, ticker, newsQuery) {
  const clean = String(name).replace(/\s+Ltd\.?$/i, '');
  const q = encodeURIComponent(newsQuery || `"${clean}" OR ${ticker} when:21d`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, { headers: { 'User-Agent': 'watchlist-app/1.0' } });
  if (!res.ok) return [];
  return parseGoogleNews(await res.text());
}

async function newsOf(symbol, name, ticker, newsQuery) {
  const found = [];
  const seen = new Set();
  const push = (item) => {
    const key = String(item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    found.push(item);
  };
  try {
    for (const item of await googleNews(name, ticker || symbol, newsQuery)) push(item);
  } catch { /* Yahoo below still runs */ }
  if (found.length < 4) {
    const query = String(name || '').replace(/\s+Ltd\.?$/i, '') || symbol;
    try {
      const s = await yahoo.search(query, { newsCount: 6, quotesCount: 0 });
      for (const n of (s && s.news) || []) {
        push({
          title: n.title || '',
          publisher: n.publisher || '',
          link: n.link || n.url || '#',
          when: newsTime(n.providerPublishTime),
          tone: toneOf(n.title || ''),
        });
      }
    } catch { /* headlines stay as whatever Google returned */ }
  }
  return found.slice(0, 5);
}

function metricsFrom(bars, quote, price, nifty63) {
  const closes = bars.map(b => b.close).filter(v => v != null);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const macdV = macd(closes);
  const bb = bollinger(closes);
  const ax = atrAdx(bars);
  const year = bars.slice(-252);
  const high52 = quote && num(quote.fiftyTwoWeekHigh) != null
    ? num(quote.fiftyTwoWeekHigh)
    : (year.length ? Math.max(...year.map(b => b.high)) : null);
  const low52 = quote && num(quote.fiftyTwoWeekLow) != null
    ? num(quote.fiftyTwoWeekLow)
    : (year.length ? Math.min(...year.map(b => b.low)) : null);
  const vols = bars.map(b => b.volume).filter(v => v != null);
  const avgVol = sma(vols, 20);
  const lastVol = vols.length ? vols[vols.length - 1] : null;
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
  const pivot = prev ? (prev.high + prev.low + prev.close) / 3 : null;
  const ret63 = ret(closes, 63);
  const pe = quote ? num(quote.trailingPE) : null;
  const divPct = quote && num(quote.dividendYield) != null
    ? num(quote.dividendYield)
    : (quote && num(quote.trailingAnnualDividendYield) != null ? num(quote.trailingAnnualDividendYield) * 100 : null);
  const base = {
    price, sma20, sma50, sma200,
    vs200: sma200 ? price / sma200 - 1 : null,
    rsi: rsi(closes),
    macdHist: macdV.hist,
    adx: ax.adx, plusDI: ax.plusDI, minusDI: ax.minusDI,
    stoch: stochastic(bars),
    pctB: bb.pctB,
    atr: ax.atr,
    atrPct: ax.atr && price ? ax.atr / price : null,
    high52, low52,
    offHigh: high52 ? price / high52 - 1 : null,
    offLow: low52 ? price / low52 - 1 : null,
    ret5: ret(closes, 5), ret21: ret(closes, 21), ret63, ret126: ret(closes, 126), ret252: ret(closes, 252),
    nifty63, vsNifty: ret63 != null && nifty63 != null ? ret63 - nifty63 : null,
    volRatio: avgVol ? lastVol / avgVol : null,
    pivot, r1: pivot != null && prev ? 2 * pivot - prev.low : null, s1: pivot != null && prev ? 2 * pivot - prev.high : null,
    pe, pb: quote ? num(quote.priceToBook) : null, divPct,
  };
  return { ...base, ...stanceOf(base) };
}

async function main() {
  const list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
  const names = loadNames();
  const screeners = loadScreenerHits();
  const { prices: livePrices } = loadLivePrices();
  const period1 = new Date(Date.now() - 420 * 86400000).toISOString().slice(0, 10);
  let nifty63 = null;
  try {
    const nb = await history(yahoo, '^NSEI', { period1, interval: '1d' });
    nifty63 = ret(nb.map(b => b.close).filter(v => v != null), 63);
    console.log(`Nifty 3m ${nifty63 == null ? 'n/a' : (nifty63 * 100).toFixed(1) + '%'}`);
  } catch (e) {
    console.warn('Nifty history failed:', e.message);
  }

  const cards = [];
  for (const row of list) {
    const ticker = row.ticker ? String(row.ticker).toUpperCase() : null;
    const name = (ticker && names[ticker]) || row.resolved || row.asked;
    process.stdout.write(`${row.asked} (${ticker || 'unlisted'}) ... `);
    if (!ticker) {
      console.log('skip');
      cards.push({
        asked: row.asked, ticker: null, name: row.asked, resolved: row.resolved, note: row.resolved,
        anchor: 'nse', ok: false,
        error: 'NSE, the exchange, is not a listed stock in this universe. BSE Ltd is the listed exchange on this page.',
      });
      continue;
    }
    const symbol = row.yahoo || yahooSymbol(ticker);
    try {
      const bars = await history(yahoo, symbol, { period1, interval: '1d' });
      await sleep(250);
      const quote = await quoteOf(symbol);
      await sleep(200);
      const displayName = row.name || (quote && (quote.longName || quote.shortName)) || name;
      const news = await newsOf(symbol, displayName, ticker, row.newsQuery);
      const last = bars.length ? bars[bars.length - 1].close : (quote ? num(quote.regularMarketPrice) : null);
      const price = reconcile(last, livePriceOf(livePrices, ticker));
      if (price == null || bars.length < 2) {
        console.log(`thin (${bars.length} bars)`);
        cards.push({
          asked: row.asked, ticker, name: displayName, resolved: row.resolved, anchor: ticker.toLowerCase(),
          ok: false, error: `Yahoo returned ${bars.length} daily bars for ${symbol}, which is not enough to draw a chart.`,
        });
        continue;
      }
      const dayPct = dayChangePct(livePrices, ticker) != null
        ? dayChangePct(livePrices, ticker)
        : (quote && num(quote.regularMarketChangePercent) != null
          ? num(quote.regularMarketChangePercent)
          : (bars.length >= 2 ? (price / bars[bars.length - 2].close - 1) * 100 : null));
      const hit = screeners[ticker] || { screens: [], extra: {} };
      const metrics = metricsFrom(bars, quote, price, nifty63);
      if (bars.length < 30) {
        metrics.stance = 'HOLD';
        metrics.score = 0;
        metrics.reasons = [`Listed too recently for a trend score (${bars.length} daily bars on ${symbol}). Moving averages, RSI, and MACD need more history, so this stays Hold.`];
      }
      cards.push({
        asked: row.asked, ticker, name: displayName, resolved: row.resolved || null,
        anchor: ticker.toLowerCase(), ok: true, price, dayPct,
        mcap: quote ? num(quote.marketCap) : null,
        closes: bars.map(b => b.close).slice(-140),
        news, newsRead: assessNews(news),
        screens: hit.screens, extra: hit.extra, metrics,
      });
      console.log(`${metrics.stance} ${metrics.score} · ${news.length} headlines`);
    } catch (e) {
      console.log('ERR', e.message);
      cards.push({
        asked: row.asked, ticker, name, resolved: row.resolved, anchor: ticker.toLowerCase(),
        ok: false, error: e.message,
      });
    }
    await sleep(300);
  }

  const generated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  fs.writeFileSync(OUT_HTML, buildHtml(cards, generated));
  const slim = cards.map(c => ({
    asked: c.asked, ticker: c.ticker, name: c.name, ok: c.ok,
    stance: c.metrics ? c.metrics.stance : 'HOLD',
    score: c.metrics ? c.metrics.score : null,
    price: c.price || null,
    error: c.error || null,
  }));
  fs.writeFileSync(OUT_JSON, JSON.stringify({ generated, cards: slim }, null, 2));
  console.log(`Wrote ${path.relative(process.cwd(), OUT_HTML)} (${cards.filter(c => c.ok).length}/${cards.length} with data)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

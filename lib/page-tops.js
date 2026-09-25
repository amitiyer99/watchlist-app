'use strict';

// Top N names on each ranked stock page, in the order the page renders them.
// The alert button is written with the row, so the first data-alert-ticker
// values in the HTML are the stocks at the top of that page.

const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');

// HTML pages whose rows are baked in by the generator (button markup is real).
const HTML_PAGES = [
  ['bestpicks.html', 'Best Picks'],
  ['sniper.html', 'Sniper'],
  ['triggers.html', 'Triggers'],
  ['confluence.html', 'Confluence'],
  ['fiidii.html', 'FII / DII'],
  ['investors.html', 'Investors'],
  ['compounders.html', 'Compounders'],
  ['trending-value.html', 'Trending Value'],
  ['breakout2.html', 'Breakout GEN2'],
  ['indian-research.html', 'India Research'],
  ['debate.html', 'Debate'],
];

// Pages that draw the table in the browser. The sidecar is already in display order.
const JSON_PAGES = [
  ['apex-tickers.json', 'APEX', 'apex.html'],
  ['creamy-tickers.json', 'Creamy', 'creamy.html'],
  ['multibagger-tickers.json', 'Multibagger', 'multibagger.html'],
  ['rocket-tickers.json', 'Rocket', 'rocket.html'],
];

const TICKER_OK = /^[A-Z0-9.&-]{1,20}$/;

function topsFromHtml(html, n) {
  const out = [];
  const seen = new Set();
  const re = /data-alert-ticker="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    const ticker = String(m[1] || '').trim().toUpperCase();
    if (!TICKER_OK.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    const slice = html.slice(m.index, m.index + 500);
    const nm = slice.match(/data-alert-name="([^"]*)"/);
    out.push({ ticker, name: (nm && nm[1]) || ticker, rank: out.length + 1 });
  }
  return out;
}

function topsFromJson(file, n) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(DOCS, file), 'utf8')); }
  catch { return []; }
  const list = Array.isArray(data) ? data : (data.rows || data.picks || []);
  const out = [];
  const seen = new Set();
  for (const s of list) {
    const ticker = String((s && s.ticker) || '').trim().toUpperCase();
    if (!TICKER_OK.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ticker, name: s.name || ticker, rank: out.length + 1 });
    if (out.length >= n) break;
  }
  return out;
}

function loadPageTops(n = 5) {
  const rows = [];
  for (const [file, page] of HTML_PAGES) {
    const p = path.join(DOCS, file);
    if (!fs.existsSync(p)) continue;
    let html;
    try { html = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const row of topsFromHtml(html, n)) rows.push({ ...row, page, file });
  }
  for (const [json, page, file] of JSON_PAGES) {
    for (const row of topsFromJson(json, n)) rows.push({ ...row, page, file });
  }
  return rows;
}

module.exports = { HTML_PAGES, JSON_PAGES, loadPageTops, topsFromHtml };

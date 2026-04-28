'use strict';
const fs   = require('fs');
const path = require('path');

function fixUrl(url) {
  return url.replace('tickertape.in/stocks//stocks/', 'tickertape.in/stocks/');
}

// Method 1: data-ticker rows with adjacent href (Indian Research HTML)
function extractFromDataTicker(html) {
  const map = {};
  const rowRe = /data-ticker="([A-Z0-9&]+)"[\s\S]{0,300}?href="(https:\/\/www\.tickertape\.in\/stocks\/[^"]+)"/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) map[m[1]] = fixUrl(m[2]);
  return map;
}

// Method 2: embedded RAW JSON (APEX/Creamy/Multibagger — several formats)
function extractFromRawJson(html) {
  const map = {};
  // Each generator puts all data on one line: var/const RAW = <json>;
  const lineRe = /(?:var|const)\s+RAW\s*=\s*(.+?);?\s*\n/g;
  let m;
  while ((m = lineRe.exec(html)) !== null) {
    try {
      const raw = JSON.parse(m[1]);
      // Array form (APEX): [{ticker, slug}, ...]
      const arr = Array.isArray(raw) ? raw : (raw.stocks || []);
      for (const s of arr) {
        if (!s.ticker) continue;
        if (s.url)        map[s.ticker] = s.url;
        else if (s.slug)  map[s.ticker] = 'https://www.tickertape.in' + s.slug;
      }
      if (Object.keys(map).length > 0) break;
    } catch(e) { /* ignore parse errors */ }
  }
  return map;
}

// Method 3: s.slug or stockUrl patterns in embedded JS objects
function extractFromStocksJson(html) {
  const map = {};
  // var STOCKS = [...] or similar
  const patterns = [/var STOCKS\s*=\s*(\[[\s\S]+?\]);/, /var stocks\s*=\s*(\[[\s\S]+?\]);/];
  for (const p of patterns) {
    const m = p.exec(html);
    if (!m) continue;
    try {
      const arr = JSON.parse(m[1]);
      for (const s of arr) {
        if (s.ticker && s.stockUrl) map[s.ticker] = s.stockUrl;
      }
    } catch(e) { /* ignore */ }
  }
  return map;
}

const sources = [
  { file: 'indian-research.html', methods: ['dataTicker'] },
  { file: 'apex.html',            methods: ['rawJson'] },
  { file: 'creamy.html',          methods: ['rawJson', 'stocksJson'] },
  { file: 'multibagger.html',     methods: ['rawJson', 'stocksJson'] },
];
const merged = {};
for (const { file, methods } of sources) {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'docs', file), 'utf8');
    let found = 0;
    for (const meth of methods) {
      let m = {};
      if (meth === 'dataTicker') m = extractFromDataTicker(html);
      if (meth === 'rawJson')    m = extractFromRawJson(html);
      if (meth === 'stocksJson') m = extractFromStocksJson(html);
      const newKeys = Object.keys(m).filter(k => !merged[k]);
      Object.assign(merged, m);
      found += newKeys.length;
    }
    console.log(file + ': extracted ' + found + ' new URLs');
  } catch(e) { console.log('skip', file, e.message); }
}
console.log('Total:', Object.keys(merged).length, 'unique ticker URLs');
console.log('TANFACIND :', merged['TANFACIND'] || 'NOT FOUND');
console.log('BSE       :', merged['BSE']       || 'NOT FOUND');
console.log('MCX       :', merged['MCX']       || 'NOT FOUND');
console.log('FORCEMOT  :', merged['FORCEMOT']  || 'NOT FOUND');

const sidecars = [
  'indianresearch-tickers.json',
  'apex-tickers.json',
  'creamy-tickers.json',
  'breakout-tickers.json',
  'multibagger-tickers.json',
];
for (const f of sidecars) {
  const fp = path.join(__dirname, 'docs', f);
  if (!fs.existsSync(fp)) continue;
  const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
  let patched = 0, missing = [];
  for (const s of arr) {
    if (merged[s.ticker]) { s.url = merged[s.ticker]; patched++; }
    else missing.push(s.ticker);
  }
  fs.writeFileSync(fp, JSON.stringify(arr), 'utf8');
  console.log(f + ': patched ' + patched + '/' + arr.length + (missing.length ? ' | missing: ' + missing.slice(0,5).join(',') + (missing.length > 5 ? '...' : '') : ''));
}
console.log('Done.');

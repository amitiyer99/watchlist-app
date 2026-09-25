'use strict';

const fs = require('fs');
const path = require('path');
const { esc } = require('./format');

const TICKER_URLS_PATH = path.join(__dirname, '..', 'ticker-urls.json');
let _map = null;

function loadTickerUrls() {
  if (_map) return _map;
  try { _map = JSON.parse(fs.readFileSync(TICKER_URLS_PATH, 'utf8')) || {}; }
  catch { _map = {}; }
  return _map;
}

function tickertapeUrl(ticker, { name, url } = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  const given = url ? String(url).trim() : '';
  if (/tickertape\.in\/stocks\//i.test(given)) return given;
  const mapped = loadTickerUrls()[t];
  if (mapped) return mapped;
  if (/tickertape\.in/i.test(given)) return given;
  const slug = String(name || t)
    .replace(/\s+Ltd\.?$/i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return `https://www.tickertape.in/stocks/${slug}-${t}`;
}

const EMAIL_LINK_STYLE = 'color:#e4e4ea;text-decoration:none;font-weight:700';

function tickertapeLink(label, ticker, opts) {
  return `<a href="${esc(tickertapeUrl(ticker, opts))}" style="${EMAIL_LINK_STYLE}" target="_blank">${esc(label || ticker)}</a>`;
}

module.exports = { tickertapeUrl, tickertapeLink, loadTickerUrls };

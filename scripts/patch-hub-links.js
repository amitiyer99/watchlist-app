'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const hubReq = "const { HUB_BACK_LINK, HUB_NAV_LINK } = require('./lib/hub-nav');\n";
const HUB_BACK =
  '<a href="hub.html" class="back-link" style="color:var(--ac);border-color:rgba(0,212,170,.45)">&#x1F3E0; Site Index</a>';
const HUB_NAV = '<a href="hub.html">Site Index</a>';

function addRequire(s) {
  if (s.includes('hub-nav')) return s;
  if (s.startsWith("'use strict';")) return s.replace("'use strict';\n", "'use strict';\n" + hubReq);
  return hubReq + s;
}

let n = 0;
const gens = fs.readdirSync(root).filter((f) => f.startsWith('generate-') && f.endsWith('.js'));
for (const f of gens) {
  const fp = path.join(root, f);
  let s = fs.readFileSync(fp, 'utf8');
  const orig = s;
  s = addRequire(s);
  s = s.replace(
    /<a href="index\.html"\s+class="back-link">My Watchlist<\/a>/g,
    '${HUB_BACK_LINK}\n    <a href="index.html"              class="back-link">My Watchlist</a>'
  );
  s = s.replace(
    /<a href="index\.html"\s+class="back-link">Dashboard<\/a>/g,
    '${HUB_BACK_LINK}\n    <a href="index.html"              class="back-link">Dashboard</a>'
  );
  s = s.replace(
    /<div class="nav-links">\s*\n\s*<a href="index\.html">Watchlist<\/a>/g,
    '<div class="nav-links">\n  ${HUB_NAV_LINK}\n  <a href="index.html">Watchlist</a>'
  );
  s = s.replace(
    /<div class="nav-links">\s*\n\s*<a href="index\.html">Dashboard<\/a>/g,
    '<div class="nav-links">\n    ${HUB_NAV_LINK}\n    <a href="index.html">Dashboard</a>'
  );
  if (s !== orig) {
    fs.writeFileSync(fp, s);
    console.log('gen', f);
    n++;
  }
}

const docsDir = path.join(root, 'docs');
for (const f of fs.readdirSync(docsDir).filter((x) => x.endsWith('.html') && x !== 'hub.html')) {
  const fp = path.join(docsDir, f);
  let s = fs.readFileSync(fp, 'utf8');
  if (s.includes('href="hub.html"')) continue;
  const orig = s;
  s = s.replace(
    /<a href="index\.html"\s+class="back-link">My Watchlist<\/a>/,
    HUB_BACK + '\n    <a href="index.html"              class="back-link">My Watchlist</a>'
  );
  s = s.replace(
    /<a href="index\.html"\s+class="nav-link">Dashboard<\/a>/,
    HUB_BACK.replace('back-link', 'nav-link') +
      '\n    <a href="index.html"              class="nav-link">Dashboard</a>'
  );
  s = s.replace(
    /<div class="nav-links">\s*\n\s*<a href="index\.html">Dashboard<\/a>/,
    '<div class="nav-links">\n    ' + HUB_NAV + '\n    <a href="index.html">Dashboard</a>'
  );
  s = s.replace(
    /<div class="nav-links">\s*\n\s*<a href="index\.html">Watchlist<\/a>/,
    '<div class="nav-links">\n  ' + HUB_NAV + '\n  <a href="index.html">Watchlist</a>'
  );
  if (s !== orig) {
    fs.writeFileSync(fp, s);
    console.log('html', f);
    n++;
  }
}

const idxPath = path.join(docsDir, 'index.html');
let idx = fs.readFileSync(idxPath, 'utf8');
if (!idx.includes('href="hub.html"')) {
  idx = idx.replace(
    '<div class="header-right">',
    '<div class="header-right">\n    <a href="hub.html" style="color:var(--ac);text-decoration:none;font-size:.8rem;padding:6px 12px;border:1px solid rgba(0,212,170,.45);border-radius:6px;font-weight:600">&#x1F3E0; Site Index</a>'
  );
  fs.writeFileSync(idxPath, idx);
  console.log('html index.html');
  n++;
}

const gdPath = path.join(root, 'generate-dashboard.js');
let gd = fs.readFileSync(gdPath, 'utf8');
if (!gd.includes('href="hub.html"')) {
  gd = addRequire(gd);
  gd = gd.replace(
    '<div class="header-right">',
    '<div class="header-right">\n    <a href="hub.html" style="color:var(--ac);text-decoration:none;font-size:.8rem;padding:6px 12px;border:1px solid rgba(0,212,170,.45);border-radius:6px;font-weight:600">&#x1F3E0; Site Index</a>'
  );
  fs.writeFileSync(gdPath, gd);
  console.log('gen generate-dashboard.js');
  n++;
}

const mwPath = path.join(root, 'my-watchlists.html');
let mw = fs.readFileSync(mwPath, 'utf8');
if (!mw.includes('hub.html')) {
  mw = mw.replace(
    '<h1>My Equity Watchlists</h1>',
    '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px"><h1 style="margin:0">My Equity Watchlists</h1><a href="docs/hub.html" style="color:var(--ac);text-decoration:none;font-size:.85rem;padding:8px 14px;border:1px solid rgba(0,212,170,.4);border-radius:8px">&#x1F3E0; Site Index</a></div>'
  );
  fs.writeFileSync(mwPath, mw);
  console.log('my-watchlists.html');
  n++;
}

console.log('patched', n);

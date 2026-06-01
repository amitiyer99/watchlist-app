'use strict';
// Move alert/research buttons inside stock-name in existing breakout2.html (placement fix without full regen).
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'docs', 'breakout2.html');
let html = fs.readFileSync(file, 'utf8');

if (html.includes('<span class="stock-actions">')) {
  console.log('breakout2.html already has stock-actions placement');
  process.exit(0);
}

const css = `
.stock-actions{display:inline-flex;align-items:center;gap:2px;margin-left:4px;vertical-align:middle;flex-shrink:0}
.card-name .name-row{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px}
`;

if (!html.includes('.stock-actions{')) {
  html = html.replace('</style>', css + '</style>');
}

// Table rows
const tableRe = /(<div class="stock-name">\s*<a[^>]*>[\s\S]*?<\/a>)\s*(<div class="ticker">[\s\S]*?<\/div>)\s*<\/div>\s*(<button class="alert-btn"[\s\S]*?<button class="research-btn"[^>]*>[\s\S]*?<\/button>)/g;
html = html.replace(tableRe, '$1\n        <span class="stock-actions">\n      $3\n        </span>\n        $2\n      </div>');

// Mobile cards
const cardRe = /(<div class="card-name"><a([^>]*)>([\s\S]*?)<\/a><\/div>\s*<div class="card-ticker">)([\s\S]*?)(<button class="alert-btn"[\s\S]*?<button class="research-btn"[^>]*>[\s\S]*?<\/button>\s*)(<\/div>)/g;
html = html.replace(cardRe, '<div class="card-name"><span class="name-row"><a$2>$3</a><span class="stock-actions">$5</span></span></div>\n        <div class="card-ticker">$4$6');

fs.writeFileSync(file, html);

const orphan = (html.match(/<\/div>\s*\n\s*<button class="alert-btn"/g) || []).length;
console.log('Patched breakout2.html. Orphan alert buttons outside stock-name:', orphan);

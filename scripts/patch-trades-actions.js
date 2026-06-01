'use strict';
const fs = require('fs');
const path = require('path');
const sa = require('../lib/stock-actions');

const file = path.join(__dirname, '..', 'docs', 'trades.html');
let html = fs.readFileSync(file, 'utf8');

if (html.includes('tradeActionBtns')) {
  console.log('trades.html already patched');
  process.exit(0);
}

html = html.replace(
  '@media(max-width:600px){.form-grid{grid-template-columns:1fr 1fr}.summary{grid-template-columns:1fr 1fr}}',
  '@media(max-width:600px){.form-grid{grid-template-columns:1fr 1fr}.summary{grid-template-columns:1fr 1fr}}\n' + sa.css
);

html = html.replace(
  '</div><!-- /main -->\n\n<script>',
  '</div><!-- /main -->\n\n' + sa.bannerHtml + '\n' + sa.modalHtml + '\n' + sa.researchModalHtml + '\n\n<script>'
);

html = html.replace(
  "<script>\n'use strict';",
  "<script>\n'use strict';\n" + sa.setupScript
);

const fn = `function tradeActionBtns(r) {
  var sym = r.symbol || '';
  var name = (r.companyName || sym).replace(/"/g, '&quot;');
  var px = (r.cmp != null && !r.closed) ? r.cmp : r.price;
  return '<span class="stock-actions"><button type="button" class="alert-btn" data-alert-ticker="' + sym + '" data-alert-price="' + (px || 0) + '" data-alert-name="' + name + '" title="Set price alert">&#x1F514;</button><button type="button" class="research-btn" data-r-ticker="' + sym + '" data-r-name="' + name + '" title="AI Deep Research">&#x1F9E0;</button></span>';
}
`;

html = html.replace('function renderTable() {', fn + '\nfunction renderTable() {');

html = html.replace(
  "'<td class=\"ticker left\"' + noteAttr + '><div>' + r.symbol + noteDot + closedBadge + '</div>' + (r.companyName ? '<div class=\"company-sub\">' + r.companyName.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</div>' : '') + '</td>' +",
  "'<td class=\"ticker left\"' + noteAttr + '><div class=\"name-row\">' + r.symbol + tradeActionBtns(r) + noteDot + closedBadge + '</div>' + (r.companyName ? '<div class=\"company-sub\">' + r.companyName.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</div>' : '') + '</td>' +"
);

html = html.replace('</script>\n</body>', sa.js + '\n</script>\n</body>');

fs.writeFileSync(file, html);
console.log('Patched docs/trades.html with alert + research actions');

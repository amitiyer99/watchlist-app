'use strict';

// Shared "how to read this page" building blocks — the tooltip + legend pattern
// first built for triggers.html, extracted so every page uses the identical
// CSS/behavior instead of copy-pasting and drifting. Pure CSS tooltips (hover
// or tap-to-focus, no JS dependency), plus a collapsible <details> glossary.
//
// Usage in a generator's buildHtml():
//   const { TOOLTIP_CSS, legendHtml } = require('./lib/page-help');
//   ...inside <style>: ${TOOLTIP_CSS}
//   ...right after the header/banner: ${legendHtml('How to read this page', sectionsArray)}
//   ...on any header/badge: <span class="tip" tabindex="0" data-tip="explanation">Label</span>

const TOOLTIP_CSS = `
/* ── Friendly hover tooltips (shared pattern, see lib/page-help.js) ── */
.tip{position:relative;cursor:help;border-bottom:1px dotted var(--t3,#6a6a82);outline:none}
.tip:hover::after,.tip:focus::after,.tip:hover::before,.tip:focus::before{opacity:1;visibility:visible}
.tip::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);background:#1c1c28;color:#e4e4ea;border:1px solid #2f2f42;padding:9px 11px;border-radius:8px;font-size:.72rem;font-weight:500;text-transform:none;letter-spacing:normal;white-space:normal;width:230px;line-height:1.45;box-shadow:0 10px 28px rgba(0,0,0,.5);opacity:0;visibility:hidden;transition:opacity .12s ease,visibility .12s ease;z-index:30;pointer-events:none}
.tip::before{content:'';position:absolute;left:50%;bottom:calc(100% + 3px);transform:translateX(-50%);border:5px solid transparent;border-top-color:#2f2f42;opacity:0;visibility:hidden;transition:opacity .12s ease;z-index:30}
.tip.tip-r::after{left:auto;right:-6px;transform:none}
.tip.tip-r::before{left:auto;right:14px;transform:none}
th .tip{color:inherit;text-transform:inherit;letter-spacing:inherit;font-weight:inherit}
/* ── Legend / glossary ── */
details.legend{background:var(--s1,#12121a);border-bottom:1px solid var(--bd,#23232f)}
details.legend summary{padding:10px 24px;cursor:pointer;color:#7dd3fc;font-size:.8rem;font-weight:600;list-style:none;user-select:none}
details.legend summary::-webkit-details-marker{display:none}
details.legend summary::before{content:'▸ ';display:inline-block;transition:transform .15s}
details.legend[open] summary::before{transform:rotate(90deg)}
.legend-body{padding:4px 24px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;font-size:.78rem;color:var(--t2,#9a9aa6);line-height:1.55}
.legend-body h4{margin:0 0 6px;color:var(--t1,#e4e4ea);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.legend-body p{margin:0 0 6px}
.legend-chip{display:inline-block;padding:1px 7px;border-radius:4px;font-size:.68rem;font-weight:700;margin-right:2px}
tbody tr:nth-child(even){background:rgba(255,255,255,.015)}
tbody tr:hover{background:rgba(125,211,252,.05)}
`;

// sections: array of { title, bodyHtml } — bodyHtml is raw HTML (already escaped
// by the caller where it embeds dynamic data; static copy needs no escaping).
function legendHtml(summaryText, sections) {
  const body = sections.map(s => `
    <div>
      <h4>${s.title}</h4>
      ${s.bodyHtml}
    </div>`).join('');
  return `<details class="legend">
  <summary>${summaryText}</summary>
  <div class="legend-body">${body}</div>
</details>`;
}

module.exports = { TOOLTIP_CSS, legendHtml };

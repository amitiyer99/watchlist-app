'use strict';

// Shared display formatters.
//
// Consolidates the fmtPrice / fmtPct / esc helpers that were previously
// copy-pasted (and subtly diverging) across the generate-*.js scripts.
// Every function is parametrised so each call site can reproduce its
// original output exactly — see the per-variant notes below.

// Currency. Default is the dominant "always two decimals" form
// (₹1,234.50). Pass { min: 0 } for the max-only variant used by
// bestpicks/confluence (₹1,234.5).
function fmtPrice(p, { min = 2, max = 2, nullText = '—' } = {}) {
  if (p == null) return nullText;
  return '₹' + Number(p).toLocaleString('en-IN', { minimumFractionDigits: min, maximumFractionDigits: max });
}

// Percentage. `decimals` stays positional so existing callers like
// fmtPct(v, 2) keep working. Options cover the rarer variants:
//   { sign: false }      → no leading '+' on positives (confluence)
//   { nullText: '' }     → blank instead of '—' for null (alerts)
function fmtPct(v, decimals = 1, { sign = true, nullText = '—' } = {}) {
  if (v == null || isNaN(v)) return nullText;
  return (sign && v >= 0 ? '+' : '') + Number(v).toFixed(decimals) + '%';
}

// HTML-attribute/text escaping. Null-safe: uses `s == null ? ''` rather
// than the old `s || ''`, so a legitimate 0 or false renders instead of
// vanishing. Escapes & < > " — the set every `esc` copy shared.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Stricter variant that also escapes the single quote — matches the old
// `escapeHtml` copies (alerts, creamy, dashboard, sectors, indianresearch).
function escapeHtml(s) {
  return esc(s).replace(/'/g, '&#39;');
}

module.exports = { fmtPrice, fmtPct, esc, escapeHtml };

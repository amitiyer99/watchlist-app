'use strict';

// ── AI-research path audit ────────────────────────────────────────────────────
// The 🧠 button's output depends on FOUR independent things, and this project has
// now been bitten by each of them separately:
//   1. RENDERER  — does the page format markdown, or dump plain text?
//   2. FORMATTER PRESENT — is the shared formatter actually IN the built page?
//   3. PROMPT SHAPE — does the prompt ASK the model for **bold** sections? A perfect
//      renderer shows nothing if the model returns prose.
//   4. COMPETING DIRECTIVES — a page-specific prompt that imposes its own layout
//      (e.g. "1) … 2) … 3) …") overrides the shared FORMAT_SPEC and silently
//      de-formats that page only.
// Checking one and assuming the rest is why this took four passes. This audits all
// four, for every generator and every built page. Run: npm run audit-ai

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DOCS = path.join(ROOT, 'docs');
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// generator -> built page filename
const PAGE_OF = {
  'generate-multibagger.js': 'multibagger.html', 'generate-creamy.js': 'creamy.html',
  'generate-breakout2.js': 'breakout2.html', 'generate-indianresearch.js': 'indian-research.html',
  'generate-confluence.js': 'confluence.html', 'generate-fiidii.js': 'fiidii.html',
  'generate-investors.js': 'investors.html', 'generate-sniper.js': 'sniper.html',
  'generate-triggers.js': 'triggers.html', 'generate-bestpicks.js': 'bestpicks.html',
  'generate-sectors.js': 'sectors.html', 'generate-apex.js': 'apex.html',
  'generate-dashboard.js': 'index.html', 'generate-potential.js': 'potential.html',
  'generate-prediction.js': 'prediction.html', 'generate-debate.js': 'debate.html',
};

// Strip // line comments so our own explanatory notes can't be mistaken for prompt
// directives (this produced a false "competing directives" hit on fiidii).
const stripComments = src => src.replace(/^[ \t]*\/\/.*$/gm, '');

// Layout directives that fight the shared FORMAT_SPEC.
function formatDirectives(rawSrc) {
  const src = stripComments(rawSrc);
  const hits = [];
  // only look inside prompt-ish string literals
  const promptish = src.match(/`[^`]{80,2000}`|'(?:[^'\\]|\\.){80,2000}'/g) || [];
  for (const lit of promptish) {
    if (!/analyst|stock|NSE|prompt|Cover:|Act as/i.test(lit)) continue;
    if (/\b[123]\)\s/.test(lit)) hits.push('numbered "1) 2) 3)"');
    if (/in this format|Format the reply|reply in|structure:/i.test(lit)) hits.push('explicit format block');
    if (/\*\*[A-Z][A-Z &/]+\*\*/.test(lit)) hits.push('own **BOLD** headings');
  }
  return [...new Set(hits)];
}

const rows = [];
for (const [gen, page] of Object.entries(PAGE_OF)) {
  const src = read(path.join(ROOT, gen));
  if (!src) continue;
  const hasBtn = /research-btn|buttonsHtml/.test(src);
  if (!hasBtn) continue;

  const usesSharedLib = /lib\/stock-actions/.test(src);
  const ownRenderer   = /innerHTML\s*=\s*text\.replace|white-space:pre-wrap/.test(src);
  const callsShared   = /window\.fmtAiText/.test(src);
  const customPrompt  = /prompt\s*:/.test(src) || /catalystPrompt|Prompt\s*\(/.test(src);
  const directives    = customPrompt ? formatDirectives(src) : [];

  const html = read(path.join(DOCS, page));
  const built = {
    exists: !!html,
    formatter: html.includes('window.fmtAiText=function'),
    formatSpec: html.includes('WHAT THE SETUP SAYS'),
    ownChain: /innerHTML=text\.replace/.test(html),
    preWrap: html.includes('white-space:pre-wrap'),
  };

  // ── SOURCE verdict: is the code correct, regardless of when the page last built?
  const ownHeadings = directives.includes('own **BOLD** headings');
  const srcProblems = [];
  if (ownRenderer && !callsShared) srcProblems.push('own renderer, not using shared formatter');
  if (!usesSharedLib && !callsShared) srcProblems.push('no shared formatter available to the page');
  if (!ownHeadings && !usesSharedLib) srcProblems.push('prompt never asks for **bold** sections');
  const competing = directives.filter(d => d !== 'own **BOLD** headings');
  if (usesSharedLib && competing.length) srcProblems.push('prompt imposes its own layout, fighting FORMAT_SPEC (' + competing.join('; ') + ')');

  // ── BUILD verdict: does the CURRENTLY BUILT page reflect a correct source?
  const buildStale = built.exists && !built.formatter && (usesSharedLib || callsShared);
  rows.push({
    page, gen, usesSharedLib, callsShared, customPrompt, directives, built,
    srcOk: srcProblems.length === 0, srcProblems, buildStale,
  });
}

console.log('🧠 AI-research path audit — renderer · formatter · prompt · conflicts\n');
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('page', 19) + pad('SOURCE', 9) + pad('BUILT', 8) + 'detail');
console.log('-'.repeat(96));
let srcBad = 0, staleOnly = 0;
for (const r of rows.sort((a, b) => a.page.localeCompare(b.page))) {
  if (!r.srcOk) srcBad++;
  else if (r.buildStale) staleOnly++;
  const builtState = !r.built.exists ? 'missing'
    : r.built.formatter ? 'current'
    : r.built.ownChain ? 'legacy' : 'no-fmt';
  const detail = !r.srcOk ? '❌ SOURCE: ' + r.srcProblems.join(' | ')
    : r.buildStale ? '⏳ source OK — page stale, rebuilds on next CI run'
    : '✅ formatted';
  console.log(pad(r.page, 19) + pad(r.srcOk ? 'ok' : 'NEEDS FIX', 9) + pad(builtState, 8) + detail);
}
console.log(`\n${srcBad} page(s) need SOURCE fixes · ${staleOnly} correct but awaiting rebuild.`);

const out = path.join(DOCS, 'ai-research-audit.json');
try { fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)); console.log(`Wrote ${out}`); } catch {}
console.log('Note: "fmt" = renderer in the BUILT page (yes=shared, own=legacy chain, NO=missing).');
console.log('      "spec" = the shared FORMAT_SPEC reached the page. "custom" = page supplies its own prompt.');

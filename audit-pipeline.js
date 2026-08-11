'use strict';

// ── Pipeline audit ────────────────────────────────────────────────────────────
// Hunts for the classes of SILENT failure this project has actually been bitten by,
// so they get caught mechanically instead of by luck months later. Run: npm run audit
//
//   A. ORPHANED GENERATOR   — a generate-*.js that no CI workflow ever runs, so its
//                             page silently freezes.
//   B. UNSTAGED OUTPUT      — the generator runs, but its output file isn't in either
//                             CI git-add list, so the COMMITTED copy freezes while the
//                             in-run copy looks fine. (This hid four May/June-frozen
//                             sidecars that starve the local fetchers.)
//   C. STALE ARTIFACT       — committed file older than STALE_DAYS.
//   D. FAIL-OPEN FILTER     — `x == null || x >= LIMIT` style guards, which let a
//                             stock through the very check meant to stop it whenever
//                             the datum is missing. (This is how BSE names bypassed
//                             the ₹2Cr liquidity floor.)
//   E. DEPRECATED YAHOO API — yahooFinance.historical(), which fails for NSE index
//                             symbols; chart() is the working endpoint.
//   F. HARDCODED .NS        — bypasses lib/exchange, so BSE listings 404 silently.
//   G. BROKEN PAGE JS       — inline <script> that doesn't parse (the india-research
//                             regex bug: alerts + AI research were dead on that page).
//   I. RAW \n IN EMITTED JS  — a single backslash-n inside a quoted string in client JS
//                             that the generator emits from a template literal. The
//                             generator's own literal eats the escape, so the browser
//                             receives a REAL newline, which terminates the string and
//                             kills the whole <script>. Caught at SOURCE, so it is
//                             flagged before a build rather than after (G only sees it
//                             once a broken page has already been committed).
//   H. ORPHANED SIDECAR     — written by nobody, or read by nobody.
//
// Exit code is always 0: this is a report, not a gate.

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const DOCS = path.join(ROOT, 'docs');
const MR   = path.join(ROOT, 'scripts', 'market-refresh.sh');
const DR   = path.join(ROOT, '.github', 'workflows', 'daily-refresh.yml');
const STALE_DAYS = 14;

const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const findings = [];
const add = (sev, cls, item, detail) => findings.push({ sev, cls, item, detail });

const mrTxt = read(MR), drTxt = read(DR);
const ciTxt = mrTxt + '\n' + drTxt;

// Generators, and the artifacts each one writes.
const generators = fs.readdirSync(ROOT).filter(f => /^generate-.*\.js$/.test(f));
const writesOf = (file) => {
  const src = read(path.join(ROOT, file));
  const out = new Set();
  // writeFileSync(<path expr>, ...) and OUTPUT_PATH-style consts
  for (const m of src.matchAll(/writeFileSync\(\s*([^,]+),/g)) {
    const expr = m[1];
    const lit = expr.match(/['"]([a-z0-9._-]+\.(?:json|html))['"]/i);
    if (lit) { out.add(lit[1]); continue; }
    const varName = expr.trim().replace(/[^\w]/g, '');
    const decl = src.match(new RegExp(varName + "\\s*=\\s*path\\.join\\([^)]*?['\"]([a-z0-9._-]+\\.(?:json|html))['\"]", 'i'));
    if (decl) out.add(decl[1]);
  }
  for (const m of src.matchAll(/path\.join\([^)]*?['"]([a-z0-9._-]+\.(?:json|html))['"]\s*\)/gi)) {
    const f2 = m[1];
    if (/OUT|OUTPUT|SIDECAR/i.test(src.slice(Math.max(0, m.index - 60), m.index))) out.add(f2);
  }
  return [...out];
};

console.log('🔎 Pipeline audit — hunting the silent-failure classes this repo has hit\n');

// ── A/B: CI coverage + staging ───────────────────────────────────────────────
for (const g of generators) {
  const runInMR = mrTxt.includes(g), runInDR = drTxt.includes(g);
  if (!runInMR && !runInDR) { add('HIGH', 'A orphaned generator', g, 'not invoked by market-refresh.sh or daily-refresh.yml — its page never updates'); continue; }
  for (const out of writesOf(g)) {
    const staged = new RegExp('docs/' + out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(ciTxt) || ciTxt.includes(out);
    if (!staged) add('MED', 'B unstaged output', `${g} -> docs/${out}`, 'generator runs but the file is in no CI git-add list; the committed copy freezes while in-run reads look fine');
  }
}

// ── C: stale committed artifacts ─────────────────────────────────────────────
const gitDate = (rel) => {
  try { return execSync(`git log -1 --format=%ad --date=short -- ${rel}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};
const today = new Date();
for (const f of fs.existsSync(DOCS) ? fs.readdirSync(DOCS) : []) {
  if (!/\.(json|html)$/.test(f)) continue;
  if (/^(score-lab|dataset-summary|exchange-map|earnings-quality)\.json$/.test(f)) continue; // locally-produced, may lag by design
  const d = gitDate(`docs/${f}`);
  if (!d) { add('LOW', 'C never committed', `docs/${f}`, 'exists locally but has no commit — CI may not know about it'); continue; }
  const age = Math.round((today - new Date(d)) / 864e5);
  if (age > STALE_DAYS) add(age > 45 ? 'HIGH' : 'MED', 'C stale artifact', `docs/${f}`, `last committed ${d} (${age} days ago)`);
}

// ── D: fail-open filters ─────────────────────────────────────────────────────
for (const f of fs.readdirSync(ROOT).filter(x => /\.js$/.test(x)).concat(fs.readdirSync(path.join(ROOT, 'lib')).map(x => 'lib/' + x))) {
  const src = read(path.join(ROOT, f));
  for (const m of src.matchAll(/(\w+(?:\.\w+)*)\s*==\s*null\s*\|\|\s*\1\s*[<>]=?/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    add('MED', 'D fail-open filter', `${f}:${line}`, `"${m[0].slice(0, 46)}…" — passes when the value is MISSING; consider failing closed or excluding`);
  }
}

// ── E/F: data-source hazards ─────────────────────────────────────────────────
for (const f of fs.readdirSync(ROOT).filter(x => /\.js$/.test(x))) {
  const src = read(path.join(ROOT, f));
  const dep = [...src.matchAll(/yahooFinance\.historical\(|yf\.historical\(/g)].length;
  if (dep) add('LOW', 'E deprecated yahoo api', f, `${dep} call(s) to historical(); chart() is the endpoint that works for index symbols`);
  const ns = [...src.matchAll(/\+\s*['"]\.NS['"]/g)].length;
  if (ns) add('MED', 'F hardcoded .NS', f, `${ns} site(s) bypass lib/exchange — BSE-listed names 404 silently`);
}

// ── G: broken inline page JS ─────────────────────────────────────────────────
const vm = require('vm');
for (const f of (fs.existsSync(DOCS) ? fs.readdirSync(DOCS) : []).filter(x => /\.html$/.test(x))) {
  const html = read(path.join(DOCS, f));
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].filter(m => !/src=/.test(m[0]));
  blocks.forEach((b, i) => {
    try { new vm.Script(b[1]); }
    catch (e) { add('HIGH', 'G broken page JS', `docs/${f} (block ${i + 1})`, String(e.message).slice(0, 90)); }
  });
}

// ── I: raw \n inside emitted client JS (source-level twin of check G) ─────────
// Properly walk the source's template literals (a naive line scan mis-detects the end
// of the literal and then flags every Node-side console.log('\n…') as a bug).
// Inside a template literal a single \n is consumed by the generator, so the browser
// receives a real newline — fine in HTML text, fatal inside a quoted JS string.
function templateLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\\\') { i += 2; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i) + 1 || src.length; continue; }
    if (c === '`') {
      let j = i + 1, depth = 0;
      while (j < src.length) {
        if (src[j] === '\\\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0) { if (src[j] === '}') depth--; j++; continue; }
        if (src[j] === '`') break;
        j++;
      }
      out.push([i, j, src.slice(i + 1, j)]);
      i = j + 1; continue;
    }
    i++;
  }
  return out;
}
for (const g of generators) {
  const src = read(path.join(ROOT, g));
  if (!src) continue;
  for (const [absStart, , body] of templateLiterals(src)) {
    if (!/<script/.test(body)) continue;
    const baseLine = src.slice(0, absStart).split('\n').length;
    body.split('\n').forEach((line, k) => {
      // a quoted JS string on this line containing a lone \n
      if (/['"][^'"]*\\n/.test(line) && !/\\\\n/.test(line)) {
        add('HIGH', 'I raw \\n in emitted JS', `${g}:${baseLine + k}`, line.trim().slice(0, 80));
      }
    });
  }
}

// ── H: orphaned sidecars ─────────────────────────────────────────────────────
const allSrc = fs.readdirSync(ROOT).filter(x => /\.js$/.test(x)).map(x => read(path.join(ROOT, x))).join('\n')
  + fs.readdirSync(path.join(ROOT, 'lib')).map(x => read(path.join(ROOT, 'lib', x))).join('\n');
for (const f of (fs.existsSync(DOCS) ? fs.readdirSync(DOCS) : []).filter(x => /\.json$/.test(x))) {
  const refs = allSrc.split(f).length - 1;
  if (refs === 0) add('LOW', 'H orphaned sidecar', `docs/${f}`, 'no source file references this filename — dead artifact?');
}

// ── Report ───────────────────────────────────────────────────────────────────
const order = { HIGH: 0, MED: 1, LOW: 2 };
findings.sort((a, b) => order[a.sev] - order[b.sev] || a.cls.localeCompare(b.cls));
const counts = findings.reduce((a, f) => { a[f.sev] = (a[f.sev] || 0) + 1; return a; }, {});
if (!findings.length) console.log('  ✅ nothing found in any checked class.\n');
let lastCls = '';
for (const f of findings) {
  if (f.cls !== lastCls) { console.log(`\n── ${f.cls.toUpperCase()} ──`); lastCls = f.cls; }
  console.log(`  [${f.sev}] ${f.item}\n         ${f.detail}`);
}
console.log(`\nSummary: ${counts.HIGH || 0} HIGH · ${counts.MED || 0} MED · ${counts.LOW || 0} LOW  (${generators.length} generators checked)`);
const outPath = path.join(DOCS, 'pipeline-audit.json');
try { fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), counts, findings }, null, 2)); console.log(`Wrote ${outPath}`); } catch {}
console.log('Note: LOW items are often intentional. Judge each; this tool finds candidates, not verdicts.');

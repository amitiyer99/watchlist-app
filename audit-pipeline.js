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
//   J. NO PRICE REFRESH     — the page displays prices but has no way to update them
//                             after the build: no data-live-px tag, no client-side fetch.
//                             It will show build-time prices forever. (NALCO showed a
//                             previous close 20 minutes after the market closed.)
//   K. PRICE COVERAGE       — tickers a page renders that live-prices.json has no quote
//                             for, so those rows can only ever show an EOD price.
//                             (Multibagger: 84% of rows had no live price.)
//   L. UNBACKED CLAIM       — page copy asserts "calibrated" / "learned" / "isotonic"
//                             while the code can emit the un-fitted fallback and never
//                             branches on the flag that says so. (Best Picks displayed a
//                             linear ramp as an isotonic-regression probability.)
//   M. SYNTHETIC IN STATS   — an imputed placeholder value (e.g. a -25% stand-in for a
//                             ticker that couldn't be priced) reaching an average/median
//                             that drives behaviour. Debate read -2.59% vs a true -0.52%.
//   N. STARVED OUTPUT       — a page whose row count has collapsed relative to the pool
//                             it screens from, the signature of stacked hard AND gates.
//                             (Triggers: 251 candidates -> 1 row/day after a VCP tighten.)
//   O. UNDEDUPED STATISTICS — rates or probabilities computed from ledger rows without
//                             non-overlapping episode dedup, so one stock re-emitted for
//                             15 sessions counts as 15 independent outcomes.
//   P. DEAD PAGE LINK       — a nav link pointing at an .html file that doesn't exist.
//   R. STALE VS SIBLINGS   — a page much older than the pages built alongside it. Absolute
//                             age says little; age relative to its siblings exposes a
//                             generator that is in CI but gated behind a freshness flag
//                             it can never satisfy. (Trending Value and Compounders sat
//                             frozen 6 days while 19 sibling pages refreshed.)
//   Q. INTERFACE DRIFT      — third-party rot: package-lock out of sync with package.json
//                             (CI's npm ci then fails outright), a dependency a major behind,
//                             a hardcoded AI model ID outside lib/ai-providers.js, or a
//                             known-retired upstream identifier still in live code.
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

// Pages and files nobody generates: age says nothing about correctness, so exclude them
// from the staleness check rather than raising a HIGH finding every single night.
const HAND_MAINTAINED = new Set(['hub.html', 'playbook.html', 'trades.html']);

// RETIRED pages: their generators were deleted and their nav links removed, but the
// built HTML is kept so old bookmarks and external links do not 404. Nothing rebuilds
// them, so age is expected rather than a finding — flagging them nightly would train
// you to skim past the HIGH lines, which is how the 6-day freeze went unnoticed.
const RETIRED_PAGES = new Set(['breakout.html', 'potential.html']);

// ── C: stale committed artifacts ─────────────────────────────────────────────
const gitDate = (rel) => {
  try { return execSync(`git log -1 --format=%ad --date=short -- ${rel}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};
const today = new Date();
for (const f of fs.existsSync(DOCS) ? fs.readdirSync(DOCS) : []) {
  if (!/\.(json|html)$/.test(f)) continue;
  if (/^(score-lab|factor-lab|dataset-summary|exchange-map|earnings-quality|pipeline-audit|ai-research-audit)\.json$/.test(f)) continue; // locally-produced, may lag by design
  // Sidecars of RETIRED pages. Nothing generates these any more, so age is not
  // staleness — they only survive as a fallback for old deploys (see the `fallback:`
  // entries in generate-confluence.js and lib/features.js). Flagging them HIGH every
  // night trains you to ignore the HIGH line, which is worse than the finding.
  if (/^(breakout-tickers|potential-tickers)\.json$/.test(f)) continue;
  if (HAND_MAINTAINED.has(f)) continue;   // nothing generates these, so age is not staleness
  const d = gitDate(`docs/${f}`);
  if (!d) { add('LOW', 'C never committed', `docs/${f}`, 'exists locally but has no commit — CI may not know about it'); continue; }
  const age = Math.round((today - new Date(d)) / 864e5);
  if (age > STALE_DAYS) add(age > 45 ? 'HIGH' : 'MED', 'C stale artifact', `docs/${f}`, `last committed ${d} (${age} days ago)`);
}

// ── D: fail-open filters ─────────────────────────────────────────────────────
// `x == null || x >= LIMIT` is only a BUG in an ACCEPT context (a .filter() predicate or
// an &&-chained qualifier), where a missing value silently passes the very check meant to
// stop it. In a REJECT context — `if (x == null || x < LIMIT) return false / continue` —
// the same shape is correct and fails closed. The first version of this check couldn't
// tell them apart and reported 19 findings of which only 4 were real, so it now looks at
// what the guard controls.
for (const f of fs.readdirSync(ROOT).filter(x => /\.js$/.test(x)).concat(fs.readdirSync(path.join(ROOT, 'lib')).map(x => 'lib/' + x))) {
  const src = read(path.join(ROOT, f));
  for (const m of src.matchAll(/(\w+(?:\.\w+)*)\s*==\s*null\s*\|\|\s*\1\s*[<>]=?/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    const lineText = src.split('\n')[line - 1] || '';
    const after = src.slice(m.index, m.index + 220);
    if (/^\s*(\/\/|\*)/.test(lineText)) continue;                 // a comment about the pattern
    // `audit-ok: reason` marks a site a human has reviewed and judged correct. Findings
    // nobody can silence get ignored wholesale, which is worse than a slightly shorter list.
    if (/audit-ok:/.test(lineText) || /audit-ok:/.test(src.split('\n')[line - 2] || '')) continue;
    const rejects = /\)\s*(return\s+(false|null|undefined)|continue|break)/.test(after)
      || /\breturn\s+(false|null)\b/.test(after.split('\n')[0] || '');
    if (rejects) continue;                                          // fails closed — correct
    add('MED', 'D fail-open filter', `${f}:${line}`,
      `"${m[0].slice(0, 46)}…" in an ACCEPT context — a MISSING value passes the check meant to stop it`);
  }
}

// ── E/F: data-source hazards ─────────────────────────────────────────────────
for (const f of fs.readdirSync(ROOT).filter(x => /\.js$/.test(x))) {
  const src = read(path.join(ROOT, f));
  // Ignore comment lines — every remaining mention is a note explaining WHY the API is
  // deprecated, and flagging your own documentation is how a checker loses credibility.
  const codeOnly = src.replace(/^[ \t]*(\/\/|\*).*$/gm, '');
  const dep = [...codeOnly.matchAll(/yahooFinance\.historical\(|yf\.historical\(/g)].length;
  if (dep) add('LOW', 'E deprecated yahoo api', f, `${dep} call(s) to historical(); chart() is the endpoint that works for index symbols`);
  // Three files legitimately hardcode .NS: the resolver itself, the probe that BUILDS the
  // exchange map, and a scratch script of literal example symbols.
  const NS_EXEMPT = new Set(['fetch-exchange-map.js', 'explore-sources.js']);
  const ns = NS_EXEMPT.has(f) ? 0 : [...src.matchAll(/\+\s*['"]\.NS['"]/g)].length;
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

// ── J: pages that display prices with no way to refresh them ──────────────────
// Checked on the GENERATOR, not the built page: a page built before the fix landed is a
// STALENESS problem (class C), not a missing-refresh problem, and conflating the two
// produced 15 false alarms the first time this check ran.
// A generator is fine if it does any of: emits data-live-px, includes the shared
// stock-actions bundle (which ships the browser-side refresher), or fetches the feed itself.
const PRICE_WORDS = /fmtPrice|toLocaleString\('en-IN'|₹/;
for (const g of generators) {
  const src = read(path.join(ROOT, g));
  if (!src || !PRICE_WORDS.test(src)) continue;               // page shows no prices
  const page = (src.match(/OUTPUT_PATH\s*=.*['"]([a-z0-9._-]+\.html)['"]/i) || [])[1]
    || (src.match(/docs['"\s,]+['"]([a-z0-9._-]+\.html)/i) || [])[1];
  const tags   = /data-live-px/.test(src);
  // any route to the shared refresher: the full bundle, or livePriceJs under any alias
  const shared = /stockActions\.js\b|livePriceJs|PX_JS/.test(src);
  const own    = /live-prices\.json/.test(src) && /fetch\(/.test(src);
  if (tags || shared || own) continue;
  add('HIGH', 'J no price refresh', g,
    `${page || 'its page'} displays prices with no refresh path (no data-live-px, no shared stock-actions bundle, no own fetch) — frozen at build time`);
}

// ── K: live-price coverage per page ───────────────────────────────────────────
{
  let feed = null;
  try { feed = new Set(Object.keys(JSON.parse(read(path.join(DOCS, 'live-prices.json'))).prices || {})); } catch { feed = null; }
  if (feed && feed.size > 20) {
    const SIDECARS = ['confluence-tickers.json', 'bestpicks-tickers.json', 'multibagger-tickers.json',
      'apex-tickers.json', 'creamy-tickers.json', 'indianresearch-tickers.json', 'rocket-tickers.json',
      'investors-tickers.json', 'breakout2-data.json'];
    for (const f of SIDECARS) {
      let rows = null;
      try { const j = JSON.parse(read(path.join(DOCS, f))); rows = Array.isArray(j) ? j : (j.rows || null); } catch { continue; }
      if (!rows || rows.length < 20) continue;
      const tickers = [...new Set(rows.map(r => r.ticker).filter(Boolean))];
      if (!tickers.length) continue;
      const hit = tickers.filter(t => feed.has(t)).length;
      const pct = Math.round((hit / tickers.length) * 100);
      if (pct < 70) {
        add(pct < 40 ? 'HIGH' : 'MED', 'K price coverage', `docs/${f}`,
          `${hit}/${tickers.length} tickers (${pct}%) have a live price — the rest can only show the EOD price baked in at build time`);
      }
    }
  }
}

// ── L: page copy claiming a statistical property the code may not have ────────
const CLAIMS = [
  [/isotonic|calibrated probability|Calibrated probability/i, /\.calibrated|calibrated\s*[:=]/, 'claims a calibrated/isotonic fit'],
  [/self-learning|learned from|auto-tuned/i, /getMult\(|screener-weights/, 'claims learned weights'],
];
for (const g of generators) {
  const src = read(path.join(ROOT, g));
  if (!src) continue;
  for (const [claimRe, evidenceRe, label] of CLAIMS) {
    if (!claimRe.test(src)) continue;
    if (!evidenceRe.test(src)) {
      add('MED', 'L unbacked claim', g, `${label} but the file never references the mechanism that would provide it`);
      continue;
    }
    // Claims a calibrated fit AND has the flag — does it ever branch on the flag?
    if (/\.calibrated/.test(src) && !/calibrated\s*\?|CAL\.ok|!\s*ctx\.calibrated|calibrated\s*===\s*false/.test(src)) {
      add('HIGH', 'L unbacked claim', g,
        'reads a `calibrated` flag but never branches on it, so an un-fitted fallback would still be presented as calibrated');
    }
  }
}

// ── M: imputed placeholder values reaching statistics ─────────────────────────
for (const f of ['validate-screeners.js', 'score-lab.js', 'factor-lab.js', 'learn-weights.js', 'lib/master-score.js']) {
  const src = read(path.join(ROOT, f));
  if (!src) continue;
  const imputes = /CENSOR_IMPUTED_RET|censored\s*:\s*true/.test(src);
  const guards = /censored\)\s*\{|!\s*r?e?s?\.?censored|res\.censored\s*\)/.test(src);
  if (imputes && !guards) {
    add('HIGH', 'M synthetic in stats', f,
      'writes or consumes an imputed placeholder without ever excluding it from the statistics it feeds');
  }
}

// ── N: starved output (stacked hard AND gates) ────────────────────────────────
{
  const POOL_OF = {
    'triggers.json':   ['breakout2-data.json', 'triggers'],
    'sniper.html':     ['triggers.json', null],
  };
  try {
    const tj = JSON.parse(read(path.join(DOCS, 'triggers.json')));
    const pool = JSON.parse(read(path.join(DOCS, 'breakout2-data.json')));
    const live = (tj.triggers || []).length, armed = (tj.armed || []).length;
    if (Array.isArray(pool) && pool.length >= 50 && live + armed < pool.length * 0.02) {
      add('HIGH', 'N starved output', 'docs/triggers.json',
        `${live} live + ${armed} armed from a pool of ${pool.length} — under 2% survival suggests stacked hard AND gates`);
    }
  } catch { /* files absent */ }
}

// ── O: statistics computed without episode dedup ──────────────────────────────
for (const f of ['lib/master-score.js', 'validate-screeners.js', 'score-lab.js', 'factor-lab.js', 'feature-lab.js', 'exit-lab.js']) {
  const src = read(path.join(ROOT, f));
  if (!src) continue;
  const readsLedger = /screener-outcomes|outcomes\.rows|loadOutcomes/.test(src);
  const computesRate = /beatNifty|\/\s*pts\.length|rate\s*=|median|beat\s*\/|win\s*\//.test(src);
  const dedupes = /dedupe|Episode|nonOverlap|nextOk/i.test(src);
  if (readsLedger && computesRate && !dedupes) {
    add('MED', 'O undeduped statistics', f,
      'computes rates from ledger rows with no episode dedup — a stock re-emitted daily counts once per day, inflating n');
  }
}

// ── P: dead nav links ─────────────────────────────────────────────────────────
for (const f of (fs.existsSync(DOCS) ? fs.readdirSync(DOCS) : []).filter(x => /\.html$/.test(x))) {
  const html = read(path.join(DOCS, f));
  const links = [...new Set([...html.matchAll(/href="([a-z0-9._-]+\.html)"/g)].map(m => m[1]))];
  const dead = links.filter(l => !fs.existsSync(path.join(DOCS, l)));
  if (dead.length) add('MED', 'P dead page link', `docs/${f}`, `links to missing page(s): ${dead.join(', ')}`);
}

// ── H: orphaned sidecars ─────────────────────────────────────────────────────
const allSrc = fs.readdirSync(ROOT).filter(x => /\.js$/.test(x)).map(x => read(path.join(ROOT, x))).join('\n')
  + fs.readdirSync(path.join(ROOT, 'lib')).map(x => read(path.join(ROOT, 'lib', x))).join('\n');
for (const f of (fs.existsSync(DOCS) ? fs.readdirSync(DOCS) : []).filter(x => /\.json$/.test(x))) {
  const refs = allSrc.split(f).length - 1;
  if (refs === 0) add('LOW', 'H orphaned sidecar', `docs/${f}`, 'no source file references this filename — dead artifact?');
}

// ── R: page stale RELATIVE to its siblings ───────────────────────────────────
// Check C only fires at STALE_DAYS (14), and check A only asks whether a generator
// appears in a workflow at all. Neither catches the real failure mode: a generator
// that IS in CI but is gated behind a freshness flag it can never satisfy.
//
// Exactly that happened to Trending Value and the compounder cohort. Both ran only
// in daily-refresh, whose guard was keyed on docs/index.html — which market-refresh
// rebuilds every 10 minutes. So the guard read "pages already fresh" every morning
// and skipped them every day. They sat frozen 20-26 Aug while 19 sibling pages
// refreshed around them, and nothing complained because 6 days < 14.
//
// A page much older than its siblings is the signature. Absolute age says nothing;
// age relative to pages built by the same pipeline says a lot.
{
  const REL_DAYS = 3;
  const ages = [];
  for (const f of (fs.existsSync(DOCS) ? fs.readdirSync(DOCS) : []).filter(x => /\.html$/.test(x))) {
    if (HAND_MAINTAINED.has(f) || RETIRED_PAGES.has(f)) continue;
    const d = gitDate(`docs/${f}`);
    if (!d) continue;
    const age = Math.round((today - new Date(d)) / 864e5);
    ages.push({ f, age, d });
  }
  if (ages.length >= 5) {
    // Median, not min: one page rebuilt seconds ago should not make everything look stale.
    const sorted = ages.map(a => a.age).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    for (const a of ages) {
      if (a.age - median >= REL_DAYS) {
        add('HIGH', 'R stale vs siblings', `docs/${a.f}`,
          `last built ${a.age}d ago (${a.d}) while the median page is ${median}d old — a generator in CI but gated behind a freshness flag it cannot satisfy looks exactly like this`);
      }
    }
  }
}

// ── Q: external interface drift ──────────────────────────────────────────────
// Every outage this repo has had from a third party looked the same: something
// upstream was retired, nothing here errored loudly, and a page or a feature just
// went quiet. Yahoo's .historical() killed 11 of 14 sector indices. Groq retiring
// llama-3.3-70b broke the 🧠 button on every page. Both were only noticed by a
// human clicking. These are the cheap mechanical checks for the same class.
{
  // Q1 — the lockfile MUST satisfy package.json, or CI's `npm ci` fails outright
  // and every workflow dies. A version bump without a lock update does exactly that.
  try {
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
    const lock = JSON.parse(read(path.join(ROOT, 'package-lock.json')));
    const decl = (lock.packages && lock.packages[''] && lock.packages[''].dependencies) || {};
    for (const [name, range] of Object.entries(pkg.dependencies || {})) {
      if (decl[name] !== range) {
        add('HIGH', 'Q interface drift', `package-lock.json (${name})`,
          `package.json wants "${range}" but the lock declares "${decl[name] || 'nothing'}" — CI runs npm ci, which will FAIL. Run: npm install --package-lock-only`);
      }
    }
  } catch { /* no manifest */ }

  // Q2 — client libraries whose installed version is a MAJOR behind. Not urgent on
  // its own, but this is the list that goes stale invisibly between sweeps.
  try {
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
    for (const name of Object.keys(pkg.dependencies || {})) {
      const p = path.join(ROOT, 'node_modules', name, 'package.json');
      if (!fs.existsSync(p)) continue;
      const installed = JSON.parse(read(p)).version || '';
      const want = String(pkg.dependencies[name]).replace(/^[^0-9]*/, '');
      const maj = v => parseInt(String(v).split('.')[0], 10);
      if (maj(installed) < maj(want)) {
        add('MED', 'Q interface drift', `node_modules/${name}`,
          `installed ${installed} but package.json wants ${pkg.dependencies[name]} — run npm install`);
      }
    }
  } catch { /* skip */ }

  // Q3 — hardcoded AI model IDs outside the one registry. This is what made the
  // Groq shutdown a ten-file edit instead of one.
  const MODEL_RE = /['"](?:openai\/|qwen\/|groq\/|google\/|meta-llama\/|mistralai\/)?[a-z0-9.]+(?:-[a-z0-9.]+)*(?:-\d+b|-flash|-flash-lite|-versatile|-instruct)[a-z0-9.:\-]*['"]/;
  for (const f of fs.readdirSync(ROOT).filter(x => /^generate-.*\.js$/.test(x))) {
    const src = read(path.join(ROOT, f));
    if (!/DR_PROVIDERS|DR_SIMPLE/.test(src)) continue;
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/audit-ok:/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
      if (/models\s*:\s*\[/.test(line) || (/model\s*:\s*['"]/.test(line) && MODEL_RE.test(line))) {
        add('HIGH', 'Q interface drift', `${f}:${i + 1}`,
          'hardcoded AI model ID — belongs in lib/ai-providers.js, or the next provider deprecation is a multi-file edit again');
      }
    });
  }

  // Q4 — known-retired upstream identifiers still referenced in live code.
  const RETIRED = [
    [/llama-3\.3-70b-versatile|llama3-8b-8192|mixtral-8x7b-32768|llama-3\.1-8b-instant/, 'Groq model retired (Aug 2026 / Mar 2025)'],
    [/gemini-2\.0-flash|gemini-1\.5-flash|gemini-3-pro-preview/, 'Gemini model shut down'],
    [/\.historical\s*\(/, 'yahoo-finance2 .historical() is deprecated and returns nothing for many symbols — use history() from lib/yahoo.js'],
    [/vnd\.github\.v3\+json/, 'legacy GitHub REST accept header — use application/vnd.github+json'],
  ];
  const srcFiles = [
    ...fs.readdirSync(ROOT).filter(x => /\.js$/.test(x)).map(x => [x, path.join(ROOT, x)]),
    ...fs.readdirSync(path.join(ROOT, 'lib')).map(x => [`lib/${x}`, path.join(ROOT, 'lib', x)]),
  ];
  for (const [label, p] of srcFiles) {
    if (/^audit-pipeline\.js$/.test(label)) continue;          // this file names them on purpose
    // Tests name retired identifiers as FIXTURES — asserting they never come back is
    // the point of test-ai-providers.js. Flagging them here inverts the check.
    if (/^test-/.test(label)) continue;
    const src = read(p);
    src.split('\n').forEach((line, i) => {
      if (/audit-ok:/.test(line)) return;
      // Strip comments before matching. These identifiers legitimately appear in
      // prose explaining WHY they were removed — and a trailing comment on a live
      // line ("require('./lib/yahoo'); // .historical() is deprecated") is the
      // common shape, so a start-of-line test alone flagged 13 files that were
      // already correct. Only code counts.
      const code = line.replace(/^\s*\*.*$/, '').replace(/(^|[^:])\/\/.*$/, '$1');
      if (!code.trim()) return;
      for (const [re, why] of RETIRED) {
        if (re.test(code)) add('MED', 'Q interface drift', `${label}:${i + 1}`, why);
      }
    });
  }
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

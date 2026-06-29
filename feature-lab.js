'use strict';

// Feature Lab — walk-forward validation of every Best Picks feature.
//
// Joins point-in-time feature values (feature-history.jsonl, written by
// generate-bestpicks.js) with realized forward returns (screener-outcomes.json,
// filled by validate-screeners.js) and measures each feature's edge:
//   - IC  : Spearman rank correlation between feature value and 20d forward alpha
//   - recentIC : same over a recent rolling window (concept-drift detector)
//   - tStat, hit-rate / median-alpha of the top tercile, sample size n
// Writes docs/feature-report.json with a LIVE / SHADOW / INSUFFICIENT verdict per
// feature. learn-weights.js consumes this to gate live weights.
//
// This is the durable, always-available validation path: it needs no network and
// strengthens automatically as feature-history.jsonl accumulates.

const fs   = require('fs');
const path = require('path');
const { REGISTRY } = require('./lib/feature-registry');

const FHIST_PATH  = path.join(__dirname, 'feature-history.jsonl');
const OUT_PATH    = path.join(__dirname, 'docs', 'feature-report.json');
const OUTCOMES    = path.join(__dirname, 'screener-outcomes.json');

const CONFIG = { horizon: '20d', minN: 60, minIC: 0.03, minT: 1.5, recentWindow: 150 };

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

function rank(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num0 = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num0 += x * y; da += x * x; db += y * y; }
  const den = Math.sqrt(da * db);
  return den ? num0 / den : null;
}
function spearman(a, b) { return pearson(rank(a), rank(b)); }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

function loadHistory() {
  if (!fs.existsSync(FHIST_PATH)) return [];
  // Dedupe by date|ticker (keep the last snapshot) so accidental same-day reruns
  // don't double-count and bias the IC.
  const byKey = new Map();
  for (const line of fs.readFileSync(FHIST_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const r = JSON.parse(t); if (r && r.date && r.ticker) byKey.set(`${r.date}|${r.ticker}`, r); } catch { /* skip */ }
  }
  return Array.from(byKey.values());
}

// Map date|ticker -> realized 20d alpha / beatNifty from the outcomes ledger (bestpicks rows).
function loadForward() {
  const m = new Map();
  if (!fs.existsSync(OUTCOMES)) return m;
  let data; try { data = JSON.parse(fs.readFileSync(OUTCOMES, 'utf8')); } catch { return m; }
  for (const r of (data.rows || [])) {
    if (r.screener !== 'bestpicks') continue;
    const res = r.results && r.results[CONFIG.horizon];
    if (!res || res.alpha == null) continue;
    m.set(`${r.date}|${r.ticker}`, { alpha: res.alpha, beat: res.beatNifty ? 1 : 0 });
  }
  return m;
}

function evalFeature(id, pairs) {
  // pairs: [{ v, alpha, beat, date }]
  const clean = pairs.filter(p => num(p.v) != null && num(p.alpha) != null);
  const n = clean.length;
  if (n < CONFIG.minN) return { n, ic: null, recentIC: null, tStat: null, hitRateTop: null, medAlphaTop: null, verdict: 'INSUFFICIENT' };
  const vs = clean.map(p => p.v), as = clean.map(p => p.alpha);
  const ic = spearman(vs, as);
  const tStat = (ic != null) ? +(ic * Math.sqrt((n - 2) / Math.max(1e-6, 1 - ic * ic))).toFixed(2) : null;
  // recent window by date order
  const recent = clean.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-CONFIG.recentWindow);
  const recentIC = recent.length >= 30 ? spearman(recent.map(p => p.v), recent.map(p => p.alpha)) : null;
  // top tercile by feature value
  const sorted = clean.slice().sort((a, b) => b.v - a.v);
  const top = sorted.slice(0, Math.max(1, Math.floor(n / 3)));
  const hitRateTop = +(top.reduce((s, p) => s + p.beat, 0) / top.length * 100).toFixed(1);
  const medAlphaTop = +median(top.map(p => p.alpha)).toFixed(2);
  const passes = ic != null && ic >= CONFIG.minIC && tStat != null && tStat >= CONFIG.minT;
  return {
    n, ic: ic != null ? +ic.toFixed(3) : null, recentIC: recentIC != null ? +recentIC.toFixed(3) : null,
    tStat, hitRateTop, medAlphaTop, verdict: passes ? 'LIVE' : 'SHADOW',
  };
}

function main() {
  console.log('Feature Lab — walk-forward validation');
  const hist = loadHistory();
  const fwd = loadForward();
  console.log(`  feature-history rows: ${hist.length} | matured bestpicks outcomes: ${fwd.size}`);

  const features = {};
  for (const F of REGISTRY) {
    const pairs = [];
    for (const h of hist) {
      const key = `${h.date}|${h.ticker}`;
      const f = fwd.get(key);
      if (!f || !h.feat) continue;
      const v = num(h.feat[F.id]);
      if (v == null) continue;
      pairs.push({ v, alpha: f.alpha, beat: f.beat, date: h.date });
    }
    features[F.id] = { block: F.block, label: F.label, ...evalFeature(F.id, pairs) };
  }

  const live = [], shadow = [], insufficient = [];
  for (const [id, r] of Object.entries(features)) {
    (r.verdict === 'LIVE' ? live : r.verdict === 'SHADOW' ? shadow : insufficient).push(id);
  }

  const out = { generatedAt: new Date().toISOString(), horizon: CONFIG.horizon, config: CONFIG, features, summary: { live, shadow, insufficient } };
  if (!fs.existsSync(path.dirname(OUT_PATH))) fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`  LIVE: ${live.length} | SHADOW: ${shadow.length} | INSUFFICIENT: ${insufficient.length}`);
  console.log(`  Wrote ${OUT_PATH}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('feature-lab error:', e); process.exit(1); }
}
module.exports = { main, CONFIG };

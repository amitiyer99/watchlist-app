'use strict';

// ── Score Lab ─────────────────────────────────────────────────────────────────
// Asks one question of every page in this system: DOES ITS SCORE ACTUALLY RANK?
//
// A screener can have positive average alpha and still be broken, if its score
// doesn't sort winners above losers — you'd be reading the list top-down and
// systematically picking the worst names. That is exactly what we found by hand:
// confluence's USS ranked INVERSELY (USS 40-59 => -6.4% median alpha vs -2.2% for
// USS <25) and triggers' conviction did too at the top end. This harness turns that
// one-off check into a standing measurement across all screeners.
//
// Method (deliberately conservative):
//   • only matured 20d results with a computable alpha
//   • NON-OVERLAPPING episode dedup per (screener, signalType, ticker) — a stock
//     re-emitted daily produces ~95% overlapping forward windows, which would
//     otherwise inflate n and fake significance (same rule as validate-screeners)
//   • per score bucket: n, median alpha, beat-Nifty rate
//   • verdict from Spearman rank correlation between score and alpha
//     (+0.10 or better = PREDICTIVE, -0.10 or worse = INVERTED, else FLAT)
//   • also buckets by an EXTENSION proxy (entry vs pivot) to test the crowding
//     hypothesis: are high scores just picking names that already ran?
//
// Usage: node score-lab.js  [--min-n=20]   → prints tables, writes docs/score-lab.json

const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, 'screener-outcomes.json');
const OUT    = path.join(__dirname, 'docs', 'score-lab.json');
const HORIZON = '20d';

function addTradingDays(from, n) {
  const d = new Date(from); let c = 0;
  while (c < n) { d.setDate(d.getDate() + 1); if (d.getDay() >= 1 && d.getDay() <= 5) c++; }
  return d;
}
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Spearman: correlate ranks, so it measures ordering not magnitude.
function spearman(pairs) {
  const n = pairs.length;
  if (n < 8) return null;
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {           // average ties
      let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(pairs.map(p => p[0])), ry = rank(pairs.map(p => p[1]));
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? +(num / Math.sqrt(dx * dy)).toFixed(3) : null;
}

// Keep only the first signal per ticker-episode: a new episode starts once the
// previous 20-day window has fully matured.
function dedupeEpisodes(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.screener}|${r.signalType}|${r.ticker}`;
    (byKey.get(k) || byKey.set(k, []).get(k)).push(r);
  }
  const out = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => new Date(a.date) - new Date(b.date));
    let nextOk = null;
    for (const r of list) {
      const d = new Date(r.date);
      if (nextOk == null || d >= nextOk) { out.push(r); nextOk = addTradingDays(d, 20); }
    }
  }
  return out;
}

function bucketStats(rows, bucketFn, order) {
  const groups = {};
  for (const r of rows) {
    const b = bucketFn(r);
    if (b == null) continue;
    (groups[b] = groups[b] || []).push(r.results[HORIZON].alpha);
  }
  const labels = order || Object.keys(groups).sort();
  return labels.map(l => {
    const a = groups[l] || [];
    return {
      bucket: l, n: a.length,
      medianAlpha: a.length ? +median(a).toFixed(2) : null,
      beatRate: a.length ? +((a.filter(x => x > 0).length / a.length) * 100).toFixed(0) : null,
    };
  });
}

function scoreBuckets(s) {
  if (s == null) return null;
  if (s >= 80) return 'F 80+';
  if (s >= 65) return 'E 65-79';
  if (s >= 50) return 'D 50-64';
  if (s >= 35) return 'C 35-49';
  if (s >= 20) return 'B 20-34';
  return 'A <20';
}
const SCORE_ORDER = ['A <20', 'B 20-34', 'C 35-49', 'D 50-64', 'E 65-79', 'F 80+'];

// Extension proxy: how far above the pivot was the entry taken?
function extBucket(r) {
  const e = r.entry, p = r.pivot;
  if (e == null || p == null || !(p > 0)) return null;
  const pct = ((e - p) / p) * 100;
  if (pct < 0) return '1 below pivot';
  if (pct < 2) return '2 at pivot (0-2%)';
  if (pct < 5) return '3 mild (2-5%)';
  if (pct < 10) return '4 extended (5-10%)';
  return '5 chased (10%+)';
}
const EXT_ORDER = ['1 below pivot', '2 at pivot (0-2%)', '3 mild (2-5%)', '4 extended (5-10%)', '5 chased (10%+)'];

function verdict(rho) {
  if (rho == null) return 'INSUFFICIENT';
  if (rho >= 0.10) return 'PREDICTIVE';
  if (rho <= -0.10) return 'INVERTED';
  return 'FLAT';
}

function main() {
  const minN = parseInt(((process.argv.find(a => a.startsWith('--min-n=')) || '').split('=')[1]) || '20', 10);
  const d = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  // Exclude CENSORED rows: their alpha is an imputed placeholder for a ticker whose
  // price could not be fetched, not an observed outcome. Including them made Debate
  // look like -2.59% when the observed figure was -0.52%.
  const all = (d.rows || []).filter(r => r.results && r.results[HORIZON]
    && r.results[HORIZON].alpha != null && !r.results[HORIZON].censored);
  console.log('🔬 Score Lab — does each page\'s score actually rank outcomes?');
  console.log(`   ledger: ${all.length} matured ${HORIZON} rows with alpha · min bucket n=${minN}\n`);

  const screeners = [...new Set(all.map(r => r.screener))].sort();
  const report = {};

  for (const scr of screeners) {
    const raw = all.filter(r => r.screener === scr);
    const rows = dedupeEpisodes(raw);
    const scored = rows.filter(r => r.score != null);
    const rho = spearman(scored.map(r => [r.score, r.results[HORIZON].alpha]));
    const v = verdict(rho);
    const overall = median(rows.map(r => r.results[HORIZON].alpha));

    console.log(`── ${scr.toUpperCase()}  (episodes ${rows.length}, raw ${raw.length})  medAlpha ${overall != null ? overall.toFixed(2) : '—'}  rank-corr ${rho == null ? 'n/a' : rho}  → ${v}`);
    const sb = bucketStats(scored, r => scoreBuckets(r.score), SCORE_ORDER).filter(b => b.n > 0);
    for (const b of sb) {
      const flag = b.n < minN ? '  (thin)' : '';
      console.log(`     score ${b.bucket.padEnd(9)} n=${String(b.n).padEnd(5)} medAlpha=${String(b.medianAlpha).padEnd(7)} beat=${b.beatRate}%${flag}`);
    }
    const eb = bucketStats(rows, extBucket, EXT_ORDER).filter(b => b.n > 0);
    if (eb.length > 1) {
      console.log('     — by entry extension vs pivot —');
      for (const b of eb) console.log(`     ${b.bucket.padEnd(19)} n=${String(b.n).padEnd(5)} medAlpha=${String(b.medianAlpha).padEnd(7)} beat=${b.beatRate}%${b.n < minN ? '  (thin)' : ''}`);
    }
    console.log('');
    report[scr] = { episodes: rows.length, rawRows: raw.length, medianAlpha: overall != null ? +overall.toFixed(2) : null, rankCorr: rho, verdict: v, scoreBuckets: sb, extensionBuckets: eb };
  }

  // Cross-screener extension view — is chasing bad everywhere?
  const allRows = dedupeEpisodes(all);
  const globalExt = bucketStats(allRows, extBucket, EXT_ORDER).filter(b => b.n > 0);
  console.log('══ ALL SCREENERS, by entry extension vs pivot ══');
  for (const b of globalExt) console.log(`   ${b.bucket.padEnd(19)} n=${String(b.n).padEnd(5)} medAlpha=${String(b.medianAlpha).padEnd(7)} beat=${b.beatRate}%`);

  const payload = { generatedAt: new Date().toISOString(), horizon: HORIZON, minN, screeners: report, globalExtension: globalExt };
  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\n   Wrote ${OUT}`);
  console.log('   PREDICTIVE = score sorts winners on top · FLAT = score adds no ordering · INVERTED = reading top-down picks the worst names.');
}

if (require.main === module) main();
module.exports = { spearman, dedupeEpisodes, scoreBuckets, extBucket, verdict };

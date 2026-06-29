'use strict';

// Render the per-screener "track record" section consumed by both confluence.html
// and index.html. Reads docs/screener-stats.json (produced by validate-screeners.js).
// Returns an HTML string (empty when no stats available).

const fs   = require('fs');
const path = require('path');
const weightsLib = require('./weights');

const STATS_PATH = path.join(__dirname, '..', 'docs', 'screener-stats.json');
const FEATURE_REPORT_PATH = path.join(__dirname, '..', 'docs', 'feature-report.json');

const SCREENER_LABELS = {
  apex:       'APEX',
  breakout2:  'Breakout',
  triggers:   'Triggers',
  debate:     'Debate',
  confluence: 'Confluence',
  prediction: 'Prediction',
};

function loadStats() {
  try {
    if (!fs.existsSync(STATS_PATH)) return null;
    return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
  } catch { return null; }
}

function flagBadge(flag) {
  if (flag === 'PROMOTE') return '<span class="sr-flag sr-promote">PROMOTE</span>';
  if (flag === 'DEMOTE')  return '<span class="sr-flag sr-demote">DEMOTE</span>';
  return '<span class="sr-flag sr-neutral">NEUTRAL</span>';
}

function num(v, suffix = '', digits = 1) {
  if (v == null || isNaN(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return sign + Number(v).toFixed(digits) + suffix;
}

function styles() {
  return `<style id="sr-styles">
  .sr-section{background:var(--s1,#12121a);border:1px solid var(--bd,#23232f);border-radius:10px;margin:18px 0;padding:14px 16px;color:var(--t1,#e4e4ea);font-family:system-ui,sans-serif}
  .sr-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:8px}
  .sr-head h3{margin:0;font-size:1rem;display:flex;align-items:center;gap:8px}
  .sr-meta{color:var(--t2,#9a9aa6);font-size:.72rem}
  .sr-tbl{width:100%;border-collapse:collapse;font-size:.82rem}
  .sr-tbl th{text-align:left;color:#7dd3fc;font-weight:700;font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px;border-bottom:1px solid var(--bd,#23232f)}
  .sr-tbl td{padding:8px;border-bottom:1px solid var(--bd,#23232f);font-variant-numeric:tabular-nums}
  .sr-pos{color:#22c55e}
  .sr-neg{color:#ef4444}
  .sr-dim{color:var(--t3,#6a6a82)}
  .sr-flag{display:inline-block;font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:4px;letter-spacing:.04em}
  .sr-promote{background:rgba(34,197,94,.18);color:#22c55e;border:1px solid rgba(34,197,94,.4)}
  .sr-demote{background:rgba(239,68,68,.18);color:#ef4444;border:1px solid rgba(239,68,68,.4)}
  .sr-neutral{background:rgba(156,163,175,.18);color:#9ca3af;border:1px solid rgba(156,163,175,.4)}
  .sr-empty{padding:14px;color:var(--t2,#9a9aa6);font-size:.85rem;text-align:center}
  </style>`;
}

// Adaptive Weights transparency panel — shows the learned multiplier each page is
// currently applying (from screener-weights.json), so the self-learning is visible
// and auditable. Renders nothing when no weights file exists yet.
function multCls(v) { return v > 1.001 ? 'sr-pos' : v < 0.999 ? 'sr-neg' : 'sr-dim'; }

function renderWeightsSection() {
  let w = null;
  try { w = weightsLib.load(); } catch { w = null; }
  if (!w || !w.weights) return '';

  const order = ['confluence', 'apex', 'triggers', 'breakout2', 'debate'];
  const prov = w.provenance || {};
  const rows = [];
  for (const sc of order) {
    const bucket = w.weights[sc];
    if (!bucket) continue;
    const sigs = Object.keys(bucket).sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b)));
    for (const sig of sigs) {
      const mult = bucket[sig];
      const p = prov[`${sc}|${sig}`];
      rows.push(`<tr>
        <td><b>${SCREENER_LABELS[sc] || sc}</b></td>
        <td class="sr-dim">${sig === '*' ? 'overall' : sig}</td>
        <td class="${multCls(mult)}">${Number(mult).toFixed(3)}&times;</td>
        <td class="sr-dim">${p ? p.reason : ''}</td>
      </tr>`);
    }
  }
  // Sizing tunables + prediction calibration flag
  if (w.signals) {
    rows.push(`<tr><td><b>Sizing</b></td><td class="sr-dim">target R:R</td><td class="sr-dim">${w.signals.targetRRMult}</td><td class="sr-dim">stop ATR&times; ${w.signals.stopAtrMult}</td></tr>`);
  }
  if (w.weights.prediction) {
    const cal = w.weights.prediction.calibrated ? 'calibrated' : 'default weights';
    rows.push(`<tr><td><b>Prediction</b></td><td class="sr-dim">sector model</td><td class="sr-dim">self-calibrated</td><td class="sr-dim">${cal}</td></tr>`);
  }
  if (!rows.length) return '';

  const ts = w.generatedAt ? new Date(w.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '';
  return `<section class="sr-section">
    <div class="sr-head">
      <h3>⚖️ Adaptive Weights <span class="sr-meta" style="font-weight:400">(auto-tuned from realized returns · clamped 0.5&ndash;1.5&times;)</span></h3>
      <div class="sr-meta">updated ${ts} IST</div>
    </div>
    <table class="sr-tbl">
      <thead><tr><th>Page</th><th>Signal</th><th>Weight</th><th>Basis</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  </section>`;
}

function renderStatsSection({ title = 'Screener Track Record (20-day forward return)', emptyMsg = 'No matured outcomes yet — the validator runs nightly; per-screener hit rate and alpha vs Nifty will appear here after the first 5-trading-day cohort.' } = {}) {
  const stats = loadStats();
  const weightsHtml = renderWeightsSection();
  if (!stats || !stats.summary || !Object.keys(stats.summary).length) {
    return `${styles()}<section class="sr-section">
      <div class="sr-head"><h3>📊 ${title}</h3></div>
      <div class="sr-empty">${emptyMsg}</div>
    </section>${weightsHtml}`;
  }

  const screeners = Object.keys(stats.summary).sort((a, b) => {
    const aa = stats.summary[a].medianAlpha20d ?? -999;
    const bb = stats.summary[b].medianAlpha20d ?? -999;
    return bb - aa;
  });

  const rows = screeners.map(k => {
    const s = stats.summary[k];
    const alphaCls = s.medianAlpha20d == null ? 'sr-dim' : s.medianAlpha20d > 0 ? 'sr-pos' : 'sr-neg';
    const retCls   = s.medianRet20d   == null ? 'sr-dim' : s.medianRet20d   > 0 ? 'sr-pos' : 'sr-neg';
    return `<tr>
      <td><b>${SCREENER_LABELS[k] || k}</b></td>
      <td>${s.count}</td>
      <td>${s.hitRate20d != null ? s.hitRate20d + '%' : '—'}</td>
      <td class="${retCls}">${num(s.medianRet20d, '%')}</td>
      <td class="${alphaCls}">${num(s.medianAlpha20d, '%')}</td>
      <td>${flagBadge(s.flag)}</td>
    </tr>`;
  }).join('');

  const ts = new Date(stats.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  return `${styles()}<section class="sr-section">
    <div class="sr-head">
      <h3>📊 ${title}</h3>
      <div class="sr-meta">${stats.totalOutcomes} signals logged · validated ${ts} IST</div>
    </div>
    <table class="sr-tbl">
      <thead><tr>
        <th>Screener</th>
        <th>Matured</th>
        <th>Hit Rate</th>
        <th>Median Return</th>
        <th>Median α vs Nifty</th>
        <th>Verdict</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>${weightsHtml}`;
}

// Feature Lab panel — shows each Best Picks feature's validated edge and whether
// it is currently LIVE (earning weight), SHADOW (failed/decayed -> demoted), or
// INSUFFICIENT (not enough matured data yet). Renders nothing until the report exists.
function renderFeatureLabSection() {
  let rep = null;
  try { if (fs.existsSync(FEATURE_REPORT_PATH)) rep = JSON.parse(fs.readFileSync(FEATURE_REPORT_PATH, 'utf8')); } catch { rep = null; }
  if (!rep || !rep.features) return '';
  const order = { LIVE: 0, SHADOW: 1, INSUFFICIENT: 2 };
  const rows = Object.entries(rep.features)
    .sort((a, b) => (order[a[1].verdict] - order[b[1].verdict]) || ((b[1].ic || -9) - (a[1].ic || -9)))
    .map(([id, f]) => {
      const badge = f.verdict === 'LIVE' ? '<span class="sr-flag sr-promote">LIVE</span>'
        : f.verdict === 'SHADOW' ? '<span class="sr-flag sr-demote">SHADOW</span>'
        : '<span class="sr-flag sr-neutral">PENDING</span>';
      const icCls = f.ic == null ? 'sr-dim' : f.ic > 0 ? 'sr-pos' : 'sr-neg';
      return `<tr>
        <td><b>${f.label || id}</b> <span class="sr-dim">${f.block || ''}</span></td>
        <td>${f.n || 0}</td>
        <td class="${icCls}">${f.ic == null ? '—' : f.ic}</td>
        <td class="sr-dim">${f.recentIC == null ? '—' : f.recentIC}</td>
        <td>${f.hitRateTop != null ? f.hitRateTop + '%' : '—'}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('');
  const ts = rep.generatedAt ? new Date(rep.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '';
  const sm = rep.summary || {};
  return `${styles()}<section class="sr-section">
    <div class="sr-head">
      <h3>🧪 Feature Lab <span class="sr-meta" style="font-weight:400">(walk-forward IC vs ${rep.horizon || '20d'} forward alpha)</span></h3>
      <div class="sr-meta">${(sm.live || []).length} live · ${(sm.shadow || []).length} shadow · ${(sm.insufficient || []).length} pending · ${ts} IST</div>
    </div>
    <table class="sr-tbl">
      <thead><tr><th>Feature</th><th>N</th><th>IC</th><th>Recent IC</th><th>Top-tercile hit</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

module.exports = { loadStats, renderStatsSection, renderWeightsSection, renderFeatureLabSection };

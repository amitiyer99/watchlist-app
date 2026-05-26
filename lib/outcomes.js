'use strict';

// Append-only screener outcome ledger.
// Schema per row:
//   {
//     date: 'YYYY-MM-DD',
//     emittedAt: ISO timestamp,
//     screener: 'triggers' | 'apex' | 'debate' | 'breakout2' | 'confluence' | 'prediction',
//     signalType: e.g. 'BREAKOUT_VALID', 'APEX_BUY', 'DEBATE_HOT', 'CONFLUENCE_USS',
//     ticker: string,
//     name: string|null,
//     sector: string|null,
//     entry: number|null,
//     pivot: number|null,
//     stop: number|null,
//     target: number|null,
//     rr: number|null,
//     sizePct: number|null,
//     score: number|null,           // primary upstream score (totalScore, apex score, USS…)
//     regime: 'BULL'|'BEAR'|null,
//     extras: {…}                   // any per-screener detail (scorecard tags, agent votes, etc.)
//   }
// Outcomes are validated by validate-screeners.js which appends forward-return
// snapshots (5/20/60 trading days).

const fs = require('fs');
const path = require('path');

const OUTCOMES_PATH = path.join(__dirname, '..', 'screener-outcomes.json');

function loadOutcomes() {
  try {
    if (!fs.existsSync(OUTCOMES_PATH)) return { rows: [], updatedAt: null };
    const raw = JSON.parse(fs.readFileSync(OUTCOMES_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.rows)) return { rows: [], updatedAt: raw?.updatedAt ?? null };
    return raw;
  } catch (e) {
    console.warn('outcomes load failed:', e.message);
    return { rows: [], updatedAt: null };
  }
}

function saveOutcomes(data) {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(OUTCOMES_PATH, JSON.stringify(data, null, 2));
}

// Append rows, deduping by (date, screener, signalType, ticker).
// Returns {added, skipped, total}.
function appendOutcomes(newRows) {
  if (!Array.isArray(newRows) || !newRows.length) return { added: 0, skipped: 0, total: 0 };
  const data = loadOutcomes();
  const seen = new Set(data.rows.map(r => `${r.date}|${r.screener}|${r.signalType}|${r.ticker}`));
  let added = 0, skipped = 0;
  for (const r of newRows) {
    if (!r.ticker || !r.date || !r.screener || !r.signalType) { skipped++; continue; }
    const key = `${r.date}|${r.screener}|${r.signalType}|${r.ticker}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    data.rows.push({ emittedAt: new Date().toISOString(), ...r });
    added++;
  }
  saveOutcomes(data);
  return { added, skipped, total: data.rows.length };
}

function todayIST() {
  const d = new Date();
  const offsetMs = (5.5 * 60 - d.getTimezoneOffset()) * 60 * 1000;
  const ist = new Date(d.getTime() + offsetMs);
  return ist.toISOString().slice(0, 10);
}

module.exports = { OUTCOMES_PATH, loadOutcomes, saveOutcomes, appendOutcomes, todayIST };

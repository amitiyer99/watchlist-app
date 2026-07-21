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
const LOCK_PATH = OUTCOMES_PATH + '.lock';
const LOCK_STALE_MS = 20000;  // a process that crashed mid-write shouldn't wedge this forever
const LOCK_WAIT_MS = 15000;   // market-refresh.sh runs generators concurrently — give them room to queue

// Synchronous sleep. appendOutcomes is called synchronously from many generator
// scripts (not awaited), so a real async wait isn't an option here. Atomics.wait
// blocks the calling thread — Node (unlike browsers) allows this on the main
// thread — which is exactly what a short lock-retry backoff needs.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* fall through if Atomics.wait is ever unavailable — busy-loop instead */
    const end = Date.now() + ms; while (Date.now() < end) { /* spin */ }
  }
}

// Cross-process advisory lock via an exclusive-create lockfile. Guards against
// the exact race that used to bite us: market-refresh.sh runs multiple
// generators concurrently (`node generate-debate.js & node generate-apex.js &`),
// and both call appendOutcomes() — without a lock, whichever finishes its
// read-modify-write last silently discards the other's rows.
function withLock(fn) {
  const start = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale lock (holder crashed without cleaning up) — break it and retry immediately.
      try {
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { try { fs.unlinkSync(LOCK_PATH); } catch {} continue; }
      } catch { continue; } // lock disappeared between the failed open and stat — just retry
      if (Date.now() - start > LOCK_WAIT_MS) {
        // Waited long enough — proceed without the lock rather than hang the
        // whole generator forever (better to risk a rare lost row than to
        // block market-refresh.sh's parallel phase indefinitely).
        console.warn('outcomes: lock wait exceeded, proceeding without lock');
        break;
      }
      sleepSync(50 + Math.random() * 100);
    }
  }
  try { return fn(); }
  finally { if (acquired) { try { fs.unlinkSync(LOCK_PATH); } catch {} } }
}

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
  // Atomic write: tmp + rename, so a crash mid-write never leaves a truncated
  // 13MB+ ledger behind.
  const tmp = OUTCOMES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, OUTCOMES_PATH);
}

// Append rows, deduping by (date, screener, signalType, ticker).
// Returns {added, skipped, total}. Locked end-to-end (read+merge+write) so
// concurrent callers (see withLock comment) can't clobber each other.
function appendOutcomes(newRows) {
  if (!Array.isArray(newRows) || !newRows.length) return { added: 0, skipped: 0, total: 0 };
  return withLock(() => {
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
  });
}

// Fixed UTC+5:30 conversion. IMPORTANT: do NOT subtract d.getTimezoneOffset() —
// d.getTime() is already an absolute UTC instant, so adding the host's local
// offset on top double-counts it. The old formula only happened to work when
// the host machine's own timezone was UTC (true on GitHub's runners, false on
// a personal PC set to IST) — which silently corrupted date-keyed dedup for
// any local run.
function todayIST() {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

module.exports = { OUTCOMES_PATH, loadOutcomes, saveOutcomes, appendOutcomes, todayIST };

'use strict';

const fs   = require('fs');
const path = require('path');

const SURVEILLANCE_PATH = path.join(__dirname, '..', 'docs', 'surveillance.json');

// Null-safe read of docs/surveillance.json (written by fetch-nse-surveillance.js).
// Returns null when missing/unreadable, else { updatedAt, asm, gsm, fnoBan, ageHours }
// where ageHours is hours since updatedAt (null when the file has no timestamp).
function loadSurveillance() {
  try {
    if (!fs.existsSync(SURVEILLANCE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(SURVEILLANCE_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    let ageHours = null;
    if (raw.updatedAt) {
      const t = new Date(raw.updatedAt).getTime();
      if (isFinite(t)) ageHours = (Date.now() - t) / 3.6e6;
    }
    return {
      updatedAt: raw.updatedAt || null,
      asm: raw.asm && typeof raw.asm === 'object' ? raw.asm : {},
      gsm: raw.gsm && typeof raw.gsm === 'object' ? raw.gsm : {},
      fnoBan: Array.isArray(raw.fnoBan) ? raw.fnoBan : [],
      ageHours,
    };
  } catch { return null; }
}

// Quick lookup — returns { asmStage, asmType, gsmStage, fnoBan } (nulls when absent).
function getFlags(data, ticker) {
  const out = { asmStage: null, asmType: null, gsmStage: null, fnoBan: false };
  if (!data || !ticker) return out;
  const a = data.asm && data.asm[ticker];
  if (a) {
    out.asmStage = a.stage != null ? a.stage : null;
    out.asmType  = a.type  != null ? a.type  : null;
  }
  const g = data.gsm && data.gsm[ticker];
  if (g) out.gsmStage = g.stage != null ? g.stage : null;
  out.fnoBan = Array.isArray(data.fnoBan) && data.fnoBan.includes(ticker);
  return out;
}

// "Don't trade this breakout" conditions:
//   - ASM long-term stage >= 2 (escalating exchange curbs: 100% margin, price bands), or
//   - any GSM stage >= 1 (graded surveillance — all stages are serious; trading is
//     throttled to the point breakout follow-through is impossible).
// ASM short-term / stage 1 and the F&O ban are milder — flag, don't block.
function isRestricted(data, ticker) {
  const f = getFlags(data, ticker);
  if (f.gsmStage != null && f.gsmStage >= 1) return true;
  if (f.asmType === 'longterm' && f.asmStage != null && f.asmStage >= 2) return true;
  return false;
}

module.exports = { loadSurveillance, getFlags, isRestricted, SURVEILLANCE_PATH };

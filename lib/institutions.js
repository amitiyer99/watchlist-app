'use strict';

// Classify NSE bulk/block-deal counterparties as FII (foreign institutional /
// FPI) vs DII (domestic institutional) vs OTHER (HNIs, corporates, PMS, prop),
// and aggregate per-stock institutional BUYING over a rolling window.
//
// This is a maintained HEURISTIC on the disclosed `clientName` string — deal
// disclosures don't carry an investor-type flag, so we match against known-name
// patterns. Anything unmatched is OTHER (deliberately conservative). It is a
// proxy for "FIIs/DIIs increased holdings": bulk/block deals only capture large
// disclosed transactions (>0.5% of equity), not routine open-market accumulation.

// Foreign institutions / FPIs. Checked first.
const FII_PATTERNS = [
  /goldman sachs/i, /morgan stanley/i, /j\.?\s?p\.?\s?morgan|jpmorgan/i, /merrill|bofa|bank of america/i,
  /citigroup|citibank|citi\b/i, /nomura/i, /\bubs\b/i, /credit suisse/i, /\bhsbc\b/i, /bnp paribas/i,
  /societe generale|soc gen/i, /macquarie/i, /jefferies/i, /deutsche bank/i, /barclays/i, /standard chartered/i,
  /blackrock/i, /vanguard/i, /fidelity/i, /capital group/i, /wellington/i, /wasatch/i, /matthews/i, /\bt\.?\s?rowe/i,
  /government of singapore|\bgic\b|monetary authority of singapore/i, /abu dhabi|\badia\b|adq\b/i,
  /norges|norway/i, /government pension/i, /canada pension|cppib|ontario teachers/i,
  /calpers|florida retirement|virginia retirement|texas\b.*(retirement|permanent)/i,
  /kuwait investment|qatar (investment|holding)|saudi/i,
  /oaktree|marshall wace|citadel|millennium|segantii|jane street|graviton|hillhouse|coatue|tiger global|steadview|ghisallo/i,
  /\bfpi\b|foreign portfolio|\bfii\b/i,
  /mauritius|luxembourg|\bireland\b|cayman|offshore|master fund|\bplc\b/i,
];

// Domestic institutions. Checked after FII.
const DII_PATTERNS = [
  /mutual fund/i, /\bmf\b/i, /\bamc\b/i, /asset management/i, /trustee/i,
  /life insurance|\blic\b/i, /general insurance|\bgic re\b|new india assurance|insurance (company|corp)/i,
  /provident fund|pension fund/i,
  /\bsbi\b/i, /\bhdfc\b/i, /icici (prudential|pru)/i, /nippon (india|life)/i, /kotak/i,
  /aditya birla|absl\b/i, /\buti\b/i, /mirae/i, /\bdsp\b/i, /tata (mutual|asset|amc)/i,
  /franklin/i, /bandhan/i, /edelweiss/i, /motilal oswal/i, /\bquant\b/i, /parag parikh|ppfas/i,
  /invesco/i, /canara robeco/i, /sundaram/i, /mahindra manulife/i, /whiteoak|white oak/i, /helios/i,
  /360 one|iifl/i, /axis (mutual|amc)/i, /baroda bnp|union (mutual|amc)|navi (mutual|amc)/i,
];

function norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim(); }

// 'FII' | 'DII' | 'OTHER'
function classify(clientName) {
  const s = norm(clientName);
  if (!s) return 'OTHER';
  for (const re of FII_PATTERNS) if (re.test(s)) return 'FII';
  for (const re of DII_PATTERNS) if (re.test(s)) return 'DII';
  return 'OTHER';
}

const cr = (qty, px) => (Number(qty) || 0) * (Number(px) || 0) / 1e7; // ₹ Crore

// Aggregate BUY-side institutional activity per symbol over the last `days`.
// Returns array sorted BOTH-first then by total institutional value, each:
//   { symbol, tier, fiiBuys, diiBuys, otherBuys, fiiValueCr, diiValueCr,
//     totalValueCr, fiiNames[], diiNames[], lastDate }
// tier: 'BOTH' (>=1 FII buy AND >=1 DII buy) | 'FII' | 'DII'. Symbols with no
// FII/DII buys are omitted.
function aggregate(dealsData, { days = 30 } = {}) {
  const rows = (dealsData && Array.isArray(dealsData.rows)) ? dealsData.rows : [];
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const bySym = new Map();

  for (const r of rows) {
    if (!r || r.buySell !== 'BUY' || !r.symbol || !r.date || r.date < cutoff) continue;
    const side = classify(r.clientName);
    if (side === 'OTHER') { /* still count for context */ }
    let a = bySym.get(r.symbol);
    if (!a) {
      a = { symbol: r.symbol, fiiBuys: 0, diiBuys: 0, otherBuys: 0,
            fiiValueCr: 0, diiValueCr: 0, totalValueCr: 0,
            fiiNames: new Set(), diiNames: new Set(), lastDate: r.date };
      bySym.set(r.symbol, a);
    }
    const v = cr(r.quantity, r.avgPrice);
    if (side === 'FII') { a.fiiBuys++; a.fiiValueCr += v; if (r.clientName) a.fiiNames.add(r.clientName); }
    else if (side === 'DII') { a.diiBuys++; a.diiValueCr += v; if (r.clientName) a.diiNames.add(r.clientName); }
    else a.otherBuys++;
    a.totalValueCr += v;
    if (r.date > a.lastDate) a.lastDate = r.date;
  }

  const out = [];
  for (const a of bySym.values()) {
    if (a.fiiBuys === 0 && a.diiBuys === 0) continue; // must have institutional buying
    const tier = (a.fiiBuys > 0 && a.diiBuys > 0) ? 'BOTH' : (a.fiiBuys > 0 ? 'FII' : 'DII');
    out.push({
      symbol: a.symbol, tier,
      fiiBuys: a.fiiBuys, diiBuys: a.diiBuys, otherBuys: a.otherBuys,
      fiiValueCr: +a.fiiValueCr.toFixed(2), diiValueCr: +a.diiValueCr.toFixed(2),
      totalValueCr: +a.totalValueCr.toFixed(2),
      fiiNames: [...a.fiiNames], diiNames: [...a.diiNames], lastDate: a.lastDate,
    });
  }
  const tierRank = { BOTH: 0, FII: 1, DII: 2 };
  out.sort((x, y) => (tierRank[x.tier] - tierRank[y.tier]) || (y.totalValueCr - x.totalValueCr));
  return out;
}

module.exports = { classify, aggregate, FII_PATTERNS, DII_PATTERNS };

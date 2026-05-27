'use strict';

const { HUB_NAV_LINK } = require('./lib/hub-nav');
const fs   = require('fs');
const path = require('path');

const DOCS       = path.join(__dirname, 'docs');
const OUT_HTML   = path.join(DOCS, 'debate.html');
const OUT_JSON   = path.join(DOCS, 'debate-data.json');

// ─── Load screener JSONs ────────────────────────────────────────────────────
function load(file) {
  const fp = path.join(DOCS, file);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return []; }
}

const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));

// ─── AGENT DEFINITIONS ──────────────────────────────────────────────────────
// Each agent returns { vote: 'Bullish'|'Neutral'|'Bearish', confidence:0-100, reasoning:string }
// Returning null = abstain (no data for this stock)

function agentFundamentalist(apex) {
  if (!apex) return null;
  const { score, tier, action, convergence } = apex;
  if (tier === 'Elite'   && (action === 'BUY'))           return { vote:'Bullish',  confidence: clamp(score + (convergence?8:0), 0,100), reasoning:`Elite tier · BUY · Score ${score}${convergence?' · Convergence bonus':''}`};
  if (tier === 'Elite')                                    return { vote:'Bullish',  confidence: clamp(score,0,100), reasoning:`Elite tier · ${action} · Score ${score}`};
  if (tier === 'Strong'  && action === 'BUY')              return { vote:'Bullish',  confidence: clamp(Math.round(score*0.92),0,100), reasoning:`Strong tier · BUY · Score ${score}`};
  if (tier === 'Strong'  && action === 'BUILD')            return { vote:'Bullish',  confidence: clamp(Math.round(score*0.82),0,100), reasoning:`Strong tier · BUILD · Score ${score}`};
  if (tier === 'Aligned' && action === 'WATCH')            return { vote:'Neutral',  confidence: 45, reasoning:`Aligned tier · WATCH · Score ${score}`};
  if (tier === 'Misaligned' || action === 'PASS')          return { vote:'Bearish',  confidence: 78, reasoning:`Misaligned · PASS signal · Score ${score} — fundamentals weak`};
  return { vote:'Neutral', confidence: 40, reasoning:`Tier ${tier} · ${action} · Score ${score}` };
}

function agentTechnician(b2) {
  if (!b2) return null;
  const { score, stage2, vcpPass, rsRating } = b2;
  if (stage2 && vcpPass && rsRating >= 80) return { vote:'Bullish',  confidence: clamp(score,0,100), reasoning:`Stage 2 ✓ · VCP Pass ✓ · RS Rating ${rsRating}`};
  if (stage2 && vcpPass)                   return { vote:'Bullish',  confidence: clamp(Math.round(score*0.78),0,100), reasoning:`Stage 2 ✓ · VCP Pass ✓ · RS ${rsRating}`};
  if (stage2 && !vcpPass && rsRating >= 70) return { vote:'Neutral',  confidence: 50, reasoning:`Stage 2 ✓ · No VCP yet · RS ${rsRating} — watch for breakout`};
  if (stage2 && !vcpPass)                  return { vote:'Neutral',  confidence: 35, reasoning:`Stage 2 ✓ · No VCP · RS ${rsRating}`};
  if (!stage2 && vcpPass)                  return { vote:'Neutral',  confidence: 30, reasoning:`VCP Pass but NOT in Stage 2 — premature`};
  return { vote:'Bearish', confidence: 62, reasoning:`Not in Stage 2 · No VCP · RS ${rsRating||'—'} — wrong phase`};
}

function agentMomentum(creamy) {
  if (!creamy) return null;
  const { score } = creamy;
  if (score >= 85) return { vote:'Bullish', confidence: clamp(score,0,100), reasoning:`Creamy score ${score} — elite momentum`};
  if (score >= 72) return { vote:'Bullish', confidence: clamp(Math.round(score*0.88),0,100), reasoning:`Creamy score ${score} — strong momentum`};
  if (score >= 60) return { vote:'Neutral', confidence: clamp(Math.round(score*0.70),0,100), reasoning:`Creamy score ${score} — moderate momentum`};
  return { vote:'Neutral', confidence: 30, reasoning:`Creamy score ${score} — below momentum threshold`};
}

function agentCompounder(mbf) {
  if (!mbf) return null;
  const { score, badges=[] } = mbf;
  const labels = badges.map(b=>b.label||'');
  const hasAccel  = labels.some(l=>l.includes('Accelerating'));
  const hasValue  = labels.some(l=>l.includes('Deep Value'));
  const hasFCF    = labels.some(l=>l.includes('FCF'));
  const hasMom    = labels.some(l=>l.includes('Momentum'));
  const bonus = (hasAccel?8:0)+(hasValue?5:0)+(hasFCF?5:0)+(hasMom?4:0);
  const adj = clamp(score + bonus, 0, 100);
  if (score >= 80 && hasAccel) return { vote:'Bullish', confidence: adj, reasoning:`MBF ${score} · ${labels.join(' · ')}`};
  if (score >= 70)             return { vote:'Bullish', confidence: clamp(Math.round(adj*0.85),0,100), reasoning:`MBF ${score} · ${labels.join(' · ')||'solid compounder'}`};
  if (score >= 55)             return { vote:'Neutral',  confidence: 45, reasoning:`MBF ${score} — moderate quality`};
  return { vote:'Neutral', confidence: 25, reasoning:`MBF ${score} — below compounder bar`};
}

function agentQuality(ir) {
  if (!ir) return null;
  const { roe=0, epsGrowth5Y=0, debtEquity=1, promoterHolding=0 } = ir;
  let pts = 0;
  if (roe >= 25)           pts += 30; else if (roe >= 18) pts += 18; else if (roe >= 12) pts += 8;
  if (epsGrowth5Y >= 30)   pts += 30; else if (epsGrowth5Y >= 20) pts += 18; else if (epsGrowth5Y >= 10) pts += 8;
  if (debtEquity <= 0.1)   pts += 20; else if (debtEquity <= 0.3) pts += 12; else if (debtEquity <= 0.5) pts += 6;
  if (promoterHolding >= 65) pts += 20; else if (promoterHolding >= 55) pts += 12; else if (promoterHolding >= 45) pts += 6;
  const conf = clamp(pts, 0, 100);
  if (pts >= 75) return { vote:'Bullish', confidence: conf, reasoning:`ROE ${roe.toFixed(0)}% · EPS CAGR ${epsGrowth5Y.toFixed(0)}% · D/E ${debtEquity.toFixed(2)} · Promoter ${promoterHolding.toFixed(0)}%`};
  if (pts >= 50) return { vote:'Neutral',  confidence: conf, reasoning:`ROE ${roe.toFixed(0)}% · EPS CAGR ${epsGrowth5Y.toFixed(0)}% — partial quality`};
  return { vote:'Bearish', confidence: clamp(80-conf,0,100), reasoning:`ROE ${roe.toFixed(0)}% · EPS CAGR ${epsGrowth5Y.toFixed(0)}% — quality concerns`};
}

// ─── Score aggregation ───────────────────────────────────────────────────────
const VOTE_VAL = { Bullish:1, Neutral:0, Bearish:-1 };
const AGENT_KEYS = ['fundamentalist','technician','momentum','compounder','quality'];
const AGENT_LABELS = { fundamentalist:'🏛️ Fundamentalist', technician:'⚡ Technician', momentum:'🚀 Momentum', compounder:'💎 Compounder', quality:'🔬 Quality' };
const AGENT_SHORT  = { fundamentalist:'F', technician:'T', momentum:'M', compounder:'C', quality:'Q' };

function scoreDebate(votes) {
  const active = AGENT_KEYS.filter(k => votes[k] !== null);
  if (active.length < 2) return null; // need at least 2 agents with data

  // Hard veto: if Fundamentalist says Bearish (PASS), exclude from hot list
  const fv = votes.fundamentalist;
  const hasFundBearish = fv && fv.vote === 'Bearish';

  // Weighted score: vote * confidence, averaged across active agents
  let wSum = 0, wTot = 0;
  const confVals = [];
  for (const k of active) {
    const v = votes[k];
    const w = 1; // equal weight for now
    wSum += VOTE_VAL[v.vote] * v.confidence * w;
    wTot += 100 * w;
    confVals.push(VOTE_VAL[v.vote] * v.confidence);
  }
  const rawScore = wTot > 0 ? (wSum / wTot) * 100 : 0; // -100 to +100

  // Disagreement penalty: std dev of confidence-weighted votes
  const mean = confVals.reduce((a,b)=>a+b,0)/confVals.length;
  const variance = confVals.reduce((a,b)=>a+(b-mean)**2,0)/confVals.length;
  const std = Math.sqrt(variance);
  const penalised = rawScore - 0.4 * std;

  const bullish = active.filter(k=>votes[k].vote==='Bullish').length;
  const bearish = active.filter(k=>votes[k].vote==='Bearish').length;
  const neutral = active.filter(k=>votes[k].vote==='Neutral').length;

  // Technician veto for hot list
  const tv = votes.technician;
  const techBearish = tv && tv.vote === 'Bearish';

  // Dual-confirmation flags
  // Price-action: Technician (Breakout2) OR Momentum (Creamy) is Bullish
  const hasPriceAction = (votes.technician && votes.technician.vote === 'Bullish') ||
                         (votes.momentum   && votes.momentum.vote   === 'Bullish');
  // Fundamental: Fundamentalist (APEX) OR Compounder (MBF) OR Quality (IR) is Bullish
  const hasFundamental = (votes.fundamentalist && votes.fundamentalist.vote === 'Bullish') ||
                         (votes.compounder     && votes.compounder.vote     === 'Bullish') ||
                         (votes.quality        && votes.quality.vote        === 'Bullish');

  // Classification — requires BOTH price-action AND fundamental confirmation for Hot
  let category;
  if (hasFundBearish) {
    category = 'avoid';
  } else if (penalised >= 35 && bullish >= 2 && hasPriceAction && hasFundamental && !techBearish) {
    category = 'hot';        // ✅ Dual-confirmed: technical + fundamental both bullish
  } else if (hasFundamental && !hasPriceAction && !hasFundBearish && penalised >= 20) {
    category = 'contrarian'; // Good business, no technical setup yet — wait for entry
  } else if (hasPriceAction && !hasFundamental && penalised >= 25) {
    category = 'momentum';   // Technical breakout, quality unverified — short-term only
  } else if (penalised >= 0) {
    category = 'watch';
  } else {
    category = 'avoid';
  }

  return {
    score: Math.round(penalised),
    rawScore: Math.round(rawScore),
    disagreement: Math.round(std),
    bullish, bearish, neutral,
    activeCount: active.length,
    hasFundBearish,
    techBearish,
    hasPriceAction: !!hasPriceAction,
    hasFundamental: !!hasFundamental,
    category,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
  console.log('=== Multi-Agent Debate Generator ===');

  // Load all screener data
  const apexArr    = load('apex-tickers.json');
  const creamyArr  = load('creamy-tickers.json');
  const b2Arr      = load('breakout2-data.json');
  const mbfArr     = load('multibagger-tickers.json');
  const irArr      = load('indianresearch-tickers.json');
  const brkArr     = load('breakout-tickers.json');

  // Earnings calendar (optional — when fetch-earnings-calendar.js has run)
  let earningsCalendar = null;
  try {
    const { loadEarnings } = require('./lib/earnings');
    earningsCalendar = loadEarnings();
    if (earningsCalendar) console.log(`  Earnings calendar: ${earningsCalendar.withDate} symbols loaded`);
  } catch {}

  // Build lookup maps
  const apexMap   = new Map(apexArr.map(x=>[x.ticker, x]));
  const creamyMap = new Map(creamyArr.map(x=>[x.ticker, x]));
  const b2Map     = new Map(b2Arr.map(x=>[x.ticker, x]));
  const mbfMap    = new Map(mbfArr.map(x=>[x.ticker, x]));
  const irMap     = new Map(irArr.map(x=>[x.ticker, x]));
  const brkMap    = new Map(brkArr.map(x=>[x.ticker, x]));

  // Build universe: all tickers that appear in at least 2 screener sources
  const allTickers = new Set([
    ...apexArr.map(x=>x.ticker),
    ...creamyArr.map(x=>x.ticker),
    ...b2Arr.map(x=>x.ticker),
    ...mbfArr.map(x=>x.ticker),
    ...irArr.map(x=>x.ticker),
  ]);

  const universe = [];
  for (const ticker of allTickers) {
    const inScreeners = [apexMap, creamyMap, b2Map, mbfMap, irMap].filter(m=>m.has(ticker)).length;
    if (inScreeners >= 2) universe.push(ticker);
  }
  universe.sort();
  console.log(`Universe: ${universe.length} stocks in 2+ screeners`);

  // Run debate for each stock
  const stocks = [];
  for (const ticker of universe) {
    const apex   = apexMap.get(ticker)   || null;
    const b2     = b2Map.get(ticker)     || null;
    const creamy = creamyMap.get(ticker) || null;
    const mbf    = mbfMap.get(ticker)    || null;
    const ir     = irMap.get(ticker)     || null;
    const brk    = brkMap.get(ticker)    || null;

    // Get meta from whichever screener has the best name/sector/price/url
    const meta = apex || creamy || mbf || ir || {};
    const name   = meta.name   || ticker;
    const sector = meta.sector || (brk ? '' : '');
    const price  = meta.price  || b2?.price || 0;
    const url    = meta.url    || brk?.url  || '';

    const votes = {
      fundamentalist: agentFundamentalist(apex),
      technician:     agentTechnician(b2),
      momentum:       agentMomentum(creamy),
      compounder:     agentCompounder(mbf),
      quality:        agentQuality(ir),
    };

    const result = scoreDebate(votes);
    if (!result) continue;

    // Earnings-within-7d gate: demote hot → watch with reason
    let earningsWithin7d = false, nextEarningsDate = null;
    if (earningsCalendar) {
      const e = earningsCalendar.stocks[ticker];
      if (e) { earningsWithin7d = !!e.earningsWithin7d; nextEarningsDate = e.nextEarningsDate; }
    }
    if (earningsWithin7d && result.category === 'hot') {
      result.category = 'watch';
      result.earningsGate = true;
    }

    // Build the consensus label
    const agentSummary = AGENT_KEYS
      .filter(k => votes[k])
      .map(k => `${AGENT_SHORT[k]}:${votes[k].vote[0]}${votes[k].confidence}`)
      .join(' ');

    stocks.push({
      ticker, name, sector, price, url,
      ...result,
      votes: Object.fromEntries(AGENT_KEYS.map(k=>[k, votes[k]])),
      agentSummary,
      screenerCount: [apexMap,creamyMap,b2Map,mbfMap,irMap].filter(m=>m.has(ticker)).length,
      earningsWithin7d,
      nextEarningsDate,
    });
  }

  // Sort by score desc
  stocks.sort((a,b) => b.score - a.score);

  // Categorised lists
  const hot         = stocks.filter(s=>s.category==='hot').slice(0,10);
  const momentum    = stocks.filter(s=>s.category==='momentum').slice(0,6);
  const contrarian  = stocks.filter(s=>s.category==='contrarian').slice(0,6);
  const watchList   = stocks.filter(s=>s.category==='watch').slice(0,20);

  console.log(`Hot: ${hot.length}  Momentum: ${momentum.length}  Contrarian: ${contrarian.length}  Watch: ${watchList.length}`);

  // Agent agreement stats
  const agentStats = {};
  for (const k of AGENT_KEYS) {
    const active = stocks.filter(s=>s.votes[k]);
    const bull = active.filter(s=>s.votes[k].vote==='Bullish').length;
    const bear = active.filter(s=>s.votes[k].vote==='Bearish').length;
    const neu  = active.filter(s=>s.votes[k].vote==='Neutral').length;
    agentStats[k] = { active:active.length, bull, bear, neu,
      bullPct: active.length?Math.round(bull/active.length*100):0 };
  }

  // Agent correlation matrix (agreement rate between pairs)
  const matrix = {};
  for (const a of AGENT_KEYS) {
    matrix[a] = {};
    for (const b of AGENT_KEYS) {
      if (a === b) { matrix[a][b] = 100; continue; }
      const both = stocks.filter(s=>s.votes[a]&&s.votes[b]);
      const agree = both.filter(s=>s.votes[a].vote===s.votes[b].vote).length;
      matrix[a][b] = both.length ? Math.round(agree/both.length*100) : 0;
    }
  }

  const generatedAt = new Date().toISOString();

  // Save JSON for prediction page to consume
  // Saves ALL stocks so prediction page can cross-reference by sector
  const debateData = {
    generatedAt,
    totalEvaluated: stocks.length,
    hot,
    momentum,
    contrarian,
    agentStats,
    // Full ranked list (stripped of HTML-heavy fields) for prediction page lookup
    allStocks: stocks.map(s => ({
      ticker: s.ticker,
      name:   s.name,
      sector: s.sector,
      price:  s.price,
      url:    s.url,
      score:  s.score,
      category: s.category,
      hasPriceAction: s.hasPriceAction,
      hasFundamental: s.hasFundamental,
      bullish: s.bullish,
      activeCount: s.activeCount,
      screenerCount: s.screenerCount,
      agentSummary: s.agentSummary,
    })),
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(debateData, null, 2));
  console.log(`Written ${OUT_JSON}`);

  // Phase 2 — append Debate Hot/Momentum/Contrarian to the outcome ledger
  try {
    const { appendOutcomes, todayIST } = require('./lib/outcomes');
    const { loadRegime } = require('./lib/regime');
    const regime = loadRegime();
    const date = todayIST();
    const actionable = stocks.filter(s => s.category === 'hot' || s.category === 'momentum' || s.category === 'contrarian');
    const rows = actionable.map(s => ({
      date,
      screener: 'debate',
      signalType: 'DEBATE_' + String(s.category).toUpperCase(),
      ticker: s.ticker,
      name: s.name,
      sector: s.sector || null,
      entry: s.price,
      pivot: null,
      stop: null,
      target: null,
      rr: null,
      sizePct: null,
      score: s.score,
      regime: regime.isBearMarket ? 'BEAR' : 'BULL',
      extras: {
        hasPriceAction: !!s.hasPriceAction,
        hasFundamental: !!s.hasFundamental,
        bullish: s.bullish,
        screenerCount: s.screenerCount,
        activeCount: s.activeCount,
      },
    }));
    const lg = appendOutcomes(rows);
    console.log(`Outcomes (debate): +${lg.added} added (${lg.skipped} dupes/skipped, ${lg.total} total)`);
  } catch (e) {
    console.warn('Outcome ledger append failed:', e.message);
  }

  // ─── Build HTML ────────────────────────────────────────────────────────────
  const nowIST = new Date(generatedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false,dateStyle:'medium',timeStyle:'short'});

  function voteColor(vote) {
    return vote==='Bullish'?'var(--gn)':vote==='Bearish'?'var(--rd)':'var(--t3)';
  }
  function voteIcon(vote) {
    return vote==='Bullish'?'🟢':vote==='Bearish'?'🔴':'🟡';
  }
  function scoreColor(s) {
    return s>=50?'#22c55e':s>=20?'#00d4aa':s>=0?'#eab308':s>=-20?'#f97316':'#ef4444';
  }
  function categoryBadge(cat) {
    const map={hot:'🔥 Hot',momentum:'⚡ Momentum',contrarian:'🧐 Contrarian',watch:'👀 Watch',avoid:'⛔ Avoid'};
    const cls={hot:'hot-badge',momentum:'mom-badge',contrarian:'con-badge',watch:'watch-badge',avoid:'avoid-badge'};
    return `<span class="cat-badge ${cls[cat]}">${map[cat]||cat}</span>`;
  }

  function buildStockCard(s, rank) {
    const sc = scoreColor(s.score);
    const barW = Math.min(100, Math.abs(s.score));
    const barDir = s.score >= 0 ? 'right' : 'left';
    const agentDots = AGENT_KEYS.map(k => {
      const v = s.votes[k];
      if (!v) return `<span class="agent-dot agent-abstain" title="${AGENT_LABELS[k]}: Abstain">–</span>`;
      return `<span class="agent-dot agent-${v.vote.toLowerCase()}" title="${AGENT_LABELS[k]}: ${v.vote} (${v.confidence})\n${v.reasoning}">${AGENT_SHORT[k]}</span>`;
    }).join('');

    // Build the pre-seeded debate prompt (no newlines inside template string)
    const agentLines = AGENT_KEYS.filter(k=>s.votes[k]).map(k=>{
      const v = s.votes[k];
      return AGENT_LABELS[k]+': '+v.vote+' ('+v.confidence+'/100) — '+v.reasoning;
    }).join(' | ');
    const debatePrompt = s.name+' ('+s.ticker+'): '+agentLines+'. Consensus score: '+s.score+'/100. '+s.bullish+' agents bullish, '+s.bearish+' bearish, '+s.neutral+' neutral. Disagreement: '+s.disagreement+'. Question: Should I buy this stock tomorrow? What are the key risks? Be specific about NSE India context, current macro, and any upcoming events. Max 250 words.';

    return `<div class="stock-card cat-${s.category}">
  <div class="card-top">
    <div class="card-rank">#${rank}</div>
    <div class="card-info">
      <div class="card-name">${s.url?`<a href="${esc(s.url)}" target="_blank" class="stock-link">${esc(s.ticker)}</a>`:esc(s.ticker)}</div>
      <div class="card-fullname">${esc(s.name)}</div>
    </div>
    <div class="card-meta">
      ${categoryBadge(s.category)}
      <div class="card-score" style="color:${sc}">${s.score>0?'+':''}${s.score}</div>
    </div>
  </div>
  <div class="score-bar-wrap">
    <div class="score-bar-bg">
      <div class="score-bar-fill" style="width:${barW}%;background:${sc};${barDir==='left'?'right:50%;':'left:50%;'}"></div>
    </div>
  </div>
  <div class="agent-row">${agentDots}</div>
  <div class="card-sigs">
    <span class="sig-stat">${s.bullish} bullish · ${s.neutral} neutral · ${s.bearish} bearish</span>
    <span class="sig-stat">${s.screenerCount} screeners · Disagree: ${s.disagreement}</span>
  </div>
  ${s.sector?`<div style="font-size:.68rem;color:var(--t3);margin:4px 0 6px">${esc(s.sector)}</div>`:''}
  <div class="card-actions">
    <button class="alert-btn" data-alert-ticker="${esc(s.ticker)}" data-alert-price="${s.price||0}" data-alert-name="${esc(s.name)}" title="Set price alert">🔔</button>
    <button class="research-btn" data-r-ticker="${esc(s.ticker)}" data-r-name="${esc(s.name)}" data-r-prompt="${esc(debatePrompt)}" title="AI Debate Analysis">🧠 Debate</button>
    ${s.url?`<a href="${esc(s.url)}" target="_blank" class="tt-link">↗ TT</a>`:''}
    ${s.price?`<span class="price-tag">₹${Number(s.price).toLocaleString('en-IN',{maximumFractionDigits:2})}</span>`:''}
  </div>
</div>`;
  }

  function buildTableRow(s) {
    const sc = scoreColor(s.score);
    const agentCells = AGENT_KEYS.map(k => {
      const v = s.votes[k];
      if (!v) return `<td class="nc" style="text-align:center">—</td>`;
      const col = voteColor(v.vote);
      return `<td style="text-align:center;color:${col};font-size:.75rem;font-weight:700" title="${esc(v.reasoning)}">${voteIcon(v.vote)} ${v.confidence}</td>`;
    }).join('');

    const debatePrompt = s.name+' ('+s.ticker+'): '+AGENT_KEYS.filter(k=>s.votes[k]).map(k=>AGENT_LABELS[k]+': '+s.votes[k].vote+' '+s.votes[k].confidence).join(' | ')+'. Consensus: '+s.score+'. Should I buy tomorrow?';

    return `<tr class="stock-row" data-category="${s.category}" data-score="${s.score}">
  <td><a href="${esc(s.url||'#')}" target="_blank" class="stock-link">${esc(s.ticker)}</a><div style="font-size:.65rem;color:var(--t3)">${esc(s.name.length>28?s.name.slice(0,26)+'…':s.name)}</div></td>
  <td style="text-align:center"><span style="font-weight:700;color:${sc}">${s.score>0?'+':''}${s.score}</span></td>
  ${agentCells}
  <td style="text-align:center;font-size:.72rem;color:var(--t3)">${s.screenerCount}</td>
  <td style="text-align:center">${categoryBadge(s.category)}</td>
  <td>
    <div style="display:flex;gap:4px">
      <button class="alert-btn" data-alert-ticker="${esc(s.ticker)}" data-alert-price="${s.price||0}" data-alert-name="${esc(s.name)}" title="Alert" style="padding:2px 6px;font-size:.7rem">🔔</button>
      <button class="research-btn" data-r-ticker="${esc(s.ticker)}" data-r-name="${esc(s.name)}" data-r-prompt="${esc(debatePrompt)}" title="Debate" style="padding:2px 6px;font-size:.7rem">🧠</button>
    </div>
  </td>
</tr>`;
  }

  const hotCards        = hot.map((s,i)=>buildStockCard(s,i+1)).join('');
  const momCards        = momentum.map((s,i)=>buildStockCard(s,i+1)).join('');
  const contraCards     = contrarian.map((s,i)=>buildStockCard(s,i+1)).join('');
  const allTableRows    = stocks.slice(0,100).map(s=>buildTableRow(s)).join('');

  // Agent agreement heatmap data
  const matrixData = JSON.stringify({ keys:AGENT_KEYS, labels:AGENT_KEYS.map(k=>AGENT_LABELS[k].replace(/^../,'')), matrix });

  // Full client data
  const clientData = JSON.stringify({
    agentStats, totalEvaluated:stocks.length,
    hotCount:hot.length, momentumCount:momentum.length, contraCount:contrarian.length,
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Debate — Tomorrow's Hot Stocks</title>
<script src="https://cdn.jsdelivr.net/npm/apexcharts@3.54.1/dist/apexcharts.min.js"><\/script>
<style>
:root{--bg:#0c0c10;--s1:#13131b;--s2:#1a1a26;--s3:#22222f;--bd:#2a2a3a;--ac:#00d4aa;--tx:#e8e8f0;--t2:#8888a0;--t3:#5a5a70;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7;--or:#f97316}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);overflow-x:hidden}
.gn{color:var(--gn)}.rd{color:var(--rd)}.yw{color:var(--yw)}.nc{color:var(--t3)}.t2{color:var(--t2)}
.header{background:var(--s1);border-bottom:1px solid var(--bd);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.1rem;font-weight:700}.header h1 span{color:var(--ac)}
.nav-links{display:flex;gap:8px;flex-wrap:wrap;padding:10px 24px;background:var(--s1);border-bottom:1px solid var(--bd)}
.nav-links a{font-size:.75rem;color:var(--t2);padding:4px 10px;border:1px solid var(--bd);border-radius:5px;text-decoration:none;transition:all .15s}
.nav-links a:hover,.nav-links a.active{color:var(--ac);border-color:var(--ac)}
.stats-bar{display:flex;gap:10px;padding:12px 24px;flex-wrap:wrap;background:var(--s1);border-bottom:1px solid var(--bd)}
.stat{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:8px 14px;min-width:100px}
.stat .sl{font-size:.65rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.stat .sv{font-size:1.2rem;font-weight:700}
.agent-status-bar{display:flex;gap:10px;flex-wrap:wrap;padding:10px 24px;background:var(--s1);border-bottom:1px solid var(--bd)}
.agent-pill{display:flex;align-items:center;gap:6px;background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:6px 12px;font-size:.75rem}
.agent-pill .ap-icon{font-size:.9rem}
.agent-pill .ap-bull{color:var(--gn)}.agent-pill .ap-neu{color:var(--t3)}.agent-pill .ap-bear{color:var(--rd)}
.section{padding:20px 24px;border-bottom:1px solid var(--bd)}
.section-title{font-size:.85rem;font-weight:700;color:var(--t2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.section-title::before{content:'';display:block;width:3px;height:14px;background:var(--ac);border-radius:2px}
.cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.stock-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:14px;transition:border-color .2s;position:relative}
.stock-card:hover{border-color:rgba(0,212,170,.3)}
.stock-card.cat-hot{border-left:3px solid var(--gn)}
.stock-card.cat-momentum{border-left:3px solid var(--ac)}
.stock-card.cat-contrarian{border-left:3px solid var(--yw)}
.stock-card.cat-watch{border-left:3px solid var(--t3)}
.card-top{display:flex;align-items:flex-start;gap:8px;margin-bottom:8px}
.card-rank{font-size:1.4rem;font-weight:700;color:var(--t3);min-width:28px;line-height:1}
.card-info{flex:1;min-width:0}
.card-name{font-size:1rem;font-weight:700;line-height:1.2}
.card-fullname{font-size:.7rem;color:var(--t2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-meta{text-align:right;flex-shrink:0}
.card-score{font-size:1.4rem;font-weight:700;line-height:1;margin-top:4px}
.score-bar-wrap{margin:8px 0}
.score-bar-bg{height:5px;background:var(--s3);border-radius:3px;position:relative}
.score-bar-fill{position:absolute;top:0;height:100%;border-radius:3px;transition:width .4s}
.agent-row{display:flex;gap:5px;margin:8px 0}
.agent-dot{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;font-size:.7rem;font-weight:700;cursor:default;border:1px solid transparent;transition:all .15s}
.agent-dot:hover{transform:scale(1.15)}
.agent-dot.agent-bullish{background:rgba(34,197,94,.15);color:var(--gn);border-color:rgba(34,197,94,.3)}
.agent-dot.agent-bearish{background:rgba(239,68,68,.12);color:var(--rd);border-color:rgba(239,68,68,.2)}
.agent-dot.agent-neutral{background:rgba(90,90,112,.15);color:var(--t3);border-color:rgba(90,90,112,.2)}
.agent-dot.agent-abstain{background:rgba(255,255,255,.03);color:var(--t3);border-color:var(--bd)}
.card-sigs{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0}
.sig-stat{font-size:.68rem;color:var(--t3)}
.card-actions{display:flex;gap:6px;margin-top:10px;align-items:center}
.stock-link{color:var(--tx);text-decoration:none;font-weight:700;transition:color .15s}
.stock-link:hover{color:var(--ac)}
.cat-badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:.65rem;font-weight:700}
.hot-badge{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.2)}
.mom-badge{background:rgba(0,212,170,.1);color:var(--ac);border:1px solid rgba(0,212,170,.2)}
.con-badge{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.2)}
.watch-badge{background:rgba(90,90,112,.12);color:var(--t3);border:1px solid rgba(90,90,112,.2)}
.avoid-badge{background:rgba(239,68,68,.08);color:var(--rd);border:1px solid rgba(239,68,68,.15)}
.price-tag{font-size:.72rem;color:var(--t3);margin-left:auto}
.tt-link{font-size:.75rem;color:var(--t2);text-decoration:none;padding:4px 8px;border:1px solid var(--bd);border-radius:5px;transition:all .15s}
.tt-link:hover{color:var(--ac);border-color:var(--ac)}
.alert-btn{background:none;border:1px solid var(--bd);border-radius:5px;cursor:pointer;padding:4px 8px;font-size:.75rem;color:var(--t3);transition:all .15s;font-family:inherit}
.alert-btn:hover{color:var(--yw);border-color:var(--yw)}.alert-btn.has-alert{color:var(--yw);border-color:var(--yw)}
.research-btn{background:none;border:1px solid var(--bd);border-radius:6px;cursor:pointer;padding:4px 10px;font-size:.75rem;color:var(--t3);transition:all .15s;font-family:inherit}
.research-btn:hover{color:var(--ac);border-color:var(--ac)}
.filter-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.filter-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--t2);cursor:pointer;font-size:.75rem;font-family:inherit;transition:all .15s}
.filter-btn:hover,.filter-btn.active{color:var(--ac);border-color:var(--ac);background:var(--s3)}
.search-box{padding:6px 12px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:.82rem;outline:none;font-family:inherit;width:200px}
.search-box:focus{border-color:var(--ac)}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th{background:var(--s1);color:var(--ac);font-size:.68rem;text-transform:uppercase;letter-spacing:.04em;padding:8px 10px;text-align:left;border-bottom:2px solid var(--bd);white-space:nowrap;cursor:pointer;user-select:none}
th:hover{color:var(--tx)}
td{padding:7px 10px;border-bottom:1px solid rgba(42,42,58,.4);vertical-align:middle}
tr:hover td{background:rgba(0,212,170,.03)}
.disclaimer{font-size:.72rem;color:var(--t3);padding:8px 14px;background:rgba(234,179,8,.04);border:1px solid rgba(234,179,8,.1);border-radius:6px;text-align:center;margin-top:12px}
#ap-modal{display:none;position:fixed;z-index:9999;background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:20px;width:270px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.ap-label{display:block;font-size:.72rem;color:var(--t2);margin-bottom:4px;margin-top:10px}
#ap-above,#ap-below{width:100%;background:var(--s3);border:1px solid var(--bd);border-radius:7px;padding:7px 10px;color:var(--tx);font-size:.84rem;outline:none;font-family:inherit}
#ap-above:focus,#ap-below:focus{border-color:var(--ac)}
.ap-actions{display:flex;gap:8px;margin-top:14px}
.ap-save-btn,.ap-clear-btn{flex:1;padding:8px;border-radius:7px;border:none;cursor:pointer;font-size:.8rem;font-weight:600;font-family:inherit}
.ap-save-btn{background:var(--ac);color:#0c0c10}.ap-clear-btn{background:var(--s3);color:var(--t2);border:1px solid var(--bd)}
#pat-setup-bar{display:none;flex-direction:row;align-items:center;gap:8px;margin:8px 28px;padding:10px 14px;background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.3);border-radius:8px;font-size:.82rem;color:#93c5fd}
#pat-setup-bar input{flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--s3);color:var(--tx);font-size:.8rem;font-family:inherit;outline:none;min-width:0}
#pat-setup-bar input:focus{border-color:var(--ac)}
#pat-setup-bar button.connect{padding:6px 12px;border:none;border-radius:6px;background:var(--ac);color:#fff;cursor:pointer;font-size:.78rem;font-weight:700;white-space:nowrap}
#pat-setup-bar button.dismiss{background:none;border:none;cursor:pointer;color:var(--t3);font-size:1rem;padding:0;flex-shrink:0}
#dr-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;align-items:center;justify-content:center}
#dr-overlay.open{display:flex}
#dr-modal{background:var(--s1);border:1px solid var(--bd);border-radius:16px;width:min(720px,95vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
#dr-header{padding:16px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;gap:12px}
#dr-header h2{font-size:.95rem;font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dr-close{background:none;border:none;color:var(--t3);font-size:1.2rem;cursor:pointer;line-height:1;flex-shrink:0}
#dr-provider-bar{padding:10px 20px;border-bottom:1px solid var(--bd);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dr-prov-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--t2);cursor:pointer;font-size:.75rem;font-family:inherit;transition:all .15s}
.dr-prov-btn:hover,.dr-prov-btn.active{color:var(--ac);border-color:var(--ac)}
#dr-key-input{flex:1;min-width:160px;background:var(--s3);border:1px solid var(--bd);border-radius:6px;padding:5px 10px;color:var(--tx);font-size:.78rem;outline:none;font-family:inherit}
#dr-key-input:focus{border-color:var(--ac)}
#dr-key-save{padding:5px 12px;border-radius:6px;border:none;background:var(--ac);color:#0c0c10;cursor:pointer;font-size:.75rem;font-weight:600;font-family:inherit}
#dr-content{padding:20px;overflow-y:auto;flex:1;font-size:.85rem;line-height:1.7}
.dr-loading{text-align:center;color:var(--t2);padding:40px;font-size:.85rem}
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd)}
@media(max-width:600px){.cards-grid{grid-template-columns:1fr}.stats-bar,.agent-status-bar{gap:6px}}
</style>
</head>
<body>

<div class="header">
  <h1>🤝 Agent <span>Debate</span> · Tomorrow's Hot Stocks</h1>
  <span style="font-size:.75rem;color:var(--t3)">Generated ${nowIST} IST · ${stocks.length} stocks evaluated</span>
</div>

<div class="nav-links">
  ${HUB_NAV_LINK}
  <a href="index.html">Watchlist</a>
  <a href="apex.html">APEX</a>
  <a href="multibagger.html">Multibagger</a>
  <a href="sectors.html">Sectors</a>
  <a href="confluence.html">Confluence</a>
  <a href="breakout.html">Breakout</a>
  <a href="prediction.html">Prediction</a>
  <a href="debate.html" class="active">🤝 Debate</a>
</div>

<div id="pat-setup-bar">
  <span style="flex-shrink:0">🔑</span>
  <span style="flex-shrink:0;white-space:nowrap">GitHub PAT for price alerts:</span>
  <input id="pat-bar-input" type="password" placeholder="ghp_... (repo Contents R+W)" autocomplete="off">
  <button class="connect" id="pat-bar-save">Connect</button>
  <button class="dismiss" id="pat-bar-close" title="Dismiss">✕</button>
</div>

<div class="stats-bar">
  <div class="stat"><div class="sl">Evaluated</div><div class="sv" style="color:var(--ac)">${stocks.length}</div></div>
  <div class="stat"><div class="sl">🔥 Hot</div><div class="sv gn">${hot.length}</div></div>
  <div class="stat"><div class="sl">⚡ Momentum</div><div class="sv" style="color:var(--ac)">${momentum.length}</div></div>
  <div class="stat"><div class="sl">🧐 Contrarian</div><div class="sv yw">${contrarian.length}</div></div>
  <div class="stat"><div class="sl">Agents</div><div class="sv">5</div></div>
</div>

<div class="agent-status-bar" id="agent-status-bar">
${AGENT_KEYS.map(k=>`  <div class="agent-pill">
    <span class="ap-icon">${AGENT_LABELS[k].split(' ')[0]}</span>
    <span style="font-weight:600;color:var(--tx)">${AGENT_LABELS[k].replace(/^.../,'')}</span>
    <span class="ap-bull">${agentStats[k].bull}B</span>
    <span class="ap-neu">${agentStats[k].neu}N</span>
    <span class="ap-bear">${agentStats[k].bear}Br</span>
    <span style="color:var(--t3);font-size:.65rem">(${agentStats[k].active} stocks)</span>
  </div>`).join('\n')}
</div>

<!-- ═══ HOT LIST ═══ -->
<div class="section">
  <div class="section-title">🔥 Tomorrow's Hot List — Multi-Agent Consensus Picks</div>
  ${hot.length ? `<div class="cards-grid">${hotCards}</div>` : `<div style="text-align:center;padding:40px 20px;color:var(--t3);line-height:2"><div style="font-size:1.8rem;margin-bottom:8px">🔍</div><div style="font-size:.9rem;font-weight:600;color:var(--t2);margin-bottom:6px">No dual-confirmed picks today</div><div style="font-size:.78rem">Hot List requires <strong style="color:var(--ac)">both</strong> a price-action signal (Breakout2 or Creamy Bullish) <strong>and</strong> a fundamental signal (APEX/MBF/IR Bullish).<br>Check the Momentum Plays and Contrarian Watch sections below for partial signals.</div></div>`}
  <div class="disclaimer">⚠️ Paper trade only · Not investment advice · Algorithm-generated consensus · Always do your own research</div>
</div>

<!-- ═══ MOMENTUM PLAYS ═══ -->
${momentum.length ? `<div class="section">
  <div class="section-title">⚡ Momentum Plays — Technical Breakout Only (No Fundamental Backing Yet)</div>
  <div style="font-size:.75rem;color:var(--t3);margin-bottom:12px">Technician (Breakout2) or Momentum (Creamy) Bullish · No APEX/MBF/IR confirmation · Short-term trade only · Higher risk</div>
  <div class="cards-grid">${momCards}</div>
</div>` : ''}

<!-- ═══ CONTRARIAN ═══ -->
${contrarian.length ? `<div class="section">
  <div class="section-title">🧐 Contrarian Watch — Fundamentally Strong, Waiting for Technical Entry</div>
  <div style="font-size:.75rem;color:var(--t3);margin-bottom:12px">APEX/MBF/IR says Bullish · No Stage 2 or VCP breakout yet · Monitor and buy on technical confirmation</div>
  <div class="cards-grid">${contraCards}</div>
</div>` : ''}

<!-- ═══ AGENT CORRELATION ═══ -->
<div class="section">
  <div class="section-title">🧬 Agent Agreement Matrix — How Often Each Pair Agrees</div>
  <div style="font-size:.75rem;color:var(--t3);margin-bottom:12px">% of stocks where both agents gave the same vote · Higher = more aligned philosophies</div>
  <div id="heatmap-chart"></div>
</div>

<!-- ═══ FULL DEBATE TABLE ═══ -->
<div class="section">
  <div class="section-title">📋 Full Debate Table — All ${stocks.length} Stocks</div>
  <div class="filter-bar">
    <button class="filter-btn active" data-cat="all">All (${stocks.length})</button>
    <button class="filter-btn" data-cat="hot">🔥 Hot (${hot.length})</button>
    <button class="filter-btn" data-cat="momentum">⚡ Momentum (${momentum.length})</button>
    <button class="filter-btn" data-cat="contrarian">🧐 Contrarian (${contrarian.length})</button>
    <button class="filter-btn" data-cat="watch">👀 Watch</button>
    <input class="search-box" id="debate-search" placeholder="Search ticker or name…" type="text">
  </div>
  <div style="overflow-x:auto">
    <table id="debate-table">
      <thead><tr>
        <th onclick="sortTable(0)">Stock</th>
        <th onclick="sortTable(1)" style="text-align:center">Score ↕</th>
        <th style="text-align:center" title="${AGENT_LABELS.fundamentalist}">🏛️ Fund.</th>
        <th style="text-align:center" title="${AGENT_LABELS.technician}">⚡ Tech.</th>
        <th style="text-align:center" title="${AGENT_LABELS.momentum}">🚀 Mom.</th>
        <th style="text-align:center" title="${AGENT_LABELS.compounder}">💎 Comp.</th>
        <th style="text-align:center" title="${AGENT_LABELS.quality}">🔬 Qual.</th>
        <th style="text-align:center">Screeners</th>
        <th>Category</th>
        <th>Actions</th>
      </tr></thead>
      <tbody id="debate-tbody">${allTableRows}</tbody>
    </table>
  </div>
</div>

<div class="footer">Agent Debate · ${nowIST} IST · 5 agents · ${stocks.length} stocks · Not investment advice</div>

<!-- Alert Modal -->
<div id="ap-modal">
  <button id="ap-x" style="position:absolute;top:12px;right:12px;background:none;border:none;color:var(--t3);font-size:1.1rem;cursor:pointer">✕</button>
  <div style="font-size:.95rem;font-weight:700;margin-bottom:2px;padding-right:24px" id="ap-title">Set Price Alert</div>
  <div style="font-size:.72rem;color:var(--t2);margin-bottom:12px" id="ap-sub"></div>
  <label class="ap-label" for="ap-above">🔔 Alert when price ABOVE ₹</label>
  <input type="number" id="ap-above" min="0" step="0.5">
  <label class="ap-label" for="ap-below">🔔 Alert when price BELOW ₹</label>
  <input type="number" id="ap-below" min="0" step="0.5">
  <div class="ap-actions">
    <button class="ap-save-btn" id="ap-save">Save Alert</button>
    <button class="ap-clear-btn" id="ap-clear">Clear</button>
  </div>
</div>

<!-- Brain Overlay -->
<div id="dr-overlay">
  <div id="dr-modal">
    <div id="dr-header">
      <h2 id="dr-title">🧠 AI Debate Analysis</h2>
      <button id="dr-close">✕</button>
    </div>
    <div id="dr-provider-bar">
      <button class="dr-prov-btn active" data-prov="groq">Groq (Free)</button>
      <button class="dr-prov-btn" data-prov="openrouter">OpenRouter</button>
      <button class="dr-prov-btn" data-prov="gemini">Gemini</button>
      <input id="dr-key-input" type="password" placeholder="API Key…" autocomplete="off">
      <button id="dr-key-save">Save</button>
    </div>
    <div id="dr-content"><div class="dr-loading">Click 🧠 Debate on any stock to get a multi-agent analysis.</div></div>
  </div>
</div>

<script>
const MATRIX_DATA = ${matrixData};
const CLIENT_DATA = ${clientData};

// ─── ApexCharts Heatmap ────────────────────────────────────────────────────
(function(){
  const { keys, labels, matrix } = MATRIX_DATA;
  const series = keys.map(rowKey => ({
    name: labels[keys.indexOf(rowKey)].trim(),
    data: keys.map(colKey => ({ x: labels[keys.indexOf(colKey)].trim(), y: matrix[rowKey][colKey] }))
  }));
  new ApexCharts(document.getElementById('heatmap-chart'), {
    chart: { type:'heatmap', height:220, toolbar:{show:false}, background:'transparent', foreColor:'#8888a0' },
    series,
    dataLabels: { enabled:true, style:{ fontSize:'11px', colors:['#e8e8f0'] }, formatter: v => v+'%' },
    colors: ['#00d4aa'],
    plotOptions: { heatmap: { shadeIntensity:0.6, radius:4, colorScale: { ranges:[
      {from:0,  to:39, color:'#ef4444', name:'Low agreement'},
      {from:40, to:64, color:'#eab308', name:'Moderate'},
      {from:65, to:79, color:'#22c55e', name:'Good'},
      {from:80, to:100,color:'#00d4aa', name:'High agreement'},
    ]}}},
    xaxis: { labels:{ style:{ fontSize:'11px', colors:'#8888a0' }}},
    yaxis: { labels:{ style:{ colors:'#8888a0' }}},
    grid: { borderColor:'#1e1e2e' },
    tooltip: { y:{ formatter: v => v+'% agreement rate' }},
  }).render();
})();

// ─── Table filter + search ─────────────────────────────────────────────────
(function(){
  const tbody = document.getElementById('debate-tbody');
  const rows  = Array.from(tbody.querySelectorAll('tr'));
  let curCat = 'all', curSearch = '';

  function applyFilter(){
    rows.forEach(r => {
      const cat   = r.dataset.category || '';
      const text  = r.textContent.toLowerCase();
      const catOk = curCat === 'all' || cat === curCat;
      const srOk  = !curSearch || text.includes(curSearch);
      r.style.display = catOk && srOk ? '' : 'none';
    });
  }

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      curCat = btn.dataset.cat;
      applyFilter();
    });
  });

  document.getElementById('debate-search').addEventListener('input', e => {
    curSearch = e.target.value.toLowerCase().trim();
    applyFilter();
  });

  let sortDir = -1;
  window.sortTable = function(col) {
    sortDir *= -1;
    rows.sort((a,b) => {
      if (col === 0) return sortDir * a.cells[0].textContent.trim().localeCompare(b.cells[0].textContent.trim());
      const va = parseFloat(a.cells[col]?.textContent) || 0;
      const vb = parseFloat(b.cells[col]?.textContent) || 0;
      return sortDir * (va - vb);
    });
    rows.forEach(r => tbody.appendChild(r));
  };
})();

// ─── Alert System ─────────────────────────────────────────────────────────
window._GH_ALERTS_REPO = 'amitiyer99/watchlist-app';
(function(){
  var _GH = window._GH_ALERTS_REPO||'', _SHA = null;
  window._GA = {};
  function pat(){ return localStorage.getItem('gh_alerts_pat')||''; }
  function fetchAlerts(){
    var p=pat(); if(!p)return;
    fetch('https://api.github.com/repos/'+_GH+'/contents/user-alerts.json?t='+Date.now(),{headers:{'Authorization':'token '+p,'Accept':'application/vnd.github.v3+json'}})
      .then(r=>r.json()).then(j=>{_SHA=j.sha;try{window._GA=JSON.parse(atob(j.content.split(String.fromCharCode(10)).join('')));}catch(e){window._GA={};}refreshA();}).catch(()=>{});
  }
  function showPatBar(){var b=document.getElementById('pat-setup-bar');if(b&&!pat())b.style.display='flex';}
  function hidePatBar(){var b=document.getElementById('pat-setup-bar');if(b)b.style.display='none';}
  function saveAlerts(a){
    var p=pat(); if(!p){showPatBar();return;}
    var content=btoa(unescape(encodeURIComponent(JSON.stringify(a,null,2))));
    function doSave(sha){var b={message:'chore: update price alerts [skip ci]',content:content};if(sha)b.sha=sha;return fetch('https://api.github.com/repos/'+_GH+'/contents/user-alerts.json',{method:'PUT',headers:{'Authorization':'token '+p,'Content-Type':'application/json','Accept':'application/vnd.github.v3+json'},body:JSON.stringify(b)});}
    (_SHA?doSave(_SHA):fetch('https://api.github.com/repos/'+_GH+'/contents/user-alerts.json?t='+Date.now(),{headers:{'Authorization':'token '+p,'Accept':'application/vnd.github.v3+json'}}).then(r=>r.ok?r.json().then(j=>{_SHA=j.sha;return doSave(_SHA);}):doSave(null)).catch(()=>doSave(null)))
      .then(r=>r.json()).then(j=>{if(j.content){_SHA=j.content.sha;window._GA=a;refreshA();}});
  }
  var modal=document.getElementById('ap-modal'),curT='',curN='',curP=0;
  document.addEventListener('click',e=>{if(modal&&modal.style.display==='block'&&!modal.contains(e.target)&&!e.target.closest('.alert-btn'))modal.style.display='none';},true);
  document.addEventListener('click',e=>{
    var btn=e.target.closest('.alert-btn');if(!btn)return;e.stopPropagation();
    curT=btn.dataset.alertTicker||'';curN=btn.dataset.alertName||curT;curP=parseFloat(btn.dataset.alertPrice)||0;
    document.getElementById('ap-title').textContent=curN+' ('+curT+')';
    document.getElementById('ap-sub').textContent='Last: \u20B9'+curP.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
    var al=window._GA[curT]||{};document.getElementById('ap-above').value=al.above||'';document.getElementById('ap-below').value=al.below||'';
    var r=btn.getBoundingClientRect(),top=r.bottom+6;if(top+340>window.innerHeight)top=Math.max(8,r.top-346);
    modal.style.top=top+'px';modal.style.left=Math.max(8,Math.min(r.left,window.innerWidth-280))+'px';modal.style.display='block';
  });
  document.getElementById('ap-x').onclick=()=>modal.style.display='none';
  document.getElementById('ap-save').onclick=()=>{var a=JSON.parse(JSON.stringify(window._GA));var ab=parseFloat(document.getElementById('ap-above').value)||null,bl=parseFloat(document.getElementById('ap-below').value)||null;if(ab||bl){a[curT]={above:ab,below:bl,name:curN};}else{delete a[curT];}modal.style.display='none';saveAlerts(a);};
  document.getElementById('ap-clear').onclick=()=>{var a=JSON.parse(JSON.stringify(window._GA));delete a[curT];modal.style.display='none';saveAlerts(a);};
  function refreshA(){var a=window._GA;document.querySelectorAll('.alert-btn').forEach(btn=>{var t=btn.dataset.alertTicker||'';btn.classList.remove('has-alert');if(a[t]&&(a[t].above||a[t].below))btn.classList.add('has-alert');});}
  var patSave=document.getElementById('pat-bar-save');
  if(patSave)patSave.onclick=()=>{var v=(document.getElementById('pat-bar-input').value||'').trim();if(v){localStorage.setItem('gh_alerts_pat',v);hidePatBar();fetchAlerts();}};
  var patClose=document.getElementById('pat-bar-close');
  if(patClose)patClose.onclick=hidePatBar;
  if(pat())hidePatBar();else showPatBar();
  fetchAlerts();
})();

// ─── Brain / Debate AI ────────────────────────────────────────────────────
(function(){
  const overlay=document.getElementById('dr-overlay'),titleEl=document.getElementById('dr-title'),content=document.getElementById('dr-content');
  const PROVIDERS={
    groq:{label:'Groq',url:'https://api.groq.com/openai/v1/chat/completions',model:'llama-3.3-70b-versatile',keyName:'groq_api_key'},
    openrouter:{label:'OpenRouter',url:'https://openrouter.ai/api/v1/chat/completions',model:'mistralai/mixtral-8x7b-instruct',keyName:'openrouter_api_key'},
    gemini:{label:'Gemini',url:'',model:'gemini-2.0-flash',keyName:'gemini_api_key'}
  };
  let curProv='groq';
  document.querySelectorAll('.dr-prov-btn').forEach(btn=>{
    btn.onclick=()=>{curProv=btn.dataset.prov;document.querySelectorAll('.dr-prov-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
    const k=localStorage.getItem(PROVIDERS[curProv].keyName)||'';document.getElementById('dr-key-input').value=k?'\u2022\u2022\u2022\u2022\u2022\u2022':'';}; });
  document.getElementById('dr-key-save').onclick=()=>{const v=document.getElementById('dr-key-input').value.trim();if(v&&!v.startsWith('\u2022'))localStorage.setItem(PROVIDERS[curProv].keyName,v);};
  document.getElementById('dr-close').onclick=()=>overlay.classList.remove('open');
  overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.classList.remove('open');});
  async function doResearch(ticker,name,customPrompt){
    overlay.classList.add('open');
    titleEl.textContent='\uD83E\uDDE0 Agent Debate: '+name;
    content.innerHTML='<div class="dr-loading">Consulting AI\u2026</div>';
    const systemPrompt='You are a sharp NSE India equity analyst. Analyse the multi-agent debate result concisely and give a clear buy/pass/wait recommendation with specific reasons. Focus on the next 1-2 trading days. Be direct and specific.';
    const prov=PROVIDERS[curProv];const key=localStorage.getItem(prov.keyName)||'';
    if(!key){content.innerHTML='<div style="color:var(--rd);padding:16px">Please enter your '+prov.label+' API key above.</div>';return;}
    try{
      let text='';
      if(curProv==='gemini'){
        const url='https://generativelanguage.googleapis.com/v1beta/models/'+prov.model+':generateContent?key='+key;
        const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:systemPrompt+'\\n\\n'+customPrompt}]}]})});
        const d=await res.json();text=d.candidates?.[0]?.content?.parts?.[0]?.text||'No response';
      } else {
        const res=await fetch(prov.url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:prov.model,messages:[{role:'system',content:systemPrompt},{role:'user',content:customPrompt}],max_tokens:600})});
        const d=await res.json();text=d.choices?.[0]?.message?.content||d.error?.message||'No response';
      }
      content.innerHTML='<div style="white-space:pre-wrap;line-height:1.8">'+text.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</div>';
    }catch(e){content.innerHTML='<div style="color:var(--rd);padding:16px">Error: '+e.message+'</div>';}
  }
  document.addEventListener('click',e=>{
    const btn=e.target.closest('.research-btn');if(!btn)return;
    const ticker=btn.dataset.rTicker||'',name=btn.dataset.rName||ticker,prompt=btn.dataset.rPrompt||ticker;
    doResearch(ticker,name,prompt);
  });
})();
<\/script>
</body>
</html>`;

  fs.writeFileSync(OUT_HTML, html);
  console.log(`Written ${OUT_HTML}`);
  console.log('Done!');
}

main();

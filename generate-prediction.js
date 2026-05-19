'use strict';

const fs   = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yf   = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// ─── Paths ─────────────────────────────────────────────────────────────────────
const DOCS         = path.join(__dirname, 'docs');
const OUT_HTML     = path.join(DOCS, 'prediction.html');
const HISTORY_PATH = path.join(DOCS, 'prediction-history.json');
const APEX_PATH    = path.join(DOCS, 'apex-tickers.json');
const CREAMY_PATH  = path.join(DOCS, 'creamy-tickers.json');

// ─── Constants ─────────────────────────────────────────────────────────────────
const HISTORY_DAYS = 1095; // ~3 years
const BENCH        = '^NSEI';

const SECTORS = [
  { ticker:'^CNXIT',     name:'Nifty IT',        abbr:'IT',      color:'#6366f1', apex:['information technology','it','technology'] },
  { ticker:'^NSEBANK',   name:'Nifty Bank',       abbr:'BANK',    color:'#3b82f6', apex:['financials','banking','bank'] },
  { ticker:'^CNXPHARMA', name:'Nifty Pharma',     abbr:'PHARMA',  color:'#22c55e', apex:['healthcare','health care','pharmaceuticals','pharma'] },
  { ticker:'^CNXMETAL',  name:'Nifty Metal',      abbr:'METAL',   color:'#a855f7', apex:['materials','metals','steel','mining'] },
  { ticker:'^CNXAUTO',   name:'Nifty Auto',       abbr:'AUTO',    color:'#f59e0b', apex:['consumer discretionary','automobile','auto','automotive'] },
  { ticker:'^CNXREALTY', name:'Nifty Realty',     abbr:'REALTY',  color:'#ec4899', apex:['real estate','realty','construction'] },
  { ticker:'^CNXENERGY', name:'Nifty Energy',     abbr:'ENERGY',  color:'#f97316', apex:['energy','power','utilities'] },
  { ticker:'^CNXFMCG',   name:'Nifty FMCG',      abbr:'FMCG',    color:'#84cc16', apex:['consumer staples','fmcg','consumer goods'] },
  { ticker:'^CNXPSE',    name:'Nifty PSE',        abbr:'PSE',     color:'#ef4444', apex:['oil & gas','oil and gas','petroleum','refinery'] },
  { ticker:'^CNXINFRA',  name:'Nifty Infra',      abbr:'INFRA',   color:'#14b8a6', apex:['industrials','infrastructure','infra','cement','capital goods'] },
  { ticker:'^CNXMEDIA',  name:'Nifty Media',      abbr:'MEDIA',   color:'#06b6d4', apex:['communication services','media','entertainment'] },
  { ticker:'^CNXCONSUM', name:'Nifty Consumer',   abbr:'CONSUM',  color:'#f43f5e', apex:['consumer electronics','consumer durables','durables','appliances'] },
  { ticker:'^CNXPSUBANK',name:'Nifty PSU Bank',   abbr:'PSUBANK', color:'#0ea5e9', apex:['psu bank','public sector bank'] },
  { ticker:'^CNXSERVICE',name:'Nifty Services',   abbr:'SVCFIN',  color:'#8b5cf6', apex:['financial services','services','insurance','nbfc'] },
];

const DEF_W = { rrg:0.35, analog:0.30, seasonality:0.15, rsi:0.10, vol:0.10 };

// ─── Helpers ───────────────────────────────────────────────────────────────────
const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const avg   = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
const fmtP  = (v,d=1) => v==null||isNaN(v)?'—':(v>=0?'+':'')+Number(v).toFixed(d)+'%';
const dateStr = d => new Date(d).toISOString().slice(0,10);

function emaArr(vals, n) {
  const k=2/(n+1); let e=vals[0]; const out=[e];
  for(let i=1;i<vals.length;i++){e=vals[i]*k+e*(1-k);out.push(e);}
  return out;
}

function rsi14(closes) {
  if(closes.length<15) return null;
  let g=0,l=0;
  for(let i=1;i<=14;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l-=d;}
  let ag=g/14,al=l/14;
  for(let i=15;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*13+Math.max(d,0))/14;al=(al*13+Math.max(-d,0))/14;}
  return al===0?100:100-100/(1+ag/al);
}

function retPct(closes,n){const len=closes.length;if(len<=n)return null;const b=closes[len-1-n];return b?((closes[len-1]/b)-1)*100:null;}

function medianVal(arr){if(!arr.length)return null;const s=[...arr].sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2===0?(s[m-1]+s[m])/2:s[m];}

function tradingDaysElapsed(from,to){
  let cnt=0,d=new Date(from);
  while(d<to){d.setDate(d.getDate()+1);if(d.getDay()>=1&&d.getDay()<=5)cnt++;}
  return cnt;
}

function addTradingDays(from,n){
  const dt=new Date(from),dir=n>=0?1:-1;
  let cnt=0;
  while(cnt<Math.abs(n)){dt.setDate(dt.getDate()+dir);if(dt.getDay()>=1&&dt.getDay()<=5)cnt++;}
  return dt;
}

// ─── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchHistory(ticker){
  const p1=new Date(Date.now()-HISTORY_DAYS*86400000);
  const p2=new Date(Date.now()-86400000);
  try{
    const rows=await yf.historical(ticker,{period1:p1,period2:p2,interval:'1d'});
    if(!rows||rows.length<60)return null;
    return rows.filter(r=>r.close!=null).sort((a,b)=>new Date(a.date)-new Date(b.date));
  }catch(e){console.warn(`  history failed ${ticker}: ${e.message}`);return null;}
}

// ─── Analysis ──────────────────────────────────────────────────────────────────
function computeRRG(sBars,bBars){
  const bMap=new Map();
  for(const b of bBars) bMap.set(dateStr(b.date),b.close);
  const aligned=sBars.filter(b=>bMap.has(dateStr(b.date))).map(b=>({sC:b.close,bC:bMap.get(dateStr(b.date))}));
  if(aligned.length<50)return null;
  const rs=aligned.map(b=>b.sC/b.bC);
  const e10=emaArr(rs,10),e26=emaArr(rs,26);
  const rrArr=e10.map((v,i)=>e26[i]>0?(v/e26[i])*100:100);
  const rre3=emaArr(rrArr,3),rre10=emaArr(rrArr,10);
  const rmArr=rre3.map((v,i)=>rre10[i]>0?(v/rre10[i])*100:100);
  // Trail: last 8 weekly snapshots (5 bars each)
  const trail=[];
  for(let w=7;w>=0;w--){const idx=rrArr.length-1-w*5;if(idx>=0)trail.push({x:+rrArr[idx].toFixed(3),y:+rmArr[idx].toFixed(3)});}
  const rr=rrArr[rrArr.length-1],rm=rmArr[rmArr.length-1];
  const quad=rr>=100&&rm>=100?'Leading':rr>=100?'Weakening':rm>=100?'Improving':'Lagging';
  return{rsRatio:+rr.toFixed(3),rsMom:+rm.toFixed(3),quadrant:quad,trail};
}

function computeSeasonality(bars){
  const dow={1:[],2:[],3:[],4:[],5:[]},mon={};
  for(let m=1;m<=12;m++)mon[m]=[];
  for(let i=1;i<bars.length;i++){
    const prev=bars[i-1].close,curr=bars[i].close;
    if(!prev||!curr)continue;
    const r=(curr/prev-1)*100,d=new Date(bars[i].date);
    if(d.getDay()>=1&&d.getDay()<=5)dow[d.getDay()].push(r);
    mon[d.getMonth()+1].push(r);
  }
  const DL=['Mon','Tue','Wed','Thu','Fri'],ML=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return{
    byDow:[1,2,3,4,5].map(i=>({dow:i,label:DL[i-1],avg:dow[i].length?+avg(dow[i]).toFixed(4):0,n:dow[i].length})),
    byMonth:Array.from({length:12},(_,i)=>({month:i+1,label:ML[i],avg:mon[i+1].length?+avg(mon[i+1]).toFixed(4):0,n:mon[i+1].length})),
  };
}

function computeAnalog(bars){
  const closes=bars.map(b=>b.close);
  if(closes.length<50)return null;
  const curRSI=rsi14(closes.slice(-50)),cur5D=retPct(closes,5);
  if(curRSI==null||cur5D==null)return null;
  const lo=curRSI-10,hi=curRSI+10,posSign=cur5D>=0,fwd=[];
  for(let i=20;i<closes.length-15;i++){
    const wRSI=rsi14(closes.slice(Math.max(0,i-49),i+1));
    if(wRSI==null||wRSI<lo||wRSI>hi||i<5)continue;
    const r5=(closes[i]/closes[i-5]-1)*100;
    if((r5>=0)!==posSign||i+10>=closes.length)continue;
    fwd.push((closes[i+10]/closes[i]-1)*100);
  }
  if(!fwd.length)return{median:null,min:null,max:null,count:0};
  return{median:+medianVal(fwd).toFixed(2),min:+Math.min(...fwd).toFixed(2),max:+Math.max(...fwd).toFixed(2),count:fwd.length};
}

function computeMomentum(bars){
  const closes=bars.map(b=>b.close),vols=bars.map(b=>b.volume||0);
  const rsiVal=rsi14(closes.slice(-50));
  const v5=vols.slice(-5).filter(v=>v>0),v20=vols.slice(-20).filter(v=>v>0);
  const volRatio=v20.length&&avg(v20)>0?+(avg(v5)/avg(v20)).toFixed(3):1;
  return{rsi:rsiVal!=null?+rsiVal.toFixed(1):null,ret5D:retPct(closes,5),ret10D:retPct(closes,10),ret22D:retPct(closes,22),ret66D:retPct(closes,66),price:closes[closes.length-1],volRatio};
}

// Fetch a stock's own historical analog to estimate its 2-week potential gain
async function fetchStockAnalog(ticker) {
  const bars = await fetchHistory(ticker + '.NS');
  if (!bars || bars.length < 50) return null;
  const analog = computeAnalog(bars);
  const closes = bars.map(b => b.close);
  const vols   = bars.map(b => b.volume || 0);
  const price  = closes[closes.length - 1];
  // ATR: mean absolute daily move over last 14 days
  let atrSum = 0, atrCount = 0;
  for (let i = Math.max(1, closes.length - 15); i < closes.length; i++) {
    atrSum += Math.abs(closes[i] - closes[i - 1]);
    atrCount++;
  }
  const atr    = atrCount ? atrSum / atrCount : 0;
  const atrPct = price ? +(atr * 10 / price * 100).toFixed(1) : null;
  // Momentum
  const rsiVal = rsi14(closes.slice(-50));
  const ret1D  = retPct(closes, 1);
  const ret5D  = retPct(closes, 5);
  const ret22D = retPct(closes, 22);
  // Volume ratio: 5D avg vs 20D avg
  const v5  = vols.slice(-5).filter(v => v > 0);
  const v20 = vols.slice(-20).filter(v => v > 0);
  const volRatio = v20.length && avg(v20) > 0 ? +(avg(v5) / avg(v20)).toFixed(2) : null;
  // 52-week range (last 252 bars)
  const yr = closes.slice(-252);
  const high52w = yr.length ? Math.max(...yr) : null;
  const low52w  = yr.length ? Math.min(...yr) : null;
  const distFromHigh = (high52w && price) ? +((price / high52w - 1) * 100).toFixed(1) : null;
  // Stop loss: 2× ATR below current price
  const stopLoss    = price && atr ? +(price - 2 * atr).toFixed(2)           : null;
  const stopLossPct = price && atr ? +((2 * atr / price) * 100).toFixed(1)   : null;
  return { analog, atrPct, rsi: rsiVal != null ? +rsiVal.toFixed(1) : null, ret1D, ret5D, ret22D, volRatio, high52w, low52w, distFromHigh, stopLoss, stopLossPct };
}

// ─── Multi-Agent Stock Analysis ────────────────────────────────────────────────

// Agent 1: Trend Quality — Minervini MA alignment (0-100)
// A stock in a proper uptrend has price > 50D > 150D > 200D MA, 200D rising, near 52W high
function agentTrend(closes) {
  if (closes.length < 200) return 0;
  const price  = closes[closes.length - 1];
  const ma50   = avg(closes.slice(-50));
  const ma150  = avg(closes.slice(-150));
  const ma200  = avg(closes.slice(-200));
  const ma200p = closes.length >= 220 ? avg(closes.slice(-220, -20)) : null; // 200D MA 1 month ago
  const high52 = Math.max(...closes.slice(-252));
  const low52  = Math.min(...closes.slice(-252));
  let s = 0;
  if (price > ma50)           s += 20; // price above 50D MA
  if (ma50  > ma150)          s += 15; // 50D > 150D
  if (ma150 > ma200)          s += 15; // 150D > 200D (full bullish alignment)
  if (ma200p && ma200 > ma200p) s += 20; // 200D MA itself trending up
  const distHi = (price / high52 - 1) * 100;
  if (distHi >= -8)           s += 20; // within 8% of 52W high = near highs
  else if (distHi >= -15)     s += 12;
  else if (distHi >= -25)     s +=  5;
  const aboveLo = (price / low52 - 1) * 100;
  if (aboveLo >= 40)          s += 10; // at least 40% above 52W low = strong base
  return Math.min(100, s);
}

// Agent 2: Relative Strength & Momentum vs Nifty (0-100)
// Strong stocks outperform the index; rising RS line is key Minervini indicator
function agentMomentum(closes, benchCloses) {
  if (closes.length < 60 || benchCloses.length < 60) return 0;
  const n = Math.min(closes.length, benchCloses.length);
  const sc = closes.slice(-n), sb = benchCloses.slice(-n);
  const r60s = retPct(sc, 60), r60b = retPct(sb, 60);
  const r20s = retPct(sc, 20), r20b = retPct(sb, 20);
  const r10s = retPct(sc, 10);
  const rsLong  = (r60s != null && r60b != null) ? r60s - r60b : 0; // 3M RS vs Nifty
  const rsShort = (r20s != null && r20b != null) ? r20s - r20b : 0; // 1M RS vs Nifty
  const rsiVal  = rsi14(sc.slice(-50));
  let s = 0;
  if (rsLong > 15)      s += 30;
  else if (rsLong > 8)  s += 20;
  else if (rsLong > 3)  s += 12;
  else if (rsLong > 0)  s +=  5;
  if (rsShort > rsLong) s += 20; // RS line accelerating (most bullish signal)
  else if (rsShort > 0) s +=  8;
  if (r10s > 5)         s += 20;
  else if (r10s > 2)    s += 12;
  else if (r10s > 0)    s +=  5;
  if (rsiVal != null) {
    if (rsiVal >= 55 && rsiVal <= 70)      s += 15; // momentum sweet spot
    else if (rsiVal >= 45 && rsiVal < 55)  s +=  8; // building
    else if (rsiVal > 70 && rsiVal <= 80)  s +=  5; // extended but strong
  }
  return Math.min(100, s);
}

// Agent 3: Setup Quality — consolidation tightness + volume pattern (0-100)
// A good setup is a tight price range (VCP-like) with volume drying up then surging
function agentSetup(closes, vols) {
  if (closes.length < 20) return 0;
  const tight  = closes.slice(-15);
  const tRange = (Math.max(...tight) - Math.min(...tight)) / Math.min(...tight) * 100;
  const v5  = vols.slice(-5).filter(v => v > 0);
  const v50 = vols.slice(-50).filter(v => v > 0);
  const vr  = (v5.length && v50.length && avg(v50) > 0) ? avg(v5) / avg(v50) : 1;
  const rsiVal = rsi14(closes.slice(-50));
  let s = 0;
  // Consolidation tightness
  if (tRange < 5)       s += 35; // very tight — VCP / flat base
  else if (tRange < 8)  s += 22;
  else if (tRange < 12) s += 10;
  // Volume pattern
  if (vr >= 2.0)        s += 35; // strong volume surge on breakout
  else if (vr >= 1.5)   s += 25;
  else if (vr >= 1.2)   s += 15;
  else if (vr >= 0.9)   s +=  5;
  // RSI in ideal entry zone
  if (rsiVal != null) {
    if (rsiVal >= 45 && rsiVal <= 62)      s += 30; // ideal entry zone
    else if (rsiVal >= 38 && rsiVal < 45)  s += 12; // slightly weak, could be recovery
    else if (rsiVal > 62 && rsiVal <= 72)  s += 12; // extended but still in range
  }
  return Math.min(100, s);
}

// ATR-based price target — reliable forward projection, no noisy historical analog
function computeAtrTarget(closes) {
  const price = closes[closes.length - 1];
  if (!price) return null;
  let atrSum = 0, n = 0;
  for (let i = Math.max(1, closes.length - 15); i < closes.length; i++) {
    atrSum += Math.abs(closes[i] - closes[i - 1]);
    n++;
  }
  const atr = n ? atrSum / n : 0;
  if (!atr || !isFinite(atr)) return null;
  // 1.5× projected 10-day ATR, floored at 2.5% (meaningful minimum), capped at 20%
  const rawPct      = atr * 10 / price * 100 * 1.5;
  if (!isFinite(rawPct) || rawPct < 0) return null;
  const targetPct   = +(Math.max(Math.min(rawPct, 20), 2.5)).toFixed(1);
  const targetPrice = +(price * (1 + targetPct / 100)).toFixed(2);
  const stopLoss    = +(price - 2 * atr).toFixed(2);
  const stopPct     = +(2 * atr / price * 100).toFixed(1);
  const rr          = stopPct > 0 ? +(targetPct / stopPct).toFixed(1) : null;
  return { targetPct, targetPrice, stopLoss, stopPct, rr };
}

// Run all three agents on every stock in the universe — bottom-up, no sector constraint
async function runMultiAgentScan(universe, benchBars) {
  const benchCloses = benchBars.map(b => b.close);
  const results = [];
  console.log(`Multi-agent scan: ${universe.length} candidates...`);
  for (let i = 0; i < universe.length; i += 3) {
    const batch = universe.slice(i, i + 3);
    await Promise.all(batch.map(async stock => {
      const bars = await fetchHistory(stock.ticker + '.NS');
      if (!bars || bars.length < 100) return;
      const closes = bars.map(b => b.close);
      const vols   = bars.map(b => b.volume || 0);
      const price  = closes[closes.length - 1];
      const trendS    = agentTrend(closes);
      const momentumS = agentMomentum(closes, benchCloses);
      const setupS    = agentSetup(closes, vols);
      // Weighted composite: Trend 35%, Momentum 35%, Setup 30%
      const composite = Math.round(trendS * 0.35 + momentumS * 0.35 + setupS * 0.30);
      const target    = computeAtrTarget(closes);
      const rsiVal    = rsi14(closes.slice(-50));
      const high52    = Math.max(...closes.slice(-252));
      const dfh       = high52 ? +((price / high52 - 1) * 100).toFixed(1) : null;
      // Quality gates: trend sound (≥35), composite ≥52, R:R ≥1.2, target ≥2.5%
      if (composite < 52 || trendS < 35 || !target || target.rr < 1.2 || target.targetPct < 2.5) return;
      results.push({
        ticker: stock.ticker, name: stock.name, sector: stock.sector,
        url: stock.url || '', apexScore: stock.apexScore || 0,
        tier: stock.tier || null, debateBacked: !!stock.debateBacked,
        agentSummary: stock.agentSummary || null,
        price,
        rsi:    rsiVal != null ? +rsiVal.toFixed(1) : null,
        ret5D:  retPct(closes, 5)  != null ? +retPct(closes, 5).toFixed(2)  : null,
        ret22D: retPct(closes, 22) != null ? +retPct(closes, 22).toFixed(2) : null,
        distFromHigh: dfh,
        trendScore: trendS, momentumScore: momentumS, setupScore: setupS, composite,
        targetGainPct: target.targetPct, targetPrice: target.targetPrice,
        stopLoss: target.stopLoss, stopLossPct: target.stopPct, riskReward: target.rr,
        action: 'BUY', conviction: composite >= 68 ? 'High' : 'Medium',
        isShortList: false,
      });
    }));
    if (i + 3 < universe.length) await sleep(600);
  }
  results.sort((a, b) => b.composite - a.composite);
  const top = Math.min(10, results.length);
  results.slice(0, top).forEach(r => r.isShortList = true);
  console.log(`  Scan done: ${results.length} passed filters, ${top} shortlisted`);
  return results;
}

function scoreSector(rrg,analog,season,mom,weights,now){
  const w=weights;
  const qMap={Leading:100,Improving:57,Weakening:-43,Lagging:-100};
  const sRRG=rrg?qMap[rrg.quadrant]:0;
  const sAnalog=(analog&&analog.median!=null)?Math.max(-100,Math.min(100,analog.median*20)):0;
  let sSeason=0;
  if(season){
    const d=now.getDay(),m=now.getMonth()+1;
    const dE=season.byDow.find(x=>x.dow===d),mE=season.byMonth.find(x=>x.month===m);
    sSeason=Math.max(-100,Math.min(100,((dE?dE.avg:0)+(mE?mE.avg*0.2:0))*200));
  }
  const rsi=mom?.rsi;
  const sRSI=rsi==null?0:rsi<30?-100:rsi<40?-30:rsi<50?60:rsi<60?100:rsi<70?50:-50;
  const vr=mom?.volRatio;
  const sVol=vr==null?0:vr>1.5?100:vr>1.2?60:vr>1.0?20:vr>0.8?-20:-80;
  const score=Math.max(-100,Math.min(100,Math.round(w.rrg*sRRG+w.analog*sAnalog+w.seasonality*sSeason+w.rsi*sRSI+w.vol*sVol)));
  const dir=score>20?'Bullish':score<-20?'Bearish':'Neutral';
  const conf=Math.abs(score)>60?'High':Math.abs(score)>30?'Medium':'Low';
  const sigs=[];
  if(rrg)sigs.push(rrg.quadrant+' quadrant');
  if(analog&&analog.median!=null)sigs.push((analog.median>=0?'+':'')+analog.median.toFixed(1)+'% hist(n='+analog.count+')');
  if(rsi!=null)sigs.push('RSI '+rsi.toFixed(0));
  return{score,direction:dir,confidence:conf,signals:sigs,cs:{rrg:sRRG,analog:sAnalog,season:sSeason,rsi:sRSI,vol:sVol}};
}

// ─── Stock Picks ───────────────────────────────────────────────────────────────
// Load debate-data.json allStocks (produced by generate-debate.js which runs first)
function loadDebateStocks() {
  const p = path.join(DOCS, 'debate-data.json');
  if (!fs.existsSync(p)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return d.allStocks || [];
  } catch(e) { return []; }
}

function matchApex(sector, apexTickers, creamyTickers) {
  const apexKeys = sector.apex || [];
  const sectorMatch = (t) => {
    const tSec = (t.sector || '').toLowerCase();
    return apexKeys.some(k => tSec.includes(k) || k.includes(tSec));
  };

  // 1) Try debate allStocks first — dual-confirmed picks (price-action + fundamental)
  const debateStocks = loadDebateStocks();
  if (debateStocks.length > 0) {
    // Prefer hot > contrarian > watch, sorted by score desc, sector-matched
    const ORDER = { hot:0, momentum:1, contrarian:2, watch:3, avoid:99 };
    const debateHits = debateStocks
      .filter(t => sectorMatch(t) && t.hasPriceAction && t.hasFundamental)
      .sort((a, b) => (ORDER[a.category]||99) - (ORDER[b.category]||99) || b.score - a.score);
    if (debateHits.length >= 2) return debateHits.slice(0, 2).map(t => ({
      ticker: t.ticker, name: t.name, sector: t.sector, price: t.price, score: t.score,
      url: t.url, action: t.category === 'hot' ? 'BUY' : 'WATCH',
      convergence: t.hasPriceAction && t.hasFundamental,
      debateBacked: true, agentSummary: t.agentSummary,
    }));
    if (debateHits.length === 1) {
      // Supplement with APEX fallback
      const apex1 = apexTickers.filter(t => sectorMatch(t)).sort((a,b)=>b.score-a.score).slice(0,1);
      return [...debateHits.slice(0,1).map(t => ({
        ticker:t.ticker, name:t.name, sector:t.sector, price:t.price, score:t.score,
        url:t.url, action:'WATCH', debateBacked:true, agentSummary:t.agentSummary,
      })), ...apex1].slice(0, 2);
    }
  }

  // 2) Fallback: APEX screener sector match (original logic)
  const hits = apexTickers.filter(t => sectorMatch(t)).sort((a,b) => b.score - a.score);
  if (hits.length >= 2) return hits.slice(0, 2);
  const cream = creamyTickers.filter(t => sectorMatch(t)).sort((a,b) => (b.score||0) - (a.score||0));
  return [...hits, ...cream].slice(0, 2);
}

// ─── History / Feedback ────────────────────────────────────────────────────────
function loadHistory(){
  if(!fs.existsSync(HISTORY_PATH))return{weights:{...DEF_W},snapshots:[],validations:[]};
  try{return JSON.parse(fs.readFileSync(HISTORY_PATH,'utf8'));}
  catch(e){console.warn('prediction-history.json parse error — resetting');return{weights:{...DEF_W},snapshots:[],validations:[]};}
}

async function validateMature(history){
  const today=new Date();let changed=false;
  for(const snap of history.snapshots){
    if(new Date(snap.targetDate)>today)continue;
    if(history.validations.some(v=>v.snapshotId===snap.id))continue;
    console.log(`Validating snapshot ${snap.id}...`);
    const results=[];
    for(const ss of(snap.sectors||[])){
      if(!ss.priceAtSnapshot)continue;
      try{
        const q=await yf.quote(ss.ticker);
        const exit=q.regularMarketPrice;
        const ret=((exit-ss.priceAtSnapshot)/ss.priceAtSnapshot)*100;
        const correct=(ss.direction==='Bullish'&&ret>0)||(ss.direction==='Bearish'&&ret<0)||(ss.direction==='Neutral');
        const cs=ss.cs||{};
        results.push({sector:ss.name,ticker:ss.ticker,actualReturn:+ret.toFixed(2),predictedDirection:ss.direction,correct,
          signalWasRight:{rrg:(cs.rrg>0)===(ret>0),analog:(cs.analog>0)===(ret>0),season:(cs.season>0)===(ret>0),rsi:(cs.rsi>0)===(ret>0),vol:(cs.vol>0)===(ret>0)}});
        ss.actualReturn=+ret.toFixed(2);ss.exitPrice=exit;
      }catch(e){console.warn(`  skip ${ss.ticker}: ${e.message}`);}
    }
    for(const pick of(snap.picks||[])){
      if(!pick.entryPrice)continue;
      try{const q=await yf.quote(pick.ticker+'.NS');pick.exitPrice=q.regularMarketPrice;pick.actualReturn=+((pick.exitPrice-pick.entryPrice)/pick.entryPrice*100).toFixed(2);}catch(e){}
    }
    const pRets=(snap.picks||[]).filter(p=>p.actualReturn!=null).map(p=>p.actualReturn);
    const basket=pRets.length?+avg(pRets).toFixed(2):null;
    const hitRate=pRets.length?+(pRets.filter(r=>r>0).length/pRets.length).toFixed(3):null;
    let niftyRet=null;
    try{const nq=await yf.quote(BENCH);const ne=nq.regularMarketPrice;if(snap.niftyAtSnapshot){niftyRet=+((ne-snap.niftyAtSnapshot)/snap.niftyAtSnapshot*100).toFixed(2);snap.niftyAtTarget=ne;}}catch(e){}
    const acc=results.length?+(results.filter(r=>r.correct).length/results.length).toFixed(3):0;
    history.validations.push({snapshotId:snap.id,validatedAt:new Date().toISOString(),overallAccuracy:acc,basketReturn:basket,hitRate,niftyReturn:niftyRet,alphaVsNifty:basket!=null&&niftyRet!=null?+(basket-niftyRet).toFixed(2):null,results});
    snap.basketReturn=basket;snap.hitRate=hitRate;snap.alphaVsNifty=basket!=null&&niftyRet!=null?+(basket-niftyRet).toFixed(2):null;
    console.log(`  ${snap.id}: ${(acc*100).toFixed(0)}% directional acc, basket ${basket!=null?basket.toFixed(1)+'%':'N/A'}`);
    changed=true;
  }
  return changed;
}

function calibrateWeights(history){
  if(history.validations.length<3)return{...DEF_W};
  const keys=['rrg','analog','season','rsi','vol'];
  const acc={};
  for(const k of keys){
    const recs=history.validations.flatMap(v=>v.results||[]).filter(r=>r.signalWasRight&&r.signalWasRight[k]!==undefined);
    acc[k]=recs.length?recs.filter(r=>r.signalWasRight[k]).length/recs.length:0.5;
  }
  const total=Object.values(acc).reduce((a,b)=>a+b,0);
  const derived={};for(const k of keys)derived[k]=acc[k]/total;
  // Map 'season' key → 'seasonality' for output
  const raw={rrg:0.7*derived.rrg+0.3*DEF_W.rrg,analog:0.7*derived.analog+0.3*DEF_W.analog,seasonality:0.7*derived.season+0.3*DEF_W.seasonality,rsi:0.7*derived.rsi+0.3*DEF_W.rsi,vol:0.7*derived.vol+0.3*DEF_W.vol};
  const wT=Object.values(raw).reduce((a,b)=>a+b,0);
  const out={};for(const k of Object.keys(raw))out[k]=+(raw[k]/wT).toFixed(4);
  return out;
}

function shouldSnapshot(history){
  if(!history.snapshots.length)return true;
  const last=history.snapshots[history.snapshots.length-1];
  return tradingDaysElapsed(new Date(last.generatedAt),new Date())>=5;
}

// ─── Back-fill bootstrap ───────────────────────────────────────────────────────
async function backfillIfNeeded(history,allBars,benchBars){
  if(history.snapshots.length>0)return false;
  console.log('Back-filling 12 weeks of historical predictions...');
  const today=new Date();
  for(let w=12;w>=1;w--){
    const snapDate=addTradingDays(today,-w*5);
    const snapStr=dateStr(snapDate);
    const targetDate=addTradingDays(snapDate,10);
    const targetStr=dateStr(targetDate);
    const sectors=[];
    for(const si of SECTORS){
      const bars=allBars[si.ticker];if(!bars)continue;
      const cutIdx=bars.findIndex(b=>dateStr(b.date)>=snapStr);
      if(cutIdx<60)continue;
      const tBars=bars.slice(0,cutIdx);
      const tBench=benchBars.filter(b=>dateStr(b.date)<snapStr);
      if(tBench.length<60)continue;
      const rrg=computeRRG(tBars,tBench),season=computeSeasonality(tBars),analog=computeAnalog(tBars),mom=computeMomentum(tBars);
      const scoring=scoreSector(rrg,analog,season,mom,DEF_W,snapDate);
      const snapPrice=tBars[tBars.length-1].close;
      const tIdx=bars.findIndex(b=>dateStr(b.date)>=targetStr);
      const exitPrice=tIdx>0?bars[tIdx].close:null;
      const actualReturn=exitPrice&&snapPrice?+((exitPrice/snapPrice-1)*100).toFixed(2):null;
      sectors.push({ticker:si.ticker,name:si.name,direction:scoring.direction,score:scoring.score,confidence:scoring.confidence,signals:scoring.signals,cs:scoring.cs,priceAtSnapshot:snapPrice,exitPrice,actualReturn});
    }
    if(sectors.length<5)continue;
    history.snapshots.push({id:snapStr,generatedAt:snapDate.toISOString(),targetDate:targetStr,niftyAtSnapshot:null,niftyAtTarget:null,basketReturn:null,hitRate:null,alphaVsNifty:null,sectors,picks:[]});
    if(new Date(targetDate)<=today){
      const results=sectors.filter(s=>s.actualReturn!=null).map(s=>({sector:s.name,ticker:s.ticker,actualReturn:s.actualReturn,predictedDirection:s.direction,correct:(s.direction==='Bullish'&&s.actualReturn>0)||(s.direction==='Bearish'&&s.actualReturn<0)||(s.direction==='Neutral'),signalWasRight:{rrg:(s.cs.rrg>0)===(s.actualReturn>0),analog:(s.cs.analog>0)===(s.actualReturn>0),season:(s.cs.season>0)===(s.actualReturn>0),rsi:(s.cs.rsi>0)===(s.actualReturn>0),vol:(s.cs.vol>0)===(s.actualReturn>0)}}));
      const acc=results.length?+(results.filter(r=>r.correct).length/results.length).toFixed(3):0;
      history.validations.push({snapshotId:snapStr,validatedAt:new Date().toISOString(),overallAccuracy:acc,basketReturn:null,hitRate:null,niftyReturn:null,alphaVsNifty:null,results});
      console.log(`  Backfill ${snapStr}: ${(acc*100).toFixed(0)}% acc`);
    }
  }
  return true;
}

// ─── HTML Builder ──────────────────────────────────────────────────────────────
function buildHtml(data){
  const D=data;
  const nowIST=new Date(D.generatedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false,dateStyle:'medium',timeStyle:'short'});
  const target2W=addTradingDays(new Date(D.generatedAt),10);
  const targetDateLabel=target2W.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'});
  const shortList=D.picks.filter(p=>p.isShortList);
  const vals=D.history.validations;
  const hasTrack=vals.length>0;

  // Track record stats
  const trackAcc=hasTrack?(vals.reduce((s,v)=>s+v.overallAccuracy,0)/vals.length*100).toFixed(0):null;
  const bRets=vals.map(v=>v.basketReturn).filter(v=>v!=null);
  const avgBasket=bRets.length?avg(bRets).toFixed(1):null;
  const nRets=vals.map(v=>v.niftyReturn).filter(v=>v!=null);
  const avgNifty=nRets.length?avg(nRets).toFixed(1):null;
  const avgAlpha=avgBasket!=null&&avgNifty!=null?(parseFloat(avgBasket)-parseFloat(avgNifty)).toFixed(1):null;
  const hRates=vals.map(v=>v.hitRate).filter(v=>v!=null);
  const avgHitRate=hRates.length?(avg(hRates)*100).toFixed(0):null;

  // Signal accuracy
  const sigKeys=['rrg','analog','season','rsi','vol'];
  const sigLabels={rrg:'RRG Rotation',analog:'Hist. Analog',season:'Seasonality',rsi:'RSI State',vol:'Volume'};
  const sigAcc={};
  for(const k of sigKeys){
    const recs=vals.flatMap(v=>v.results||[]).filter(r=>r.signalWasRight&&r.signalWasRight[k]!==undefined);
    sigAcc[k]=recs.length?(recs.filter(r=>r.signalWasRight[k]).length/recs.length*100).toFixed(0):null;
  }
  const wMap={rrg:'rrg',analog:'analog',season:'seasonality',rsi:'rsi',vol:'vol'};

  // Prepare JSON data for client-side charts
  const clientData={
    niftyPrice:D.niftyPrice,niftyRet5D:D.niftyRet5D,
    niftySeason:D.niftySeasonality,
    sectors:D.sectors.map(s=>({
      ticker:s.ticker,name:s.name,abbr:s.abbr,color:s.color,
      rsRatio:s.rrg?s.rrg.rsRatio:null,rsMom:s.rrg?s.rrg.rsMom:null,
      quadrant:s.rrg?s.rrg.quadrant:null,trail:s.rrg?s.rrg.trail:[],
      rsi:s.mom?s.mom.rsi:null,ret5D:s.mom?s.mom.ret5D:null,ret10D:s.mom?s.mom.ret10D:null,
      ret22D:s.mom?s.mom.ret22D:null,ret66D:s.mom?s.mom.ret66D:null,volRatio:s.mom?s.mom.volRatio:null,
      analogMedian:s.analog?s.analog.median:null,analogMin:s.analog?s.analog.min:null,
      analogMax:s.analog?s.analog.max:null,analogCount:s.analog?s.analog.count:0,
      score:s.score,direction:s.direction,confidence:s.confidence,signals:s.signals||[],
      price:s.currentPrice,byDow:s.season?s.season.byDow:[],byMonth:s.season?s.season.byMonth:[],
    })),
    picks:D.picks,
    weights:D.weights,calibrated:D.weightsCalibrated,
    recentValidations:vals.slice(-3).map(v=>({id:v.snapshotId,acc:+(v.overallAccuracy*100).toFixed(0),basket:v.basketReturn,alpha:v.alphaVsNifty,hitRate:v.hitRate?+(v.hitRate*100).toFixed(0):null,results:v.results})),
  };

  // Sector table rows
  const tableRows=D.sectors.map(s=>{
    const dirIcon=s.direction==='Bullish'?'🔺':s.direction==='Bearish'?'🔻':'➡️';
    const dirCls=s.direction==='Bullish'?'gn':s.direction==='Bearish'?'rd':'nc';
    const confBadge=`<span class="conf-badge conf-${s.confidence.toLowerCase()}">${esc(s.confidence)}</span>`;
    const scorePct=((s.score+100)/2)+'%';
    const scoreBarCol=s.score>20?'#22c55e':s.score<-20?'#ef4444':'#eab308';
    const quadTag=s.rrg?`<span class="quad-tag quad-${s.rrg.quadrant.toLowerCase()}">${s.rrg.quadrant}</span>`:'—';
    const analogStr=s.analog&&s.analog.median!=null?`${s.analog.median>=0?'+':''}${s.analog.median.toFixed(1)}% <span style="color:var(--t3);font-size:.7rem">(n=${s.analog.count})</span>`:'<span class="nc">—</span>';
    const sigsHtml=(s.signals||[]).map(sig=>`<span class="sig-tag">${esc(sig)}</span>`).join('');
    return `<tr class="sector-row" data-ticker="${esc(s.ticker)}" data-score="${s.score}">
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${s.color};flex-shrink:0"></span>
          <div>
            <a href="https://finance.yahoo.com/quote/${encodeURIComponent(s.ticker)}" target="_blank" style="color:var(--tx);text-decoration:none;font-weight:600;white-space:nowrap" onmouseover="this.style.color='var(--ac)'" onmouseout="this.style.color='var(--tx)'">${esc(s.name)}</a>
            <div style="font-size:.7rem;color:var(--t3)">${esc(s.ticker)}</div>
          </div>
        </div>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;min-width:120px">
          <div style="flex:1;height:6px;background:var(--s3);border-radius:3px;position:relative">
            <div style="position:absolute;left:50%;top:0;height:100%;width:${Math.abs(s.score)/2+'%'};background:${scoreBarCol};border-radius:3px;transform-origin:${s.score>=0?'left':'right'};margin-left:${s.score<0?-Math.abs(s.score)/2+'%':'0'}"></div>
          </div>
          <span style="font-weight:700;font-size:.88rem;color:${scoreBarCol};min-width:32px;text-align:right">${s.score>0?'+':''}${s.score}</span>
        </div>
      </td>
      <td><span class="${dirCls}" style="font-weight:700">${dirIcon} ${esc(s.direction)}</span> ${confBadge}</td>
      <td>${quadTag}</td>
      <td class="${s.mom&&s.mom.rsi!=null?(s.mom.rsi<40?'rd':s.mom.rsi>65?'yw':'gn'):'nc'}">${s.mom&&s.mom.rsi!=null?s.mom.rsi.toFixed(0):'—'}</td>
      <td class="${s.mom&&s.mom.ret5D!=null?(s.mom.ret5D>=0?'gn':'rd'):'nc'}">${s.mom?fmtP(s.mom.ret5D):'—'}</td>
      <td>${analogStr}</td>
      <td><div style="display:flex;gap:3px;flex-wrap:wrap">${sigsHtml}</div></td>
      <td style="white-space:nowrap">
        <div style="display:flex;gap:4px;align-items:center">
          <button class="alert-btn" data-alert-ticker="${esc(s.ticker)}" data-alert-price="${s.currentPrice||0}" data-alert-name="${esc(s.name)}" title="Set price alert">🔔</button>
          <button class="research-btn" data-r-ticker="${esc(s.abbr||s.name)}" data-r-name="${esc(s.name)}" title="AI Deep Research">🧠</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  // Analog accordion
  const analogAccordion=D.sectors.filter(s=>s.analog&&s.analog.count>0).map(s=>{
    const med=s.analog.median,mn=s.analog.min,mx=s.analog.max,cnt=s.analog.count;
    const range=mx-mn||1;
    const medPct=Math.max(0,Math.min(100,((med-mn)/range)*100));
    const medColor=med>=0?'#22c55e':'#ef4444';
    return `<div class="analog-item">
      <div class="analog-header" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none';this.querySelector('.arr').textContent=this.querySelector('.arr').textContent==='▸'?'▾':'▸'">
        <span style="display:flex;align-items:center;gap:8px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.color}"></span>
          <strong>${esc(s.name)}</strong>
          <span class="conf-badge conf-${s.confidence.toLowerCase()}" style="margin-left:4px">${esc(s.confidence)}</span>
        </span>
        <span style="display:flex;align-items:center;gap:12px">
          <span style="color:${medColor};font-weight:700">${med>=0?'+':''}${med.toFixed(1)}% median</span>
          <span style="color:var(--t3);font-size:.75rem">n=${cnt} windows</span>
          <span class="arr" style="color:var(--t3)">▸</span>
        </span>
      </div>
      <div class="analog-body" style="display:none">
        <p style="font-size:.78rem;color:var(--t2);margin-bottom:12px">
          When <strong>${esc(s.name)}</strong> was in a similar state (RSI ±10, same 5D return direction) over the past 3 years,
          the forward 10-day return ranged from <strong>${mn.toFixed(1)}%</strong> to <strong>${mx.toFixed(1)}%</strong> with a median of <strong style="color:${medColor}">${med>=0?'+':''}${med.toFixed(1)}%</strong> across ${cnt} historical windows.
        </p>
        <div style="margin:8px 0 4px;font-size:.72rem;color:var(--t3);display:flex;justify-content:space-between">
          <span>Min: ${mn.toFixed(1)}%</span><span>Median: ${med>=0?'+':''}${med.toFixed(1)}%</span><span>Max: +${mx.toFixed(1)}%</span>
        </div>
        <div style="position:relative;height:12px;background:var(--s3);border-radius:6px;margin-bottom:8px">
          <div style="position:absolute;left:0;top:0;height:100%;width:100%;background:linear-gradient(to right,rgba(239,68,68,.3),rgba(34,197,94,.3));border-radius:6px"></div>
          <div style="position:absolute;top:-4px;left:${medPct.toFixed(1)}%;transform:translateX(-50%);width:3px;height:20px;background:${medColor};border-radius:2px"></div>
        </div>
        <p style="font-size:.72rem;color:var(--t3)">Confidence: <strong>${cnt>=20?'High':cnt>=10?'Medium':'Low'}</strong> (${cnt>=20?'20+':cnt>=10?'10–19':'<10'} analog windows)</p>
      </div>
    </div>`;
  }).join('');

  // Pick cards
  const pickCards=shortList.map(p=>{
    const actionCls=p.action==='BUY'?'gn':p.action==='BUILD'?'yw':'t2';
    const tierLabel=p.debateBacked?'Confirmed':(p.tier||'Watch');
    const tierBg=p.debateBacked?'rgba(0,212,170,.15)':(p.tier==='Elite'?'rgba(99,102,241,.15)':p.tier==='Strong'?'rgba(0,212,170,.1)':'rgba(255,255,255,.05)');
    const tierClr=p.debateBacked?'var(--ac)':(p.tier==='Elite'?'#6366f1':p.tier==='Strong'?'#00d4aa':'#8888a0');
    const tgPct=p.targetGainPct;
    const tgPrice=tgPct!=null&&p.price!=null?'₹'+Number(p.price*(1+tgPct/100)).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}):null;
    const tgColor=tgPct>=4?'var(--gn)':tgPct>=2?'#eab308':tgPct>=0?'var(--ac)':'var(--rd)';
    const targetHtml=tgPct!=null?`
      <div style="background:rgba(0,212,170,.07);border:1px solid rgba(0,212,170,.2);border-radius:6px;padding:9px 12px;margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:.6rem;color:var(--t3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">2W Potential Target</div>
            <div style="font-size:1.3rem;font-weight:700;color:${tgColor}">${tgPct>=0?'+':''}${tgPct.toFixed(1)}%</div>
          </div>
          ${tgPrice?`<div style="text-align:right"><div style="font-size:.6rem;color:var(--t3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">Price Target</div><div style="font-size:.92rem;font-weight:700;color:var(--tx)">${tgPrice}</div></div>`:''}
        </div>
        <div style="font-size:.65rem;color:var(--t3);margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span>📅 By <strong style="color:var(--t2)">${targetDateLabel}</strong> (10 trading days)</span>
          <span style="color:var(--bd)">|</span>
          <span>📊 ATR-based projection</span>
        </div>
      </div>`:'';
    // Metrics grid: RSI / 5D return / 1M return / distance from 52W high
    const metricsHtml=(p.rsi!=null||p.ret5D!=null||p.ret22D!=null||p.distFromHigh!=null)?`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px">
        ${p.rsi!=null?`<div style="background:var(--s3);border-radius:4px;padding:5px 8px"><div style="font-size:.58rem;color:var(--t3);margin-bottom:1px">RSI</div><div style="font-size:.82rem;font-weight:600;color:${p.rsi<35?'var(--rd)':p.rsi<50?'var(--yw)':p.rsi<65?'var(--gn)':'var(--yw)'}">${p.rsi}</div></div>`:''}
        ${p.ret5D!=null?`<div style="background:var(--s3);border-radius:4px;padding:5px 8px"><div style="font-size:.58rem;color:var(--t3);margin-bottom:1px">5D Return</div><div style="font-size:.82rem;font-weight:600;color:${p.ret5D>=0?'var(--gn)':'var(--rd)'}">${p.ret5D>=0?'+':''}${p.ret5D.toFixed(1)}%</div></div>`:''}
        ${p.ret22D!=null?`<div style="background:var(--s3);border-radius:4px;padding:5px 8px"><div style="font-size:.58rem;color:var(--t3);margin-bottom:1px">1M Return</div><div style="font-size:.82rem;font-weight:600;color:${p.ret22D>=0?'var(--gn)':'var(--rd)'}">${p.ret22D>=0?'+':''}${p.ret22D.toFixed(1)}%</div></div>`:''}
        ${p.distFromHigh!=null?`<div style="background:var(--s3);border-radius:4px;padding:5px 8px"><div style="font-size:.58rem;color:var(--t3);margin-bottom:1px">vs 52W High</div><div style="font-size:.82rem;font-weight:600;color:${p.distFromHigh>=-10?'var(--yw)':'var(--t2)'}">${p.distFromHigh>=0?'+':''}${p.distFromHigh.toFixed(1)}%</div></div>`:''}
      </div>`:'';
    // Agent score bars (Trend / Momentum / Setup)
    const agentScoreHtml=p.trendScore!=null?`
      <div style="margin-top:10px">
        <div style="font-size:.6rem;color:var(--t3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Agent Analysis</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px">
          <div style="background:var(--s3);border-radius:4px;padding:5px 6px;text-align:center">
            <div style="font-size:.58rem;color:var(--t3);margin-bottom:2px">📈 Trend</div>
            <div style="font-size:.88rem;font-weight:700;color:${p.trendScore>=70?'var(--gn)':p.trendScore>=50?'var(--yw)':'var(--rd)'}">${p.trendScore}</div>
            <div style="height:3px;background:var(--s1);border-radius:2px;margin-top:3px"><div style="height:100%;width:${p.trendScore}%;background:${p.trendScore>=70?'var(--gn)':p.trendScore>=50?'var(--yw)':'var(--rd)'};border-radius:2px"></div></div>
          </div>
          <div style="background:var(--s3);border-radius:4px;padding:5px 6px;text-align:center">
            <div style="font-size:.58rem;color:var(--t3);margin-bottom:2px">⚡ Momentum</div>
            <div style="font-size:.88rem;font-weight:700;color:${p.momentumScore>=70?'var(--gn)':p.momentumScore>=50?'var(--yw)':'var(--rd)'}">${p.momentumScore}</div>
            <div style="height:3px;background:var(--s1);border-radius:2px;margin-top:3px"><div style="height:100%;width:${p.momentumScore}%;background:${p.momentumScore>=70?'var(--gn)':p.momentumScore>=50?'var(--yw)':'var(--rd)'};border-radius:2px"></div></div>
          </div>
          <div style="background:var(--s3);border-radius:4px;padding:5px 6px;text-align:center">
            <div style="font-size:.58rem;color:var(--t3);margin-bottom:2px">🎯 Setup</div>
            <div style="font-size:.88rem;font-weight:700;color:${p.setupScore>=70?'var(--gn)':p.setupScore>=50?'var(--yw)':'var(--rd)'}">${p.setupScore}</div>
            <div style="height:3px;background:var(--s1);border-radius:2px;margin-top:3px"><div style="height:100%;width:${p.setupScore}%;background:${p.setupScore>=70?'var(--gn)':p.setupScore>=50?'var(--yw)':'var(--rd)'};border-radius:2px"></div></div>
          </div>
        </div>
      </div>`:'';
    // Stop loss + R:R row
    const stopHtml=p.stopLoss!=null?`
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:7px;padding:6px 8px;background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.15);border-radius:5px">
        <span style="font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.04em">Stop Loss</span>
        <span style="font-size:.8rem;font-weight:700;color:var(--rd)">₹${Number(p.stopLoss).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})} (−${p.stopLossPct}%)</span>
        ${p.riskReward!=null?`<span style="margin-left:auto;font-size:.65rem;color:var(--t3)">R:R</span><span style="font-size:.82rem;font-weight:700;color:${p.riskReward>=2?'var(--gn)':p.riskReward>=1?'var(--yw)':'var(--rd)'}">${p.riskReward}:1</span>`:''}
      </div>`:'';
    // Auto-generated pick commentary based on agent scores
    const commentaryLines=[];
    if(p.trendScore>=70)commentaryLines.push('Stage 2 Minervini uptrend confirmed — price above all key MAs (50D/150D/200D) with 200D rising'+(p.distFromHigh!=null&&p.distFromHigh>=-8?' and within striking distance of 52W highs':'')+'. ');
    else if(p.trendScore>=55)commentaryLines.push('Developing uptrend — MA stack aligning bullishly, 200D beginning to slope up. ');
    else commentaryLines.push('Early trend structure — key MA crossovers in progress. ');
    if(p.momentumScore>=70)commentaryLines.push('Strongly outperforming Nifty with accelerating RS line'+(p.ret22D!=null&&p.ret22D>0?` (+${p.ret22D.toFixed(1)}% 1M vs market)`:'')+' — institutional money rotating in. ');
    else if(p.momentumScore>=55)commentaryLines.push('Outperforming Nifty over the past quarter; RS line trending higher. ');
    else commentaryLines.push('Building momentum relative to Nifty benchmark. ');
    if(p.setupScore>=70)commentaryLines.push('VCP-style tight consolidation with volume contraction then surge — textbook low-risk entry point.');
    else if(p.setupScore>=55)commentaryLines.push('Clean base forming with volume pattern supporting breakout.');
    else commentaryLines.push('Setup in early stages; await volume confirmation before entry.');
    if(p.debateBacked&&p.agentSummary)commentaryLines.push(' AI thesis: '+p.agentSummary.slice(0,120)+(p.agentSummary.length>120?'…':''));
    const commentaryHtml=`
      <div style="margin-top:9px;padding:8px 11px;background:rgba(255,255,255,.02);border-left:2px solid rgba(0,212,170,.25);border-radius:0 5px 5px 0">
        <div style="font-size:.6rem;color:var(--t3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">📝 Why picked</div>
        <div style="font-size:.68rem;color:var(--t2);line-height:1.6">${esc(commentaryLines.join(''))}</div>
      </div>`;
    // Legacy thesis (debate-backed) — preserved but merged into commentary above
    const thesisHtml='';
    return `<div class="pick-card" style="border-color:${p.conviction==='High'?'rgba(34,197,94,.3)':'var(--bd)'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <a href="${esc(p.url||'#')}" target="_blank" style="display:block;font-size:1rem;font-weight:700;color:var(--tx);text-decoration:none" onmouseover="this.style.color='var(--ac)'" onmouseout="this.style.color='var(--tx)'">${esc(p.ticker)}</a>
          <a href="${esc(p.url||'#')}" target="_blank" style="display:block;font-size:.72rem;color:var(--t2);text-decoration:none" onmouseover="this.style.color='var(--ac)'" onmouseout="this.style.color='var(--t2)'">${esc(p.name)}</a>
        </div>
        <span style="background:${tierBg};color:${tierClr};border:1px solid ${tierClr}40;padding:3px 8px;border-radius:4px;font-size:.7rem;font-weight:700">${esc(tierLabel)}</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <span style="background:rgba(255,255,255,.06);color:var(--t2);padding:2px 8px;border-radius:4px;font-size:.72rem">${esc(p.sector)}</span>
        <span style="background:rgba(255,255,255,.06);color:var(--${actionCls});padding:2px 8px;border-radius:4px;font-size:.72rem;font-weight:600">${esc(p.action)}</span>
        ${p.conviction==='High'?'<span style="background:rgba(34,197,94,.1);color:#22c55e;padding:2px 8px;border-radius:4px;font-size:.72rem">⭐ High Conv.</span>':''}
        ${p.debateBacked?'<span style="background:rgba(0,212,170,.08);color:var(--ac);padding:2px 8px;border-radius:4px;font-size:.72rem">✓ Dual-Confirmed</span>':''}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:.7rem;color:var(--t3)">Entry ≈</div>
          <div style="font-size:1.1rem;font-weight:700;color:var(--tx)">₹${p.price!=null?Number(p.price).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}):'—'}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:.7rem;color:var(--t3)">Composite</div>
          <div style="font-size:1rem;font-weight:700;color:var(--ac)">${p.composite||p.apexScore}</div>
        </div>
      </div>
      ${targetHtml}
      ${metricsHtml}
      ${agentScoreHtml}
      ${commentaryHtml}
      ${stopHtml}
      ${thesisHtml}
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="alert-btn" data-alert-ticker="${esc(p.ticker)}" data-alert-price="${p.price||0}" data-alert-name="${esc(p.name)}" title="Set price alert" style="flex:1;padding:6px;justify-content:center;display:flex;align-items:center;gap:4px;font-size:.75rem">🔔 Alert</button>
        <button class="research-btn" data-r-ticker="${esc(p.ticker)}" data-r-name="${esc(p.name)}" title="AI Deep Research" style="flex:1;padding:6px;justify-content:center;display:flex;align-items:center;gap:4px;font-size:.75rem">🧠 Research</button>
        <a href="${esc(p.url||'https://www.tickertape.in/search?q='+encodeURIComponent(p.ticker))}" target="_blank" style="flex:1;padding:6px;text-align:center;border:1px solid var(--bd);border-radius:5px;font-size:.75rem;color:var(--t2);text-decoration:none;transition:all .15s" onmouseover="this.style.color='var(--ac)';this.style.borderColor='var(--ac)'" onmouseout="this.style.color='var(--t2)';this.style.borderColor='var(--bd)'">↗ TT</a>
      </div>
    </div>`;
  }).join('');

  // Track record signal bars
  const sigBars=sigKeys.map(k=>{
    const pct=sigAcc[k];
    const wKey=wMap[k];
    const wPct=D.weights[wKey]!=null?(D.weights[wKey]*100).toFixed(0):null;
    const barColor=pct==null?'#5a5a70':pct>=65?'#22c55e':pct>=50?'#eab308':'#ef4444';
    return `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:.78rem;margin-bottom:3px">
        <span>${sigLabels[k]}</span>
        <span style="color:${barColor}">${pct!=null?pct+'% accuracy':'No data yet'}</span>
        ${wPct?`<span style="color:var(--t3);font-size:.7rem">Weight: ${wPct}%</span>`:''}
      </div>
      <div style="height:5px;background:var(--s3);border-radius:3px">
        <div style="height:100%;width:${pct||0}%;background:${barColor};border-radius:3px;transition:width .5s"></div>
      </div>
    </div>`;
  }).join('');

  // Recent validation rows
  const recentRows=vals.slice(-5).reverse().map(v=>{
    const acc=(v.overallAccuracy*100).toFixed(0);
    const accCls=v.overallAccuracy>=0.65?'gn':v.overallAccuracy>=0.5?'yw':'rd';
    return `<tr>
      <td style="color:var(--t2)">${v.snapshotId}</td>
      <td class="${accCls}" style="font-weight:600">${acc}%</td>
      <td class="${v.basketReturn>=0?'gn':'rd'}">${v.basketReturn!=null?fmtP(v.basketReturn):'—'}</td>
      <td class="${v.niftyReturn>=0?'gn':'rd'}">${v.niftyReturn!=null?fmtP(v.niftyReturn):'—'}</td>
      <td class="${v.alphaVsNifty>=0?'gn':'rd'}">${v.alphaVsNifty!=null?fmtP(v.alphaVsNifty):'—'}</td>
      <td style="color:var(--t2)">${v.hitRate!=null?(v.hitRate*100).toFixed(0)+'%':'—'}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Market Prediction — 2-Week Forecast</title>
<script src="https://cdn.jsdelivr.net/npm/apexcharts@3.54.1/dist/apexcharts.min.js"><\/script>
<style>
:root{--bg:#0c0c10;--s1:#13131b;--s2:#1a1a26;--s3:#22222f;--bd:#2a2a3a;--ac:#00d4aa;--tx:#e8e8f0;--t2:#8888a0;--t3:#5a5a70;--gn:#22c55e;--rd:#ef4444;--yw:#eab308;--bl:#3b82f6;--pp:#a855f7}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);overflow-x:hidden}
a{color:var(--ac);text-decoration:none}
.gn{color:var(--gn)}.rd{color:var(--rd)}.yw{color:var(--yw)}.nc{color:var(--t3)}.t2{color:var(--t2)}
.header{background:var(--s1);border-bottom:1px solid var(--bd);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:1.1rem;font-weight:700;color:var(--tx)}.header h1 span{color:var(--ac)}
.header-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.nav-links{display:flex;gap:8px;flex-wrap:wrap;padding:10px 24px;background:var(--s1);border-bottom:1px solid var(--bd)}
.nav-links a{font-size:.75rem;color:var(--t2);padding:4px 10px;border:1px solid var(--bd);border-radius:5px;transition:all .15s}
.nav-links a:hover,.nav-links a.active{color:var(--ac);border-color:var(--ac)}
.refresh-btn{background:var(--ac);color:#0c0c10;border:none;padding:7px 16px;border-radius:7px;cursor:pointer;font-size:.8rem;font-weight:700;font-family:inherit;transition:opacity .15s}
.refresh-btn:hover{opacity:.85}
.stats-bar{display:flex;gap:10px;padding:12px 24px;flex-wrap:wrap;background:var(--s1);border-bottom:1px solid var(--bd)}
.stat{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:8px 14px;min-width:100px}
.stat .sl{font-size:.65rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.stat .sv{font-size:1.2rem;font-weight:700}
.section{padding:20px 24px;border-bottom:1px solid var(--bd)}
.section-title{font-size:.85rem;font-weight:700;color:var(--t2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.section-title::before{content:'';display:block;width:3px;height:14px;background:var(--ac);border-radius:2px}
.picks-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-bottom:12px}
.pick-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:14px;transition:border-color .2s}
.pick-card:hover{border-color:var(--ac)}
.disclaimer{font-size:.72rem;color:var(--t3);padding:8px 12px;background:rgba(234,179,8,.05);border:1px solid rgba(234,179,8,.15);border-radius:6px;text-align:center}
.charts-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:640px){.charts-row{grid-template-columns:1fr}}
.chart-box{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:12px}
.chart-box h3{font-size:.78rem;color:var(--t2);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.rrg-container{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:16px;position:relative}
.rrg-container h3{font-size:.78rem;color:var(--t2);margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.rrg-legend{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px}
.rrg-legend span{font-size:.72rem;display:flex;align-items:center;gap:4px}
.rrg-legend span::before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%}
.rrg-legend .leg-leading::before{background:#22c55e}
.rrg-legend .leg-improving::before{background:#00d4aa}
.rrg-legend .leg-weakening::before{background:#f97316}
.rrg-legend .leg-lagging::before{background:#ef4444}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{background:var(--s1);color:var(--ac);font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;padding:9px 12px;text-align:left;border-bottom:2px solid var(--bd);white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid rgba(42,42,58,.5);vertical-align:middle}
tr:hover td{background:rgba(0,212,170,.03)}
.conf-badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:.65rem;font-weight:700;text-transform:uppercase}
.conf-high{background:rgba(34,197,94,.12);color:var(--gn);border:1px solid rgba(34,197,94,.2)}
.conf-medium{background:rgba(234,179,8,.1);color:var(--yw);border:1px solid rgba(234,179,8,.2)}
.conf-low{background:rgba(90,90,112,.15);color:var(--t3);border:1px solid rgba(90,90,112,.3)}
.quad-tag{display:inline-block;padding:1px 7px;border-radius:4px;font-size:.65rem;font-weight:700}
.quad-leading{background:rgba(34,197,94,.12);color:var(--gn)}
.quad-improving{background:rgba(0,212,170,.12);color:var(--ac)}
.quad-weakening{background:rgba(249,115,22,.12);color:#f97316}
.quad-lagging{background:rgba(239,68,68,.12);color:var(--rd)}
.sig-tag{display:inline-block;padding:1px 6px;background:rgba(255,255,255,.05);border:1px solid var(--bd);border-radius:3px;font-size:.65rem;color:var(--t2);white-space:nowrap}
.analog-item{border:1px solid var(--bd);border-radius:8px;margin-bottom:8px;overflow:hidden}
.analog-header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;background:var(--s2);transition:background .15s}
.analog-header:hover{background:var(--s3)}
.analog-body{padding:14px;background:var(--s1);border-top:1px solid var(--bd)}
.analog-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}
.track-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.track-card{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:12px;text-align:center}
.track-card .tc-val{font-size:1.5rem;font-weight:700;margin-bottom:2px}
.track-card .tc-lbl{font-size:.68rem;color:var(--t2);text-transform:uppercase}
.weight-badge{font-size:.72rem;color:var(--t3);padding:6px 12px;background:rgba(255,255,255,.04);border-radius:6px;border:1px solid var(--bd)}
.alert-btn{background:none;border:1px solid var(--bd);border-radius:5px;cursor:pointer;padding:3px 7px;font-size:.75rem;color:var(--t3);transition:all .15s;font-family:inherit}
.alert-btn:hover{color:var(--yw);border-color:var(--yw)}.alert-btn.has-alert{color:var(--yw);border-color:var(--yw)}
.research-btn{background:none;border:1px solid var(--bd);border-radius:5px;cursor:pointer;padding:3px 7px;font-size:.75rem;color:var(--t3);transition:all .15s;font-family:inherit}
.research-btn:hover{color:var(--ac);border-color:var(--ac)}
#ap-modal{display:none;position:fixed;z-index:9999;background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:20px;width:270px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.ap-label{display:block;font-size:.72rem;color:var(--t2);margin-bottom:4px;margin-top:10px}
#ap-above,#ap-below{width:100%;background:var(--s3);border:1px solid var(--bd);border-radius:7px;padding:7px 10px;color:var(--tx);font-size:.84rem;outline:none;font-family:inherit}
#ap-above:focus,#ap-below:focus{border-color:var(--ac)}
.ap-actions{display:flex;gap:8px;margin-top:14px}
.ap-save-btn,.ap-clear-btn{flex:1;padding:8px;border-radius:7px;border:none;cursor:pointer;font-size:.8rem;font-weight:600;font-family:inherit}
.ap-save-btn{background:var(--ac);color:#0c0c10}.ap-clear-btn{background:var(--s3);color:var(--t2);border:1px solid var(--bd)}
#dr-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;align-items:center;justify-content:center}
#dr-overlay.open{display:flex}
#dr-modal{background:var(--s1);border:1px solid var(--bd);border-radius:16px;width:min(700px,95vw);max-height:85vh;display:flex;flex-direction:column;overflow:hidden}
#dr-header{padding:16px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between}
#dr-header h2{font-size:1rem;font-weight:700}
#dr-close{background:none;border:none;color:var(--t3);font-size:1.2rem;cursor:pointer;line-height:1}
#dr-provider-bar{padding:10px 20px;border-bottom:1px solid var(--bd);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dr-prov-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--t2);cursor:pointer;font-size:.75rem;font-family:inherit;transition:all .15s}
.dr-prov-btn:hover,.dr-prov-btn.active{color:var(--ac);border-color:var(--ac)}
#dr-key-input{flex:1;min-width:160px;background:var(--s3);border:1px solid var(--bd);border-radius:6px;padding:5px 10px;color:var(--tx);font-size:.78rem;outline:none;font-family:inherit}
#dr-key-input:focus{border-color:var(--ac)}
#dr-key-save{padding:5px 12px;border-radius:6px;border:none;background:var(--ac);color:#0c0c10;cursor:pointer;font-size:.75rem;font-weight:600;font-family:inherit}
#dr-content{padding:20px;overflow-y:auto;flex:1;font-size:.85rem;line-height:1.7}
.dr-loading{text-align:center;color:var(--t2);padding:40px;font-size:.85rem}
.footer{text-align:center;padding:20px;color:var(--t3);font-size:.72rem;border-top:1px solid var(--bd)}
</style>
</head>
<body>

<div class="header">
  <h1>📡 Market <span>Prediction</span> · 2-Week Forecast</h1>
  <div class="header-meta">
    <span style="font-size:.75rem;color:var(--t3)">Generated ${nowIST} IST</span>
    <span class="weight-badge">${D.weightsCalibrated?'⚖️ Calibrated weights':'🔧 Default weights (needs '+Math.max(0,3-vals.length)+' more validated week'+(3-vals.length===1?'':'s')+')'}</span>
    <button class="refresh-btn" onclick="window.location.reload(true)">↺ Refresh</button>
  </div>
</div>

<div class="nav-links">
  <a href="index.html">Watchlist</a>
  <a href="apex.html">APEX</a>
  <a href="multibagger.html">Multibagger</a>
  <a href="sectors.html">Sectors</a>
  <a href="indian-research.html">India Research</a>
  <a href="confluence.html">Confluence</a>
  <a href="breakout.html">Breakout</a>
  <a href="prediction.html" class="active">Prediction</a>
</div>

<div class="stats-bar">
  <div class="stat">
    <div class="sl">Nifty 50</div>
    <div class="sv">${D.niftyPrice?Number(D.niftyPrice).toLocaleString('en-IN',{maximumFractionDigits:0}):'—'}</div>
  </div>
  <div class="stat">
    <div class="sl">5D Change</div>
    <div class="sv ${D.niftyRet5D>=0?'gn':'rd'}">${fmtP(D.niftyRet5D)}</div>
  </div>
  <div class="stat">
    <div class="sl">Bullish Sectors</div>
    <div class="sv gn">${D.sectors.filter(s=>s.direction==='Bullish').length}</div>
  </div>
  <div class="stat">
    <div class="sl">Bearish Sectors</div>
    <div class="sv rd">${D.sectors.filter(s=>s.direction==='Bearish').length}</div>
  </div>
  <div class="stat">
    <div class="sl">Today's Picks</div>
    <div class="sv" style="color:var(--ac)">${shortList.length}</div>
  </div>
  ${hasTrack?`<div class="stat"><div class="sl">Track Record</div><div class="sv ${parseFloat(trackAcc)>=60?'gn':'yw'}">${trackAcc}% acc</div></div>`:''}
</div>

<!-- ═══ TOMORROW'S PICKS ═══ -->
<div class="section">
  <div class="section-title">🎯 Tomorrow's Buy List${shortList.length?` — ${shortList.length} High-Conviction Picks`:''}</div>
  ${shortList.length?`<div class="picks-grid">${pickCards}</div>
  <div class="disclaimer">⚠️ Paper trade only · Not investment advice · Based on historical pattern analysis · Always do your own research</div>`:
  `<div style="text-align:center;padding:32px;color:var(--t3)">No high-conviction picks this week — no sector is strongly bullish. Wait for a better setup.</div>`}
</div>

<!-- ═══ SEASONALITY ═══ -->
<div class="section">
  <div class="section-title">📅 Seasonality Patterns (3Y Nifty 50)</div>
  <div class="charts-row">
    <div class="chart-box">
      <h3>Day-of-Week Bias</h3>
      <div id="dow-chart"></div>
    </div>
    <div class="chart-box">
      <h3>Month-of-Year Bias</h3>
      <div id="month-chart"></div>
    </div>
  </div>
</div>

<!-- ═══ RRG CHART ═══ -->
<div class="section">
  <div class="section-title">🔄 Sector Rotation (RRG)</div>
  <div class="rrg-container">
    <h3>Relative Rotation Graph — vs Nifty 50 Benchmark</h3>
    <div class="rrg-legend">
      <span class="leg-leading">Leading — outperforming &amp; accelerating</span>
      <span class="leg-improving">Improving — underperforming but turning up</span>
      <span class="leg-weakening">Weakening — outperforming but slowing</span>
      <span class="leg-lagging">Lagging — underperforming &amp; decelerating</span>
    </div>
    <div id="rrg-chart"></div>
    <p style="font-size:.68rem;color:var(--t3);margin-top:8px">RS-Ratio &gt; 100 = sector outperforming Nifty · RS-Momentum &gt; 100 = relative strength improving · Trail = last 8 weeks of path</p>
  </div>
</div>

<!-- ═══ SECTOR FORECAST TABLE ═══ -->
<div class="section">
  <div class="section-title">📊 2-Week Sector Forecast — Ranked by Score</div>
  <div style="overflow-x:auto">
    <table>
      <thead><tr>
        <th>Sector</th>
        <th>Score</th>
        <th>Direction</th>
        <th>RRG Quadrant</th>
        <th>RSI</th>
        <th>5D Ret</th>
        <th>Analog 10D</th>
        <th>Key Signals</th>
        <th>Actions</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>
</div>

<!-- ═══ HISTORICAL ANALOG ═══ -->
<div class="section">
  <div class="section-title">📐 Historical Analog — What Happened Next in Similar Conditions</div>
  <div class="analog-grid">${analogAccordion}</div>
  <p style="font-size:.72rem;color:var(--t3);margin-top:12px">Methodology: For each sector, we find all 5-trading-day windows in the past 3 years where the RSI14 was within ±10 of today's value AND the 5-day return direction was the same. We then record what happened in the following 10 trading days.</p>
</div>

<!-- ═══ TRACK RECORD ═══ -->
<div class="section">
  <div class="section-title">📈 Track Record — Prediction Validation & Self-Calibration</div>
  ${hasTrack?`
  <div class="track-grid">
    <div class="track-card"><div class="tc-val ${parseFloat(trackAcc)>=60?'gn':'yw'}">${trackAcc}%</div><div class="tc-lbl">Directional Accuracy</div></div>
    ${avgBasket!=null?`<div class="track-card"><div class="tc-val ${parseFloat(avgBasket)>=0?'gn':'rd'}">${parseFloat(avgBasket)>=0?'+':''}${avgBasket}%</div><div class="tc-lbl">Avg Basket Return</div></div>`:''}
    ${avgAlpha!=null?`<div class="track-card"><div class="tc-val ${parseFloat(avgAlpha)>=0?'gn':'rd'}">${parseFloat(avgAlpha)>=0?'+':''}${avgAlpha}%</div><div class="tc-lbl">Alpha vs Nifty</div></div>`:''}
    ${avgHitRate!=null?`<div class="track-card"><div class="tc-val ${parseFloat(avgHitRate)>=55?'gn':'yw'}">${avgHitRate}%</div><div class="tc-lbl">Pick Hit Rate</div></div>`:''}
    <div class="track-card"><div class="tc-val" style="color:var(--ac)">${vals.length}</div><div class="tc-lbl">Validated Weeks</div></div>
  </div>
  <div style="margin-bottom:20px">
    <div style="font-size:.78rem;font-weight:600;color:var(--t2);margin-bottom:12px;text-transform:uppercase;letter-spacing:.04em">Signal Accuracy & Calibrated Weights</div>
    ${sigBars}
  </div>
  <div style="overflow-x:auto">
    <table style="font-size:.78rem">
      <thead><tr><th>Week</th><th>Accuracy</th><th>Basket</th><th>Nifty</th><th>Alpha</th><th>Hit Rate</th></tr></thead>
      <tbody>${recentRows}</tbody>
    </table>
  </div>
  `:`<div style="text-align:center;padding:32px;color:var(--t3)">
    <div style="font-size:2rem;margin-bottom:8px">🔬</div>
    <div style="margin-bottom:6px">Track record will appear here after the first 10 trading days have passed.</div>
    <div style="font-size:.75rem">The algorithm automatically validates its own predictions and recalibrates signal weights based on what actually worked.</div>
  </div>`}
</div>

<div class="footer">Market Prediction · ${nowIST} IST · Data: Yahoo Finance · NSE India · Not investment advice</div>

<!-- Alert Modal -->
<div id="ap-modal">
  <button id="ap-x" style="position:absolute;top:12px;right:12px;background:none;border:none;color:var(--t3);font-size:1.1rem;cursor:pointer">✕</button>
  <div style="font-size:.95rem;font-weight:700;margin-bottom:2px;padding-right:24px" id="ap-title">Set Price Alert</div>
  <div style="font-size:.72rem;color:var(--t2);margin-bottom:12px" id="ap-sub"></div>
  <label class="ap-label" for="ap-above">🔔 Alert when price goes ABOVE ₹</label>
  <input type="number" id="ap-above" placeholder="e.g. 25000" min="0" step="0.5">
  <label class="ap-label" for="ap-below">🔔 Alert when price goes BELOW ₹</label>
  <input type="number" id="ap-below" placeholder="e.g. 24000" min="0" step="0.5">
  <div class="ap-actions">
    <button class="ap-save-btn" id="ap-save">Save Alert</button>
    <button class="ap-clear-btn" id="ap-clear">Clear</button>
  </div>
</div>

<!-- Brain Overlay -->
<div id="dr-overlay">
  <div id="dr-modal">
    <div id="dr-header">
      <h2 id="dr-title">🧠 AI Deep Research</h2>
      <button id="dr-close">✕</button>
    </div>
    <div id="dr-provider-bar">
      <button class="dr-prov-btn active" data-prov="groq">Groq (Free)</button>
      <button class="dr-prov-btn" data-prov="openrouter">OpenRouter</button>
      <button class="dr-prov-btn" data-prov="gemini">Gemini</button>
      <input id="dr-key-input" type="password" placeholder="API Key…" autocomplete="off">
      <button id="dr-key-save">Save</button>
    </div>
    <div id="dr-content"><div class="dr-loading">Select a sector and click 🧠 to start research.</div></div>
  </div>
</div>

<script>
const DATA = ${JSON.stringify(clientData)};

// ─── ApexCharts Initialization ──────────────────────────────────────────────
(function(){
  const CHART_THEME = {background:'transparent',foreColor:'#8888a0'};

  // ── Day-of-Week Chart
  const dowLabels = DATA.niftySeason.byDow.map(d=>d.label);
  const dowVals   = DATA.niftySeason.byDow.map(d=>+d.avg.toFixed(4));
  const dowColors = dowVals.map(v=>v>=0?'#22c55e':'#ef4444');
  new ApexCharts(document.getElementById('dow-chart'),{
    chart:{type:'bar',height:180,...CHART_THEME,toolbar:{show:false},sparkline:{enabled:false}},
    series:[{name:'Avg Daily Return',data:dowVals}],
    xaxis:{categories:dowLabels,labels:{style:{fontSize:'11px',colors:'#8888a0'}}},
    yaxis:{labels:{formatter:v=>(v>=0?'+':'')+v.toFixed(3)+'%',style:{colors:'#5a5a70'}}},
    colors:[...dowColors],plotOptions:{bar:{distributed:true,borderRadius:3}},
    legend:{show:false},dataLabels:{enabled:true,formatter:v=>(v>=0?'+':'')+v.toFixed(3)+'%',style:{fontSize:'9px',colors:['#e8e8f0']}},
    tooltip:{y:{formatter:v=>(v>=0?'+':'')+v.toFixed(4)+'%'}},
    grid:{borderColor:'#2a2a3a',xaxis:{lines:{show:false}}},
  }).render();

  // ── Month-of-Year Chart
  const mLabels = DATA.niftySeason.byMonth.map(m=>m.label);
  const mVals   = DATA.niftySeason.byMonth.map(m=>+m.avg.toFixed(4));
  const mColors = mVals.map(v=>v>=0?'#22c55e':'#ef4444');
  new ApexCharts(document.getElementById('month-chart'),{
    chart:{type:'bar',height:180,...CHART_THEME,toolbar:{show:false}},
    series:[{name:'Avg Daily Return',data:mVals}],
    xaxis:{categories:mLabels,labels:{style:{fontSize:'9px',colors:'#8888a0'}}},
    yaxis:{labels:{formatter:v=>(v>=0?'+':'')+v.toFixed(3)+'%',style:{colors:'#5a5a70'}}},
    colors:[...mColors],plotOptions:{bar:{distributed:true,borderRadius:3}},
    legend:{show:false},dataLabels:{enabled:false},
    tooltip:{y:{formatter:v=>(v>=0?'+':'')+v.toFixed(4)+'%'}},
    grid:{borderColor:'#2a2a3a',xaxis:{lines:{show:false}}},
  }).render();

  // ── RRG Scatter Chart
  const quadColors={Leading:'#22c55e',Improving:'#00d4aa',Weakening:'#f97316',Lagging:'#ef4444'};
  const byQuad={Leading:[],Improving:[],Weakening:[],Lagging:[]};
  DATA.sectors.forEach(s=>{if(s.quadrant&&s.rsRatio!=null){byQuad[s.quadrant].push({x:s.rsRatio,y:s.rsMom,label:s.abbr});}});
  const rrgSeries=Object.entries(byQuad).filter(([,d])=>d.length>0).map(([q,d])=>({name:q,data:d.map(p=>({x:p.x,y:p.y,label:p.label}))}));
  const rrgColors=Object.entries(byQuad).filter(([,d])=>d.length>0).map(([q])=>quadColors[q]);

  // Determine axis range
  const allRR=DATA.sectors.filter(s=>s.rsRatio!=null).map(s=>s.rsRatio);
  const allRM=DATA.sectors.filter(s=>s.rsMom!=null).map(s=>s.rsMom);
  const rrMin=allRR.length?Math.min(...allRR)-0.3:99,rrMax=allRR.length?Math.max(...allRR)+0.3:101;
  const rmMin=allRM.length?Math.min(...allRM)-0.3:99,rmMax=allRM.length?Math.max(...allRM)+0.3:101;

  new ApexCharts(document.getElementById('rrg-chart'),{
    chart:{type:'scatter',height:420,...CHART_THEME,toolbar:{show:false},zoom:{enabled:false}},
    series:rrgSeries,colors:rrgColors,
    xaxis:{min:rrMin,max:rrMax,tickAmount:6,title:{text:'RS-Ratio (>100 = Outperforming Nifty)',style:{color:'#5a5a70',fontSize:'11px'}},
      labels:{formatter:v=>v.toFixed(2),style:{colors:'#5a5a70'}},
      crosshairs:{show:true,stroke:{color:'#2a2a3a'}}},
    yaxis:{min:rmMin,max:rmMax,tickAmount:6,title:{text:'RS-Momentum (>100 = Improving)',style:{color:'#5a5a70',fontSize:'11px'}},
      labels:{formatter:v=>v.toFixed(2),style:{colors:'#5a5a70'}}},
    annotations:{
      xaxis:[{x:100,borderColor:'#3a3a4a',strokeDashArray:4,label:{text:'Benchmark',style:{color:'#5a5a70',background:'transparent',fontSize:'10px'}}}],
      yaxis:[{y:100,borderColor:'#3a3a4a',strokeDashArray:4,label:{text:'Benchmark',style:{color:'#5a5a70',background:'transparent',fontSize:'10px'},position:'left'}}],
    },
    dataLabels:{enabled:true,formatter:function(v,opts){const d=rrgSeries[opts.seriesIndex]?.data[opts.dataPointIndex];return d?.label||'';},style:{fontSize:'9px',colors:['#e8e8f0']},offsetY:-8},
    markers:{size:8,strokeWidth:0,hover:{size:10}},
    legend:{labels:{colors:'#8888a0'}},
    grid:{borderColor:'#1e1e2e',xaxis:{lines:{show:true}},yaxis:{lines:{show:true}}},
    tooltip:{custom:function({seriesIndex,dataPointIndex}){const s=rrgSeries[seriesIndex];const d=s?.data[dataPointIndex];return '<div style="padding:8px;background:#1a1a26;border:1px solid #2a2a3a;border-radius:6px;font-size:11px"><strong>'+d?.label+'</strong><br/>'+s.name+'<br/>RS-Ratio: '+d?.x?.toFixed(3)+'<br/>RS-Momentum: '+d?.y?.toFixed(3)+'</div>';}},
  }).render();
})();

// ─── Alert System ─────────────────────────────────────────────────────────────
window._GH_ALERTS_REPO='amitiyer99/watchlist-app';
(function(){
  var _GH=window._GH_ALERTS_REPO||'',_SHA=null;
  window._GA={};
  function pat(){return localStorage.getItem('gh_alerts_pat')||'';}
  function setPat(v){v?localStorage.setItem('gh_alerts_pat',v):localStorage.removeItem('gh_alerts_pat');}
  function fetchAlerts(){var p=pat();if(!p)return;fetch('https://api.github.com/repos/'+_GH+'/contents/user-alerts.json?t='+Date.now(),{headers:{'Authorization':'token '+p,'Accept':'application/vnd.github.v3+json'}}).then(r=>r.json()).then(j=>{_SHA=j.sha;try{window._GA=JSON.parse(atob(j.content.split(String.fromCharCode(10)).join('')));}catch(e){window._GA={};}refreshA();}).catch(()=>{});}
  function saveAlerts(a){var p=pat();if(!p){alert('Set your GitHub PAT in the Alerts section of another page first.');return;}var content=btoa(unescape(encodeURIComponent(JSON.stringify(a,null,2))));function doSave(sha){var b={message:'chore: update price alerts [skip ci]',content:content};if(sha)b.sha=sha;return fetch('https://api.github.com/repos/'+_GH+'/contents/user-alerts.json',{method:'PUT',headers:{'Authorization':'token '+p,'Content-Type':'application/json','Accept':'application/vnd.github.v3+json'},body:JSON.stringify(b)});}((_SHA)?doSave(_SHA):fetch('https://api.github.com/repos/'+_GH+'/contents/user-alerts.json?t='+Date.now(),{headers:{'Authorization':'token '+p,'Accept':'application/vnd.github.v3+json'}}).then(r=>r.ok?r.json().then(j=>{_SHA=j.sha;return doSave(_SHA);}):doSave(null)).catch(()=>doSave(null))).then(r=>r.json()).then(j=>{if(j.content){_SHA=j.content.sha;window._GA=a;refreshA();}});}
  var modal=document.getElementById('ap-modal'),curT='',curN='',curP=0;
  document.addEventListener('click',e=>{if(modal&&modal.style.display==='block'&&!modal.contains(e.target)&&!e.target.closest('.alert-btn'))modal.style.display='none';},true);
  document.addEventListener('click',e=>{
    var btn=e.target.closest('.alert-btn');if(!btn)return;e.stopPropagation();
    curT=btn.dataset.alertTicker||'';curN=btn.dataset.alertName||curT;curP=parseFloat(btn.dataset.alertPrice)||0;
    document.getElementById('ap-title').textContent=curN+' ('+curT+')';
    document.getElementById('ap-sub').textContent='Last: ₹'+curP.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
    var al=window._GA[curT]||{};document.getElementById('ap-above').value=al.above||'';document.getElementById('ap-below').value=al.below||'';
    var r=btn.getBoundingClientRect(),top=r.bottom+6;if(top+350>window.innerHeight)top=Math.max(8,r.top-356);
    modal.style.top=top+'px';modal.style.left=Math.max(8,Math.min(r.left,window.innerWidth-280))+'px';modal.style.display='block';
  });
  document.getElementById('ap-x').onclick=()=>modal.style.display='none';
  document.getElementById('ap-save').onclick=()=>{var a=JSON.parse(JSON.stringify(window._GA));var ab=parseFloat(document.getElementById('ap-above').value)||null,bl=parseFloat(document.getElementById('ap-below').value)||null;if(ab||bl){a[curT]={above:ab,below:bl,name:curN};}else{delete a[curT];}modal.style.display='none';saveAlerts(a);};
  document.getElementById('ap-clear').onclick=()=>{var a=JSON.parse(JSON.stringify(window._GA));delete a[curT];modal.style.display='none';saveAlerts(a);};
  function refreshA(){var a=window._GA;document.querySelectorAll('.alert-btn').forEach(btn=>{var t=btn.dataset.alertTicker||'';btn.classList.remove('has-alert');if(a[t]&&(a[t].above||a[t].below))btn.classList.add('has-alert');});}
  fetchAlerts();
})();

// ─── Brain / Deep Research ────────────────────────────────────────────────────
(function(){
  const overlay=document.getElementById('dr-overlay'),title=document.getElementById('dr-title'),content=document.getElementById('dr-content');
  const PROVIDERS={groq:{label:'Groq',url:'https://api.groq.com/openai/v1/chat/completions',model:'llama-3.3-70b-versatile',keyName:'groq_api_key'},openrouter:{label:'OpenRouter',url:'https://openrouter.ai/api/v1/chat/completions',model:'mistralai/mixtral-8x7b-instruct',keyName:'openrouter_api_key'},gemini:{label:'Gemini',url:'',model:'gemini-2.0-flash',keyName:'gemini_api_key'}};
  let curProv='groq';
  document.querySelectorAll('.dr-prov-btn').forEach(btn=>{btn.onclick=()=>{curProv=btn.dataset.prov;document.querySelectorAll('.dr-prov-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');const k=localStorage.getItem(PROVIDERS[curProv].keyName)||'';document.getElementById('dr-key-input').value=k?'••••••':'';};});
  document.getElementById('dr-key-save').onclick=()=>{const v=document.getElementById('dr-key-input').value.trim();if(v&&!v.startsWith('•'))localStorage.setItem(PROVIDERS[curProv].keyName,v);};
  document.getElementById('dr-close').onclick=()=>overlay.classList.remove('open');
  overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.classList.remove('open');});
  async function doResearch(ticker,sectorName){
    overlay.classList.add('open');title.textContent='🧠 '+sectorName;content.innerHTML='<div class="dr-loading">Researching '+sectorName+'…</div>';
    const prompt='Analyse the NSE India sector: '+sectorName+' ('+ticker+'). Today is '+new Date().toDateString()+'. Cover: 1) Current macro/policy tailwinds and headwinds for this sector, 2) Key companies to watch in next 2 weeks, 3) Technical setup — is this sector in an uptrend or downtrend? 4) What events or data releases in the next 14 days could move this sector significantly? 5) Verdict: Bullish, Bearish or Neutral for 2-week horizon and why. Be specific and concise.';
    const prov=PROVIDERS[curProv];const key=localStorage.getItem(prov.keyName)||'';if(!key){content.innerHTML='<div style="color:var(--rd);padding:16px">Please enter your '+prov.label+' API key above.</div>';return;}
    try{
      let text='';
      if(curProv==='gemini'){const url='https://generativelanguage.googleapis.com/v1beta/models/'+prov.model+':generateContent?key='+key;const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})});const d=await res.json();text=d.candidates?.[0]?.content?.parts?.[0]?.text||'No response';}
      else{const res=await fetch(prov.url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:prov.model,messages:[{role:'user',content:prompt}],max_tokens:1200})});const d=await res.json();text=d.choices?.[0]?.message?.content||d.error?.message||'No response';}
      content.innerHTML='<div style="white-space:pre-wrap;line-height:1.8">'+text.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</div>';
    }catch(e){content.innerHTML='<div style="color:var(--rd);padding:16px">Error: '+e.message+'</div>';}
  }
  document.addEventListener('click',e=>{
    const btn=e.target.closest('.research-btn');if(!btn)return;
    const ticker=btn.dataset.rTicker||'';const name=btn.dataset.rName||ticker;
    doResearch(ticker,name);
  });
})();
<\/script>
</body>
</html>`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main(){
  console.log('=== Market Prediction Generator ===');
  const today=new Date();
  const apexTickers=fs.existsSync(APEX_PATH)?JSON.parse(fs.readFileSync(APEX_PATH,'utf8')):[];
  const creamyTickers=fs.existsSync(CREAMY_PATH)?JSON.parse(fs.readFileSync(CREAMY_PATH,'utf8')):[];
  const history=loadHistory();

  // Fetch all historical data
  console.log('Fetching 3Y historical data for 15 tickers...');
  const allTickers=[BENCH,...SECTORS.map(s=>s.ticker)];
  const allBars={};
  for(let i=0;i<allTickers.length;i+=5){
    const batch=allTickers.slice(i,i+5);
    await Promise.all(batch.map(async t=>{const bars=await fetchHistory(t);if(bars)allBars[t]=bars;}));
    await sleep(600);
  }
  const benchBars=allBars[BENCH]||[];
  if(!benchBars.length)throw new Error('Nifty benchmark data unavailable');
  console.log(`Benchmark: ${benchBars.length} bars`);

  // Back-fill if first run
  await backfillIfNeeded(history,allBars,benchBars);

  // Validate mature snapshots
  await validateMature(history);

  // Calibrate weights
  const weights=calibrateWeights(history);
  const weightsCalibrated=history.validations.length>=3;
  history.weights=weights;
  console.log('Weights:',JSON.stringify(weights));

  // Nifty current data
  let niftyPrice=null,niftyRet5D=null;
  try{const nq=await yf.quote(BENCH);niftyPrice=nq.regularMarketPrice;}catch(e){}
  if(!niftyPrice&&benchBars.length)niftyPrice=benchBars[benchBars.length-1].close;
  if(benchBars.length>5){const c=benchBars.map(b=>b.close);niftyRet5D=+((c[c.length-1]/c[c.length-6]-1)*100).toFixed(2);}
  const niftySeasonality=computeSeasonality(benchBars);

  // Analyse all sectors
  console.log('Analysing sectors...');
  const analyzedSectors=[];
  for(const si of SECTORS){
    const bars=allBars[si.ticker];
    if(!bars){console.warn(`  No data: ${si.ticker}`);continue;}
    const rrg=computeRRG(bars,benchBars);
    const season=computeSeasonality(bars);
    const analog=computeAnalog(bars);
    const mom=computeMomentum(bars);
    const scoring=scoreSector(rrg,analog,season,mom,weights,today);
    console.log(`  ${si.abbr.padEnd(8)} score:${String(scoring.score).padStart(4)}  ${scoring.direction.padEnd(8)}  ${scoring.confidence.padEnd(6)}  ${rrg?rrg.quadrant:'no RRG'}`);
    analyzedSectors.push({...si,rrg,season,analog,mom,...scoring,currentPrice:mom.price});
  }
  analyzedSectors.sort((a,b)=>b.score-a.score);

  // Build merged URL lookup: apex (most reliable) → creamy → debate → ticker-urls.json
  const mergedUrlMap=new Map();
  for(const t of apexTickers){if(t.ticker&&t.url)mergedUrlMap.set(t.ticker,t.url);}
  for(const t of creamyTickers){if(t.ticker&&t.url&&!mergedUrlMap.has(t.ticker))mergedUrlMap.set(t.ticker,t.url);}
  const tuPath=path.join(__dirname,'ticker-urls.json');
  if(fs.existsSync(tuPath)){try{const tu=JSON.parse(fs.readFileSync(tuPath,'utf8'));Object.entries(tu).forEach(([k,v])=>{if(k&&v&&!mergedUrlMap.has(k))mergedUrlMap.set(k,v);});}catch(e){}}

  // Build stock universe: APEX + Creamy + Debate (bottom-up scan, no sector constraint)
  const universeMap=new Map();
  const resolveUrl=(ticker,rawUrl)=>rawUrl||(mergedUrlMap.get(ticker)||`https://www.tickertape.in/search?q=${encodeURIComponent(ticker)}`);
  for(const t of apexTickers){if(t.ticker)universeMap.set(t.ticker,{ticker:t.ticker,name:t.name,sector:t.sector,url:resolveUrl(t.ticker,t.url),apexScore:t.score||0,tier:t.tier||null,debateBacked:false,agentSummary:null});}
  for(const t of creamyTickers){if(t.ticker&&!universeMap.has(t.ticker))universeMap.set(t.ticker,{ticker:t.ticker,name:t.name,sector:t.sector,url:resolveUrl(t.ticker,t.url),apexScore:t.score||50,tier:t.tier||null,debateBacked:false,agentSummary:null});}
  const debateAll=loadDebateStocks();
  for(const t of debateAll){if(t.ticker){const ex=universeMap.get(t.ticker);if(ex){if(!ex.url||ex.url.includes('/search?'))ex.url=resolveUrl(t.ticker,t.url);ex.debateBacked=!!(t.hasPriceAction&&t.hasFundamental);ex.agentSummary=t.agentSummary||null;}else universeMap.set(t.ticker,{ticker:t.ticker,name:t.name,sector:t.sector,url:resolveUrl(t.ticker,t.url),apexScore:t.score||50,tier:null,debateBacked:!!(t.hasPriceAction&&t.hasFundamental),agentSummary:t.agentSummary||null});}}
  const universe=[...universeMap.values()];
  console.log(`Stock universe: ${universe.length} candidates`);

  // Run 3-agent scan: Trend + Momentum + Setup → composite score + ATR target
  const picks=await runMultiAgentScan(universe,benchBars);

  // Snapshot
  if(shouldSnapshot(history)){
    const targetDate=addTradingDays(today,10);
    const snap={
      id:dateStr(today),generatedAt:today.toISOString(),targetDate:dateStr(targetDate),
      niftyAtSnapshot:niftyPrice,niftyAtTarget:null,basketReturn:null,hitRate:null,alphaVsNifty:null,
      sectors:analyzedSectors.map(s=>({ticker:s.ticker,name:s.name,direction:s.direction,score:s.score,confidence:s.confidence,signals:s.signals,cs:s.cs,priceAtSnapshot:s.currentPrice,exitPrice:null,actualReturn:null})),
      picks:picks.filter(p=>p.isShortList).map(p=>({ticker:p.ticker,name:p.name,sector:p.sector,entryPrice:p.price,exitPrice:null,actualReturn:null,predictedDirection:'Bullish',apexScore:p.apexScore,tier:p.tier,conviction:p.conviction,targetGainPct:p.targetGainPct??null,targetGainSource:p.targetGainSource||null,isShortList:true})),
    };
    history.snapshots.push(snap);
    console.log(`Snapshot ${snap.id} → target ${snap.targetDate}`);
  }

  // Save history
  fs.writeFileSync(HISTORY_PATH,JSON.stringify(history,null,2));
  console.log('Saved prediction-history.json');

  // Build and write HTML
  const html=buildHtml({generatedAt:today.toISOString(),niftyPrice,niftyRet5D,weights,weightsCalibrated,niftySeasonality,sectors:analyzedSectors,picks,history});
  fs.writeFileSync(OUT_HTML,html);
  console.log(`Written ${OUT_HTML}`);
  console.log('Done!');
}

main().catch(e=>{console.error(e);process.exit(1);});

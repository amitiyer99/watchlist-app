'use strict';

// Regression: Alerts must not treat Triggers "armed" as a buy-now when LTP
// is a deep dip below the breakout pivot (ASMTEC: ~₹6,000 vs pivot ₹7,230).

const { evaluateEntryTiming, inArmedWindow, inPrimeWindow } = require('./lib/entry-timing');

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const asmTech = {
  price: 6019.4,
  tech: {
    s50: 6414.74,
    s150: 4695.33,
    s200: 4147.7,
    sma200Up: true,
    aboveSma200: true,
    dma200Cross: null,
    pivot: 7230,
    atrPct: 4.78,
    stage2: true,
    vcpPass: false,
  },
  trig: {
    isArmed: true,
    isLive: false,
    pivot: 7230,
    entry: 7230,
    stop: 6632,
  },
};

const et = evaluateEntryTiming(asmTech.price, asmTech.tech, asmTech.trig);

check('ASMTEC is not Armed while 16% below pivot',
  et.code === 'BASE_BUILDING',
  'got ' + et.code);
check('ASMTEC buy zone stays the breakout pivot (~7230)',
  et.buyZoneMin === 7230,
  'got ' + et.buyZoneMin);
check('ASMTEC pctToPivot is ~-16.7',
  et.pctToPivot != null && et.pctToPivot < -16 && et.pctToPivot > -18,
  String(et.pctToPivot));
check('ASMTEC is not an active buy-now',
  et.activeBuy === false, String(et.activeBuy));
check('copy does not claim breakout is imminent',
  !/imminent/i.test(et.action + et.summary),
  et.action);
check('copy distinguishes dip from breakout buy',
  /not today's dip|breakout buy/i.test(et.summary + et.action),
  et.summary);

const nearPivot = evaluateEntryTiming(7200, asmTech.tech, asmTech.trig);
check('same sidecar still Armed when actually coiling (~-0.4%)',
  nearPivot.code === 'ARMED_COILING',
  'got ' + nearPivot.code + ' pct=' + nearPivot.pctToPivot);
check('in-window Armed is an active buy',
  nearPivot.activeBuy === true, String(nearPivot.activeBuy));

const liveFar = evaluateEntryTiming(6019.4, asmTech.tech, { isLive: true, isArmed: false, pivot: 7230, entry: 7230 });
check('isLive does not force Prime on a 16% dip',
  liveFar.code !== 'PRIME_BUY_ZONE',
  'got ' + liveFar.code);

const liveNear = evaluateEntryTiming(7250, asmTech.tech, { isLive: true, pivot: 7230, entry: 7230 });
check('isLive + in-window is Prime',
  liveNear.code === 'PRIME_BUY_ZONE',
  'got ' + liveNear.code);

check('window helpers',
  inArmedWindow(-2) && !inArmedWindow(-16.7) && inPrimeWindow(1) && !inPrimeWindow(16));

const failed = results.filter(r => !r.pass);
results.forEach(r => console.log((r.pass ? 'ok  ' : 'FAIL') + ' ' + r.name + (r.detail ? ' — ' + r.detail : '')));
if (failed.length) {
  console.error('\n' + failed.length + ' failed');
  process.exit(1);
}
console.log('\n' + results.length + ' checks passed');

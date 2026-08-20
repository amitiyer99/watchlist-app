'use strict';

// ── Pinned third-party browser bundles ────────────────────────────────────────
// One place for every CDN script the pages load, so a version bump (or a revert)
// is a single edit rather than a hunt through generators.
//
// ApexCharts was pinned at 3.54.1 for a long time while upstream reached 6.x.
// Verified before bumping: every option these pages use still exists in 6.10.0
// (shadeIntensity, colorScale, distributed, borderRadius, strokeDashArray,
// sparkline, foreColor, crosshairs, tickAmount), and the UMD bundle still sets
// a global `ApexCharts` constructor via globalThis, which is how the pages use it.
//
// NOT verified: actual rendering. ApexCharts 6 requires ResizeObserver and other
// browser APIs that jsdom does not provide, so it cannot be exercised headlessly.
// Hence APEX_GUARD_JS below — if a chart throws, the container says so instead of
// leaving a silent blank space, which is how a broken chart normally hides.
//
// To revert: set APEX_VERSION back to '3.54.1'. Nothing else changes.
const APEX_VERSION = '6.10.0';
const APEXCHARTS_SRC = `https://cdn.jsdelivr.net/npm/apexcharts@${APEX_VERSION}/dist/apexcharts.min.js`;

// Wrap a chart render so a failure is VISIBLE. Charts that throw normally leave an
// empty div, which looks like "no data" rather than "this is broken" — the same
// class of silent failure as the deprecated Yahoo endpoint returning nothing.
//
// Usage in a generator's client JS:
//   ${APEX_GUARD_JS}
//   drawChart('heatmap-chart', () => new ApexCharts(el, opts).render());
const APEX_GUARD_JS = `
window.drawChart=function(elId,fn){
  var el=document.getElementById(elId);
  if(!el)return;
  if(typeof ApexCharts==='undefined'){
    el.innerHTML='<div style="padding:18px;color:#eab308;font-size:.8rem">Chart library did not load (CDN blocked or offline).</div>';
    return;
  }
  try{ var r=fn(); if(r&&typeof r.catch==='function')r.catch(function(e){chartFail(el,e);}); }
  catch(e){ chartFail(el,e); }
  function chartFail(box,err){
    console.error('[chart] '+elId+' failed to render:',err);
    box.innerHTML='<div style="padding:18px;color:#f87171;font-size:.8rem">Chart failed to render (ApexCharts ${APEX_VERSION}). '
      +'The underlying data is fine \\u2014 see the table below. Details in the browser console.</div>';
  }
};
`;

module.exports = { APEX_VERSION, APEXCHARTS_SRC, APEX_GUARD_JS };

'use strict';
// Shared alert + AI research buttons for all screener pages.
const alertSystem = require('../alert-system');
const aiProviders = require('./ai-providers');

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Data panel ────────────────────────────────────────────────────────────────
// Multibagger's 🧠 modal opens with a rich panel — score breakdown, fundamentals,
// signals, scorecard — and only THEN the AI analysis. Every page using this shared
// modal opened straight into the AI text with no context, which is the real
// inconsistency between pages (not the markdown rendering).
//
// `panel` is a compact declarative spec so each page can surface what IT knows:
//   panel: [
//     { title: '⚡ Signal Score', metrics: [{ label, val, sub, cls }] },
//     { title: '📉 Signals', signals: [{ tone: 'bull'|'bear'|'neut', icon, text }] },
//   ]
// It is JSON-encoded into a data attribute and rendered by the shared modal JS, so
// the markup/CSS lives in exactly one place.
function panelAttr(panel) {
  if (!panel || !panel.length) return '';
  const compact = panel
    .map(sec => ({
      t: sec.title || '',
      m: (sec.metrics || []).filter(x => x && x.val != null && x.val !== '').map(x => [x.label || '', String(x.val), x.sub || '', x.cls || '']),
      s: (sec.signals || []).filter(Boolean).map(x => [x.tone || 'neut', x.icon || '◆', x.text || '']),
    }))
    .filter(sec => sec.m.length || sec.s.length);
  if (!compact.length) return '';
  return ` data-r-panel="${esc(JSON.stringify(compact))}"`;
}

/** Inline 🔔 + 🧠 buttons — place immediately after stock name/ticker. */
function buttonsHtml({ ticker, name, price, prompt, research = true, panel = null }) {
  const t = esc(ticker);
  const n = esc(name || ticker);
  const p = Number(price) || 0;
  const promptAttr = (prompt ? ` data-r-prompt="${esc(prompt)}"` : '') + panelAttr(panel);
  let html = `<span class="stock-actions">`
    + `<button type="button" class="alert-btn" data-alert-ticker="${t}" data-alert-price="${p}" data-alert-name="${n}" title="Set price alert">&#x1F514;</button>`;
  if (research) {
    html += `<button type="button" class="research-btn" data-r-ticker="${t}" data-r-name="${n}" data-r-price="${p}"${promptAttr} title="AI Deep Research">&#x1F9E0;</button>`;
  }
  return html + `</span>`;
}

const livePriceCss = `
.px-stamp{position:fixed;left:10px;bottom:10px;z-index:9990;font-size:.68rem;padding:4px 10px;border-radius:20px;font-family:inherit;letter-spacing:.02em;cursor:help;border:1px solid;backdrop-filter:blur(4px)}
.px-stamp.px-live{background:rgba(34,197,94,.13);color:#22c55e;border-color:rgba(34,197,94,.35)}
.px-stamp.px-warm{background:rgba(234,179,8,.13);color:#eab308;border-color:rgba(234,179,8,.35)}
.px-stamp.px-bad{background:rgba(239,68,68,.13);color:#f87171;border-color:rgba(239,68,68,.35)}
@keyframes pxflash{0%{background:rgba(0,212,170,.28)}100%{background:transparent}}
.px-flash{animation:pxflash 1.1s ease-out}
@media(max-width:640px){.px-stamp{left:6px;bottom:6px;font-size:.62rem}}
`;

const panelCss = `/* Data panel — same visual language as the Multibagger modal, shared by all pages. */
.dr-section{margin-bottom:18px}
.dr-section-title{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ac,#00d4aa);font-weight:700;margin-bottom:8px}
.dr-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dr-metric{background:var(--s1,#12121a);border:1px solid var(--bd,#2a2a38);border-radius:8px;padding:10px 12px}
.dr-metric .dm-label{font-size:.65rem;color:var(--t2,#9898b0);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.dr-metric .dm-val{font-size:.9rem;font-weight:600}
.dr-metric .dm-sub{font-size:.65rem;color:var(--t3,#6a6a82);margin-top:2px}
.dr-metric .dm-val.pos{color:var(--gn,#22c55e)}.dr-metric .dm-val.neg{color:var(--rd,#ef4444)}
.dr-signal{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:7px;margin-bottom:5px;font-size:.8rem;line-height:1.4}
.dr-signal.bull{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.18);color:#22c55e}
.dr-signal.bear{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);color:#ef4444}
.dr-signal.neut{background:rgba(234,179,8,.07);border:1px solid rgba(234,179,8,.18);color:#eab308}
.dr-signal .ds-icon{flex-shrink:0;margin-top:1px}
@media(max-width:768px){.dr-grid{grid-template-columns:1fr}}
`;

const researchCss = `
.research-btn{background:none;border:none;cursor:pointer;padding:1px 4px;border-radius:4px;font-size:.82rem;color:var(--t3,#6a6a82);transition:color .15s;vertical-align:middle;line-height:1;flex-shrink:0}
.research-btn:hover{color:#a78bfa}
.stock-actions{display:inline-flex;align-items:center;gap:2px;margin-left:4px;vertical-align:middle;flex-shrink:0}
.stock-name-cell,.stock-name,.stock .name-row{display:flex;align-items:flex-start;flex-wrap:wrap;gap:2px}
#dr-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;align-items:center;justify-content:center;padding:12px}
#dr-overlay.open{display:flex}
#dr-modal{background:var(--s1,#12121a);border:1px solid var(--bd,#2a2a38);border-radius:16px;width:min(720px,95vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
#dr-header{padding:16px 20px;border-bottom:1px solid var(--bd,#2a2a38);display:flex;align-items:center;justify-content:space-between;gap:12px}
#dr-header h2{font-size:.95rem;font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0}
#dr-close{background:none;border:none;color:var(--t3,#6a6a82);font-size:1.2rem;cursor:pointer;line-height:1}
#dr-provider-bar{padding:10px 20px;border-bottom:1px solid var(--bd,#2a2a38);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dr-prov-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--bd,#2a2a38);background:var(--s2,#1a1a24);color:var(--t2,#9898b0);cursor:pointer;font-size:.75rem;font-family:inherit}
.dr-prov-btn:hover,.dr-prov-btn.active{color:var(--ac,#00d4aa);border-color:var(--ac,#00d4aa)}
#dr-key-input{flex:1;min-width:140px;background:var(--s3,#22222e);border:1px solid var(--bd,#2a2a38);border-radius:6px;padding:5px 10px;color:var(--tx,#e8e8f0);font-size:.78rem;outline:none;font-family:inherit}
#dr-key-save{padding:5px 12px;border-radius:6px;border:none;background:var(--ac,#00d4aa);color:#0c0c10;cursor:pointer;font-size:.75rem;font-weight:600;font-family:inherit}
#dr-content{padding:20px;overflow-y:auto;flex:1;font-size:.85rem;line-height:1.7}
${panelCss}
.dr-loading{text-align:center;color:var(--t2,#9898b0);padding:40px;font-size:.85rem}
.wl-chip .stock-actions{margin-left:4px}
.wl-chip .alert-btn,.wl-chip .research-btn{font-size:.7rem;padding:0 2px}
`;

const panelRendererJs = `
// ONE renderer for the 🧠 modal's data panel, used by the shared modal in this lib and
// by pages that host their own modal (debate, prediction). Input is the compact JSON
// emitted by panelAttr() into data-r-panel.
window.drRenderPanel=function(json){
    if(!json) return '';
    var secs; try{ secs=JSON.parse(json); }catch(e){ return ''; }
    if(!secs||!secs.length) return '';
    var out='';
    secs.forEach(function(sec){
      out+='<div class="dr-section"><div class="dr-section-title">'+sec.t+'</div>';
      if(sec.m&&sec.m.length){
        out+='<div class="dr-grid">';
        sec.m.forEach(function(m){
          out+='<div class="dr-metric"><div class="dm-label">'+m[0]+'</div>'
             + '<div class="dm-val'+(m[3]?' '+m[3]:'')+'">'+m[1]+'</div>'
             + (m[2]?'<div class="dm-sub">'+m[2]+'</div>':'')+'</div>';
        });
        out+='</div>';
      }
      if(sec.s&&sec.s.length){
        sec.s.forEach(function(g){
          out+='<div class="dr-signal '+g[0]+'"><span class="ds-icon">'+g[1]+'</span><span>'+g[2]+'</span></div>';
        });
      }
      out+='</div>';
    });
    return out;
};
window.drAiHeading='<div class="dr-section-title" style="margin-top:4px">\uD83E\uDDE0 AI Deep Analysis</div>';
`;

// ── Live price refresher (shared, browser-side) ───────────────────────────────
// Pages bake a price at BUILD time. Between market refreshes that is ~10 minutes stale;
// if a refresh fails, or after hours, it is hours or days stale — and nothing on the page
// said so. Observed: Triggers showed NALCO at 388 (previous close) twenty minutes after it
// closed at 418.6, and a distance-to-pivot computed from that stale number pointed the
// wrong way entirely.
//
// This refreshes prices in the BROWSER on load, so a page is only ever as stale as the
// feed, never as stale as the build. Three levels of opt-in, so it works on every page:
//   1. Any element with data-live-px="TICKER"        -> its text becomes the live price
//   2. tr[data-ticker] [data-price-cell]             -> existing convention, also updated
//   3. data-alert-price / data-r-price attributes    -> always refreshed, so price alerts
//      and the AI modal quote the current price even on pages that display none
// Plus an always-visible as-of stamp: the point is that you can SEE the age.
const livePriceJs = `
window.__livePx = null;
(function(){
  var FRESH_MIN = 20;      // a feed older than this is not "live" during market hours
  var DAY_MIN   = 20 * 60; // beyond this we stop calling it today's price at all
  var TOL = 0.30;          // same sanity band as lib/live-prices.js reconcile()

  function fmtPx(v){
    if (v == null || isNaN(v)) return '\\u2014';
    return '\\u20b9' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Client-side twin of reconcile(): a >30% gap between the baked price and the feed is
  // almost always bad data (a missed split/bonus on an SME name), not a real move.
  function sane(shown, live){
    if (live == null) return null;
    if (shown == null || !(shown > 0)) return live;
    return Math.abs(live - shown) / shown > TOL ? null : live;
  }
  function parsePx(el){
    var t = (el.textContent || '').replace(/[^0-9.]/g, '');
    var v = parseFloat(t);
    return isFinite(v) ? v : null;
  }

  function stamp(ageMin, n, ok){
    var el = document.getElementById('px-stamp');
    if (!el) {
      el = document.createElement('div');
      el.id = 'px-stamp';
      document.body.appendChild(el);
    }
    var cls = !ok ? 'px-bad' : ageMin <= FRESH_MIN ? 'px-live' : ageMin <= DAY_MIN ? 'px-warm' : 'px-bad';
    var age = ageMin == null ? 'unknown age'
      : ageMin < 1 ? 'just now'
      : ageMin < 60 ? Math.round(ageMin) + ' min old'
      : ageMin < DAY_MIN ? (ageMin / 60).toFixed(1) + ' h old'
      : Math.round(ageMin / 1440) + ' day(s) old';
    var label = !ok ? 'price feed unavailable'
      : (ageMin <= FRESH_MIN ? 'Live prices' : 'Prices') + ' \\u00b7 ' + age + (n ? ' \\u00b7 ' + n + ' updated' : '');
    el.className = 'px-stamp ' + cls;
    el.title = ok
      ? 'Prices on this page were refreshed in your browser from live-prices.json, which is ' + age
        + '. Anything the feed does not cover still shows the end-of-day price baked in when the page was built.'
      : 'Could not load live-prices.json, so every price on this page is whatever was baked in at build time. Treat them as indicative only.';
    el.textContent = (ageMin != null && ageMin <= FRESH_MIN ? '\\u25cf ' : '\\u25cb ') + label;
  }

  function apply(lp){
    var px = lp.prices || {};
    var n = 0;
    // 1 + 2: displayed price cells
    document.querySelectorAll('[data-live-px]').forEach(function(el){
      var t = el.getAttribute('data-live-px');
      var d = px[t];
      if (!d || d.p == null) return;
      var v = sane(parsePx(el), d.p);
      if (v == null) return;
      var firstNode = el.firstChild;
      if (firstNode && firstNode.nodeType === 3) firstNode.nodeValue = fmtPx(v);
      else el.textContent = fmtPx(v);
      el.classList.add('px-flash');
      n++;
    });
    document.querySelectorAll('tr[data-ticker]').forEach(function(row){
      var d = px[(row.getAttribute('data-ticker') || '').toUpperCase()];
      if (!d || d.p == null) return;
      var cell = row.querySelector('[data-price-cell]');
      if (cell && !cell.hasAttribute('data-live-px')) {
        var v = sane(parsePx(cell), d.p);
        if (v != null) { cell.textContent = fmtPx(v); cell.classList.add('px-flash'); n++; }
      }
    });
    // 3: keep alerts and the AI modal quoting the current price everywhere
    document.querySelectorAll('[data-alert-ticker]').forEach(function(b){
      var d = px[(b.getAttribute('data-alert-ticker') || '').toUpperCase()];
      if (d && d.p != null) b.setAttribute('data-alert-price', d.p);
    });
    document.querySelectorAll('[data-r-ticker]').forEach(function(b){
      var d = px[(b.getAttribute('data-r-ticker') || '').toUpperCase()];
      if (d && d.p != null) b.setAttribute('data-r-price', d.p);
    });
    return n;
  }

  fetch('./live-prices.json?_=' + Date.now())
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(lp){
      if (!lp || !lp.prices) { stamp(null, 0, false); return; }
      window.__livePx = lp;
      var ageMin = lp.ts ? (Date.now() - lp.ts) / 60000 : null;
      var n = apply(lp);
      stamp(ageMin, n, true);
      if (window.onLivePrices) { try { window.onLivePrices(lp); } catch (e) {} }
    })
    .catch(function(){ stamp(null, 0, false); });
})();
`;

const researchModalHtml = `<div id="dr-overlay">
  <div id="dr-modal">
    <div id="dr-header">
      <h2 id="dr-title">&#x1F9E0; AI Research</h2>
      <button type="button" id="dr-close">&#x2715;</button>
    </div>
    <div id="dr-provider-bar">
      <button type="button" class="dr-prov-btn active" data-prov="groq">Groq (Free)</button>
      <button type="button" class="dr-prov-btn" data-prov="openrouter">OpenRouter</button>
      <button type="button" class="dr-prov-btn" data-prov="gemini">Gemini</button>
      <input id="dr-key-input" type="password" placeholder="API Key…" autocomplete="off">
      <button type="button" id="dr-key-save">Save</button>
    </div>
    <div id="dr-content"><div class="dr-loading">Click &#x1F9E0; on any stock for AI analysis.</div></div>
  </div>
</div>`;

// ─── Shared AI-output formatter ───────────────────────────────────────────────
// SINGLE implementation of "render the model's markdown-ish reply". Previously four
// pages (multibagger, creamy, breakout2, india-research) each carried a byte-identical
// copy of a .replace() chain, and every page using this lib got an unformatted
// pre-wrap block instead. The copies had already drifted: creamy hardcoded #00d4aa
// while its own --ac is #a855f7, so its headings were off-theme.
// Exposed as a global so pages that host their own AI modal can call the same code.
// Improvements over the old per-page copies: bullets are rendered, and HTML is escaped
// BEFORE markdown is applied so model output cannot inject markup.
// Line-by-line, BLOCK-LEVEL rendering. The previous version wrapped everything in a
// <p> and emitted <div> bullets inside it — HTML forbids <div> inside <p>, so browsers
// auto-closed the paragraph and the layout collapsed: headings ran straight into the
// first bullet ("WHAT THE SETUP SAYS• Institutional buying…"). It looked unformatted
// even though the markdown had been converted, which is exactly what kept getting
// reported. Verified in Chrome against a live model response before committing.
const aiFormatterJs = `
window.fmtAiText=function(raw){
  var s=String(raw==null?'':raw).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Inline bold NEVER becomes block-level. The old per-page formatters styled every
  // **bold** as display:block, which tore inline bold onto its own line and shredded
  // exactly the patterns Groq emits — "**VERDICT**: STRONG BUY" split into two lines,
  // and "1. **Regulatory Risks**: Changes..." split into three.
  var inl=function(t){ return t.replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>').replace(/\\*(?!\\s)(.+?)\\*/g,'<i>$1</i>'); };
  var HEAD='color:var(--ac,#00d4aa);font-weight:700;letter-spacing:.02em;margin:14px 0 6px';
  var ITEM='margin:3px 0 3px 18px;text-indent:-13px';
  var lines=s.split(/\\r?\\n/), out=[], i, L, m;
  for(i=0;i<lines.length;i++){
    L=lines[i].trim();
    if(!L) continue;
    L=L.replace(/^#{1,4}\\s*/,'');                            // tolerate ### headings
    // Block heading ONLY when the entire line is bold (optionally ending in a colon)
    if((m=L.match(/^\\*\\*([^*]+)\\*\\*\\s*:?\\s*$/))){
      out.push('<div style="'+HEAD+'">'+m[1].replace(/:$/,'')+'</div>'); continue;
    }
    // Bare ALL-CAPS heading line (some replies drop the asterisks entirely)
    if(/^[A-Z][A-Z0-9 &/()'.-]{3,48}:?$/.test(L)){
      out.push('<div style="'+HEAD+'">'+L.replace(/:$/,'')+'</div>'); continue;
    }
    if((m=L.match(/^[-*\\u2022]\\s+(.*)$/))){                  // - / * / • bullet
      out.push('<div style="'+ITEM+'">&bull; '+inl(m[1])+'</div>'); continue;
    }
    if((m=L.match(/^(\\d+)[.)]\\s+(.*)$/))){                    // 1. / 1) numbered item
      out.push('<div style="'+ITEM+'">'+m[1]+'. '+inl(m[2])+'</div>'); continue;
    }
    out.push('<div style="margin:3px 0">'+inl(L)+'</div>');
  }
  if(!out.length) return '<div style="line-height:1.65;opacity:.6">No response.</div>';
  return '<div style="line-height:1.65">'+out.join('')+'</div>';
};
`;

const researchJs = `
// ─── AI Research (shared) ───
(function(){
  var fmtAi = window.fmtAiText;
  var overlay=document.getElementById('dr-overlay'),titleEl=document.getElementById('dr-title'),content=document.getElementById('dr-content');
  if(!overlay||!titleEl||!content)return;
  // Unified key names (dr_*_key) — migrate legacy *_api_key keys on first load
  (function migrateLegacyKeys(){
    var map={'groq_api_key':'dr_groq_key','openrouter_api_key':'dr_openrouter_key','gemini_api_key':'dr_gemini_key'};
    Object.keys(map).forEach(function(old){
      var v=localStorage.getItem(old);
      if(v&&!localStorage.getItem(map[old])){localStorage.setItem(map[old],v);}
      if(v){localStorage.removeItem(old);}
    });
  })();
  // Provider + model config from lib/ai-providers.js — one registry for the whole
  // site. Previously this list was hardcoded here AND in nine generators, so when
  // Groq shut down llama-3.3-70b-versatile the 🧠 button broke on every page at once.
  var PROVIDERS=window.DR_SIMPLE;
  var curProv='groq';
  document.querySelectorAll('.dr-prov-btn').forEach(function(btn){
    btn.onclick=function(){curProv=btn.dataset.prov;document.querySelectorAll('.dr-prov-btn').forEach(function(b){b.classList.remove('active');});btn.classList.add('active');
    var k=localStorage.getItem(PROVIDERS[curProv].keyName)||'';var inp=document.getElementById('dr-key-input');if(inp)inp.value=k?'\u2022\u2022\u2022\u2022\u2022\u2022':'';}; });
  var keySave=document.getElementById('dr-key-save');
  if(keySave)keySave.onclick=function(){var v=(document.getElementById('dr-key-input').value||'').trim();if(v&&!v.startsWith('\u2022'))localStorage.setItem(PROVIDERS[curProv].keyName,v);};
  var keyInp=document.getElementById('dr-key-input');
  if(keyInp){var k0=localStorage.getItem(PROVIDERS[curProv].keyName)||'';keyInp.value=k0?'\u2022\u2022\u2022\u2022\u2022\u2022':'';}
  document.getElementById('dr-close').onclick=function(){overlay.classList.remove('open');};
  overlay.addEventListener('click',function(e){if(e.target===overlay)overlay.classList.remove('open');});
  async function doResearch(ticker,name,prompt,panelJson){
    overlay.classList.add('open');
    titleEl.textContent='\uD83E\uDDE0 '+(name||ticker);
    var panelHtml=window.drRenderPanel(panelJson);
    var aiHead=window.drAiHeading;
    content.innerHTML=panelHtml+aiHead+'<div class="dr-loading">Consulting AI\u2026</div>';
    // The formatter can only style what the model actually returns. Multibagger looks
    // "formatted" because ITS prompt demands markdown sections; this shared prompt used
    // to ask for none, so every shared-lib page got flat prose no renderer could help.
    // FORMAT_SPEC is appended to the default AND to any page-supplied custom prompt
    // (e.g. FII/DII's catalyst prompt), so output is structured everywhere.
    var FORMAT_SPEC='\\n\\nFormat the reply EXACTLY like this, using **bold** section headings on their own line and short "- " bullets inside each section. No preamble, no closing remarks.\\n\\n'
      +'**WHAT THE SETUP SAYS**\\n- 2-3 bullets on the current technical/flow picture.\\n\\n'
      +'**WHY IT COULD WORK**\\n- 2-3 bullets: the bull case and its catalyst.\\n\\n'
      +'**KEY RISKS**\\n- 2 bullets: what breaks the thesis.\\n\\n'
      +'**VERDICT**: [BUY / WAIT / PASS] — one sentence, max 25 words.';
    var systemPrompt='You are a sharp NSE India equity analyst. Be specific and quantitative, never generic. Always reply in the exact markdown structure the user specifies — bold section headings and short bullets.';
    var userPrompt=(prompt||((name||ticker)+' ('+ticker+') on NSE India. Should I buy, hold, or pass? Cover the setup, the bull case, key risks and a verdict for the next 1-2 weeks.'))+FORMAT_SPEC;
    var prov=PROVIDERS[curProv];var key=localStorage.getItem(prov.keyName)||'';
    if(!key){content.innerHTML=panelHtml+aiHead+'<div style="color:#ef4444;padding:16px">Please enter your '+prov.label+' API key above.</div>';return;}
    // One request against a given model. Kept separate so the dead-model path can
    // call it a second time without duplicating the provider branching.
    async function ask(model){
      if(curProv==='gemini'){
        var url='https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent?key='+key;
        var res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:systemPrompt+'\\n\\n'+userPrompt}]}]})});
        var d=await res.json();
        var t=(d.candidates&&d.candidates[0]&&d.candidates[0].content&&d.candidates[0].content.parts&&d.candidates[0].content.parts[0]&&d.candidates[0].content.parts[0].text)||'';
        return {text:t,error:t?'':((d.error&&d.error.message)||'No response')};
      }
      var res2=await fetch(prov.url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:model,messages:[{role:'system',content:systemPrompt},{role:'user',content:userPrompt}],max_tokens:600})});
      var d2=await res2.json();
      var t2=(d2.choices&&d2.choices[0]&&d2.choices[0].message&&d2.choices[0].message.content)||'';
      return {text:t2,error:t2?'':((d2.error&&d2.error.message)||'No response')};
    }

    try{
      // Prefer a model the user has already been switched to, else the registry default.
      var chosen=null;
      try{chosen=localStorage.getItem('dr_model_'+curProv);}catch(e){}
      var model=chosen||prov.model;
      var r=await ask(model);

      // AUTO-RECOVERY. Providers retire models on a few weeks' notice, and when
      // that happens the only symptom is "model does not exist". Rather than
      // making this a support question, ask the provider what it DOES have, switch
      // to it, remember the choice, and retry once.
      if(r.error&&window.DR_DEAD_MODEL&&window.DR_DEAD_MODEL(r.error)){
        content.innerHTML=panelHtml+aiHead+'<div class="dr-loading">'+model+' has been retired by '+prov.label+'. Finding a current model\\u2026</div>';
        var fixed=await new Promise(function(resolve){window.DR_RECOVER_MODEL(curProv,key,model,function(pick){resolve(pick);});});
        if(fixed){
          try{localStorage.setItem('dr_model_'+curProv,fixed);}catch(e){}
          r=await ask(fixed);
          if(!r.error)r.text='_Switched to '+fixed+' \\u2014 '+model+' was retired by the provider._\\n\\n'+r.text;
          model=fixed;
        }
      }
      if(r.error){
        content.innerHTML=panelHtml+aiHead+'<div style="color:#ef4444;padding:16px">'+r.error
          +'<div style="color:#8888a0;font-size:.8rem;margin-top:8px">Model: '+model+' \\u00b7 provider: '+prov.label
          +'. If this says the model no longer exists, the provider retired it and no current replacement could be reached \\u2014 check your key, or try another provider above.</div></div>';
        return;
      }
      content.innerHTML=panelHtml+aiHead+fmtAi(r.text);
    }catch(e){content.innerHTML=panelHtml+aiHead+'<div style="color:#ef4444;padding:16px">Error: '+e.message+'</div>';}
  }
  document.addEventListener('click',function(e){
    var btn=e.target.closest('.research-btn');if(!btn)return;
    doResearch(btn.dataset.rTicker||'',btn.dataset.rName||btn.dataset.rTicker||'',btn.dataset.rPrompt||'',btn.dataset.rPanel||'');
  });
})();
`;

const setupScript = "window._GH_ALERTS_REPO='amitiyer99/watchlist-app';";

module.exports = {
  esc,
  buttonsHtml,
  css: alertSystem.css + researchCss + livePriceCss,
  researchCss,
  bannerHtml: alertSystem.bannerHtml,
  modalHtml: alertSystem.modalHtml,
  researchModalHtml,
  // Order matters: the formatter and the panel renderer must be defined before the
  // modal code that calls them.
  // AI_PROVIDERS_JS must come FIRST: it defines window.DR_PROVIDERS / DR_SIMPLE,
  // which researchJs and every page-local modal read at definition time.
  js: aiProviders.providersJs + alertSystem.js + aiFormatterJs + panelRendererJs + researchJs + livePriceJs,
  // For pages that host their own modal and assemble their own bundle.
  providersJs: aiProviders.providersJs,
  researchJs,
  aiFormatterJs,
  // For pages that host their OWN AI modal (debate, prediction, multibagger…): include
  // panelCss + panelRendererJs and call window.drRenderPanel(btn.dataset.rPanel).
  panelCss,
  panelRendererJs,
  // For pages that assemble their own script/style bundles:
  livePriceCss,
  livePriceJs,
  panelAttr,
  setupScript,
};

'use strict';
// Shared alert + AI research buttons for all screener pages.
const alertSystem = require('../alert-system');

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Inline 🔔 + 🧠 buttons — place immediately after stock name/ticker. */
function buttonsHtml({ ticker, name, price, prompt, research = true }) {
  const t = esc(ticker);
  const n = esc(name || ticker);
  const p = Number(price) || 0;
  const promptAttr = prompt ? ` data-r-prompt="${esc(prompt)}"` : '';
  let html = `<span class="stock-actions">`
    + `<button type="button" class="alert-btn" data-alert-ticker="${t}" data-alert-price="${p}" data-alert-name="${n}" title="Set price alert">&#x1F514;</button>`;
  if (research) {
    html += `<button type="button" class="research-btn" data-r-ticker="${t}" data-r-name="${n}" data-r-price="${p}"${promptAttr} title="AI Deep Research">&#x1F9E0;</button>`;
  }
  return html + `</span>`;
}

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
.dr-loading{text-align:center;color:var(--t2,#9898b0);padding:40px;font-size:.85rem}
.wl-chip .stock-actions{margin-left:4px}
.wl-chip .alert-btn,.wl-chip .research-btn{font-size:.7rem;padding:0 2px}
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
  var lines=s.split(/\\r?\\n/), out=[], i, L, mH, mB;
  for(i=0;i<lines.length;i++){
    L=lines[i].trim();
    if(!L) continue;
    mH=L.match(/^\\*\\*(.+?)\\*\\*:?\\s*(.*)$/);            // **HEADING** (optional trailing text)
    if(mH){
      out.push('<div style="color:var(--ac,#00d4aa);font-weight:700;margin:14px 0 6px">'+mH[1]+'</div>');
      if(mH[2]) out.push('<div style="margin:3px 0">'+mH[2]+'</div>');
      continue;
    }
    mB=L.match(/^[-*\\u2022]\\s+(.*)$/);                    // - / * / • bullet
    if(mB){ out.push('<div style="margin:3px 0 3px 16px;text-indent:-11px">&bull; '+mB[1]+'</div>'); continue; }
    out.push('<div style="margin:3px 0">'+L.replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>')+'</div>');
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
  var PROVIDERS={
    groq:{label:'Groq',url:'https://api.groq.com/openai/v1/chat/completions',model:'llama-3.3-70b-versatile',keyName:'dr_groq_key'},
    openrouter:{label:'OpenRouter',url:'https://openrouter.ai/api/v1/chat/completions',model:'mistralai/mixtral-8x7b-instruct',keyName:'dr_openrouter_key'},
    gemini:{label:'Gemini',url:'',model:'gemini-2.0-flash',keyName:'dr_gemini_key'}
  };
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
  async function doResearch(ticker,name,prompt){
    overlay.classList.add('open');
    titleEl.textContent='\uD83E\uDDE0 '+(name||ticker);
    content.innerHTML='<div class="dr-loading">Consulting AI\u2026</div>';
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
    if(!key){content.innerHTML='<div style="color:#ef4444;padding:16px">Please enter your '+prov.label+' API key above.</div>';return;}
    try{
      var text='';
      if(curProv==='gemini'){
        var url='https://generativelanguage.googleapis.com/v1beta/models/'+prov.model+':generateContent?key='+key;
        var res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:systemPrompt+'\\n\\n'+userPrompt}]}]})});
        var d=await res.json();text=(d.candidates&&d.candidates[0]&&d.candidates[0].content&&d.candidates[0].content.parts&&d.candidates[0].content.parts[0]&&d.candidates[0].content.parts[0].text)||(d.error&&d.error.message)||'No response';
      }else{
        var res2=await fetch(prov.url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:prov.model,messages:[{role:'system',content:systemPrompt},{role:'user',content:userPrompt}],max_tokens:600})});
        var d2=await res2.json();text=(d2.choices&&d2.choices[0]&&d2.choices[0].message&&d2.choices[0].message.content)||(d2.error&&d2.error.message)||'No response';
      }
      content.innerHTML=fmtAi(text);
    }catch(e){content.innerHTML='<div style="color:#ef4444;padding:16px">Error: '+e.message+'</div>';}
  }
  document.addEventListener('click',function(e){
    var btn=e.target.closest('.research-btn');if(!btn)return;
    doResearch(btn.dataset.rTicker||'',btn.dataset.rName||btn.dataset.rTicker||'',btn.dataset.rPrompt||'');
  });
})();
`;

const setupScript = "window._GH_ALERTS_REPO='amitiyer99/watchlist-app';";

module.exports = {
  esc,
  buttonsHtml,
  css: alertSystem.css + researchCss,
  researchCss,
  bannerHtml: alertSystem.bannerHtml,
  modalHtml: alertSystem.modalHtml,
  researchModalHtml,
  js: alertSystem.js + aiFormatterJs + researchJs,
  researchJs,
  aiFormatterJs,
  setupScript,
};

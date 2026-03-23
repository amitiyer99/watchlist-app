'use strict';
// Shared alert system — embedded into all 3 generated HTML pages

const css = `
/* ─────── Price Alert System ─────── */
.alert-btn{background:none;border:none;cursor:pointer;padding:1px 4px;border-radius:4px;font-size:.80rem;color:var(--t3);transition:color .15s;vertical-align:middle;margin-left:3px;line-height:1;flex-shrink:0}
.alert-btn:hover{color:var(--yw)}
.alert-btn.has-alert{color:var(--yw)}
.alert-btn.triggered{color:var(--rd);animation:alertPulse 1.5s ease-in-out infinite}
@keyframes alertPulse{0%,100%{opacity:1}50%{opacity:.35}}
tr.alert-triggered-row td,.stock-card.alert-triggered-row{background:rgba(239,68,68,.04)!important}
.alert-bar{display:none;flex-direction:row;align-items:flex-start;gap:10px;margin:8px 28px;padding:10px 14px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:8px;font-size:.82rem;color:var(--rd)}
.alert-bar-body{flex:1;line-height:1.5}
.alert-bar-close{background:none;border:none;cursor:pointer;color:var(--t3);font-size:1rem;padding:0;flex-shrink:0}
html[data-theme="light"] .alert-bar{background:rgba(185,28,28,.06);border-color:rgba(185,28,28,.18);color:#991b1b}
#ap-modal{display:none;position:fixed;background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:16px;z-index:9999;box-shadow:0 12px 40px rgba(0,0,0,.55);width:270px}
.ap-modal-title{font-size:.85rem;font-weight:700;color:var(--tx);margin-bottom:2px;padding-right:20px;line-height:1.4}
.ap-modal-sub{font-size:.72rem;color:var(--t2);margin-bottom:10px}
#ap-x{position:absolute;top:8px;right:10px;background:none;border:none;cursor:pointer;color:var(--t3);font-size:1.1rem;line-height:1;padding:0}
.ap-label{display:block;font-size:.72rem;color:var(--t2);margin:8px 0 3px}
#ap-above,#ap-below,#ap-pat-input{display:block;width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--s3);color:var(--tx);font-size:.84rem;font-family:inherit;outline:none;transition:border .2s;-moz-appearance:textfield;box-sizing:border-box}
#ap-above::-webkit-outer-spin-button,#ap-above::-webkit-inner-spin-button,
#ap-below::-webkit-outer-spin-button,#ap-below::-webkit-inner-spin-button{-webkit-appearance:none}
#ap-above:focus,#ap-below:focus,#ap-pat-input:focus{border-color:var(--ac)}
.ap-actions{display:flex;gap:6px;margin-top:12px}
.ap-save-btn{flex:1;padding:8px;border:none;border-radius:6px;background:var(--ac);color:#fff;cursor:pointer;font-weight:700;font-size:.8rem;font-family:inherit}
html[data-theme="light"] .ap-save-btn{color:#fff}
.ap-clear-btn{padding:8px 12px;border:1px solid var(--bd);border-radius:6px;background:transparent;color:var(--t2);cursor:pointer;font-size:.8rem;font-family:inherit}
.ap-clear-btn:hover{color:var(--rd);border-color:var(--rd)}
html[data-theme="light"] #ap-modal{box-shadow:0 4px 20px rgba(0,0,0,.12)}
@media(max-width:768px){.alert-bar{margin:8px 14px}#ap-modal{width:calc(100vw - 24px);left:12px!important}}
.ap-gh-section{margin-top:10px;padding-top:8px;border-top:1px solid var(--bd)}
.ap-gh-toggle{font-size:.7rem;color:var(--t3);cursor:pointer;user-select:none;padding:2px 0;display:flex;align-items:center;gap:4px}
.ap-gh-toggle:hover{color:var(--t2)}
.ap-gh-body{padding-top:6px}
.ap-gh-note{font-size:.62rem;color:var(--t3);margin-top:4px;line-height:1.4}
.ap-gh-note a{color:var(--ac);text-decoration:none}
.ap-gh-status{font-size:.7rem;margin-top:5px;padding:4px 6px;border-radius:4px;display:none}
.ap-gh-status.ok{background:rgba(34,197,94,.1);color:var(--gn);display:block}
.ap-gh-status.err{background:rgba(239,68,68,.1);color:var(--rd);display:block}
#pat-setup-bar{display:none;flex-direction:row;align-items:center;gap:8px;margin:8px 28px;padding:10px 14px;background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.3);border-radius:8px;font-size:.82rem;color:#93c5fd}
#pat-setup-bar input{flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--s3);color:var(--tx);font-size:.8rem;font-family:inherit;outline:none;min-width:0}
#pat-setup-bar input:focus{border-color:var(--ac)}
#pat-setup-bar button.connect{padding:6px 12px;border:none;border-radius:6px;background:var(--ac);color:#fff;cursor:pointer;font-size:.78rem;font-weight:700;white-space:nowrap}
#pat-setup-bar button.dismiss{background:none;border:none;cursor:pointer;color:var(--t3);font-size:1rem;padding:0;flex-shrink:0}
@media(max-width:768px){#pat-setup-bar{margin:8px 14px;flex-wrap:wrap}}
`;

const bannerHtml = `<div id="alert-bar" class="alert-bar">
  <span style="font-size:1rem;flex-shrink:0">&#x1F514;</span>
  <div class="alert-bar-body" id="alert-bar-body"></div>
  <button class="alert-bar-close" onclick="document.getElementById('alert-bar').style.display='none'" title="Dismiss">&#x2715;</button>
</div>
<div id="pat-setup-bar">
  <span style="flex-shrink:0">&#x1F511;</span>
  <span style="flex-shrink:0;white-space:nowrap">GitHub PAT for alerts:</span>
  <input id="pat-bar-input" type="password" placeholder="ghp_... (repo Contents R+W)" autocomplete="off">
  <button class="connect" id="pat-bar-save">Connect</button>
  <button class="dismiss" id="pat-bar-close" title="Dismiss">&#x2715;</button>
</div>`;

const modalHtml = `<div id="ap-modal">
  <button id="ap-x">&#x2715;</button>
  <div class="ap-modal-title" id="ap-title">Set Price Alert</div>
  <div class="ap-modal-sub" id="ap-sub"></div>
  <label class="ap-label" for="ap-above">&#x1F514; Alert when price goes ABOVE &#x20B9;</label>
  <input type="number" id="ap-above" placeholder="e.g. 1500" min="0" step="0.5">
  <label class="ap-label" for="ap-below">&#x1F514; Alert when price goes BELOW &#x20B9;</label>
  <input type="number" id="ap-below" placeholder="e.g. 1200" min="0" step="0.5">
  <div class="ap-actions">
    <button class="ap-save-btn" id="ap-save">Save Alert</button>
    <button class="ap-clear-btn" id="ap-clear">Clear</button>
  </div>
  <div class="ap-gh-section">
    <div class="ap-gh-toggle" id="ap-gh-toggle">&#x2699;&#xFE0F; GitHub sync <span id="ap-gh-arrow">&#x25B8;</span></div>
    <div class="ap-gh-body" id="ap-gh-body" style="display:none">
      <label class="ap-label" for="ap-pat-input">Personal Access Token</label>
      <input type="password" id="ap-pat-input" placeholder="ghp_..." autocomplete="off">
      <button class="ap-save-btn" id="ap-pat-save" style="margin-top:8px;width:100%">Save PAT</button>
      <div id="ap-gh-status" class="ap-gh-status"></div>
      <p class="ap-gh-note">Create at <a href="https://github.com/settings/tokens" target="_blank">github.com/settings/tokens</a> &rarr; Fine-grained &rarr; Contents: Read+Write on this repo. Alerts save automatically to user-alerts.json on every change.</p>
    </div>
  </div>
</div>`;

// Client-side JS — no template literals inside so it embeds safely in any template literal
const js = `
// ─────── Price Alert System (GitHub-backed) ───────
(function(){
  var _GH = window._GH_ALERTS_REPO || '';
  var _GH_FILE = 'user-alerts.json';
  var _SHA = null;
  window._GA = {};

  function pat(){ return localStorage.getItem('gh_alerts_pat')||''; }
  function setPat(v){ if(v) localStorage.setItem('gh_alerts_pat',v); else localStorage.removeItem('gh_alerts_pat'); }

  function showPatBar(msg){
    var b=document.getElementById('pat-setup-bar');
    if(!b)return;
    b.style.display='flex';
    var inp=document.getElementById('pat-bar-input');
    if(inp&&msg){ inp.placeholder=msg; }
  }
  function hidePatBar(){ var b=document.getElementById('pat-setup-bar');if(b)b.style.display='none'; }

  function ghStatus(msg,type){
    var el=document.getElementById('ap-gh-status');
    if(!el)return;
    el.textContent=msg; el.className='ap-gh-status '+(type||'');
  }

  function fetchAlerts(cb){
    var p=pat();
    if(!p){ showPatBar(); if(cb)cb(false); return; }
    fetch('https://api.github.com/repos/'+_GH+'/contents/'+_GH_FILE+'?t='+Date.now(),
      {headers:{'Authorization':'token '+p,'Accept':'application/vnd.github.v3+json'}})
    .then(function(r){ return r.json().then(function(j){return{ok:r.ok,j:j};}); })
    .then(function(res){
      if(!res.ok) throw new Error(res.j.message||'HTTP error');
      _SHA=res.j.sha;
      try{ window._GA=JSON.parse(atob(res.j.content.replace(/\\n/g,''))); }catch(e){ window._GA={}; }
      // One-time migration: if GitHub is empty but localStorage has legacy alerts, push them up
      if(!Object.keys(window._GA).length){
        try{
          var _lg=localStorage.getItem('stockAlerts_v1');
          if(_lg){ var _la=JSON.parse(_lg); if(Object.keys(_la).length){ window._GA=_la; saveAlerts(_la); } }
        }catch(e){}
      }
      hidePatBar();
      refreshA();
      if(window.onAlertChange) window.onAlertChange();
      if(cb)cb(true);
    })
    .catch(function(e){
      console.error('[Alerts] fetch:',e.message);
      if(/401|403|Bad cred/i.test(e.message)){ setPat(''); showPatBar('Invalid PAT — re-enter'); }
      if(cb)cb(false);
    });
  }

  function saveAlerts(a,cb){
    var p=pat();
    if(!p){ showPatBar(); if(cb)cb(false); return; }
    var content=btoa(unescape(encodeURIComponent(JSON.stringify(a,null,2))));
    var body=JSON.stringify({message:'chore: update price alerts [skip ci]',content:content,sha:_SHA});
    ghStatus('Saving\u2026','');
    fetch('https://api.github.com/repos/'+_GH+'/contents/'+_GH_FILE,{
      method:'PUT',
      headers:{'Authorization':'token '+p,'Content-Type':'application/json','Accept':'application/vnd.github.v3+json'},
      body:body
    })
    .then(function(r){ return r.json().then(function(j){return{ok:r.ok,j:j};}); })
    .then(function(res){
      if(!res.ok) throw new Error(res.j.message||'HTTP error');
      _SHA=res.j.content.sha;
      window._GA=a;
      refreshA();
      if(window.onAlertChange) window.onAlertChange();
      ghStatus('\\u2713 Saved to GitHub','ok');
      setTimeout(function(){ghStatus('','');},3000);
      if(cb)cb(true);
    })
    .catch(function(e){
      console.error('[Alerts] save:',e.message);
      ghStatus('\\u274C '+e.message,'err');
      if(cb)cb(false);
    });
  }

  var modal=document.getElementById('ap-modal');
  var curT='',curN='',curP=0;

  document.addEventListener('click',function(e){
    if(modal&&modal.style.display==='block'&&!modal.contains(e.target)&&!e.target.closest('.alert-btn')){
      modal.style.display='none';
    }
  },true);

  document.addEventListener('click',function(e){
    var btn=e.target.closest('.alert-btn');
    if(!btn)return;
    e.stopPropagation();
    curT=btn.dataset.alertTicker||'';
    curN=btn.dataset.alertName||curT;
    curP=parseFloat(btn.dataset.alertPrice)||0;
    document.getElementById('ap-title').textContent=curN+' ('+curT+')';
    document.getElementById('ap-sub').textContent='Last price: \\u20B9'+curP.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
    var a=(window._GA[curT])||{};
    document.getElementById('ap-above').value=a.above||'';
    document.getElementById('ap-below').value=a.below||'';
    var r=btn.getBoundingClientRect();
    var topPos=r.bottom+6;
    if(topPos+340>window.innerHeight)topPos=Math.max(8,r.top-346);
    modal.style.top=topPos+'px';
    modal.style.left=Math.max(8,Math.min(r.left,window.innerWidth-280))+'px';
    modal.style.display='block';
    ghStatus('','');
  });

  document.getElementById('ap-x').onclick=function(){modal.style.display='none';};

  document.getElementById('ap-save').onclick=function(){
    var a=JSON.parse(JSON.stringify(window._GA));
    var above=parseFloat(document.getElementById('ap-above').value)||null;
    var below=parseFloat(document.getElementById('ap-below').value)||null;
    if(above||below){ a[curT]={above:above,below:below,name:curN}; }else{ delete a[curT]; }
    modal.style.display='none';
    saveAlerts(a);
  };
  document.getElementById('ap-clear').onclick=function(){
    var a=JSON.parse(JSON.stringify(window._GA));
    delete a[curT];
    modal.style.display='none';
    saveAlerts(a);
  };

  // GitHub PAT setup in modal
  var ghToggle=document.getElementById('ap-gh-toggle');
  if(ghToggle){
    ghToggle.onclick=function(){
      var body=document.getElementById('ap-gh-body');
      var arrow=document.getElementById('ap-gh-arrow');
      if(body.style.display==='none'){
        body.style.display='block';
        if(arrow)arrow.textContent='\\u25BE';
        var pi=document.getElementById('ap-pat-input');
        if(pi){ pi.value=pat(); }
      } else {
        body.style.display='none';
        if(arrow)arrow.textContent='\\u25B8';
      }
    };
  }
  var patSave=document.getElementById('ap-pat-save');
  if(patSave){
    patSave.onclick=function(){
      var v=(document.getElementById('ap-pat-input').value||'').trim();
      if(!v)return;
      setPat(v);
      ghStatus('Connecting\\u2026','');
      fetchAlerts(function(ok){
        ghStatus(ok?'\\u2713 Connected — alerts loaded':'\\u274C Connection failed',ok?'ok':'err');
      });
    };
  }

  // PAT setup bar (shown when no PAT)
  var patBarSave=document.getElementById('pat-bar-save');
  if(patBarSave){
    patBarSave.onclick=function(){
      var v=(document.getElementById('pat-bar-input').value||'').trim();
      if(!v)return;
      setPat(v);
      fetchAlerts();
    };
  }
  var patBarClose=document.getElementById('pat-bar-close');
  if(patBarClose){ patBarClose.onclick=function(){hidePatBar();}; }

  function refreshA(){
    var a=window._GA;
    var triggered=[];
    document.querySelectorAll('.alert-btn').forEach(function(btn){
      var t=btn.dataset.alertTicker||'';
      var p=parseFloat(btn.dataset.alertPrice)||0;
      var n=btn.dataset.alertName||t;
      var al=a[t];
      btn.classList.remove('has-alert','triggered');
      var row=btn.closest('tr')||btn.closest('.stock-card');
      if(row)row.classList.remove('alert-triggered-row');
      if(!al||(!al.above&&!al.below)){btn.title='Set price alert';return;}
      btn.classList.add('has-alert');
      btn.title='Alert: '+(al.above?'\\u25b2\\u20B9'+al.above:'')+(al.above&&al.below?' / ':'')+(al.below?'\\u25bc\\u20B9'+al.below:'');
      var msgs=[];
      if(al.above&&p>=al.above)msgs.push('\\u20B9'+p.toFixed(2)+' \\u2265 target \\u20B9'+al.above);
      if(al.below&&p<=al.below)msgs.push('\\u20B9'+p.toFixed(2)+' \\u2264 target \\u20B9'+al.below);
      if(msgs.length){
        btn.classList.add('triggered');
        if(row)row.classList.add('alert-triggered-row');
        triggered.push('<strong>'+n+'</strong>: '+msgs.join(' & '));
      }
    });
    var bar=document.getElementById('alert-bar');
    var body=document.getElementById('alert-bar-body');
    if(!bar||!body)return;
    if(triggered.length){
      body.innerHTML='\\uD83D\\uDD14 '+triggered.length+' price alert'+(triggered.length>1?'s':'')+' triggered \\u2014 '+triggered.join(' \\u00B7 ');
      bar.style.display='flex';
    }else{ bar.style.display='none'; }
  }

  refreshA();
  if(window.MutationObserver){
    ['table-body','cards-container'].forEach(function(id){
      var el=document.getElementById(id);
      if(el){new MutationObserver(function(){refreshA();}).observe(el,{childList:true});}
    });
  }
  // Show PAT bar immediately on load if no token stored (don't wait for async fetch)
  if(!pat()){ showPatBar(); }
  // Fetch alerts from GitHub on load
  fetchAlerts();
})();
`;

module.exports = { css, bannerHtml, modalHtml, js };

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
#ap-modal{display:none;position:fixed;background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:16px;z-index:9999;box-shadow:0 12px 40px rgba(0,0,0,.55);width:260px}
.ap-modal-title{font-size:.85rem;font-weight:700;color:var(--tx);margin-bottom:2px;padding-right:20px;line-height:1.4}
.ap-modal-sub{font-size:.72rem;color:var(--t2);margin-bottom:10px}
#ap-x{position:absolute;top:8px;right:10px;background:none;border:none;cursor:pointer;color:var(--t3);font-size:1.1rem;line-height:1;padding:0}
.ap-label{display:block;font-size:.72rem;color:var(--t2);margin:8px 0 3px}
#ap-above,#ap-below{display:block;width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--s3);color:var(--tx);font-size:.84rem;font-family:inherit;outline:none;transition:border .2s;-moz-appearance:textfield}
#ap-above::-webkit-outer-spin-button,#ap-above::-webkit-inner-spin-button,
#ap-below::-webkit-outer-spin-button,#ap-below::-webkit-inner-spin-button{-webkit-appearance:none}
#ap-above:focus,#ap-below:focus{border-color:var(--ac)}
.ap-actions{display:flex;gap:6px;margin-top:12px}
.ap-save-btn{flex:1;padding:8px;border:none;border-radius:6px;background:var(--ac);color:#fff;cursor:pointer;font-weight:700;font-size:.8rem;font-family:inherit}
html[data-theme="light"] .ap-save-btn{color:#fff}
.ap-clear-btn{padding:8px 12px;border:1px solid var(--bd);border-radius:6px;background:transparent;color:var(--t2);cursor:pointer;font-size:.8rem;font-family:inherit}
.ap-clear-btn:hover{color:var(--rd);border-color:var(--rd)}
html[data-theme="light"] #ap-modal{box-shadow:0 4px 20px rgba(0,0,0,.12)}
@media(max-width:768px){.alert-bar{margin:8px 14px}#ap-modal{width:calc(100vw - 24px);left:12px!important}}
`;

const bannerHtml = `<div id="alert-bar" class="alert-bar">
  <span style="font-size:1rem;flex-shrink:0">&#x1F514;</span>
  <div class="alert-bar-body" id="alert-bar-body"></div>
  <button class="alert-bar-close" onclick="document.getElementById('alert-bar').style.display='none'" title="Dismiss">&#x2715;</button>
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
</div>`;

// Client-side JS — no template literals inside so it embeds safely in any template literal
const js = `
// ─────── Price Alert System ───────
(function(){
  var LS='stockAlerts_v1';
  function getA(){try{return JSON.parse(localStorage.getItem(LS)||'{}')}catch(e){return{}}}
  function saveA(a){localStorage.setItem(LS,JSON.stringify(a))}
  var modal=document.getElementById('ap-modal');
  var curT='',curN='',curP=0;

  // Close modal on outside click
  document.addEventListener('click',function(e){
    if(modal&&modal.style.display==='block'&&!modal.contains(e.target)&&!e.target.closest('.alert-btn')){
      modal.style.display='none';
    }
  },true);

  // Open modal on bell click
  document.addEventListener('click',function(e){
    var btn=e.target.closest('.alert-btn');
    if(!btn)return;
    e.stopPropagation();
    curT=btn.dataset.alertTicker||'';
    curN=btn.dataset.alertName||curT;
    curP=parseFloat(btn.dataset.alertPrice)||0;
    document.getElementById('ap-title').textContent=curN+' ('+curT+')';
    document.getElementById('ap-sub').textContent='Last price: \u20B9'+curP.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
    var a=getA()[curT]||{};
    document.getElementById('ap-above').value=a.above||'';
    document.getElementById('ap-below').value=a.below||'';
    var r=btn.getBoundingClientRect();
    modal.style.top=(r.bottom+6+window.scrollY)+'px';
    modal.style.left=Math.max(8,Math.min(r.left+window.scrollX,window.innerWidth-270+window.scrollX))+'px';
    modal.style.display='block';
  });

  document.getElementById('ap-x').onclick=function(){modal.style.display='none'};

  document.getElementById('ap-save').onclick=function(){
    var a=getA();
    var above=parseFloat(document.getElementById('ap-above').value)||null;
    var below=parseFloat(document.getElementById('ap-below').value)||null;
    if(above||below){a[curT]={above:above,below:below,name:curN};}else{delete a[curT];}
    saveA(a);modal.style.display='none';refreshA();
  };
  document.getElementById('ap-clear').onclick=function(){
    var a=getA();delete a[curT];saveA(a);modal.style.display='none';refreshA();
  };

  function refreshA(){
    var a=getA();var triggered=[];
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
      btn.title='Alert: '+(al.above?'\u25b2\u20B9'+al.above:'')+(al.above&&al.below?' / ':'')+(al.below?'\u25bc\u20B9'+al.below:'');
      var msgs=[];
      if(al.above&&p>=al.above)msgs.push('\u20B9'+p.toFixed(2)+' \u2265 target \u20B9'+al.above);
      if(al.below&&p<=al.below)msgs.push('\u20B9'+p.toFixed(2)+' \u2264 target \u20B9'+al.below);
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
      body.innerHTML='\uD83D\uDD14 '+triggered.length+' price alert'+(triggered.length>1?'s':'')+' triggered \u2014 '+triggered.join(' \u00B7 ');
      bar.style.display='flex';
    }else{bar.style.display='none';}
  }

  // Re-run after any renderTable call so dynamic rows get alerts applied
  var origRender=window.renderTable;
  if(typeof origRender==='function'){
    window.renderTable=function(){origRender.apply(this,arguments);refreshA();};
  }

  refreshA();
})();
`;

module.exports = { css, bannerHtml, modalHtml, js };

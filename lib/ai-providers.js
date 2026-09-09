'use strict';

// ── AI provider + model registry (single source of truth) ─────────────────────
// WHY THIS FILE EXISTS
// The 🧠 modal stopped working on every page on 2026-08-16, when Groq shut down
// llama-3.3-70b-versatile. Fixing it meant editing the same hardcoded model list
// in TEN files (7 generators with a model dropdown, 2 with a single-model config,
// plus lib/stock-actions.js). That is the actual bug — a provider deprecation
// should be a one-line change, not ten.
//
// It also turned out that EVERY model the app offered was already dead:
//   Groq    llama-3.3-70b-versatile   shut down 2026-08-16
//           llama3-8b-8192            long removed
//           mixtral-8x7b-32768        removed 2025-03-05
//   Gemini  gemini-2.0-flash          shut down
//           gemini-2.0-flash-lite     shut down
//           gemini-1.5-flash-8b       shut down
//
// So a static list is not good enough on its own. Every provider publishes its
// live model list over HTTP, and this module uses it: the dropdown is populated
// from the provider itself, cached for a day, with the baked-in list as the
// fallback. When a request fails because a model went away, it refreshes the
// list, picks the first working model and retries once — so the next deprecation
// heals itself instead of silently breaking the feature.
//
// Sources for the current IDs below:
//   https://console.groq.com/docs/models  ·  https://console.groq.com/docs/deprecations
//   https://ai.google.dev/gemini-api/docs/models
//   https://openrouter.ai/api/v1/models

// Verified against the provider docs on 2026-08-20. Order matters: the FIRST
// entry is the default, and the auto-recovery path falls back to it.
const PROVIDERS = {
  groq: {
    label: 'Groq — fast, generous free tier ★',
    keyName: 'dr_groq_key',
    keyPlaceholder: 'Paste Groq API key (console.groq.com)',
    keyLink: 'https://console.groq.com/keys',
    keyLinkLabel: 'console.groq.com',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B — best quality' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B — fastest' },
      { id: 'groq/compound', label: 'Compound — has web search' },
      { id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B (preview)' },
    ],
  },
  openrouter: {
    label: 'OpenRouter — many models, one key',
    keyName: 'dr_openrouter_key',
    keyPlaceholder: 'Paste OpenRouter API key (openrouter.ai/keys)',
    keyLink: 'https://openrouter.ai/keys',
    keyLinkLabel: 'openrouter.ai',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
    ],
  },
  gemini: {
    label: 'Google Gemini',
    keyName: 'dr_gemini_key',
    keyPlaceholder: 'Paste Gemini API key (aistudio.google.com)',
    keyLink: 'https://aistudio.google.com/app/apikey',
    keyLinkLabel: 'aistudio.google.com',
    url: '',                       // built per-request, model goes in the path
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    models: [
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite — fastest' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash — balanced' },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash — best quality' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — older stable' },
    ],
  },
};

// Models that exist but cannot answer a chat prompt. Kept as a denylist rather
// than an allowlist so a newly-released text model shows up without a code change.
const NON_CHAT_RE = String.raw`whisper|tts|embed|guard|safeguard|image|veo|lyria|imagen|robotics|live|translate|omni|orpheus|computer-use|deep-research`;

// ── Client-side runtime ───────────────────────────────────────────────────────
// Emitted into every page. Defines window.DR_PROVIDERS plus the discovery,
// model-picking and auto-recovery helpers the modals use.
//
// NOTE ON ESCAPING: this string is interpolated into a template literal in the
// generators, so any newline inside an emitted JS string MUST be written \\n.
// A bare \n becomes a real line break and kills the whole <script> block —
// audit-pipeline.js check I exists because of exactly that bug.
const providersJs = `
(function(){
  window.DR_PROVIDERS=${JSON.stringify(PROVIDERS)};
  var NON_CHAT=/${NON_CHAT_RE}/i;
  var CACHE_H=24;

  function cacheKey(p){return 'dr_models_'+p;}

  // Live model list, cached for a day. Returns the baked-in list on any failure —
  // a dropdown that still works beats an empty one.
  window.DR_LIVE_MODELS=function(provId,key,cb){
    var prov=window.DR_PROVIDERS[provId];
    if(!prov){if(cb)cb(null);return;}
    var fallback=prov.models.slice();
    try{
      var raw=localStorage.getItem(cacheKey(provId));
      if(raw){
        var c=JSON.parse(raw);
        if(c&&c.at&&(Date.now()-c.at)/3.6e6<CACHE_H&&c.models&&c.models.length){if(cb)cb(c.models);return;}
      }
    }catch(e){}
    if(!prov.modelsUrl||(provId!=='openrouter'&&!key)){if(cb)cb(fallback);return;}
    var url=prov.modelsUrl,opts={};
    if(provId==='gemini')url+='?key='+encodeURIComponent(key);
    else if(provId==='groq')opts={headers:{'Authorization':'Bearer '+key}};
    fetch(url,opts).then(function(r){return r.ok?r.json():null;}).then(function(j){
      if(!j){if(cb)cb(fallback);return;}
      var list=[];
      if(provId==='gemini'){
        (j.models||[]).forEach(function(m){
          var id=String(m.name||'').replace(/^models\\//,'');
          var gen=m.supportedGenerationMethods||m.supportedActions||[];
          var canChat=!gen.length||gen.indexOf('generateContent')>=0;
          if(id&&canChat&&!NON_CHAT.test(id))list.push({id:id,label:m.displayName||id});
        });
      }else{
        (j.data||[]).forEach(function(m){
          var id=String(m.id||'');
          if(id&&!NON_CHAT.test(id))list.push({id:id,label:m.name||id});
        });
      }
      if(!list.length){if(cb)cb(fallback);return;}
      // Keep the curated order at the top — the live list is alphabetical noise
      // otherwise, and "first entry" is what auto-recovery reaches for.
      var live={};list.forEach(function(m){live[m.id]=m;});
      var ordered=[];
      fallback.forEach(function(m){if(live[m.id]){ordered.push({id:m.id,label:m.label});delete live[m.id];}});
      Object.keys(live).forEach(function(k){ordered.push(live[k]);});
      try{localStorage.setItem(cacheKey(provId),JSON.stringify({at:Date.now(),models:ordered}));}catch(e){}
      if(cb)cb(ordered);
    }).catch(function(){if(cb)cb(fallback);});
  };

  // Pull visible text out of OpenAI / Groq / Gemini / reasoning-model payloads.
  window.DR_EXTRACT_TEXT=function(d){
    if(!d)return '';
    var gem=d.candidates&&d.candidates[0]&&d.candidates[0].content&&d.candidates[0].content.parts;
    if(gem&&gem.length){
      return gem.map(function(p){return p.text||'';}).filter(Boolean).join('\\n');
    }
    var ch=d.choices&&d.choices[0];
    var m=ch&&ch.message;
    if(!m)return '';
    var c=m.content;
    if(typeof c==='string'&&c.trim())return c;
    if(Array.isArray(c)){
      var joined=c.map(function(p){return (p&&(p.text||p.content))||'';}).join('');
      if(joined.trim())return joined;
    }
    return '';
  };

  function chatSkip(id){
    return !id||NON_CHAT.test(id)||/compound/i.test(id);
  }

  // Does this error mean "that model is gone / empty" rather than "your key is wrong"?
  window.DR_DEAD_MODEL=function(msg){
    return /does not exist|do not have access|decommission|deprecat|no longer|invalid[_ ]?model|(model|models\\/[a-z0-9.\\-]+)[^.]{0,20}not[_ ]?found|not found for api version|unknown model|no response|empty response|reasoning used the token budget/i.test(String(msg||''));
  };

  // Drop a stale cache and hand back the first live model, so a caller can retry.
  window.DR_RECOVER_MODEL=function(provId,key,badModel,cb){
    try{localStorage.removeItem(cacheKey(provId));}catch(e){}
    var skip={};skip[String(badModel||'')]=true;
    if(arguments.length>4&&arguments[4]){Object.keys(arguments[4]).forEach(function(k){skip[k]=true;});}
    window.DR_LIVE_MODELS(provId,key,function(list){
      var pick=null;
      (list||[]).some(function(m){
        if(!chatSkip(m.id)&&!skip[m.id]){pick=m.id;return true;}
        return false;
      });
      if(cb)cb(pick,list||[]);
    });
  };

  // One chat call with a high completion budget. GPT-OSS spends hidden reasoning
  // tokens from the same budget; max_tokens:600 was returning empty "No response".
  function drChatOnce(provId,key,model,system,prompt){
    var prov=window.DR_PROVIDERS[provId];
    if(provId==='gemini'){
      var gUrl=prov.modelsUrl+'/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(key);
      var gBody={contents:[{parts:[{text:(system?system+'\\n\\n':'')+prompt}]}],generationConfig:{temperature:0.65,maxOutputTokens:4096}};
      return fetch(gUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(gBody)}).then(function(r){return r.json();});
    }
    var headers={'Content-Type':'application/json','Authorization':'Bearer '+key};
    if(provId==='openrouter')headers['HTTP-Referer']='https:'+String.fromCharCode(47,47)+'amitiyer99.github.io/watchlist-app/';
    var messages=[];
    if(system)messages.push({role:'system',content:system});
    messages.push({role:'user',content:prompt});
    var payload={model:model,messages:messages,temperature:0.65,max_tokens:4096,max_completion_tokens:4096};
    if(/gpt-oss|qwen3/i.test(model))payload.reasoning_effort='low';
    return fetch(prov.url,{method:'POST',headers:headers,body:JSON.stringify(payload)}).then(function(r){return r.json();});
  }

  function drFailMsg(d,text){
    if(text&&String(text).trim())return '';
    if(d&&d.error&&d.error.message)return d.error.message;
    var fr=d&&d.choices&&d.choices[0]&&d.choices[0].finish_reason;
    if(fr==='length')return 'empty response (reasoning used the token budget)';
    return 'No response';
  }

  // Try preferred model, then walk the live list until one actually answers.
  window.DR_COMPLETE=function(opts){
    opts=opts||{};
    var provId=opts.provId||'groq';
    var key=opts.key||'';
    var prompt=opts.prompt||'';
    var system=opts.system||'';
    var onStatus=opts.onStatus;
    var prov=window.DR_PROVIDERS[provId];
    if(!prov)return Promise.reject(new Error('Unknown provider'));
    if(!key)return Promise.reject(new Error('Missing API key'));
    var tried={};
    function remember(id){
      try{localStorage.setItem('dr_model_'+provId,id);localStorage.setItem('dr_model.'+provId,id);}catch(e){}
    }
    function attempt(model){
      if(onStatus)onStatus(model);
      return drChatOnce(provId,key,model,system,prompt).then(function(d){
        var text=window.DR_EXTRACT_TEXT(d);
        return {text:text,error:drFailMsg(d,text),model:model};
      });
    }
    function walk(queue,i,from){
      if(i>=queue.length)return Promise.reject(new Error(from||'No response'));
      var id=queue[i];
      if(tried[id]||chatSkip(id))return walk(queue,i+1,from);
      tried[id]=true;
      return attempt(id).then(function(r){
        if(!r.error){remember(r.model);if(from)r.switchedFrom=from;return r;}
        if(!window.DR_DEAD_MODEL(r.error))return Promise.reject(new Error(r.error));
        if(onStatus)onStatus('switching from '+id);
        return walk(queue,i+1,from||id);
      });
    }
    var start=opts.model;
    try{if(!start)start=localStorage.getItem('dr_model_'+provId)||localStorage.getItem('dr_model.'+provId);}catch(e){}
    if(!start)start=prov.models[0].id;
    tried[start]=true;
    return attempt(start).then(function(first){
      if(!first.error){remember(first.model);return first;}
      if(!window.DR_DEAD_MODEL(first.error))return Promise.reject(new Error(first.error));
      if(onStatus)onStatus('switching from '+start);
      try{localStorage.removeItem(cacheKey(provId));}catch(e){}
      return new Promise(function(resolve){
        window.DR_LIVE_MODELS(provId,key,function(list){resolve(list&&list.length?list:prov.models);});
      }).then(function(list){
        var queue=[];
        (list||[]).forEach(function(m){if(m.id&&m.id!==start)queue.push(m.id);});
        return walk(queue,0,start);
      });
    });
  };

  // The single-model shape used by the Debate, Prediction and shared-lib modals,
  // derived from the same registry so there is still only one model list.
  //
  // These three pages used to key their API keys as 'groq_api_key' etc., while
  // lib/stock-actions.js migrates 'groq_api_key' -> 'dr_groq_key' AND DELETES the
  // old key. So opening any other page silently logged you out of Debate and
  // Prediction. They now share the dr_* names, which also means one key entry
  // works everywhere.
  window.DR_SIMPLE=(function(){
    var out={};
    Object.keys(window.DR_PROVIDERS).forEach(function(k){
      var p=window.DR_PROVIDERS[k];
      out[k]={label:p.label.split(' \\u2014')[0],url:p.url,model:p.models[0].id,keyName:p.keyName};
    });
    return out;
  })();

  // Populate a <select> from the live list, preserving the user's choice if it
  // still exists. Safe to call when the element is absent.
  window.DR_FILL_MODELS=function(provId,selectEl,preferred){
    if(!selectEl)return;
    var prov=window.DR_PROVIDERS[provId];if(!prov)return;
    var key='';try{key=localStorage.getItem(prov.keyName)||'';}catch(e){}
    var render=function(list){
      var want=preferred||selectEl.value||'';
      selectEl.innerHTML=list.map(function(m){
        return '<option value="'+m.id+'">'+String(m.label||m.id).replace(/</g,'&lt;')+'</option>';
      }).join('');
      if(want&&list.some(function(m){return m.id===want;}))selectEl.value=want;
    };
    render(prov.models);
    window.DR_LIVE_MODELS(provId,key,function(list){if(list&&list.length)render(list);});
  };
})();
`;

// The 7 generators that carry their own model dropdown declare a local
// `var DR_PROVIDERS = {...}`. This replaces that literal, so there is exactly one
// list in the repo.
const providersDeclJs = 'var DR_PROVIDERS=window.DR_PROVIDERS;';

// Node-side helpers, for anything that needs the default model without a browser.
const defaultModel = provId => (PROVIDERS[provId] && PROVIDERS[provId].models[0] && PROVIDERS[provId].models[0].id) || null;

module.exports = { PROVIDERS, providersJs, providersDeclJs, defaultModel, NON_CHAT_RE };

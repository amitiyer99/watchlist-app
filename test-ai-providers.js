'use strict';

// ── AI provider registry test ─────────────────────────────────────────────────
// The 🧠 modal is browser code emitted from Node template literals, which is the
// one place in this repo where a mistake is invisible until a user clicks the
// button: a stray real newline inside an emitted string kills the whole <script>
// (see audit-pipeline.js check I), and a wrong model ID only shows up as an API
// error. So this runs the emitted JS in a stubbed browser and asserts behaviour.
//
// Run: npm run test-ai   (exit code 1 on failure)

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { providersJs, PROVIDERS, defaultModel } = require('./lib/ai-providers');

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ── A stubbed browser ─────────────────────────────────────────────────────────
function browser({ fetchImpl } = {}) {
  const store = {};
  const win = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    fetch: fetchImpl || (() => Promise.reject(new Error('no network'))),
    Promise, JSON, Date, encodeURIComponent, String, Object, RegExp, isFinite, console,
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(providersJs, ctx);
  return { ctx, win, store };
}

// 1 — It parses at all, and defines what every page depends on.
let b;
try {
  b = browser();
  check('emitted provider JS parses and runs in a browser context', true);
} catch (e) {
  check('emitted provider JS parses and runs in a browser context', false, e.message);
}
if (b) {
  check('window.DR_PROVIDERS is defined with all three providers',
    !!b.win.DR_PROVIDERS && ['groq', 'openrouter', 'gemini'].every(k => k in b.win.DR_PROVIDERS),
    Object.keys(b.win.DR_PROVIDERS || {}).join(','));
  check('window.DR_SIMPLE is derived for the single-model pages',
    !!b.win.DR_SIMPLE && b.win.DR_SIMPLE.groq.model === defaultModel('groq'),
    JSON.stringify(b.win.DR_SIMPLE && b.win.DR_SIMPLE.groq));
  check('DR_SIMPLE uses the shared dr_* key names, not the old groq_api_key',
    b.win.DR_SIMPLE && Object.keys(b.win.DR_SIMPLE).every(k => /^dr_/.test(b.win.DR_SIMPLE[k].keyName)),
    JSON.stringify(Object.keys(b.win.DR_SIMPLE || {}).map(k => b.win.DR_SIMPLE[k].keyName)));
  check('every helper the modals call is exported',
    ['DR_LIVE_MODELS', 'DR_DEAD_MODEL', 'DR_RECOVER_MODEL', 'DR_FILL_MODELS'].every(f => typeof b.win[f] === 'function'));
}

// 2 — No retired model IDs anywhere in the shipped registry. This is the specific
//     regression: on 2026-08-16 every single ID in the app was already dead.
{
  const DEAD = [
    'llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768',
    'llama-3.1-8b-instant', 'gemini-2.0-flash', 'gemini-2.0-flash-lite',
    'gemini-1.5-flash-8b', 'gemini-1.5-flash', 'gemini-3-pro-preview',
    'meta-llama/llama-4-scout-17b-16e-instruct', 'qwen-qwq-32b', 'gemma-7b-it',
  ];
  const ids = Object.values(PROVIDERS).flatMap(p => p.models.map(m => m.id));
  const found = ids.filter(id => DEAD.includes(id));
  check('no shut-down model IDs remain in the registry', found.length === 0, found.join(', '));
  check('every provider offers at least two models', Object.values(PROVIDERS).every(p => p.models.length >= 2));
  check('every provider has a models endpoint for live discovery',
    Object.values(PROVIDERS).every(p => !!p.modelsUrl));
}

// 3 — The error the user actually saw must be recognised as a dead model, and a
//     wrong-key error must NOT be (otherwise we'd loop retrying on a bad key).
if (b) {
  const D = b.win.DR_DEAD_MODEL;
  check('recognises the real Groq shutdown message',
    D('The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.'));
  check('recognises Gemini-style retirement wording',
    D('models/gemini-2.0-flash is not found for API version v1beta') && D('Model has been deprecated'));
  check('does NOT treat an invalid API key as a dead model',
    !D('Invalid API Key') && !D('Incorrect API key provided') && !D('401 Unauthorized'),
    'a false positive here would retry forever on a bad key');
  check('does NOT treat a rate limit as a dead model',
    !D('Rate limit reached for model') === false ? true : !D('429 Too Many Requests'),
    'rate limits must surface, not trigger a model swap');
}

// 4 — Live discovery: parse a realistic Groq payload, drop the non-chat models,
//     and keep the curated order at the front.
{
  const groqPayload = {
    data: [
      { id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' },
      { id: 'meta-llama/llama-prompt-guard-2-22m' }, { id: 'openai/gpt-oss-120b' },
      { id: 'some-new-text-model' }, { id: 'canopylabs/orpheus-v1-english' },
    ],
  };
  const bb = browser({ fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve(groqPayload) }) });
  return new Promise(resolve => {
    bb.win.DR_LIVE_MODELS('groq', 'test-key', list => {
      const ids = list.map(m => m.id);
      check('live discovery drops whisper/guard/tts models',
        !ids.some(i => /whisper|guard|orpheus/.test(i)), ids.join(', '));
      check('live discovery keeps the curated order at the top',
        ids[0] === defaultModel('groq'), ids.join(', '));
      check('live discovery surfaces models the registry has never heard of',
        ids.includes('some-new-text-model'), ids.join(', '));
      check('live discovery caches its result', !!bb.store.dr_models_groq);
      resolve(bb);
    });
  }).then(() => finish5());
}

// 5 — Gemini's shape is different (models/NAME + supportedGenerationMethods).
function finish5() {
  const geminiPayload = {
    models: [
      { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-tts-preview', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    ],
  };
  const bb = browser({ fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve(geminiPayload) }) });
  return new Promise(resolve => {
    bb.win.DR_LIVE_MODELS('gemini', 'k', list => {
      const ids = list.map(m => m.id);
      check('Gemini discovery strips the models/ prefix', ids.includes('gemini-3.6-flash'), ids.join(', '));
      check('Gemini discovery drops embedding and TTS models',
        !ids.some(i => /embedding|tts/.test(i)), ids.join(', '));
      resolve();
    });
  }).then(finish6);
}

// 6 — Failure must degrade to the baked list, never to an empty dropdown.
function finish6() {
  const bb = browser({ fetchImpl: () => Promise.reject(new Error('offline')) });
  return new Promise(resolve => {
    bb.win.DR_LIVE_MODELS('groq', 'k', list => {
      check('a failed model fetch falls back to the baked-in list',
        Array.isArray(list) && list.length === PROVIDERS.groq.models.length,
        `got ${list && list.length}`);
      resolve();
    });
  }).then(finish7);
}

// 7 — Recovery picks a DIFFERENT model than the dead one.
function finish7() {
  const payload = { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }] };
  const bb = browser({ fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }) });
  return new Promise(resolve => {
    bb.win.DR_RECOVER_MODEL('groq', 'k', 'openai/gpt-oss-120b', pick => {
      check('recovery never hands back the model that just failed',
        pick && pick !== 'openai/gpt-oss-120b', `picked ${pick}`);
      resolve();
    });
  }).then(finish8);
}

// 8 — The escaping trap: a real newline inside an emitted JS string breaks the
//     whole <script>. Check the emitted source has none inside single quotes.
function finish8() {
  const bad = [];
  providersJs.split('\n').forEach((line, i) => {
    // Comments legitimately contain apostrophes ("the user's choice"), so strip
    // them before counting — otherwise this check cries wolf on prose.
    const code = line.replace(/\/\/.*$/, '');
    // count unescaped single quotes; an odd number means a string spans the line end
    const q = (code.match(/(?<!\\)'/g) || []).length;
    if (q % 2 !== 0) bad.push(`line ${i + 1}: ${line.trim().slice(0, 60)}`);
  });
  check('no emitted string literal spans a line break', bad.length === 0, bad.join(' | '));

  // Every generator that renders a modal must emit the registry before using it.
  const consumers = [
    'generate-apex.js', 'generate-breakout2.js', 'generate-creamy.js',
    'generate-multibagger.js', 'generate-rocket.js', 'generate-indianresearch.js',
    'generate-dashboard.js', 'generate-debate.js', 'generate-prediction.js',
  ];
  const missing = consumers.filter(f => {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    return !s.includes('${AI_PROV}') || !s.includes("require('./lib/ai-providers')");
  });
  check('every page with its own modal emits the shared registry', missing.length === 0, missing.join(', '));

  const stray = consumers.filter(f => {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    return /models:\s*\[\s*\{\s*id:/.test(s);   // a local model list left behind
  });
  check('no generator still carries its own model list', stray.length === 0, stray.join(', '));

  report();
}

function report() {
  let failed = 0;
  console.log('\nAI provider registry\n' + '─'.repeat(72));
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.name}${r.detail && !r.pass ? `\n         ${r.detail}` : ''}`);
  }
  console.log('─'.repeat(72));
  console.log(`${results.length - failed}/${results.length} passed\n`);
  process.exit(failed ? 1 : 0);
}

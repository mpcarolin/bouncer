// engine.js — everything that touches the Prompt API (LanguageModel).
// Classic script: loaded by bench.html (<script>), background.js (importScripts)
// and the content script (manifest), so each context can run the model itself.
(function () {
  'use strict';

  const LANG = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

  // Keep this short: prompt length is a main latency driver.
  const SYSTEM = `You answer cookie consent dialogs so the website gets the LEAST data.
Input: dialog text, then numbered controls "[n] role label" (toggles show on/off).
Pick ONE action:
- reject: click control n that rejects/declines optional cookies (e.g. "Reject all", "Deny", "Necessary only").
- settings: no reject control exists; click control n that opens cookie settings/preferences.
- save: a settings panel with category toggles and no reject control; off = indices of optional toggles that are on; n = the save/confirm control.
- none: none of the above applies.
Never pick accept/agree/allow. Never switch off necessary toggles.
Reply only JSON: {"action":"reject|settings|save|none","index":n,"off":[n],"confidence":"high|medium|low"}. index -1 for none.`;

  const SCHEMA = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['reject', 'settings', 'save', 'none'] },
      index: { type: 'integer' },
      off: { type: 'array', items: { type: 'integer' } },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['action', 'index', 'off', 'confidence'],
    additionalProperties: false,
  };

  const now = () => performance.now();
  // availability()/create() have been seen to hang forever (headless Chromium without the model),
  // so everything is raced against a timeout instead of awaiting blindly.
  function withTimeout(p, ms, what) {
    let id;
    return Promise.race([p, new Promise((_, rej) => { id = setTimeout(() => rej(new Error(`timeout: ${what} > ${ms} ms`)), ms); })])
      .finally(() => clearTimeout(id));
  }
  const AVAIL_TIMEOUT = 10000, CREATE_TIMEOUT = 60000, PROMPT_TIMEOUT = 60000;
  const has = () => typeof LanguageModel !== 'undefined';

  function bannerToPrompt(banner, maxText) {
    maxText = maxText == null ? 400 : maxText;
    let t = banner.text || '';
    if (t.length > maxText) t = t.slice(0, maxText) + '…';
    const lines = banner.controls.map((c) => {
      let s = `[${c.i}] ${c.role} "${c.label}"`;
      if (c.on !== undefined) s += c.on ? ' on' : ' off';
      if (c.disabled) s += ' disabled';
      return s;
    });
    return (maxText > 0 ? `Text: ${t}\n` : '') + `Controls:\n${lines.join('\n')}`;
  }

  function parseDecision(text) {
    if (!text) return null;
    let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b < a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  }

  // expected: array of acceptable answers [{action, index?, off?}]
  function score(decision, expected, banner) {
    if (!decision) return { correct: false, why: 'unparseable' };
    for (const e of expected) {
      if (decision.action !== e.action) continue;
      if (e.action === 'none') return { correct: true };
      if (decision.index !== e.index) continue;
      if (e.action === 'save') {
        const off = Array.isArray(decision.off) ? decision.off : [];
        const missing = (e.off || []).filter((i) => !off.includes(i));
        const bad = off.filter((i) => {
          const c = banner.controls[i];
          return !c || c.role !== 'toggle' || c.disabled || /necessary|required|essential/i.test(c.label);
        });
        if (missing.length || bad.length) return { correct: false, why: `toggles missing=${missing} bad=${bad}` };
      }
      return { correct: true };
    }
    const c = banner.controls[decision.index];
    return { correct: false, why: `chose ${decision.action} [${decision.index}] "${c ? c.label : '?'}"` };
  }

  // Context-usage helpers: contextUsage/measureContextUsage are current; inputUsage/measureInputUsage are the
  // deprecated aliases (still enabled in extension processes only).
  function usage(session) {
    if (!session) return null;
    if (typeof session.contextUsage === 'number') return session.contextUsage;
    if (typeof session.inputUsage === 'number') return session.inputUsage;
    return null;
  }
  function windowSize(session) {
    if (!session) return null;
    if (session.contextWindow != null) return session.contextWindow;
    if (session.inputQuota != null) return session.inputQuota;
    return null;
  }
  async function measure(session, input, opts) {
    try {
      if (session.measureContextUsage) return await session.measureContextUsage(input, opts);
      if (session.measureInputUsage) return await session.measureInputUsage(input, opts);
    } catch (e) { return 'error: ' + e.message; }
    return null;
  }

  function createOptions(o) {
    o = o || {};
    const opts = Object.assign({}, LANG);
    if (o.system !== false) opts.initialPrompts = [{ role: 'system', content: SYSTEM }];
    if (o.greedy) { opts.topK = 1; opts.temperature = 0; } // extension-only legacy params
    if (o.monitor) opts.monitor = o.monitor;
    return opts;
  }

  async function probe() {
    const out = { context: contextName(), hasLanguageModel: has() };
    if (!out.hasLanguageModel) return out;
    out.hasLegacyInputUsage = 'inputUsage' in LanguageModel.prototype;
    out.hasMeasureContextUsage = 'measureContextUsage' in LanguageModel.prototype;
    out.hasClone = 'clone' in LanguageModel.prototype;
    out.hasParams = typeof LanguageModel.params === 'function';
    const t = now();
    try { out.availability = await withTimeout(LanguageModel.availability(LANG), AVAIL_TIMEOUT, 'availability'); } catch (e) { out.availabilityError = String(e); out.availability = 'error'; }
    out.availabilityMs = now() - t;
    if (out.availability === 'error') return out; // don't wait out a second timeout
    const t2 = now();
    try { out.availabilityNoOpts = await withTimeout(LanguageModel.availability(), AVAIL_TIMEOUT, 'availability'); } catch (e) { out.availabilityNoOptsError = String(e); }
    out.availabilityNoOptsMs = now() - t2;
    if (out.hasParams) { try { out.params = await withTimeout(LanguageModel.params(), AVAIL_TIMEOUT, 'params'); } catch (e) { out.paramsError = String(e); } }
    return out;
  }

  function contextName() {
    if (typeof window === 'undefined') return 'service-worker';
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && location.protocol === 'chrome-extension:') return 'extension-page';
    return 'content-script';
  }

  // Needs user activation if availability is "downloadable"/"downloading".
  async function download(onProgress) {
    const events = [];
    const t = now();
    const s = await LanguageModel.create(createOptions({
      system: false,
      monitor(m) { m.addEventListener('downloadprogress', (e) => { events.push([Math.round(now() - t), e.loaded]); onProgress && onProgress(e.loaded); }); },
    }));
    const ms = now() - t;
    s.destroy();
    return { ms, events };
  }

  // ---- shared state (per context) ----
  let base = null; // primed session with the system prompt, used for clone()
  let baseKey = '';

  async function getBase(o) {
    const key = JSON.stringify({ greedy: !!(o && o.greedy) });
    if (base && baseKey === key) return { session: base, createdMs: 0, warm: true };
    if (base) { base.destroy(); base = null; }
    const t = now();
    base = await withTimeout(LanguageModel.create(createOptions(o)), CREATE_TIMEOUT, 'create');
    baseKey = key;
    return { session: base, createdMs: now() - t, warm: false };
  }

  async function createTimings(n, o) {
    const out = { firstCreateMs: null, bareCreateMs: [], systemCreateMs: [], cloneMs: [], baseCreateMs: null };
    let t = now();
    const first = await withTimeout(LanguageModel.create(createOptions(Object.assign({}, o, { system: false }))), CREATE_TIMEOUT, 'create');
    out.firstCreateMs = now() - t;
    out.contextWindow = windowSize(first);
    out.bareUsage = usage(first);
    first.destroy();
    for (let i = 0; i < n; i++) {
      t = now(); const s = await LanguageModel.create(createOptions(Object.assign({}, o, { system: false }))); out.bareCreateMs.push(now() - t); s.destroy();
    }
    for (let i = 0; i < n; i++) {
      t = now(); const s = await LanguageModel.create(createOptions(o)); out.systemCreateMs.push(now() - t);
      if (i === 0) out.systemPromptUsage = usage(s);
      s.destroy();
    }
    const b = await getBase(o);
    out.baseCreateMs = b.createdMs;
    for (let i = 0; i < n; i++) {
      t = now(); const c = await b.session.clone(); out.cloneMs.push(now() - t); c.destroy();
    }
    return out;
  }

  // One decision. strategy: 'fresh' (create w/ system prompt) | 'clone' (clone primed base)
  // constraint: 'none' | 'schema' | 'schema-omit'
  async function decide(banner, o) {
    o = Object.assign({ strategy: 'clone', constraint: 'schema', maxText: 400, greedy: false, measureTokens: true }, o);
    const r = { strategy: o.strategy, constraint: o.constraint };
    const t0 = now();
    let session;
    try {
      if (o.strategy === 'fresh') {
        session = await withTimeout(LanguageModel.create(createOptions(o)), CREATE_TIMEOUT, 'create');
        r.setupMs = now() - t0;
      } else {
        const b = await getBase(o);
        r.baseCreateMs = b.createdMs; r.baseWasWarm = b.warm;
        const t1 = now();
        session = await withTimeout(b.session.clone(), CREATE_TIMEOUT, 'clone');
        r.cloneMs = now() - t1;
        r.setupMs = now() - t0;
      }
      const input = bannerToPrompt(banner, o.maxText);
      r.promptChars = input.length;
      const popts = {};
      if (o.constraint !== 'none') popts.responseConstraint = SCHEMA;
      if (o.constraint === 'schema-omit') popts.omitResponseConstraintInput = true;
      const usageBefore = usage(session);
      if (o.measureTokens) {
        const tm = now();
        r.inputTokens = await withTimeout(measure(session, input, popts), AVAIL_TIMEOUT, 'measureContextUsage').catch((e) => String(e));
        r.measureMs = now() - tm;
      }
      const tp = now();
      const stream = session.promptStreaming(input, popts);
      let acc = '', chunks = 0, cumulative = null;
      await withTimeout((async () => {
        for await (const chunk of stream) {
          if (chunks === 0) r.ttftMs = now() - tp;
          chunks++;
          if (cumulative === null && acc && chunk.startsWith(acc) && chunk.length > acc.length) cumulative = true;
          acc = cumulative ? chunk : acc + chunk;
        }
      })(), PROMPT_TIMEOUT, 'promptStreaming');
      r.promptMs = now() - tp;
      r.chunks = chunks;
      r.chunksLookCumulative = !!cumulative;
      r.output = acc;
      r.usageBefore = usageBefore;
      r.usageAfter = usage(session);
      r.decision = parseDecision(acc);
      r.parseOk = !!r.decision;
    } catch (e) {
      r.error = (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e));
    } finally {
      if (session && session !== base) { try { session.destroy(); } catch {} }
    }
    r.totalMs = now() - t0; // setup + (measure) + prompt
    r.decisionMs = r.totalMs - (r.measureMs || 0); // what the product would pay (no measurement)
    return r;
  }

  function reset() { if (base) { try { base.destroy(); } catch {} } base = null; baseKey = ''; }

  globalThis.CookieEngine = { withTimeout, SYSTEM, SCHEMA, LANG, bannerToPrompt, parseDecision, score, probe, download, createTimings, decide, reset, contextName };
})();

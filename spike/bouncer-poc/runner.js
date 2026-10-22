// runner.js — the only code that touches LanguageModel. Side-effect script: sets globalThis.Runner.
// A Ctx caches one primed base session per prompt key (system prompt + few-shot) and hands
// out clone()s, so initialPrompts are prefilled once; per-decision cost = clone + prompt.
(function () {
  'use strict';
  const LANG = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
  const now = () => performance.now();

  function withTimeout(p, ms, what) {
    let id;
    return Promise.race([p, new Promise((_, rej) => { id = setTimeout(() => rej(new Error(`timeout: ${what} > ${ms} ms`)), ms); })])
      .finally(() => clearTimeout(id));
  }

  // "Greedy": samplingMode is the new API but is gated (AIPromptAPIParams, origin trial/experimental);
  // topK/temperature are deprecated but still honoured in extension contexts (set both or neither).
  function samplingOptions(greedy) {
    if (!greedy) return {};
    if (typeof LanguageModel !== 'undefined' && 'samplingMode' in LanguageModel.prototype) return { samplingMode: 'most-predictable' };
    return { topK: 1, temperature: 0 };
  }

  class Ctx {
    constructor(opts) {
      opts = opts || {};
      this.greedy = !!opts.greedy;
      this.bases = new Map();     // key -> session
      this.baseInfo = {};         // key -> {createMs, contextUsage, sampling}
      this.live = [];
      this.calls = [];
      this.measure = false;
      this.tokens = [];
    }
    async base(key, initialPrompts) {
      if (this.bases.has(key)) return this.bases.get(key);
      if (this.unavailable) throw new Error('model unavailable: ' + this.unavailable); // fail fast, never wait on create()
      if (!this.checkedAvailability) {
        // Checked lazily, only when a pipeline actually needs the model (the no-model fast path never waits).
        const ta = now();
        let a;
        if (typeof LanguageModel === 'undefined') a = 'no LanguageModel';
        else { try { a = await withTimeout(LanguageModel.availability(LANG), 10000, 'availability'); } catch (e) { a = 'error: ' + e.message; } }
        this.availabilityMs = now() - ta;
        this.checkedAvailability = true;
        if (a !== 'available') { this.unavailable = a; throw new Error('model unavailable: ' + a); }
      }
      const t = now();
      const s = await withTimeout(LanguageModel.create(Object.assign({}, LANG, samplingOptions(this.greedy), { initialPrompts })), 60000, 'create');
      this.baseInfo[key] = {
        createMs: now() - t, contextUsage: s.contextUsage != null ? s.contextUsage : s.inputUsage, contextWindow: s.contextWindow,
        requestedSampling: samplingOptions(this.greedy), topK: s.topK, temperature: s.temperature, samplingMode: s.samplingMode,
      };
      this.bases.set(key, s);
      return s;
    }
    async open(key, initialPrompts) {
      const b = await this.base(key, initialPrompts);
      const t = now();
      const s = await withTimeout(b.clone(), 30000, 'clone');
      this.calls.push({ kind: 'clone', key, ms: now() - t });
      this.live.push(s);
      return s;
    }
    async ask(session, input, constraint) {
      const opts = constraint ? { responseConstraint: constraint } : {};
      if (this.measure) {
        const tm = now();
        try { this.tokens.push(await withTimeout(session.measureContextUsage(input, opts), 10000, 'measure')); } catch (e) { this.tokens.push(null); }
        this.measureMs += now() - tm;
      }
      const t = now();
      let ttft = null, text = '';
      await withTimeout((async () => {
        for await (const chunk of session.promptStreaming(input, opts)) { if (ttft == null) ttft = now() - t; text += chunk; } // chunks are deltas (round 1)
      })(), 60000, 'promptStreaming');
      const r = { text, ttftMs: ttft, ms: now() - t, inputChars: input.length };
      this.calls.push(Object.assign({ kind: 'prompt' }, r, { text: undefined }));
      return r;
    }
    begin(measure) { this.calls = []; this.tokens = []; this.measure = !!measure; this.measureMs = 0; this.live = []; this.t0 = now(); }
    end() {
      const wall = now() - this.t0;
      for (const s of this.live) { try { s.destroy(); } catch {} }
      this.live = [];
      const prompts = this.calls.filter((c) => c.kind === 'prompt');
      return {
        ms: wall - this.measureMs, modelCalls: prompts.length,
        firstTtftMs: prompts[0] ? prompts[0].ttftMs : null,
        inputTokens: this.tokens.length ? this.tokens.reduce((a, b) => a + (b || 0), 0) : null,
        calls: this.calls,
      };
    }
    destroyAll() {
      for (const s of this.bases.values()) { try { s.destroy(); } catch {} }
      this.bases.clear();
    }
  }

  async function probe() {
    const out = { hasLanguageModel: typeof LanguageModel !== 'undefined' };
    if (!out.hasLanguageModel) return out;
    const t = now();
    try { out.availability = await withTimeout(LanguageModel.availability(LANG), 10000, 'availability'); }
    catch (e) { out.availability = 'error'; out.availabilityError = String(e.message || e); }
    out.availabilityMs = now() - t;
    out.hasSamplingMode = 'samplingMode' in LanguageModel.prototype;
    out.hasLegacyTopK = 'topK' in LanguageModel.prototype;
    if (typeof LanguageModel.params === 'function') {
      try {
        const p = await withTimeout(LanguageModel.params(), 5000, 'params');
        out.params = p && { defaultTopK: p.defaultTopK, maxTopK: p.maxTopK, defaultTemperature: p.defaultTemperature, maxTemperature: p.maxTemperature };
      } catch (e) { out.paramsError = String(e.message || e); }
    }
    return out;
  }

  // Cold-start probe: availability → create (with a system prompt) → first prompt, then the same warm.
  async function coldProbe(banner) {
    const r = {};
    let t = now();
    try { r.availability = await withTimeout(LanguageModel.availability(LANG), 10000, 'availability'); } catch (e) { r.availability = 'error: ' + e.message; }
    r.availabilityMs = now() - t;
    const once = async () => {
      const o = {};
      let t1 = now();
      const s = await withTimeout(LanguageModel.create(Object.assign({}, LANG, { initialPrompts: [{ role: 'system', content: 'Is this a cookie consent dialog? Answer yes or no.' }] })), 120000, 'create');
      o.createMs = now() - t1;
      t1 = now();
      let ttft = null, text = '';
      for await (const ch of s.promptStreaming(globalThis.Variants.fmtInput(banner, 300, 'full'), { responseConstraint: { type: 'string', enum: ['yes', 'no'] } })) { if (ttft == null) ttft = now() - t1; text += ch; }
      o.ttftMs = ttft; o.promptMs = now() - t1; o.output = text;
      s.destroy();
      return o;
    };
    r.cold = await once();
    r.warm = await once();
    r.coldTotalMs = r.availabilityMs + r.cold.createMs + r.cold.promptMs;
    return r;
  }

  globalThis.Runner = { LANG, Ctx, probe, coldProbe, withTimeout, samplingOptions };
})();

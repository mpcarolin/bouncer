// background.js — MV3 module service worker. Live mode: runs a hybrid pipeline on banners the
// content script finds (measurement only; nothing is clicked). Also serves the bench's cold-start probe.
import * as ACHeur from './node_modules/@duckduckgo/autoconsent/dist/heuristics.mjs';
import './runner.js';
import './variants.js';
globalThis.ACHeur = ACHeur;
const V = globalThis.Variants, R = globalThis.Runner;

const SW_STARTED = Date.now();
let decisions = 0;
let ctx = null;          // sessions live only as long as this service worker does
let availability = null;

const DEFAULTS = { liveEnabled: true, liveVariant: 'h-safe' };
chrome.runtime.onInstalled.addListener(async () => { await chrome.storage.local.set(await chrome.storage.local.get(DEFAULTS)); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e), swAgeMs: Date.now() - SW_STARTED }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'decide': {
      const t = performance.now();
      const r = { swAgeMs: Date.now() - SW_STARTED, firstDecisionInThisSw: decisions === 0, sessionsWarm: !!(ctx && ctx.bases.size) };
      decisions++;
      if (!availability) {
        const ta = performance.now();
        if (typeof LanguageModel === 'undefined') availability = 'no LanguageModel';
        else { try { availability = await R.withTimeout(LanguageModel.availability(R.LANG), 10000, 'availability'); } catch (e) { availability = 'error: ' + e.message; } }
        r.availabilityMs = performance.now() - ta;
      }
      const variant = V.ALL.find((v) => v.id === msg.variant) || V.ALL.find((v) => v.id === 'h-safe');
      r.variant = variant.id;
      if (variant.kind !== 'mechanical' && availability !== 'available') {
        r.error = 'model not available: ' + availability; availability = null;
      } else {
        ctx = ctx || new R.Ctx({});
        const basesBefore = new Set(ctx.bases.keys());
        ctx.begin(false);
        try {
          const out = await variant.run(ctx, msg.fx.banner, msg.fx);
          Object.assign(r, { decision: out.decision, output: V.fmtDecision(out.decision), gate: out.gate, steps: out.steps, raw: out.raw });
        } catch (e) { r.error = String(e && e.message || e); }
        const m = ctx.end();
        r.modelCalls = m.modelCalls; r.calls = m.calls; r.pipelineMs = m.ms;
        r.basesCreatedNow = Object.fromEntries([...ctx.bases.keys()].filter((k) => !basesBefore.has(k)).map((k) => [k, ctx.baseInfo[k].createMs]));
      }
      r.swWorkMs = performance.now() - t;
      return r;
    }
    case 'live-result': {
      const res = msg.result;
      res.tabId = sender.tab && sender.tab.id;
      const { liveResults = [] } = await chrome.storage.local.get('liveResults');
      liveResults.unshift(res);
      await chrome.storage.local.set({ liveResults: liveResults.slice(0, 50) });
      if (res.tabId != null && res.isTop !== false && res.found) {
        const ms = res.t && res.t.aiAddedAfterBannerFoundMs;
        chrome.action.setBadgeText({ tabId: res.tabId, text: res.error ? 'err' : ms != null ? String(Math.round(ms)) : '?' });
      }
      return { ok: true };
    }
    case 'reset': {
      const had = ctx ? ctx.bases.size : 0;
      if (ctx) ctx.destroyAll();
      ctx = null; availability = null;
      return { ok: true, destroyedBases: had, swAgeMs: Date.now() - SW_STARTED };
    }
    case 'cold-probe': {
      const swAgeMs = Date.now() - SW_STARTED; // small = this worker was just (re)started
      const r = await R.coldProbe(msg.banner);
      return Object.assign(r, { swAgeMs, swRestarted: swAgeMs < 5000 });
    }
    default: return { error: 'unknown message ' + msg.type };
  }
}

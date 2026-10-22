// background.js — MV3 service worker. Runs the model for live mode (and for the
// bench when "run in: service worker" is chosen). Classic worker, not a module.
importScripts('engine.js');

const SW_STARTED = Date.now();
let decisionsSinceStart = 0;
let swAvailability = null;

const DEFAULTS = { liveEnabled: true, liveEngine: 'sw', constraint: 'schema', maxText: 400, greedy: false };

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set(cur);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
  return true; // async response
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'decide': { // from content script (live mode)
      const t = performance.now();
      const swAgeMs = Date.now() - SW_STARTED;
      const firstDecisionInThisSw = decisionsSinceStart === 0;
      decisionsSinceStart++;
      // Check availability once per SW lifetime (cheap when the model is present; avoids
      // waiting out a create() timeout when it is not).
      let availMs;
      if (!swAvailability) {
        const ta = performance.now();
        if (typeof LanguageModel === 'undefined') swAvailability = 'no LanguageModel in service worker';
        else {
          try { swAvailability = await CookieEngine.withTimeout(LanguageModel.availability(CookieEngine.LANG), 10000, 'availability'); }
          catch (e) { swAvailability = 'error: ' + e.message; }
        }
        availMs = performance.now() - ta;
      }
      if (swAvailability !== 'available') {
        const a = swAvailability; swAvailability = null; // re-check next time
        return { error: 'model not available in SW: ' + a, availabilityMs: availMs, swAgeMs, swWorkMs: performance.now() - t };
      }
      const r = await CookieEngine.decide(msg.banner, Object.assign({ strategy: 'clone', measureTokens: false }, msg.opts));
      r.availabilityMs = availMs;
      r.swWorkMs = performance.now() - t;
      r.swAgeMs = swAgeMs;
      r.firstDecisionInThisSw = firstDecisionInThisSw;
      return r;
    }
    case 'live-result': {
      const r = msg.result;
      r.tabId = sender.tab && sender.tab.id;
      const { liveResults = [] } = await chrome.storage.local.get('liveResults');
      liveResults.unshift(r);
      await chrome.storage.local.set({ liveResults: liveResults.slice(0, 50) });
      if (r.tabId != null && r.isTop !== false) {
        const ms = r.t && r.t.decisionAt != null && r.t.bannerFoundAt != null ? Math.round(r.t.decisionAt - r.t.bannerFoundAt) : null;
        chrome.action.setBadgeText({ tabId: r.tabId, text: r.error ? 'err' : ms != null ? String(ms) : '?' });
        chrome.action.setBadgeBackgroundColor({ tabId: r.tabId, color: r.error ? '#b00' : '#333' });
      }
      return { ok: true };
    }
    // ---- bench-in-service-worker commands ----
    case 'bench-probe': return Object.assign(await CookieEngine.probe(), { swAgeMs: Date.now() - SW_STARTED });
    case 'bench-createTimings': return CookieEngine.createTimings(msg.n, msg.opts);
    case 'bench-decide': return CookieEngine.decide(msg.banner, msg.opts);
    case 'bench-reset': CookieEngine.reset(); return { ok: true };
    default: return { error: 'unknown message ' + msg.type };
  }
}

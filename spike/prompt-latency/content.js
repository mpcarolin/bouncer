// content.js — live mode. MEASUREMENT ONLY: never clicks, hides, or modifies the page.
// Times: detection, serialisation, message round-trip, model decision, end-to-end.
// All t.* values are performance.now() = ms since this document's navigation start.
(function () {
  'use strict';
  const T = { csStartAt: performance.now() };
  const SCAN_WINDOW_MS = 20000; // stop looking 20s after DOMContentLoaded
  const isTop = window === window.top;
  let done = false, scans = 0, scanCostMs = 0, observer = null, pending = null;

  chrome.storage.local.get({ liveEnabled: true, liveEngine: 'sw', constraint: 'schema', maxText: 400, greedy: false }).then((cfg) => {
    if (!cfg.liveEnabled) return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(cfg), { once: true });
    else start(cfg);
  });

  function start(cfg) {
    T.dclAt = performance.now();
    scan(cfg);
    if (done) return;
    observer = new MutationObserver(() => {
      if (pending || done) return;
      pending = setTimeout(() => { pending = null; scan(cfg); }, 50); // throttle
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    setTimeout(() => { if (!done) { stop(); if (isTop) report({ found: false }); } }, SCAN_WINDOW_MS);
  }

  function stop() { done = true; if (observer) observer.disconnect(); if (pending) clearTimeout(pending); }

  async function scan(cfg) {
    if (done) return;
    const t = performance.now();
    let found = null;
    try { found = CookieDetect.findBanner(document); } catch (e) { /* ignore */ }
    const cost = performance.now() - t;
    scans++; scanCostMs += cost;
    if (!found) return;
    stop();
    T.bannerFoundAt = performance.now();
    T.detectLastScanMs = cost;
    const ts = performance.now();
    const banner = CookieDetect.serializeBanner(found);
    T.serializeMs = performance.now() - ts;

    const result = { found: true, banner, cfg };
    result.csHasLanguageModel = typeof LanguageModel !== 'undefined';
    const opts = { constraint: cfg.constraint, maxText: cfg.maxText, greedy: cfg.greedy };
    try {
      if (cfg.liveEngine === 'content') {
        // Runs the model in this content script (page's renderer). Fresh session per page.
        T.sendAt = performance.now();
        result.model = await CookieEngine.decide(banner, Object.assign({ strategy: 'fresh', measureTokens: false }, opts));
        T.decisionAt = performance.now();
      } else {
        T.sendAt = performance.now();
        result.model = await chrome.runtime.sendMessage({ type: 'decide', banner, opts });
        T.decisionAt = performance.now();
        T.roundTripMs = T.decisionAt - T.sendAt;
        if (result.model && result.model.swWorkMs != null) T.messageOverheadMs = T.roundTripMs - result.model.swWorkMs;
      }
      if (result.model && result.model.error) result.error = result.model.error;
    } catch (e) {
      result.error = String(e && e.message || e);
      T.decisionAt = performance.now();
    }
    // After timing is done: can this content script itself see a usable model? (product design input)
    if (result.csHasLanguageModel && isTop) {
      try { result.csAvailability = await CookieEngine.withTimeout(LanguageModel.availability(CookieEngine.LANG), 5000, 'availability'); }
      catch (e) { result.csAvailability = 'error: ' + e.message; }
    }
    const d = result.model && result.model.decision;
    if (d && banner.controls[d.index]) result.chosenLabel = banner.controls[d.index].label;
    report(result);
  }

  function report(result) {
    const nav = performance.getEntriesByType('navigation')[0];
    T.domContentLoadedEventStart = nav ? nav.domContentLoadedEventStart : null;
    T.loadEventEnd = nav ? nav.loadEventEnd : null;
    T.scans = scans;
    T.scanCostTotalMs = scanCostMs;
    if (T.decisionAt != null) {
      T.endToEndFromNavStartMs = T.decisionAt;
      T.endToEndFromDocStartMs = T.decisionAt - T.csStartAt;
      T.endToEndFromDclMs = T.decisionAt - T.dclAt;
      T.aiAddedAfterBannerFoundMs = T.decisionAt - T.bannerFoundAt; // vs. a human who starts reading when it appears
    }
    Object.assign(result, { url: location.href, isTop, at: new Date().toISOString(), t: T });
    if (!result.found && !isTop) return; // don't log every iframe without a banner
    chrome.runtime.sendMessage({ type: 'live-result', result }).catch(() => {});
    console.debug('[cookie-latency-spike]', result);
  }
})();

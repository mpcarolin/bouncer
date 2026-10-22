// content.js — live mode. MEASUREMENT ONLY: never clicks, hides, or modifies the page.
// Finds a likely banner, serialises it, asks the service worker to run a pipeline, and records
// timings. All t.* values are performance.now() = ms since this document's navigation start.
(function () {
  'use strict';
  const T = { csStartAt: performance.now() };
  const SCAN_WINDOW_MS = 20000;
  const isTop = window === window.top;
  let done = false, scans = 0, scanCostMs = 0, observer = null, pending = null;

  chrome.storage.local.get({ liveEnabled: true, liveVariant: 'h-safe' }).then((cfg) => {
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
      pending = setTimeout(() => { pending = null; scan(cfg); }, 50);
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
    scans++; scanCostMs += performance.now() - t;
    if (!found) return;
    stop();
    T.bannerFoundAt = performance.now();
    const ts = performance.now();
    const banner = CookieDetect.serializeBanner(found);
    const fullText = CookieDetect.clean(CookieDetect.textOf(found.el), 4000);
    T.serializeMs = performance.now() - ts;
    const result = { found: true, banner, variant: cfg.liveVariant };
    try {
      T.sendAt = performance.now();
      result.model = await chrome.runtime.sendMessage({ type: 'decide', variant: cfg.liveVariant, fx: { banner, fullText } });
      T.decisionAt = performance.now();
      T.roundTripMs = T.decisionAt - T.sendAt;
      if (result.model && result.model.swWorkMs != null) T.messageOverheadMs = T.roundTripMs - result.model.swWorkMs;
      if (result.model && result.model.error) result.error = result.model.error;
    } catch (e) {
      result.error = String(e && e.message || e);
      T.decisionAt = performance.now();
    }
    const d = result.model && result.model.decision;
    if (d && banner.controls[d.index]) result.chosenLabel = banner.controls[d.index].label;
    report(result);
  }

  function report(result) {
    const nav = performance.getEntriesByType('navigation')[0];
    T.loadEventEnd = nav ? nav.loadEventEnd : null;
    T.scans = scans;
    T.scanCostTotalMs = scanCostMs;
    if (T.decisionAt != null) {
      T.endToEndFromNavStartMs = T.decisionAt;
      T.aiAddedAfterBannerFoundMs = T.decisionAt - T.bannerFoundAt;
    }
    Object.assign(result, { url: location.href, isTop, at: new Date().toISOString(), t: T });
    if (!result.found && !isTop) return;
    chrome.runtime.sendMessage({ type: 'live-result', result }).catch(() => {});
  }
})();

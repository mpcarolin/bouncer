// bouncer.js — top-frame content script: handles banners autoconsent's rules don't know.
// Order of safety: autoconsent gets first claim; nothing is hidden or clicked until the pipeline
// (fast heuristic path, or the AI gate saying "consent") has decided; on no_option / unsure /
// any failure the banner is left (or put back) exactly as it was.
// Never scrolls, focuses, or captures events: it only calls .click() on the chosen controls.
// All t.* values are ms since navigation start (performance.now()).
(function () {
  'use strict';
  if (window !== window.top) return;
  const T = { csStartAt: Math.round(performance.now()) };
  const SCAN_WINDOW_MS = 20000;
  let done = false, observer = null, pending = null;
  const hidden = []; // [{el, opacity, pe}]

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Math.round(performance.now());

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'bouncer-ac-done') {
      // autoconsent finished an opt-out; give its own cleanup a moment, then unlock scroll if still locked
      setTimeout(() => { const u = unlockScroll(); if (u) send({ type: 'bouncer-ac-scroll', unlocked: u }).catch(() => {}); }, 600);
    }
  });

  send({ type: 'bouncer-hello', timeOrigin: performance.timeOrigin, url: location.href }).then((r) => {
    if (!r || !r.enabled) return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }).catch(() => {});

  function start() {
    T.dclAt = now();
    scan();
    if (done) return;
    observer = new MutationObserver(() => {
      if (pending || done) return;
      pending = setTimeout(() => { pending = null; scan(); }, 50);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    setTimeout(stop, SCAN_WINDOW_MS);
  }
  function stop() { done = true; if (observer) observer.disconnect(); if (pending) clearTimeout(pending); }

  function scan() {
    if (done) return;
    let found = null;
    try { found = CookieDetect.findBanner(document); } catch (e) { /* ignore */ }
    if (!found) return;
    stop();
    handle(found).catch((e) => finish({ outcome: 'failed', detail: 'exception: ' + (e && e.message || e) }));
  }

  // ---------------------------------------------------------------- page helpers
  function hide(el) {
    if (!el || el.hasAttribute('data-bouncer-hidden')) return;
    hidden.push({ el, opacity: el.style.getPropertyValue('opacity'), opPrio: el.style.getPropertyPriority('opacity'), pe: el.style.getPropertyValue('pointer-events'), pePrio: el.style.getPropertyPriority('pointer-events') });
    el.setAttribute('data-bouncer-hidden', '1');
    el.style.setProperty('opacity', '0', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  }
  function unhideAll() {
    for (const h of hidden.splice(0)) {
      h.el.removeAttribute('data-bouncer-hidden');
      h.el.style.setProperty('opacity', h.opacity, h.opPrio);
      h.el.style.setProperty('pointer-events', h.pe, h.pePrio);
    }
  }
  const isGone = (el) => !el.isConnected || !CookieDetect.isVisible(el);
  async function waitGone(el, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (isGone(el)) return true; await sleep(100); } return isGone(el); }

  function stateOf(el) {
    if (el.matches('input')) return el.checked;
    const a = el.getAttribute('aria-checked') || el.getAttribute('aria-pressed');
    return a === 'true' ? true : a === 'false' ? false : undefined;
  }
  function isScrollLocked() {
    const h = getComputedStyle(document.documentElement), b = document.body ? getComputedStyle(document.body) : null;
    return [h, b].some((cs) => cs && (cs.overflowY === 'hidden' || cs.overflow === 'hidden'));
  }
  function unlockScroll() {
    const out = [];
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowY === 'hidden' || cs.overflow === 'hidden') { el.style.setProperty('overflow', 'auto', 'important'); out.push(el.tagName.toLowerCase()); }
    }
    return out.length ? out : null;
  }

  // ---------------------------------------------------------------- main flow
  const entry = { path: null, t: T, clicked: [], toggled: [], modelCalls: 0 };

  async function handle(found) {
    T.bannerFoundAt = now();
    const lockedAtFound = isScrollLocked();
    let { banner, els } = CookieDetect.serializeWithElements(found);
    const fx = { banner, fullText: CookieDetect.clean(CookieDetect.textOf(found.el), 4000) };
    entry.vendorHint = found.vendor; entry.selector = found.selector;

    // 1+2. Decide (heuristics → AI gate → AI labels → chooser, in the service worker) while giving
    // autoconsent's rules first claim: it re-detects every ≥500 ms, so wait until it has started two
    // more detection passes since the banner appeared (or claims it / gives up / 1.5 s passes).
    const st0 = await send({ type: 'bouncer-status' }).catch(() => ({ topAttempts: 0 }));
    T.decideStartAt = now();
    const decideP = send({ type: 'bouncer-decide', fx });
    const st = await waitForAutoconsent((st0.topAttempts || 0) + 2);
    const r1 = await decideP;
    T.decisionAt = now();
    if (st.claimed) return finish({ path: 'deferred', outcome: 'deferred', detail: `autoconsent has ${st.cmp || 'a CMP'}` }, true);
    absorb(r1, 'stage1');
    entry.path = r1 && r1.steps && r1.steps.includes('fast-path') ? 'heuristic' : 'ai';
    entry.gate = r1 && r1.gate;
    entry.decision = r1 && r1.output;
    if (!r1 || r1.error) return finish({ outcome: 'left-alone', detail: 'pipeline error: ' + (r1 && r1.error) });
    const d = r1.decision;
    if (!d || ['not_consent', 'no_option', 'unsure'].includes(d.action)) return finish({ outcome: 'left-alone', detail: d ? d.action : 'unparseable' });

    // 3. last checks before touching anything
    const st2 = await send({ type: 'bouncer-status' });
    if (st2 && st2.claimed) return finish({ path: 'deferred', outcome: 'deferred', detail: `autoconsent claimed it during the decision (${st2.cmp})` }, true);
    if (isGone(found.el)) return finish({ outcome: 'left-alone', detail: 'banner disappeared by itself before we acted' });

    // 4. act
    hide(found.el);
    let target = found.el, ok;
    if (d.action === 'reject') ok = click(els, d.index, banner);
    else if (d.action === 'save') ok = (await setToggles(els, banner, d)) && click(els, d.index, banner);
    else if (d.action === 'settings') {
      if (!click(els, d.index, banner)) return fail('settings control missing');
      const panel = await waitForPanel(found.el, 4000);
      if (!panel) return fail('no preference panel appeared after clicking settings');
      hide(panel.el);
      target = panel.el;
      const s2 = CookieDetect.serializeWithElements(panel);
      entry.stage2 = { selector: panel.selector, controls: s2.banner.controls.length, foundAt: now() };
      const r2 = await send({ type: 'bouncer-decide', fx: { banner: s2.banner, fullText: CookieDetect.clean(CookieDetect.textOf(panel.el), 4000), stage2: true } });
      absorb(r2, 'stage2');
      entry.stage2.decision = r2 && r2.output;
      entry.stage2.decisionAt = now();
      if (!r2 || r2.error || !r2.decision) return fail('stage-2 pipeline: ' + (r2 && r2.error || 'no decision'));
      const d2 = r2.decision;
      if (d2.action === 'reject') ok = click(s2.els, d2.index, s2.banner);
      else if (d2.action === 'save') ok = (await setToggles(s2.els, s2.banner, d2)) && click(s2.els, d2.index, s2.banner);
      else return fail(`stage-2 decision ${r2.output} — not acting`);
    }
    if (!ok) return fail('could not click the chosen control');
    const gone = await waitGone(target, 3000); // for the settings flow: the panel going away is success
    if (!gone) return fail('clicked, but the banner did not go away within 3 s');
    T.goneAt = now();
    if (lockedAtFound) { await sleep(300); const u = unlockScroll(); if (u) entry.scrollUnlocked = u; }
    return finish({ outcome: 'dismissed' });
  }

  function absorb(r, key) {
    if (!r) return;
    entry.modelCalls += r.modelCalls || 0;
    if (r.MOCK_MODEL) entry.MOCK_MODEL = true;
    entry.coldStart = entry.coldStart || !!r.coldStart;
    entry[key] = Object.assign(entry[key] || {}, { steps: r.steps, gate: r.gate, output: r.output, calls: r.calls, basesCreated: r.basesCreated, sessionsWarmBefore: r.sessionsWarmBefore, coldStart: r.coldStart, availabilityMs: r.availabilityMs, workMs: r.workMs, swAgeMs: r.swAgeMs, error: r.error });
  }

  function click(els, index, banner) {
    const el = els[index];
    if (!el) return false;
    entry.clicked.push(banner.controls[index] ? banner.controls[index].label : `#${index}`);
    el.click(); // synthesized click on the target only; no focus, no scrolling
    return true;
  }

  async function setToggles(els, banner, d) {
    const want = [].concat((d.off || []).map((i) => [i, false]), (d.on || []).map((i) => [i, true]));
    for (const [i, on] of want) {
      const el = els[i], c = banner.controls[i];
      if (!el || !c || c.role !== 'toggle' || c.disabled) continue;
      if (stateOf(el) === on) continue;
      el.click();
      await sleep(30);
      entry.toggled.push(`${c.label} → ${on ? 'on' : 'off'}${stateOf(el) === on ? '' : ' (state did not change!)'}`);
    }
    return true;
  }

  async function waitForPanel(prev, ms) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      await sleep(150);
      const p = CookieDetect.findPanel(prev);
      if (p) return p;
    }
    return null;
  }

  async function waitForAutoconsent(targetAttempts) {
    const t = Date.now();
    let st = { claimed: false };
    while (Date.now() - t < 1500) {
      st = await send({ type: 'bouncer-status' }).catch(() => ({ claimed: false }));
      if (st.claimed || st.topAttempts >= targetAttempts || ['nothingDetected', 'done'].includes(st.topLifecycle)) break;
      await sleep(100);
    }
    T.autoconsentWaitMs = Date.now() - t;
    return st;
  }

  function fail(detail) { unhideAll(); return finish({ outcome: 'failed', detail }); }

  let finished = false;
  function finish(patch, quiet) {
    if (finished) return;
    finished = true;
    if (patch.outcome !== 'dismissed') unhideAll();
    Object.assign(entry, patch);
    if (!entry.path) entry.path = 'none';
    entry.quiet = !!quiet;
    send({ type: 'bouncer-log', entry }).catch(() => {});
  }
})();

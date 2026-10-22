// detect.js — find a likely cookie-consent banner and serialise it compactly.
// Classic script (no modules) so it can be used as a content script, from
// bench.html, and injected via agent-browser `eval` to capture fixtures.
// Read-only: never clicks, hides, or modifies the page.
(function () {
  'use strict';

  // Known vendor containers, checked first (cheap querySelector).
  const VENDORS = [
    ['onetrust', '#onetrust-banner-sdk'],
    ['onetrust-pc', '#onetrust-pc-sdk'],
    ['cookiebot', '#CybotCookiebotDialog'],
    ['cookieinformation', '#coiOverlay'],
    ['hubspot', '#hs-eu-cookie-confirmation'],
    ['trustarc', '#truste-consent-track'],
    ['trustarc', '.truste_box_overlay'],
    ['usercentrics', '#usercentrics-root'],
    ['usercentrics', '#usercentrics-cmp-ui'],
    ['didomi', '#didomi-notice'],
    ['quantcast', '.qc-cmp2-container'],
    ['osano', '.osano-cm-window'],
    ['cookieyes', '.cky-consent-container'],
    ['complianz', '#cmplz-cookiebanner-container'],
    ['iubenda', '#iubenda-cs-banner'],
    ['termly', '[data-tid="banner-wrapper"]'],
    ['ketch', '#lanyard_root'],
    ['transcend', '#transcend-consent-manager'],
  ];

  const KEYWORDS = /cookie|consent|privacy|gdpr|tracking|personal data|datenschutz/i;
  const CONTROL_SEL = [
    'button', 'a[href]', '[role="button"]', '[role="link"]', '[role="switch"]',
    '[role="checkbox"]', 'input[type="checkbox"]', 'input[type="radio"]',
    'input[type="button"]', 'input[type="submit"]', 'select',
  ].join(',');
  const GENERIC_SEL = [
    '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
    '[id*="gdpr" i]', '[class*="gdpr" i]', '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
    '[aria-label*="privacy" i]', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
  ].join(',');

  const MAX_TEXT = 700;
  const MAX_CONTROLS = 30;
  const MAX_LABEL = 60;

  function isVisible(el) {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  // Elements whose own box is hidden but which are still the real control
  // (custom toggle switches hide the <input> and style a sibling/label).
  function isVisibleControl(el) {
    if (isVisible(el)) return true;
    const isToggle = el.matches('input[type="checkbox"],input[type="radio"],[role="switch"],[role="checkbox"]');
    if (!isToggle) return false;
    if (el.labels && [...el.labels].some(isVisible)) return true;
    return isVisible(el.parentElement);
  }

  function isOverlayish(el) {
    for (let n = el, d = 0; n && n !== document.documentElement && d < 8; n = n.parentElement, d++) {
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed' || cs.position === 'sticky') return n;
      const z = parseInt(cs.zIndex, 10);
      if (z >= 1000) return n;
    }
    return null;
  }

  function clean(s, max) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria, MAX_LABEL);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const root = el.getRootNode();
      const t = by.split(/\s+/).map((id) => {
        const n = root.getElementById ? root.getElementById(id) : document.getElementById(id);
        return n ? n.textContent : '';
      }).join(' ');
      if (t.trim()) return clean(t, MAX_LABEL);
    }
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map((l) => l.innerText || l.textContent).join(' ');
      if (t.trim()) return clean(t, MAX_LABEL);
    }
    const inner = el.innerText || el.textContent;
    if (inner && inner.trim()) return clean(inner, MAX_LABEL);
    if (el.value && typeof el.value === 'string') return clean(el.value, MAX_LABEL);
    const title = el.getAttribute('title');
    if (title) return clean(title, MAX_LABEL);
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img) return clean(img.alt, MAX_LABEL);
    return '';
  }

  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r === 'switch' || r === 'checkbox') return 'toggle';
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return 'toggle';
      return 'button';
    }
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'select';
    return 'button';
  }

  function toggleState(el) {
    if (typeof el.checked === 'boolean' && el.matches('input')) return el.checked;
    const a = el.getAttribute('aria-checked') || el.getAttribute('aria-pressed');
    if (a === 'true') return true;
    if (a === 'false') return false;
    return undefined;
  }

  // Collect controls, including those inside open shadow roots.
  function collectControls(root) {
    const out = [];
    const walk = (r) => {
      for (const el of r.querySelectorAll(CONTROL_SEL)) out.push(el);
      for (const el of r.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(root.shadowRoot || root);
    // De-dupe nested matches (e.g. <a role=button> inside <button>): keep outermost.
    return out.filter((el) => !out.some((o) => o !== el && o.contains(el) && o.matches('button,a[href],[role="button"]')));
  }

  // Round 2: skip <select>/<option> text (an age gate's 200-country list drowned the real text).
  function textOf(root) {
    const r = root.shadowRoot || root;
    const hasSelect = r.querySelector && r.querySelector('select');
    if (!hasSelect && r.innerText !== undefined) return r.innerText;
    if (!hasSelect) return [...r.children].map((c) => c.innerText || '').join('\n');
    const parts = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.matches('select,option,script,style,noscript,template')) continue;
        if (c.children.length === 0) { const t = c.innerText !== undefined ? c.innerText : c.textContent; if (t && t.trim()) parts.push(t); }
        else walk(c);
      }
    };
    walk(r);
    return parts.join(' ');
  }

  function hasVisibleControls(el) {
    return collectControls(el).some(isVisibleControl);
  }

  // Returns {el, vendor, selector} or null.
  function findBanner(doc) {
    doc = doc || document;
    for (const [vendor, sel] of VENDORS) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      if (el.shadowRoot ? hasVisibleControls(el) : (isVisible(el) && hasVisibleControls(el))) {
        return { el, vendor, selector: sel };
      }
    }
    // Generic fallback.
    let best = null;
    let bestScore = 0;
    const seen = new Set();
    for (const cand of doc.querySelectorAll(GENERIC_SEL)) {
      const container = isOverlayish(cand) || cand;
      if (seen.has(container)) continue;
      seen.add(container);
      if (!isVisible(container)) continue;
      const text = textOf(container) || '';
      if (text.length < 60 || text.length > 6000) continue;
      if (!KEYWORDS.test(text)) continue;
      const controls = collectControls(container).filter(isVisibleControl);
      if (controls.length === 0 || controls.length > 80) continue;
      if (!controls.some((c) => roleOf(c) === 'button')) continue; // links-only = not a banner
      let score = 1;
      if (/cookie/i.test(text)) score += 3;
      if (/consent|accept|reject|decline|agree/i.test(text)) score += 2;
      if (isOverlayish(container)) score += 2;
      score -= text.length / 6000; // prefer compact containers
      if (score > bestScore) { bestScore = score; best = container; }
    }
    if (best) return { el: best, vendor: 'generic', selector: describe(best) };
    return null;
  }

  function describe(el) {
    if (el.id) return '#' + el.id;
    const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + cls;
  }

  // Serialised shape (also the fixture shape):
  // { url, vendor, selector, text, controls: [{i, role, label, on?, id?}] }
  function serializeBanner(found, extra) {
    const el = found.el;
    const controls = collectControls(el).filter(isVisibleControl).slice(0, MAX_CONTROLS);
    return Object.assign({
      url: location.href,
      vendor: found.vendor,
      selector: found.selector,
      text: clean(textOf(el), MAX_TEXT),
      controls: controls.map((c, i) => {
        const o = { i, role: roleOf(c), label: labelOf(c) };
        if (o.role === 'toggle') {
          const s = toggleState(c);
          if (s !== undefined) o.on = s;
          if (c.disabled || c.getAttribute('aria-disabled') === 'true') o.disabled = true;
        }
        if (c.id) o.id = c.id;
        return o;
      }),
    }, extra || {});
  }

  // Capture helper for NEGATIVE fixtures: every visible overlay-ish element with at least one
  // visible control, no keyword requirement. Returns [{el, selector, textLen, overlay, keyword}].
  function findOverlays(doc) {
    doc = doc || document;
    const out = [];
    const seen = new Set();
    for (const el of doc.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const fixed = cs.position === 'fixed' || cs.position === 'sticky';
      const z = parseInt(cs.zIndex, 10);
      const isDialog = el.matches('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],iframe');
      if (!fixed && !(z >= 1000) && !isDialog) continue;
      if (seen.has(el) || [...seen].some((s) => s.contains(el))) continue;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) continue;
      if (el.tagName === 'IFRAME') { seen.add(el); out.push({ el, selector: describe(el), iframe: true, src: el.src, w: r.width, h: r.height }); continue; }
      const controls = collectControls(el).filter(isVisibleControl);
      if (!controls.length) continue;
      seen.add(el);
      const text = textOf(el) || '';
      out.push({ el, selector: describe(el), textLen: text.length, controls: controls.length, w: Math.round(r.width), h: Math.round(r.height), keyword: KEYWORDS.test(text), head: clean(text, 80) });
    }
    return out;
  }

  globalThis.CookieDetect = { findBanner, findOverlays, serializeBanner, isVisible, VENDORS, describe, textOf, clean };
})();

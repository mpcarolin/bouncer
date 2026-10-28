// Did the site itself dismiss the banner, and does it stay dismissed? Bouncer's own hiding
// (clip-path, pointer-events) is deliberately not one of the tests here.
import { VERIFY_GONE_MS, VERIFY_STAY_MS } from "../config.ts";
import type { ClickResult, NavigationWatch } from "./click.ts";
import { deepAll, parentOf } from "./dom.ts";

const POLL_MS = 100;
const MIN_GAP_MS = 50;
const AUTOCONSENT_STYLES = "style#autoconsent-prehide, style#autoconsent-css-rules";

/** Detached, display:none, visibility:hidden, opacity 0, zero size, or fixed and off-screen. */
export function isGoneBySite(el: Element): boolean {
  if (!el.isConnected) return true;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden") return true;
  for (let n: Element | null = el; n; n = parentOf(n)) {
    const s = n === el ? cs : getComputedStyle(n);
    if (s.display === "none" || Number(s.opacity) === 0) return true;
  }
  // display:contents has no box of its own, so a zero size says nothing about it.
  if (cs.display !== "contents") {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return true;
  }
  if (cs.position === "fixed") {
    const r = el.getBoundingClientRect();
    const win = el.ownerDocument.defaultView ?? window;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= win.innerWidth || r.top >= win.innerHeight) {
      return true;
    }
  }
  return false;
}

function ruleMatches(rules: CSSRuleList, el: Element): boolean {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      try {
        if (el.matches(rule.selectorText)) return true;
      } catch {
        // an invalid selector matches nothing
      }
    }
    const nested = (rule as CSSGroupingRule).cssRules;
    if (nested && ruleMatches(nested, el)) return true;
  }
  return false;
}

/**
 * True when autoconsent's styles hide some of `el`: they match it, an element it sits in (shadow
 * hosts included), or one inside it. Its prehide does this, until it has looked for a CMP, to any
 * banner its generic rules name: hiding that is autoconsent's, not the site's (§2g).
 */
export function autoconsentHides(el: Element): boolean {
  for (let n: Element | null = el; n; n = parentOf(n)) if (autoconsentStyleTouches(n)) return true;
  return deepAll(el, "*").some(autoconsentStyleTouches);
}

/** True when autoconsent's prehide or CSS-rules style, in the element's own root or the document, matches it. */
export function autoconsentStyleTouches(el: Element): boolean {
  const own = el.getRootNode();
  const roots: ParentNode[] = [el.ownerDocument];
  if (own instanceof ShadowRoot) roots.push(own);
  for (const root of roots) {
    for (const style of root.querySelectorAll<HTMLStyleElement>(AUTOCONSENT_STYLES)) {
      let rules: CSSRuleList | undefined;
      try {
        rules = style.sheet?.cssRules;
      } catch {
        continue;
      }
      if (rules && ruleMatches(rules, el)) return true;
    }
  }
  return false;
}

export interface VerifyOptions {
  goneMs?: number;
  stayMs?: number;
  nav: NavigationWatch;
  /**
   * True when the site has put the banner back as a new element. Checked every tick, where a
   * recent answer may stand (`fresh` false), and once more, `fresh`, before a pass.
   */
  reappeared?: (fresh: boolean) => boolean;
  /**
   * §2g's GOV.UK-style confirmation, asked on every check while phase one waits: "clicked" when it
   * clicked the control that closes the confirmation the banner now shows (phase one then runs
   * from that click), a result to end verification with, or null.
   */
  confirmation?: () => "clicked" | VerifyResult | null;
}

export interface VerifyResult {
  ok: boolean;
  /** `confirmation`: the banner confirmed the refusal, and was left to show it. */
  reason?:
    | "not_gone"
    | "came_back"
    | "navigation"
    | "autoconsent_style"
    | "confirmation"
    | NonNullable<ClickResult["reason"]>;
}

/**
 * Phase one: every element gone within `goneMs`, else `not_gone`. Phase two: all stay gone
 * for `stayMs`, else `came_back`. Navigation or a matching autoconsent style at any point
 * ends it. Re-checks every 100 ms and on any DOM mutation.
 */
export async function verifyDismissed(els: Element[], o: VerifyOptions): Promise<VerifyResult> {
  const goneMs = o.goneMs ?? VERIFY_GONE_MS;
  const stayMs = o.stayMs ?? VERIFY_STAY_MS;
  // Nothing to watch is not a dismissal.
  if (els.length === 0) return { ok: false, reason: "not_gone" };
  const doc = (els[0] as Element).ownerDocument;
  let wake: (() => void) | undefined;
  let lastCheck = Number.NEGATIVE_INFINITY;
  // A busy page must not make us spin: wake early at most every MIN_GAP_MS.
  const mo = new MutationObserver(() => {
    if (performance.now() - lastCheck >= MIN_GAP_MS) wake?.();
  });
  mo.observe(doc, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"],
  });
  const tick = () =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, POLL_MS);
      function done() {
        clearTimeout(t);
        wake = undefined;
        resolve();
      }
      wake = done;
    });
  const interrupted = (): VerifyResult | null => {
    lastCheck = performance.now();
    if (o.nav.started()) return { ok: false, reason: "navigation" };
    if (els.some(autoconsentStyleTouches)) return { ok: false, reason: "autoconsent_style" };
    if (o.reappeared?.(false)) return { ok: false, reason: "came_back" };
    return null;
  };
  try {
    let t0 = performance.now();
    for (;;) {
      const stop = interrupted();
      if (stop) return stop;
      if (els.every(isGoneBySite)) break;
      const confirmed = o.confirmation?.() ?? null;
      if (confirmed === "clicked") t0 = performance.now();
      else if (confirmed) return confirmed;
      if (performance.now() - t0 >= goneMs) return { ok: false, reason: "not_gone" };
      await tick();
    }
    const t1 = performance.now();
    while (performance.now() - t1 < stayMs) {
      await tick();
      const stop = interrupted();
      if (stop) return stop;
      if (!els.every(isGoneBySite)) return { ok: false, reason: "came_back" };
    }
    // The ticks' answers may have stood on an earlier scan; a pass doesn't.
    if (o.reappeared?.(true)) return { ok: false, reason: "came_back" };
    return { ok: true };
  } finally {
    mo.disconnect();
  }
}

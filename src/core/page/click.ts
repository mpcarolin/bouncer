// Every click Bouncer makes goes through `safeClick`: it never navigates, scrolls or clicks a
// detached element. `captureFocus` undoes focus traps the flow may have triggered.
import { parentOf } from "./dom.ts";

export interface ClickResult {
  ok: boolean;
  reason?: "navigation" | "hash_changed" | "stale_target";
  /** True whenever the `#` guard listener was installed for this click. */
  hashGuardUsed: boolean;
}

/**
 * Records whether script started a navigation: the Navigation API `navigate` event (Chrome
 * has it) and `beforeunload`. `started()` stays true once either has fired.
 */
export class NavigationWatch {
  private fired = false;
  private readonly nav: EventTarget | undefined;
  private readonly onEvent = () => {
    this.fired = true;
  };

  constructor(private readonly win: Window) {
    this.nav = (win as Window & { navigation?: EventTarget }).navigation;
    this.nav?.addEventListener("navigate", this.onEvent);
    win.addEventListener("beforeunload", this.onEvent);
  }

  started(): boolean {
    return this.fired;
  }

  dispose(): void {
    this.nav?.removeEventListener("navigate", this.onEvent);
    this.win.removeEventListener("beforeunload", this.onEvent);
  }
}

function isHashLink(el: Element): boolean {
  return el.getAttribute("href")?.trim().startsWith("#") ?? false;
}

/**
 * Clicks `el` with `.click()` only. A detached element is never clicked. For a `#…` link, a
 * one-time listener on the element itself calls only `preventDefault()` (registered last, so
 * the site's own listeners on it still see `defaultPrevented` false). A handler that calls
 * `stopImmediatePropagation()` can defeat it, so when the guard did not run, hash and scroll
 * are compared synchronously against their values before the click.
 */
export function safeClick(el: Element, nav: NavigationWatch): ClickResult {
  if (!el.isConnected) return { ok: false, reason: "stale_target", hashGuardUsed: false };
  const win = el.ownerDocument.defaultView ?? window;
  const guarded = isHashLink(el);
  let guardRan = false;
  const guard = (e: Event) => {
    guardRan = true;
    e.preventDefault();
  };
  const hash = win.location.hash;
  const { scrollX, scrollY } = win;
  if (guarded) el.addEventListener("click", guard, { once: true });
  try {
    (el as HTMLElement).click();
  } finally {
    // `once` only removes it if the click reached it.
    if (guarded) el.removeEventListener("click", guard);
  }
  if (guarded && !guardRan) {
    if (win.location.hash !== hash || win.scrollX !== scrollX || win.scrollY !== scrollY) {
      return { ok: false, reason: "hash_changed", hashGuardUsed: true };
    }
  }
  if (nav.started()) return { ok: false, reason: "navigation", hashGuardUsed: guarded };
  return { ok: true, hashGuardUsed: guarded };
}

function deepActive(doc: Document): Element | null {
  let a: Element | null = doc.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

/**
 * Records the focused element now. The returned `restore(touched)` puts focus back (with
 * `preventScroll`) only if focus currently sits inside one of `touched`, the banner and panel
 * elements the flow acted on (shadow trees count as inside their host). If nothing was
 * focused before, the trapped element is blurred instead.
 */
export function captureFocus(doc: Document): (touched: Element[]) => void {
  const before = deepActive(doc);
  return (touched) => {
    const now = deepActive(doc);
    if (!now || now === before) return;
    let inside = false;
    for (let n: Element | null = now; n && !inside; n = parentOf(n)) inside = touched.includes(n);
    if (!inside) return;
    if (before && before !== doc.body && before.isConnected) {
      (before as HTMLElement).focus({ preventScroll: true });
    } else {
      (now as HTMLElement).blur();
    }
  };
}

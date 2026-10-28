// Every click Bouncer makes goes through `safeClick`: it never navigates, scrolls or clicks a
// detached element, and the control has focus only for its click. `captureFocus` undoes focus
// traps the flow may have triggered.
import { SUBMIT_GUARD_MS } from "../config.ts";
import { isFragmentLink, submitterOf } from "./clickable.ts";
import { parentOf } from "./dom.ts";

export interface ClickResult {
  ok: boolean;
  reason?: "navigation" | "hash_changed" | "stale_target";
  /** True whenever the `#` guard listener was installed for this click. */
  hashGuardUsed: boolean;
  /**
   * The click submitted a form and the page's own handlers didn't cancel the submission, so the
   * submit guard did. The page probably did nothing with the click.
   */
  submitGuard?: "cancelled";
}

/** The parts of the Navigation API's `NavigateEvent` read here. */
interface NavigateEventLike extends Event {
  navigationType?: string;
  /** The link or submitter (or the form, for `form.submit()`) that started it; not in every Chrome. */
  sourceElement?: Element | null;
}

interface GuardedSubmission {
  submitter: Element;
  form: HTMLFormElement;
  timer: number;
}

/**
 * Records whether script started a navigation: the Navigation API `navigate` event (Chrome
 * has it) and `beforeunload`. `started()` stays true once either has fired. A navigation that
 * was cancelled before this watch heard of it (by an earlier watch's submit guard) starts nothing.
 *
 * It is also the submit guard's backstop (`guardSubmission`).
 */
export class NavigationWatch {
  private fired = false;
  private disposed = false;
  private submission: GuardedSubmission | null = null;
  private readonly nav: EventTarget | undefined;
  private readonly onNavigate = (e: Event) => {
    if (this.submission && isSubmission(e as NavigateEventLike, this.submission)) {
      e.preventDefault();
      return;
    }
    if (!this.disposed && !e.defaultPrevented) this.fired = true;
  };
  private readonly onUnload = () => {
    this.fired = true;
  };

  constructor(private readonly win: Window) {
    this.nav = (win as Window & { navigation?: EventTarget }).navigation;
    this.nav?.addEventListener("navigate", this.onNavigate);
    win.addEventListener("beforeunload", this.onUnload);
  }

  started(): boolean {
    return this.fired;
  }

  /**
   * The submit guard's backstop: cancels the navigation that submitting `form` with `submitter`
   * begins. That navigation begins in a task the click queues, after `safeClick` has returned and
   * most likely after `dispose`, so the backstop stays armed for SUBMIT_GUARD_MS whatever happens.
   */
  guardSubmission(submitter: Element, form: HTMLFormElement): void {
    if (!this.nav) return;
    if (this.submission) this.win.clearTimeout(this.submission.timer);
    const timer = this.win.setTimeout(() => this.endSubmissionGuard(), SUBMIT_GUARD_MS);
    this.submission = { submitter, form, timer };
  }

  /** Stops recording. A submit guard's backstop is left to run its time. */
  dispose(): void {
    this.disposed = true;
    this.win.removeEventListener("beforeunload", this.onUnload);
    if (!this.submission) this.nav?.removeEventListener("navigate", this.onNavigate);
  }

  private endSubmissionGuard(): void {
    this.submission = null;
    if (this.disposed) this.nav?.removeEventListener("navigate", this.onNavigate);
  }
}

/**
 * The guarded form's submission, as its `navigate` event shows it: started by its submitter or
 * by the form itself. Where the browser doesn't say what started a navigation, any navigation
 * but a traversal is taken for it, so the user is never navigated away.
 */
function isSubmission(e: NavigateEventLike, g: GuardedSubmission): boolean {
  if (!e.cancelable || e.navigationType === "traverse") return false;
  if (!("sourceElement" in e)) return true;
  return e.sourceElement === g.submitter || e.sourceElement === g.form;
}

/** True when activating `el` follows a fragment link: its own, or an ancestor's. */
function underFragmentLink(el: Element): boolean {
  for (let n: Element | null = el; n; n = parentOf(n)) if (isFragmentLink(n)) return true;
  return false;
}

/**
 * Clicks `el` with `.click()` only. A detached element is never clicked.
 *
 * For a `#…` link, a one-time listener on the element itself calls only `preventDefault()`
 * (registered last, so the site's own listeners on it still see `defaultPrevented` false). A
 * handler that calls `stopImmediatePropagation()` can defeat it, so when the guard did not run,
 * hash and scroll are compared synchronously against their values before the click.
 *
 * For a submit control (§0's submit guard), the form's native submission never happens. The page's
 * own submit handlers run as for a user's click, seeing `defaultPrevented` false: the `submit`
 * event is dispatched inside `.click()`, and a listener registered last at the end of its path
 * (the window, or the form's shadow root, which it doesn't leave) cancels it if nothing else did.
 * A handler that stops its propagation defeats that listener, so the `navigate` backstop on `nav`
 * cancels the submission's navigation when it begins, in a task after this returns. `formdata`,
 * which fires only when a submission goes ahead, says whether the backstop will have to.
 */
export function safeClick(el: Element, nav: NavigationWatch): ClickResult {
  if (!el.isConnected) return { ok: false, reason: "stale_target", hashGuardUsed: false };
  const win = el.ownerDocument.defaultView ?? window;
  const guarded = underFragmentLink(el);
  let guardRan = false;
  const guard = (e: Event) => {
    guardRan = true;
    e.preventDefault();
  };
  const submitter = submitterOf(el);
  const form = submitter?.form ?? null;
  let cancelled = false;
  const onSubmit = (e: Event) => {
    if (e.target !== form || e.defaultPrevented) return;
    e.preventDefault();
    cancelled = true;
  };
  const onFormData = (e: Event) => {
    if (e.target === form) cancelled = true; // the backstop will cancel its navigation
  };
  const formRoot = form?.getRootNode();
  const path: EventTarget = formRoot instanceof ShadowRoot ? formRoot : win;
  const hash = win.location.hash;
  const { scrollX, scrollY } = win;
  if (guarded) el.addEventListener("click", guard, { once: true });
  if (submitter && form) {
    nav.guardSubmission(submitter, form);
    path.addEventListener("submit", onSubmit);
    path.addEventListener("formdata", onFormData, true);
  }
  const unfocus = focusForClick(el);
  try {
    // SVG elements have no click(); a synthetic click activates their links just the same.
    if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
    else {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
      );
    }
  } finally {
    unfocus();
    // `once` only removes it if the click reached it.
    if (guarded) el.removeEventListener("click", guard);
    if (form) {
      path.removeEventListener("submit", onSubmit);
      path.removeEventListener("formdata", onFormData, true);
    }
  }
  const submit = cancelled ? { submitGuard: "cancelled" as const } : {};
  if (guarded && !guardRan) {
    if (win.location.hash !== hash || win.scrollX !== scrollX || win.scrollY !== scrollY) {
      return { ok: false, reason: "hash_changed", hashGuardUsed: true, ...submit };
    }
  }
  if (nav.started()) return { ok: false, reason: "navigation", hashGuardUsed: guarded, ...submit };
  return { ok: true, hashGuardUsed: guarded, ...submit };
}

const NOT_TYPED_IN = new Set(["button", "submit", "reset", "image", "checkbox", "radio"]);

/** A field someone may be typing in. */
function isEditable(el: Element | null): boolean {
  if (el instanceof HTMLInputElement) return !NOT_TYPED_IN.has(el.type);
  return (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/**
 * A user's click focuses the control first, and some pages read `document.activeElement` to
 * tell which button it was (ons.gov.uk), so `el` has focus for the click, and the returned
 * function puts focus back where it was at once (Goal 4). Never while a field has focus: someone
 * may be typing in it.
 */
function focusForClick(el: Element): () => void {
  const doc = el.ownerDocument;
  const before = deepActive(doc);
  const target = el as HTMLElement;
  if (isEditable(before) || before === el || typeof target.focus !== "function") return () => {};
  target.focus({ preventScroll: true });
  return () => {
    // Focus the page moved during the click is the page's.
    if (deepActive(doc) !== el) return;
    if (before && before !== doc.body && before.isConnected) {
      (before as HTMLElement).focus({ preventScroll: true });
    } else {
      target.blur();
    }
  };
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

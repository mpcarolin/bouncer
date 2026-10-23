// Finding the panel that appears after a settings click (§2f.3).
import { PANEL_WAIT_MS } from "../config.ts";
import { CONSENT_WORDING } from "./detect.ts";
import { BUTTON_SEL, deepAll, parentOf, textOf } from "./dom.ts";
import { isVisibleControl } from "./serialise.ts";

const TOGGLE_SEL = 'input[type="checkbox"], [role="switch"], [role="checkbox"]';
const CONTROL_SEL = `${BUTTON_SEL}, a[href], [role="link"], ${TOGGLE_SEL}`;
/** Bounds the work of one snapshot or scan on a huge page. */
const MAX_ELEMENTS = 20000;
const POLL_MS = 100;

/**
 * What `snapshotRendered` returns: the set of elements visible at click time, plus what is needed
 * to tell "was hidden" from "never looked at" when the page was too big to walk in full. Anywhere
 * a `WeakSet<Element>` is wanted, this is one.
 */
export class RenderSnapshot extends WeakSet<Element> {
  /** The walk hit its element cap, so elements it never reached are unknown, not hidden. */
  truncated = false;
  /** Elements the walk reached and found hidden, or under display:none. Read only when `truncated`. */
  readonly hidden = new WeakSet<Element>();
}

/**
 * Whether `el` was not visible at snapshot time. Complete snapshot: anything not in it. Truncated
 * snapshot: only an element that was reached hidden, or sits under one. An element it never
 * reached (or one created since) is never new, so a footer link past the cap cannot pose as the
 * panel. A plain `WeakSet` carries no such information and is taken to be complete.
 */
function isNew(el: Element, before: WeakSet<Element>): boolean {
  if (before.has(el)) return false;
  if (!(before instanceof RenderSnapshot) || !before.truncated) return true;
  for (let n: Element | null = el; n; n = parentOf(n)) if (before.hidden.has(n)) return true;
  return false;
}

/** Child elements, with an open shadow root's children after the host's own. */
function* childrenOf(node: Element | Document): Generator<Element> {
  yield* node.children;
  if (node instanceof Element && node.shadowRoot) yield* node.shadowRoot.children;
}

/** Pushes `node`'s children so that they pop in document order. */
function pushChildren(stack: Element[], node: Element | Document): void {
  const kids = [...childrenOf(node)];
  for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Element);
}

/**
 * Pre-order walk of the top frame under `doc`, open shadow roots included, visiting at most `max`
 * elements. `visit(el, rendered)` returns whether to go on into the element's children; a
 * display:none element (`rendered` false) never has its children visited. Returns true if it
 * stopped at the cap with elements left unvisited.
 */
function walk(
  doc: Document,
  max: number,
  visit: (el: Element, rendered: boolean) => boolean,
): boolean {
  const stack: Element[] = [];
  pushChildren(stack, doc);
  for (let seen = 0; stack.length; seen++) {
    if (seen >= max) return true;
    const el = stack.pop() as Element;
    const rendered = getComputedStyle(el).display !== "none";
    if (visit(el, rendered) && rendered) pushChildren(stack, el);
  }
  return false;
}

/**
 * Elements rendered and visible now (top frame only, open shadow roots included). "Visible" is
 * `isVisibleControl`, so a custom switch whose native input is hidden counts when its label is
 * shown; for everything else that is plain visibility.
 */
export function snapshotRendered(doc: Document, maxElements = MAX_ELEMENTS): RenderSnapshot {
  const snap = new RenderSnapshot();
  snap.truncated = walk(doc, maxElements, (el, rendered) => {
    const shown = isVisibleControl(el);
    if (shown) snap.add(el);
    if (!shown || !rendered) snap.hidden.add(el);
    return true;
  });
  return snap;
}

export interface FindPanelOptions {
  banner: Element;
  /** From `snapshotRendered`, taken just before the settings click. */
  before: WeakSet<Element>;
  rejected: Set<Element>;
  doc: Document;
  waitMs?: number;
  pollMs?: number;
}

export type PanelResult = { panel: Element } | { failed: "none" | "ambiguous" };

function insideRejected(el: Element, rejected: Set<Element>): boolean {
  for (let n: Element | null = el; n; n = parentOf(n)) if (rejected.has(n)) return true;
  return false;
}

function qualifies(el: Element): boolean {
  return deepAll(el, TOGGLE_SEL).length > 0 || CONSENT_WORDING.test(textOf(el));
}

/** Outermost newly visible elements that carry toggles or consent wording. */
function newPanels(o: FindPanelOptions): Element[] {
  const found: Element[] = [];
  walk(o.doc, MAX_ELEMENTS, (el, rendered) => {
    if (!rendered) return false;
    if (!isNew(el, o.before) || !isVisibleControl(el)) return true;
    if (!insideRejected(el, o.rejected) && qualifies(el)) found.push(el);
    return false; // outermost only: its descendants never count separately
  });
  return found;
}

/** The banner now holds a visible control that was not visible at click time. */
function bannerGained(o: FindPanelOptions): boolean {
  if (!o.banner.isConnected || !isVisibleControl(o.banner)) return false;
  return deepAll(o.banner, CONTROL_SEL).some((el) => isNew(el, o.before) && isVisibleControl(el));
}

/**
 * Waits up to `PANEL_WAIT_MS` for the settings panel: the banner itself if it gained a visible
 * control, else exactly one outermost newly visible element with toggles or consent wording.
 * An error while looking resolves as `none`.
 */
export function findPanel(o: FindPanelOptions): Promise<PanelResult> {
  const waitMs = o.waitMs ?? PANEL_WAIT_MS;
  const pollMs = o.pollMs ?? POLL_MS;
  return new Promise((resolve) => {
    let done = false;
    let lastCheck = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    // A burst of mutations must not mean a full walk each: checks run at least `pollMs` apart,
    // and the poll picks up whatever a skipped mutation changed.
    const observer = new MutationObserver(() => {
      if (performance.now() - lastCheck >= pollMs) check();
    });
    const finish = (r: PanelResult) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      clearInterval(poll);
      resolve(r);
    };
    function check(): void {
      if (done) return;
      lastCheck = performance.now();
      try {
        if (bannerGained(o)) return finish({ panel: o.banner });
        const found = newPanels(o);
        if (found.length === 1) return finish({ panel: found[0] as Element });
        if (found.length > 1) finish({ failed: "ambiguous" });
      } catch {
        finish({ failed: "none" });
      }
    }
    observer.observe(o.doc, { subtree: true, childList: true, attributes: true });
    poll = setInterval(check, pollMs);
    timer = setTimeout(() => {
      check();
      finish({ failed: "none" });
    }, waitMs);
    check();
  });
}

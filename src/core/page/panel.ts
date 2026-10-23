// Finding the panel that appears after a settings click (§2f.3).
import { PANEL_WAIT_MS } from "../config.ts";
import { CONSENT_WORDING } from "./detect.ts";
import { BUTTON_SEL, deepAll, isVisible, parentOf, textOf } from "./dom.ts";

const TOGGLE_SEL = 'input[type="checkbox"], [role="switch"], [role="checkbox"]';
const CONTROL_SEL = `${BUTTON_SEL}, a[href], [role="link"], ${TOGGLE_SEL}`;
/** Bounds the work of one snapshot or scan on a huge page. */
const MAX_ELEMENTS = 20000;
const POLL_MS = 100;

/** Child elements, with an open shadow root's children in place of the host's own. */
function* childrenOf(el: Element): Generator<Element> {
  yield* el.children;
  if (el.shadowRoot) yield* el.shadowRoot.children;
}

/** Elements under `doc` that are not display:none, visiting each at most `MAX_ELEMENTS` times. */
function* walk(doc: Document): Generator<Element> {
  const stack: Element[] = [...doc.children].reverse();
  let seen = 0;
  while (stack.length && seen++ < MAX_ELEMENTS) {
    const el = stack.pop() as Element;
    const display = getComputedStyle(el).display;
    yield el;
    if (display === "none") continue;
    stack.push(...[...childrenOf(el)].reverse());
  }
}

/** Elements rendered and visible now (top frame only, open shadow roots included). */
export function snapshotRendered(doc: Document): WeakSet<Element> {
  const out = new WeakSet<Element>();
  for (const el of walk(doc)) if (isVisible(el)) out.add(el);
  return out;
}

export interface FindPanelOptions {
  banner: Element;
  before: WeakSet<Element>;
  bannerControlCount: number;
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
  const stack: Element[] = [...o.doc.children].reverse();
  let seen = 0;
  while (stack.length && seen++ < MAX_ELEMENTS) {
    const el = stack.pop() as Element;
    if (getComputedStyle(el).display === "none") continue;
    if (!o.before.has(el) && isVisible(el)) {
      if (!insideRejected(el, o.rejected) && qualifies(el)) found.push(el);
      continue; // outermost only: its descendants never count separately
    }
    stack.push(...[...childrenOf(el)].reverse());
  }
  return found;
}

function bannerGained(o: FindPanelOptions): boolean {
  if (!o.banner.isConnected || !isVisible(o.banner)) return false;
  return deepAll(o.banner, CONTROL_SEL).filter(isVisible).length > o.bannerControlCount;
}

/**
 * Waits up to `PANEL_WAIT_MS` for the settings panel: the banner itself if it gained toggles or
 * controls, else exactly one outermost newly visible element with toggles or consent wording.
 */
export function findPanel(o: FindPanelOptions): Promise<PanelResult> {
  const waitMs = o.waitMs ?? PANEL_WAIT_MS;
  const pollMs = o.pollMs ?? POLL_MS;
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const observer = new MutationObserver(() => check());
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
      if (bannerGained(o)) return finish({ panel: o.banner });
      const found = newPanels(o);
      if (found.length === 1) return finish({ panel: found[0] as Element });
      if (found.length > 1) finish({ failed: "ambiguous" });
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

import { DETECT_THROTTLE_MS, DETECT_WATCH_MS, LINK_THRESHOLD } from "../config.ts";
import { normalise } from "../text/normalise.ts";
import type { Clock } from "../types.ts";
import { BUTTON_SEL, deepAll, isVisible, parentOf, shadowRootsOf, textOf } from "./dom.ts";

export interface Candidate {
  el: Element;
  root: Document | ShadowRoot;
  modal: boolean;
  /** Cheap stable hash of the normalised text. */
  key: string;
}

/**
 * Wording that marks consent text on its own. The privacy words are not in it ("privacy" and
 * its German, French and Spanish forms): a newsletter modal links to a privacy policy too.
 */
export const CONSENT_WORDING = /cookie|consent/i;
const PRIVACY_WORDING = /privacy|datenschutz|confidentialit|privacidad/i;
/** Text that lets an overlay be a banner candidate: consent wording or a privacy word. */
const CONSENT_TEXT = new RegExp(`${CONSENT_WORDING.source}|${PRIVACY_WORDING.source}`, "i");
/** An in-flow banner's own id, class or `aria-label` calls it one. An app root (`#root`) doesn't. */
const NAMES_A_BANNER = /cookie|consent|gdpr/i;
/** The page's own content: a cookie preferences page, an "accept cookies to see this" placeholder. */
const PAGE_CONTENT = 'main, article, [role="main"], [role="article"]';
const Z_INDEX_MIN = 1000;
const MODAL_COVERAGE = 0.5;

/** FNV-1a over the normalised text. Not cryptographic; only for telling "same text" from "changed". */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of normalise(text)) {
    h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Fixed, sticky, high z-index, or a dialog: what a banner (or any overlay) is made of. */
export function isOverlay(el: Element): boolean {
  if (el.matches('[role="dialog"], [aria-modal="true"]')) return true;
  const cs = getComputedStyle(el);
  return (
    cs.position === "fixed" ||
    cs.position === "sticky" ||
    Number.parseInt(cs.zIndex, 10) >= Z_INDEX_MIN
  );
}

function namesItselfABanner(el: Element): boolean {
  return [el.id, el.getAttribute("class"), el.getAttribute("aria-label")].some(
    (s) => !!s && NAMES_A_BANNER.test(s),
  );
}

function inPageContent(el: Element): boolean {
  for (let n: Element | null = el; n; n = parentOf(n)) if (n.matches(PAGE_CONTENT)) return true;
  return false;
}

/** Within a viewport's height of the top or the bottom of the document. */
function atPageEdge(el: Element): boolean {
  const win = el.ownerDocument.defaultView ?? window;
  const r = el.getBoundingClientRect();
  const end = el.ownerDocument.documentElement.scrollHeight;
  return r.top + win.scrollY < win.innerHeight || r.bottom + win.scrollY > end - win.innerHeight;
}

/**
 * §2a's in-flow case: a banner in the page's normal flow (GOV.UK's style) rather than an overlay.
 * It names itself a consent banner, sits outside the page's main content and holds none of it
 * (a wrapper of the whole page, `div#app.cookie-banner-visible`, is not a banner), and sits at the
 * top or the bottom of the page. Its text must also carry consent wording (`qualify`).
 */
function isInFlowBanner(el: Element): boolean {
  return (
    namesItselfABanner(el) &&
    !inPageContent(el) &&
    atPageEdge(el) &&
    deepAll(el, PAGE_CONTENT).length === 0
  );
}

function sameOriginLinks(el: Element): number {
  let n = 0;
  for (const a of deepAll(el, "a[href]")) {
    try {
      if (new URL((a as HTMLAnchorElement).href).origin === location.origin) n++;
    } catch {
      // An unparseable href cannot navigate anywhere.
    }
  }
  return n;
}

/** `aria-modal`, or covering most of the viewport (§2a's modal test). */
export function isModal(el: Element): boolean {
  if (el.hasAttribute("aria-modal") && el.getAttribute("aria-modal") !== "false") return true;
  const r = el.getBoundingClientRect();
  const viewport = innerWidth * innerHeight;
  return viewport > 0 && (r.width * r.height) / viewport >= MODAL_COVERAGE;
}

function qualify(el: Element): Candidate | null {
  const overlay = isOverlay(el);
  if ((!overlay && !isInFlowBanner(el)) || !isVisible(el)) return null;
  const text = textOf(el);
  // Privacy wording alone doesn't make an in-flow element a banner.
  if (!(overlay ? CONSENT_TEXT : CONSENT_WORDING).test(text)) return null;
  if (!deepAll(el, BUTTON_SEL).some(isVisible)) return null;
  if (sameOriginLinks(el) > LINK_THRESHOLD) return null;
  return {
    el,
    root: el.getRootNode() as Document | ShadowRoot,
    modal: isModal(el),
    key: hashText(text),
  };
}

/**
 * Outermost qualifying elements, in document order of their first button. Starts from the
 * buttons (few) rather than from every element (many), walking up through shadow hosts.
 * `wasRejected` marks elements already rejected (under any text): such an element no longer
 * masks the qualifying elements inside it, which are reported instead. If every qualifying
 * ancestor of a button was rejected, the outermost is returned (its text may have changed).
 */
export function findCandidates(
  doc: Document,
  wasRejected: (el: Element) => boolean = () => false,
): Candidate[] {
  const cache = new Map<Element, Candidate | null>();
  const found = new Map<Element, Candidate>();
  for (const btn of deepAll(doc, BUTTON_SEL)) {
    const chain: Candidate[] = []; // innermost first
    for (let a = parentOf(btn); a && a !== doc.documentElement && a !== doc.body; a = parentOf(a)) {
      let c = cache.get(a);
      if (c === undefined) {
        c = qualify(a);
        cache.set(a, c);
      }
      if (c) chain.push(c);
    }
    let best: Candidate | undefined = chain[chain.length - 1];
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!wasRejected((chain[i] as Candidate).el)) {
        best = chain[i];
        break;
      }
    }
    if (best && !found.has(best.el)) found.set(best.el, best);
  }
  // A rejected shell whose text changed only because a banner appeared inside it is not news.
  for (const el of [...found.keys()]) {
    if (!wasRejected(el)) continue;
    for (const other of found.keys()) {
      if (other === el) continue;
      for (let p = parentOf(other); p; p = parentOf(p)) {
        if (p === el) {
          found.delete(el);
          break;
        }
      }
    }
  }
  return [...found.values()];
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
};

export interface WatcherOptions {
  /** Called at the start of every detection pass. For tests that count passes. */
  onPass?: () => void;
}

/**
 * Watches the live DOM and reports each new candidate once. Passes run at most once per
 * DETECT_THROTTLE_MS however many mutations arrive; watching ends after DETECT_WATCH_MS.
 * A candidate is identified by element plus text hash, so changed text is reported again.
 */
export class CandidateWatcher {
  private readonly observers: MutationObserver[] = [];
  private readonly observed = new WeakSet<Node>();
  private readonly seen = new WeakMap<Element, Set<string>>();
  private readonly rejected = new WeakSet<Element>();
  private lastPass = Number.NEGATIVE_INFINITY;
  private timer: number | null = null;
  private stopTimer: number | null;
  private stopped = false;

  constructor(
    private readonly doc: Document,
    private readonly onCandidate: (c: Candidate) => void,
    private readonly clock: Clock = realClock,
    private readonly opts: WatcherOptions = {},
  ) {
    this.observe(doc);
    this.stopTimer = clock.setTimeout(() => this.stop(), DETECT_WATCH_MS);
    // Not synchronous: `onCandidate` may call back into the watcher before the constructor returns.
    this.schedule();
  }

  /** Never report this element with this text again. */
  reject(c: Candidate): void {
    this.mark(c);
    this.rejected.add(c.el);
  }

  /** Report this element with this text again, on a pass after it shows: it was set aside unjudged. */
  retry(c: Candidate): void {
    this.seen.get(c.el)?.delete(c.key);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const o of this.observers) o.disconnect();
    this.observers.length = 0;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    if (this.stopTimer !== null) this.clock.clearTimeout(this.stopTimer);
    this.timer = this.stopTimer = null;
  }

  /** A document observer does not see inside shadow roots, so each open root gets its own. */
  private observe(root: Node): void {
    if (this.observed.has(root)) return;
    this.observed.add(root);
    const o = new MutationObserver(() => this.schedule());
    o.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    this.observers.push(o);
  }

  private mark(c: Candidate): boolean {
    let keys = this.seen.get(c.el);
    if (!keys) this.seen.set(c.el, (keys = new Set()));
    if (keys.has(c.key)) return false;
    keys.add(c.key);
    return true;
  }

  private schedule(): void {
    if (this.stopped || this.timer !== null) return;
    const wait = Math.max(0, this.lastPass + DETECT_THROTTLE_MS - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.pass();
    }, wait);
  }

  private pass(): void {
    if (this.stopped) return;
    this.opts.onPass?.();
    for (const root of shadowRootsOf(this.doc)) this.observe(root);
    for (const c of findCandidates(this.doc, (el) => this.rejected.has(el))) {
      if (this.stopped) break;
      if (!this.mark(c)) continue;
      try {
        this.onCandidate(c);
      } catch (e) {
        console.error("Bouncer: candidate handler threw", e);
      }
    }
    this.lastPass = this.clock.now();
  }
}

import { DETECT_THROTTLE_MS, DETECT_WATCH_MS, LINK_THRESHOLD } from "../config.ts";
import { normalise } from "../text/normalise.ts";
import type { Clock } from "../types.ts";
import { BUTTON_SEL, deepAll, isVisible, parentOf, textOf } from "./dom.ts";

export interface Candidate {
  el: Element;
  root: Document | ShadowRoot;
  modal: boolean;
  /** Cheap stable hash of the normalised text. */
  key: string;
}

const CONSENT_TEXT = /cookie|consent|privacy|datenschutz|confidentialit|privacidad/i;
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

function isOverlay(el: Element): boolean {
  if (el.matches('[role="dialog"], [aria-modal="true"]')) return true;
  const cs = getComputedStyle(el);
  return (
    cs.position === "fixed" ||
    cs.position === "sticky" ||
    Number.parseInt(cs.zIndex, 10) >= Z_INDEX_MIN
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

function isModal(el: Element): boolean {
  if (el.hasAttribute("aria-modal") && el.getAttribute("aria-modal") !== "false") return true;
  const r = el.getBoundingClientRect();
  const viewport = innerWidth * innerHeight;
  return viewport > 0 && (r.width * r.height) / viewport >= MODAL_COVERAGE;
}

function qualify(el: Element): Candidate | null {
  if (!isOverlay(el) || !isVisible(el)) return null;
  const text = textOf(el);
  if (!CONSENT_TEXT.test(text)) return null;
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
 */
export function findCandidates(doc: Document): Candidate[] {
  const cache = new Map<Element, Candidate | null>();
  const found = new Map<Element, Candidate>();
  for (const btn of deepAll(doc, BUTTON_SEL)) {
    let best: Candidate | null = null;
    for (let a = parentOf(btn); a && a !== doc.documentElement && a !== doc.body; a = parentOf(a)) {
      let c = cache.get(a);
      if (c === undefined) {
        c = qualify(a);
        cache.set(a, c);
      }
      if (c) best = c;
    }
    if (best && !found.has(best.el)) found.set(best.el, best);
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
  private readonly observer: MutationObserver;
  private readonly seen = new WeakMap<Element, Set<string>>();
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
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(doc, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    this.stopTimer = clock.setTimeout(() => this.stop(), DETECT_WATCH_MS);
    // Not synchronous: `onCandidate` may call back into the watcher before the constructor returns.
    this.schedule();
  }

  /** Never report this element with this text again. */
  reject(c: Candidate): void {
    this.mark(c);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.observer.disconnect();
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    if (this.stopTimer !== null) this.clock.clearTimeout(this.stopTimer);
    this.timer = this.stopTimer = null;
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
    this.lastPass = this.clock.now();
    this.opts.onPass?.();
    for (const c of findCandidates(this.doc)) {
      if (this.stopped) return;
      if (this.mark(c)) this.onCandidate(c);
    }
  }
}

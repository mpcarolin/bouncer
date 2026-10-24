// Read-only checks the pipeline makes on the live page around an action (§2g). None of them
// touches the page.
import { DETECT_THROTTLE_MS } from "../config.ts";
import { clickability } from "../page/clickable.ts";
import { type Candidate, findCandidates, isModal, isOverlay } from "../page/detect.ts";
import { deepAll, isVisible, parentOf } from "../page/dom.ts";
import { type Serialised, serialise } from "../page/serialise.ts";
import { isGoneBySite } from "../page/verify.ts";

/** True when `inner` is `outer` or sits inside it, open shadow roots included. */
function within(inner: Element, outer: Element): boolean {
  for (let n: Element | null = inner; n; n = parentOf(n)) if (n === outer) return true;
  return false;
}

/**
 * The decided-on control is still in the banner (or panel), still visible, and reads as it did
 * when it was serialised. A re-rendered banner fails this, so a stale decision is never clicked.
 */
export function stillSame(c: Pick<Candidate, "el">, s: Serialised, id: number): boolean {
  const el = s.elements.get(id);
  const was = s.banner.controls.find((x) => x.id === id);
  if (!el || !was || !c.el.isConnected || !el.isConnected) return false;
  const now = serialise(c, clickability);
  for (const [nowId, e] of now.elements) {
    if (e !== el) continue;
    const is = now.banner.controls.find((x) => x.id === nowId);
    return (
      is !== undefined &&
      is.role === was.role &&
      is.text === was.text &&
      is.ariaLabel === was.ariaLabel &&
      is.title === was.title &&
      is.absent === was.absent
    );
  }
  return false;
}

/**
 * The site has put the banner (or the settings panel) back as a new element: a visible candidate
 * whose text hashes to one of `keys`, the acted-on texts, and that is neither one of `verified`
 * nor wraps one (those `verifyDismissed` checks itself). Never throws; an error counts as not
 * reappeared.
 */
export function reappeared(
  doc: Document,
  keys: ReadonlySet<string>,
  verified: readonly Element[],
): boolean {
  try {
    return findCandidates(doc).some(
      (k) => keys.has(k.key) && !verified.some((v) => within(v, k.el)),
    );
  } catch {
    return false;
  }
}

/**
 * `reappeared`, for `verifyDismissed`, which asks on every tick and DOM mutation (as often as
 * every 50 ms, for seconds): the page is rescanned at most once per DETECT_THROTTLE_MS, and the
 * last answer stands in between. A `fresh` check always rescans.
 */
export function throttledReappeared(
  doc: Document,
  keys: ReadonlySet<string>,
  verified: readonly Element[],
  now: () => number,
): (fresh: boolean) => boolean {
  let scannedAt = Number.NEGATIVE_INFINITY;
  let last = false;
  return (fresh) => {
    const t = now();
    if (fresh || t - scannedAt >= DETECT_THROTTLE_MS) {
      scannedAt = t;
      last = reappeared(doc, keys, verified);
    }
    return last;
  };
}

/** A `not_consent` candidate that is visible and modal (§2a): the scroll record pauses for it. */
export function modalNotConsentShowing(notConsent: readonly Candidate[]): boolean {
  return notConsent.some((c) => c.el.isConnected && isVisible(c.el) && isModal(c.el));
}

/**
 * §2g's overlay test before a scroll unlock: a modal `not_consent` candidate is visible, or some
 * other visible overlay the site has not dismissed covers most of the viewport. `actedOn` (the
 * dismissed banner) and what is inside it don't count.
 */
export function overlayStillShowing(
  doc: Document,
  notConsent: readonly Candidate[],
  actedOn: readonly Element[],
): boolean {
  if (modalNotConsentShowing(notConsent)) return true;
  for (const el of deepAll(doc, "*")) {
    if (actedOn.some((a) => within(el, a))) continue;
    if (isOverlay(el) && isVisible(el) && isModal(el) && !isGoneBySite(el)) return true;
  }
  return false;
}

// Scroll-state snapshot and narrow unlock (§2a, §2g). Many banners lock page scroll; after a
// verified dismissal Bouncer restores the inline `overflow` values it saw before the banner,
// but only when nothing suggests the lock belongs to a login wall or paywall. Only inline
// `overflow` is restored (never forced to `auto`); `position`, `top` and the scroll offset are
// left alone.

import type { Outcome } from "../types.ts";

/** Inline `overflow` values of `html` and `body`, and whether the page could scroll. */
export interface ScrollRecord {
  html: string;
  body: string;
  scrollable: boolean;
}

export type SkipReason =
  | "not_dismissed"
  | "no_snapshot"
  | "not_scrollable_before"
  | "not_locked"
  | "overlay_showing"
  | "inline_changed"
  | "lock_not_inline";

export type UnlockResult = "unlocked" | `skipped:${SkipReason}`;

const DISMISSED: ReadonlySet<Outcome> = new Set<Outcome>([
  "dismissed",
  "dismissed_unverified",
  "dismissed_close",
  "dismissed_agreed",
  "dismissed_late",
]);

export class ScrollTracker {
  private record: ScrollRecord | null = null;
  private atAction: Pick<ScrollRecord, "html" | "body"> | null = null;
  private frozen = false;

  constructor(private readonly doc: Document) {}

  private inline(): Pick<ScrollRecord, "html" | "body"> {
    return {
      html: this.doc.documentElement.style.overflow,
      body: this.doc.body?.style.overflow ?? "",
    };
  }

  /** "Locked now": `html` or `body` computed overflow is hidden/clip, or the body is fixed. */
  private isLocked(): boolean {
    const view = this.doc.defaultView;
    if (!view || !this.doc.body) return false;
    const clipped = (v: string) => v === "hidden" || v === "clip";
    const html = view.getComputedStyle(this.doc.documentElement);
    const body = view.getComputedStyle(this.doc.body);
    return clipped(html.overflow) || clipped(body.overflow) || body.position === "fixed";
  }

  private isScrollable(): boolean {
    const el = this.doc.documentElement;
    return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
  }

  /**
   * Take a record on a detection pass. No-op while a modal `not_consent` candidate shows, or
   * once frozen. A pass that finds the page already locked keeps the earlier record: a lock
   * is never the "before" state.
   */
  refresh(modalNotConsentVisible: boolean): void {
    if (this.frozen || modalNotConsentVisible || this.isLocked()) return;
    this.record = { ...this.inline(), scrollable: this.isScrollable() };
  }

  /** The acted-on candidate appeared, or autoconsent reported `cmpDetected`. */
  freeze(): void {
    this.frozen = true;
  }

  /** At the first click (or `popupFound` on autoconsent's path), note the inline values. */
  markAction(): void {
    this.atAction = this.inline();
  }

  tryUnlock(outcome: Outcome, overlayStillShowing: boolean): UnlockResult {
    if (!DISMISSED.has(outcome)) return "skipped:not_dismissed";
    if (!this.record || !this.atAction) return "skipped:no_snapshot";
    if (!this.record.scrollable) return "skipped:not_scrollable_before";
    if (!this.isLocked()) return "skipped:not_locked";
    if (overlayStillShowing) return "skipped:overlay_showing";
    const now = this.inline();
    if (now.html !== this.atAction.html || now.body !== this.atAction.body) {
      return "skipped:inline_changed";
    }
    this.doc.documentElement.style.overflow = this.record.html;
    if (this.doc.body) this.doc.body.style.overflow = this.record.body;
    if (this.isLocked()) {
      // A fixed body or a class/stylesheet lock isn't released by inline overflow: undo.
      this.doc.documentElement.style.overflow = now.html;
      if (this.doc.body) this.doc.body.style.overflow = now.body;
      return "skipped:lock_not_inline";
    }
    return "unlocked";
  }
}

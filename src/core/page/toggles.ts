// Reading and setting toggles directly from their elements. `serialise` omits invisible controls,
// so nothing here goes through it: toggles in collapsed sections and hidden tabs are read too.
import { NavigationWatch, safeClick } from "./click.ts";

export interface ToggleTarget {
  el: Element;
  to: boolean;
}

/** Checked state of a checkbox or ARIA switch/checkbox; null if it cannot be read. */
export function readToggle(el: Element): boolean | null {
  if (el instanceof HTMLInputElement) return el.type === "checkbox" ? el.checked : null;
  const role = el.getAttribute("role");
  if (role !== "switch" && role !== "checkbox") return null;
  const v = el.getAttribute("aria-checked");
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function isDisabled(el: Element): boolean {
  return el.matches(":disabled") || el.closest('[aria-disabled="true"]') !== null;
}

/**
 * Clicks each toggle whose state differs from `to`. Never scrolls (`click()` only), never clicks a
 * disabled or unreadable toggle. A click that changes nothing is left for `recheck` to catch.
 */
export function setToggles(targets: ToggleTarget[]): void {
  for (const { el, to } of targets) {
    const now = readToggle(el);
    if (now === null || now === to || isDisabled(el)) continue;
    const win = el.ownerDocument.defaultView ?? window;
    const nav = new NavigationWatch(win);
    try {
      safeClick(el, nav);
    } finally {
      nav.dispose();
    }
  }
}

/** True only if every target is attached, readable and in its wanted state. */
export function recheck(targets: ToggleTarget[]): boolean {
  return targets.every(({ el, to }) => el.isConnected && readToggle(el) === to);
}

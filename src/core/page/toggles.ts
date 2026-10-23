// Reading and setting toggles directly from their elements. `serialise` omits invisible controls,
// so nothing here goes through it: toggles in collapsed sections and hidden tabs are read too.
import { clickability } from "./clickable.ts";
import { type ClickResult, NavigationWatch, safeClick } from "./click.ts";

export interface ToggleTarget {
  el: Element;
  to: boolean;
}

export type SetTogglesResult =
  | { ok: true }
  | { ok: false; reason: NonNullable<ClickResult["reason"]> };

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
 * Clicks each toggle whose state differs from `to`, through `safeClick` (so it never scrolls).
 * A toggle is left alone, for `recheck` to fail, if it is unreadable or disabled, or if
 * `clickability` says a click would navigate or submit (a `<button role=switch>` in a form, a
 * switch inside a link). Stops at the first click that is not ok and returns why: after a
 * navigation or hash change nothing more should be clicked. A click that merely changes nothing
 * is left for `recheck` to catch.
 */
export function setToggles(targets: ToggleTarget[]): SetTogglesResult {
  for (const { el, to } of targets) {
    const now = readToggle(el);
    if (now === null || now === to || isDisabled(el) || clickability(el) !== null) continue;
    const nav = new NavigationWatch(el.ownerDocument.defaultView ?? window);
    let result: ClickResult;
    try {
      result = safeClick(el, nav);
    } finally {
      nav.dispose();
    }
    if (!result.ok) return { ok: false, reason: result.reason ?? "navigation" };
  }
  return { ok: true };
}

/** True only if every target is attached, readable and in its wanted state. */
export function recheck(targets: ToggleTarget[]): boolean {
  return targets.every(({ el, to }) => el.isConnected && readToggle(el) === to);
}

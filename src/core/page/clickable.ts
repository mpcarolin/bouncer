// §0 "Never navigate the user away": decides whether `.click()` on an element is safe.
// Read-only; never touches the page.
import type { AbsentReason } from "../types.ts";
import { parentOf } from "./dom.ts";

/** What activating this one element does by itself, ignoring its ancestors. */
function ownReason(el: Element): AbsentReason | null {
  if (el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement) {
    const href = el.getAttribute("href");
    if (href === null) return null;
    if (el.target.toLowerCase() === "_blank") return "navigates";
    const h = href.trim().toLowerCase();
    // `#…` is clickable with a guard (see safeClick); `javascript:` navigates nowhere.
    if (h.startsWith("#") || h.startsWith("javascript:")) return null;
    return "navigates";
  }
  let type: string | null = null;
  if (el instanceof HTMLButtonElement) {
    // `type` is already normalised by the platform: a missing or invalid value reads "submit".
    type = el.type;
  } else if (el instanceof HTMLInputElement) {
    if (el.type === "submit" || el.type === "image" || el.type === "reset") type = el.type;
  }
  if (type === "reset") return "reset";
  // `.form`, not DOM ancestry: the `form=` attribute can tie a button to a form elsewhere.
  if ((type === "submit" || type === "image") && (el as HTMLButtonElement).form) return "submit";
  return null;
}

/**
 * Why Bouncer must not click `el`, or null if it may. The control's own rule applies, and so
 * does the same rule on every ancestor: a `div role=button` inside `<a href="/x">` has no
 * activation behaviour of its own, so `.click()` follows the link. The walk crosses open
 * shadow roots to the host, because a click on a control in a shadow tree bubbles out and the
 * host's link ancestor activates just the same. A reset ancestor is refused too (spec names
 * only submit): clicking inside it would reset the form, which is no consent action.
 */
export function clickability(el: Element): AbsentReason | null {
  for (let n: Element | null = el; n; n = parentOf(n)) {
    const r = ownReason(n);
    if (r) return r;
  }
  return null;
}

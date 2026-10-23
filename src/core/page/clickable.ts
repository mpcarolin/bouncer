// §0 "Never navigate the user away": decides whether `.click()` on an element is safe.
// Read-only; never touches the page.
import type { AbsentReason } from "../types.ts";
import { parentOf } from "./dom.ts";

type LinkKind = "none" | "script" | "fragment" | "navigates";

/** Resolved href and effective target of an HTML `<a>`/`<area>` or an SVG `<a>`; null for others. */
function linkParts(el: Element): { href: string | null; target: string } | null {
  let target: string;
  if (el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement) {
    target = el.getAttribute("target") ?? "";
  } else if (el instanceof SVGAElement) {
    target = el.getAttribute("target") ?? "";
  } else {
    return null;
  }
  // An inherited <base target> applies when the link has no target of its own.
  if (target === "")
    target = el.ownerDocument.querySelector("base[target]")?.getAttribute("target") ?? "";
  const href = el.getAttribute("href") ?? el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  return { href, target: target.trim().toLowerCase() };
}

/** Classifies a link by its resolved URL, as the browser would follow it. */
function linkKind(el: Element): LinkKind {
  const p = linkParts(el);
  if (!p || p.href === null) return "none";
  let url: URL;
  try {
    url = new URL(p.href, el.baseURI);
  } catch {
    return "navigates";
  }
  if (url.protocol === "javascript:")
    return p.target === "" || p.target === "_self" ? "script" : "navigates";
  if (p.target !== "" && p.target !== "_self") return "navigates";
  const here = el.ownerDocument.URL.split("#")[0];
  // A `<base href>` elsewhere makes `#x` cross-document, which this comparison catches.
  if (url.href.includes("#") && url.href.split("#")[0] === here) return "fragment";
  return "navigates";
}

/** A link to a fragment of the current document: clickable only with the `#` guard. */
export function isFragmentLink(el: Element): boolean {
  return linkKind(el) === "fragment";
}

/** What activating this one element does by itself, ignoring its ancestors. */
function ownReason(el: Element): AbsentReason | null {
  const kind = linkKind(el);
  if (kind === "navigates") return "navigates";
  if (kind !== "none") return null;
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

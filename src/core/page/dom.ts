// Small DOM helpers shared by detection and serialisation. Read-only; never touches the page.

/** Elements that carry no visible text of their own. Skipped when reading text. */
const NON_TEXT = new Set(["SELECT", "OPTION", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/** Button-like controls: what a banner must contain at least one of. */
export const BUTTON_SEL = 'button, input[type="button"], input[type="submit"], [role="button"]';

export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Every match of `sel` under `root` (inclusive of `root`'s own shadow root), descending into
 * open shadow roots. Document order within each tree; shadow content follows its tree's own.
 */
export function deepAll(root: ParentNode, sel: string): Element[] {
  const out: Element[] = [];
  const walk = (r: ParentNode) => {
    out.push(...r.querySelectorAll(sel));
    if (r instanceof Element && r.shadowRoot) walk(r.shadowRoot);
    for (const el of r.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(root);
  return out;
}

/** The parent in the flattened-for-our-purposes tree: crosses an open shadow root to its host. */
export function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const p = el.parentNode;
  return p instanceof ShadowRoot ? p.host : null;
}

const VIS_OPTS = { opacityProperty: true, visibilityProperty: true } as const;

/** Not display:none, visibility:hidden or opacity:0, on the element or any ancestor. */
function renderedAndVisible(el: Element): boolean {
  if (typeof el.checkVisibility === "function") return el.checkVisibility(VIS_OPTS);
  for (let n: Element | null = el; n; n = parentOf(n)) {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || Number(cs.opacity) === 0) return false;
    if (n === el && cs.visibility === "hidden") return false;
  }
  return true;
}

/** Every open shadow root under `root` (nested ones included). */
export function shadowRootsOf(root: ParentNode): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const walk = (r: ParentNode) => {
    if (r instanceof Element && r.shadowRoot) {
      out.push(r.shadowRoot);
      walk(r.shadowRoot);
    }
    for (const el of r.querySelectorAll("*")) {
      if (el.shadowRoot) {
        out.push(el.shadowRoot);
        walk(el.shadowRoot);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Rendered text of `el`, descending into open shadow roots. Skips `<select>`/`<option>` (a
 * country list must not drown the real text) and subtrees that are not rendered or not
 * visible (`hidden`, display:none, visibility:hidden, opacity:0), so a hidden mega-menu
 * cannot match, fill the text budget or change the key. Whitespace is collapsed.
 */
export function textOf(el: Element): string {
  return textBelow(el, (n) => {
    if (NON_TEXT.has(n.tagName) || (n as HTMLElement).hidden) return true;
    // display:contents has no box of its own, so checkVisibility reports false for it.
    return getComputedStyle(n).display !== "contents" && !renderedAndVisible(n);
  });
}

/**
 * Text of `el` whether or not `el` is rendered (a label in a collapsed section or on a hidden
 * tab), leaving out what `el`'s own markup hides: `hidden`, `aria-hidden="true"`, display:none,
 * opacity 0, a visibility:hidden its parent doesn't have, and the elements `textOf` skips. A
 * label's hidden tooltip ("You can opt out") must not change what the toggle is taken to be.
 */
export function labelText(el: Element): string {
  return textBelow(el, (n) => {
    if (NON_TEXT.has(n.tagName) || (n as HTMLElement).hidden) return true;
    if (n.getAttribute("aria-hidden") === "true") return true;
    const cs = getComputedStyle(n);
    if (cs.display === "none" || Number(cs.opacity) === 0) return true;
    const parent = parentOf(n);
    return (
      cs.visibility !== "visible" && !!parent && getComputedStyle(parent).visibility === "visible"
    );
  });
}

/** Text below `el`, open shadow roots included, skipping descendants `skip` names. Collapsed. */
function textBelow(el: Element, skip: (n: Element) => boolean): string {
  const parts: string[] = [];
  const walk = (n: Node, isRoot: boolean) => {
    if (n.nodeType === Node.TEXT_NODE) {
      parts.push(n.nodeValue ?? "");
      return;
    }
    if (n instanceof Element && !isRoot && skip(n)) return;
    if (n instanceof Element && n.shadowRoot) walk(n.shadowRoot, false);
    for (const c of n.childNodes) walk(c, false);
    // Keep adjacent blocks from fusing into one word.
    parts.push(" ");
  };
  walk(el, true);
  return collapse(parts.join(""));
}

export function isVisible(el: Element): boolean {
  if (el.getClientRects().length === 0 || !renderedAndVisible(el)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

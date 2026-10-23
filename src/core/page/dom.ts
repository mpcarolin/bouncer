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

/**
 * Rendered text of `el`, descending into open shadow roots and ignoring `<select>`/`<option>`
 * (a country list must not drown the real text). Whitespace is collapsed.
 */
export function textOf(el: Element): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      parts.push(n.nodeValue ?? "");
      return;
    }
    if (n instanceof Element) {
      if (NON_TEXT.has(n.tagName)) return;
      if (n.shadowRoot) walk(n.shadowRoot);
    }
    for (const c of n.childNodes) walk(c);
    // Keep adjacent blocks from fusing into one word.
    parts.push(" ");
  };
  walk(el);
  return collapse(parts.join(""));
}

export function isVisible(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

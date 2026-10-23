// Hiding a banner without touching what verification reads. The rule only sets `clip-path`
// and `pointer-events`, so `display`, `visibility`, `opacity` and size stay the site's to change.

const ATTR = "data-bouncer-hidden";
const RULE = `[${ATTR}]{clip-path:inset(100%)!important;pointer-events:none!important}`;
/** Nodes that render nothing and so are not "content" of a shadow root or host. */
const INERT = new Set(["STYLE", "SCRIPT", "LINK", "TEMPLATE", "META", "NOSCRIPT"]);

type Root = Document | ShadowRoot;

function isInert(n: Node): boolean {
  if (n.nodeType === Node.COMMENT_NODE) return true;
  if (n.nodeType === Node.TEXT_NODE) return !(n.nodeValue ?? "").trim();
  return n instanceof Element && INERT.has(n.tagName);
}

/** True when, at every level from `el` up to `root`, `el`'s branch is the only content. */
function isSoleContent(el: Element, root: ShadowRoot): boolean {
  let n: Node = el;
  while (n.parentNode) {
    const parent: Node = n.parentNode;
    for (const sib of parent.childNodes) if (sib !== n && !isInert(sib)) return false;
    if (parent === root) break;
    n = parent;
  }
  // Light-DOM children of the host would be slotted content: the host holds more than us.
  for (const c of root.host.childNodes) if (!isInert(c)) return false;
  return true;
}

export class Hider {
  private readonly hidden = new Set<Element>();
  private readonly styles = new Map<Root, HTMLStyleElement>();

  hide(el: Element, root: Root): void {
    this.mark(el, root);
    // Climb through hosts, but only while each is wholly the banner's.
    let node = el;
    let r = root;
    while (r instanceof ShadowRoot && isSoleContent(node, r)) {
      const host = r.host;
      const hostRoot = host.getRootNode();
      if (!(hostRoot instanceof Document || hostRoot instanceof ShadowRoot)) break;
      this.mark(host, hostRoot);
      node = host;
      r = hostRoot;
    }
  }

  unhideAll(): void {
    for (const el of this.hidden) el.removeAttribute(ATTR);
    this.hidden.clear();
    for (const s of this.styles.values()) s.remove();
    this.styles.clear();
  }

  hiddenCount(): number {
    return this.hidden.size;
  }

  private mark(el: Element, root: Root): void {
    this.ensureStyle(root);
    el.setAttribute(ATTR, "");
    this.hidden.add(el);
  }

  private ensureStyle(root: Root): void {
    const have = this.styles.get(root);
    if (have?.isConnected) return;
    const style = (root.ownerDocument ?? (root as Document)).createElement("style");
    style.setAttribute("data-bouncer", "");
    style.textContent = RULE;
    const parent = root instanceof Document ? (root.head ?? root.documentElement) : root;
    parent.append(style);
    this.styles.set(root, style);
  }
}

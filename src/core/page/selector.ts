// Stable selectors for learned rules (§2h): recording a control relative to its banner or panel,
// and finding it again on a later visit. Read-only; never touches the page.
import type { LearnedStage, LearnedToggle, TargetRef } from "../learned.ts";
import type { Label } from "../types.ts";

/** Steps into an open shadow root: the next segment is resolved in the shadow root found. */
const SHADOW = " >>> ";
const CHILD = " > ";
const SCOPE = ":scope";
/** The attributes, besides `data-*`, kept in a path step. */
const NAMED_ATTRS = new Set(["aria-label", "name", "role", "type"]);
/** What a toggle's path keeps: its state shows in `data-*` and often its `aria-label`. */
const TOGGLE_ATTRS = new Set(["name", "role", "type"]);
const MAX_ATTR_CHARS = 100;
/**
 * `data-*` attributes that carry UI state, not identity (Radix's `data-state`, Headless UI's
 * `data-headlessui-state`, React Aria's `data-focused`/`data-hovered`/`data-pressed`, …): they
 * change as the page is used, and Bouncer's own clicks change them.
 */
const STATE_ATTR =
  /^data-(?:[\w-]+-)?(?:state|checked|unchecked|selected|active|current|focus|focused|focus-visible|focus-within|hover|hovered|press|pressed|open|opened|closed|expanded|collapsed|highlighted|disabled|loading|visible|hidden|value|index)$/;

/**
 * An id, attribute name or attribute value a framework or build generated, which may differ on
 * the next visit: digits first or a long run of them, React's `:r1:`, a hash (Vue's
 * `data-v-7ba5bd90`), a random token, and a few frameworks' counters.
 */
export function looksGenerated(v: string): boolean {
  if (/^\d|\d{5,}|:/.test(v)) return true;
  if (/^(?:ember\d|headlessui-|radix-|react-aria|mui-\d)/i.test(v)) return true;
  if ((v.match(/[0-9a-f]{8,}/gi) ?? []).some((run) => /\d/.test(run))) return true;
  return v.split(/[-_]/).some((t) => t.length >= 10 && /\d.*\d/.test(t) && /[a-z]/i.test(t));
}

/** `#id` when the element's id is stable and unique in its own tree (document or shadow root). */
function stableId(el: Element): string | undefined {
  const id = el.id;
  if (!id || looksGenerated(id)) return undefined;
  const sel = `#${CSS.escape(id)}`;
  const scope = el.getRootNode() as ParentNode;
  return scope.querySelectorAll(sel).length === 1 ? sel : undefined;
}

function keepAttr(name: string, value: string, toggle: boolean): boolean {
  if (value.length > MAX_ATTR_CHARS) return false;
  if (toggle) return TOGGLE_ATTRS.has(name);
  if (NAMED_ATTRS.has(name)) return true;
  return (
    name.startsWith("data-") &&
    !name.startsWith("data-bouncer") &&
    !STATE_ATTR.test(name) &&
    !looksGenerated(name) &&
    !looksGenerated(value)
  );
}

function attrsOf(el: Element, toggle: boolean): string {
  return [...el.attributes]
    .filter((a) => keepAttr(a.name, a.value, toggle))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((a) => `[${CSS.escape(a.name)}="${CSS.escape(a.value)}"]`)
    .join("");
}

/** Tag, stable attributes and `:nth-of-type` among the element's siblings. */
function stepFor(el: Element, toggle: boolean): string {
  let n = 1;
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
    if (s.localName === el.localName) n++;
  }
  return `${CSS.escape(el.localName)}${attrsOf(el, toggle)}:nth-of-type(${n})`;
}

export interface SelectorOptions {
  /**
   * For a toggle: the path keeps only tag, `name`, `type` and `role`. A toggle's text and label
   * carry its identity; its attributes (`data-state`, an `aria-label` naming the state) change
   * with the state it is in.
   */
  toggle?: boolean;
}

/**
 * A stable selector for `el` relative to `root`: `#id` when the id is stable and unique in its
 * tree, else a child path from `root` (`:scope > tag[attrs]:nth-of-type(n) > …`), anchored at
 * the nearest ancestor with such an id. ` >>> ` steps into an open shadow root. Without a shadow
 * root in the way it is plain CSS for `root.querySelectorAll`. Throws if `el` is not under `root`.
 */
export function selectorFor(el: Element, root: Element, o: SelectorOptions = {}): string {
  const toggle = o.toggle === true;
  const segments: string[] = [];
  let steps: string[] = [];
  let n = el;
  for (;;) {
    if (n === root) {
      segments.unshift([SCOPE, ...steps].join(CHILD));
      break;
    }
    const id = stableId(n);
    if (id) {
      segments.unshift([id, ...steps].join(CHILD));
      steps = [];
      const tree = n.getRootNode();
      if (tree === root.getRootNode()) break; // the id anchors in root's own tree
      if (!(tree instanceof ShadowRoot)) throw new Error("selectorFor: not under the root");
      n = tree.host;
      continue;
    }
    steps.unshift(stepFor(n, toggle));
    if (n.parentElement) {
      n = n.parentElement;
      continue;
    }
    const parent = n.parentNode;
    if (!(parent instanceof ShadowRoot)) throw new Error("selectorFor: not under the root");
    segments.unshift(steps.join(CHILD));
    steps = [];
    n = parent.host;
  }
  return segments.join(SHADOW);
}

// The grammar `selectorFor` writes, and the only one `resolveSelector` accepts: an identifier
// as `CSS.escape` writes it, `#id`, and `tag[name="value"]…:nth-of-type(n)`. Anything else (a
// selector list, a descendant combinator, a pseudo-class) finds nothing.
const IDENT = String.raw`(?:[\w\-\u{80}-\u{10FFFF}]|\\[0-9a-fA-F]{1,6} |\\[^0-9a-fA-F\n])+`;
const ID_STEP = new RegExp(`^#${IDENT}$`, "u");
const PATH_STEP = new RegExp(
  String.raw`^${IDENT}(?:\[${IDENT}="(?:[^"\\\n]|\\.)*"\])*:nth-of-type\(\d+\)$`,
  "u",
);

const childrenOf = (scope: ParentNode) => [...scope.children];

/**
 * One segment in `scope`: from the root itself (`:scope`, first segment only), from an `#id`
 * below the scope, or (later segments) from the shadow root's children. Malformed: nothing.
 */
function resolveSegment(scope: ParentNode, segment: string, root: Element | null): Element[] {
  const [first, ...rest] = segment.split(CHILD);
  if (first === undefined || !rest.every((s) => PATH_STEP.test(s))) return [];
  let found: Element[];
  if (first === SCOPE && root) found = [root];
  else if (ID_STEP.test(first)) found = [...scope.querySelectorAll(first)];
  else if (!root && PATH_STEP.test(first))
    found = childrenOf(scope).filter((c) => c.matches(first));
  else return [];
  for (const step of rest)
    found = found.flatMap((f) => childrenOf(f).filter((c) => c.matches(step)));
  return found;
}

/**
 * The elements `selector` (from `selectorFor`) names under `root`, in order. Never anything
 * outside `root`. A selector outside the grammar, or one that crosses into a missing shadow
 * root, finds nothing.
 */
export function resolveSelector(root: Element, selector: string): Element[] {
  try {
    let scope: ParentNode = root;
    let found: Element[] = [];
    const segments = selector.split(SHADOW);
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        const host = found.length === 1 ? found[0] : undefined;
        if (!host?.shadowRoot) return [];
        scope = host.shadowRoot;
      }
      found = resolveSegment(scope, segments[i] as string, i === 0 ? root : null);
    }
    return found;
  } catch {
    return [];
  }
}

/** A control as the flow found it, just before acting. */
export interface Seen {
  el: Element;
  text: string;
}

/**
 * One stage, recorded just before it acts, while the page is as a fresh visit will find it.
 * `toggles` are every toggle-optional and toggle-optout in `root`, with their target states.
 * Every selector must resolve back to its own element, or nothing is recorded (undefined).
 */
export function recordStage<A extends LearnedStage["action"]>(
  root: Element,
  action: A,
  target: Seen,
  toggles: readonly (Seen & { label: Label; to: boolean })[] = [],
): { action: A; target: TargetRef; toggles?: LearnedToggle[] } | undefined {
  try {
    const ref = (el: Element, text: string, label: Label, toggle: boolean) => {
      const selector = selectorFor(el, root, { toggle });
      const back = resolveSelector(root, selector);
      return back.length === 1 && back[0] === el ? { selector, text, label } : undefined;
    };
    const t = ref(target.el, target.text, action, false);
    if (!t) return undefined;
    if (toggles.length === 0) return { action, target: t };
    const refs: LearnedToggle[] = [];
    for (const x of toggles) {
      const r = ref(x.el, x.text, x.label, true);
      if (!r) return undefined;
      refs.push({ ref: r, to: x.to });
    }
    return { action, target: t, toggles: refs };
  } catch {
    return undefined;
  }
}

/**
 * A document-anchored selector for `el`, for a rule's `banner.locator`: only when it is anchored
 * at a stable id (a position from `<html>` changes with the page) and finds `el` again.
 */
export function locatorFor(el: Element): string | undefined {
  try {
    const html = el.ownerDocument.documentElement;
    const sel = selectorFor(el, html);
    const back = resolveSelector(html, sel);
    return sel.startsWith("#") && back.length === 1 && back[0] === el ? sel : undefined;
  } catch {
    return undefined;
  }
}

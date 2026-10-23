// §2h: learned rules. After a verified, deterministic refusal on Bouncer's own path, what worked
// is kept as a local per-site rule: each target control by selector, expected text and label, and
// each toggle's target state (never a click). The replay is in pipeline/replay.ts.
import type { LogEntry } from "./log.ts";
import type { KV } from "./platform.ts";
import type { Label } from "./types.ts";

/** A control, by selector relative to the banner (stage 1) or the panel (stage 2). */
export interface TargetRef {
  selector: string;
  text: string;
  label: Label;
}

/** A toggle and the state it must end in: off, or on for a toggle-optout. */
export interface LearnedToggle {
  ref: TargetRef;
  to: boolean;
}

/**
 * One site's rule. Stage 1 acts in the banner; stage 2, after a settings click, in the panel that
 * opened. Toggles go with a save, and only with one.
 *
 * The format can be exported to autoconsent's rules later: a selector is CSS relative to its root
 * (`:scope` stands for the root), with ` >>> ` stepping into an open shadow root, which is what
 * autoconsent's selector arrays express.
 */
export interface LearnedRule {
  site: string;
  createdAt: number;
  stage1: { action: "reject" | "settings" | "save"; target: TargetRef; toggles?: LearnedToggle[] };
  stage2?: { action: "reject" | "save"; target: TargetRef; toggles?: LearnedToggle[] };
}

export type Stage1 = LearnedRule["stage1"];
export type Stage2 = NonNullable<LearnedRule["stage2"]>;
export type LearnedStage = Stage1 | Stage2;

/**
 * A flow's stages, each recorded by `recordStage` just before it acted: the page as the next
 * visit will find it, not as Bouncer's own clicks and the site's dismissal left it.
 */
export interface RecordedFlow {
  stage1: Stage1;
  stage2?: Stage2;
}

/**
 * True for an own-path flow (the AI path or the fast path) that ended in a verified `dismissed`
 * with no click relying on an AI-only label. Never `dismissed_close`, `dismissed_agreed`, a
 * failure, or a replay, which is not saved again.
 */
export function learnable(
  e: Pick<LogEntry, "outcome" | "path" | "clicked" | "verification">,
): boolean {
  return (
    e.outcome === "dismissed" &&
    (e.path === "ai" || e.path === "heuristic") &&
    e.verification === "verified" &&
    e.clicked.length > 0 &&
    e.clicked.every((c) => !c.aiOnly)
  );
}

/** The rule for `site` from a flow's recorded stages. */
export function recordRule(site: string, flow: RecordedFlow, now = Date.now()): LearnedRule {
  return flow.stage2
    ? { site, createdAt: now, stage1: flow.stage1, stage2: flow.stage2 }
    : { site, createdAt: now, stage1: flow.stage1 };
}

// --- validation: a stored or received rule is checked before anything trusts it ---

type Loose = Record<string, unknown>;
const isObject = (x: unknown): x is Loose => typeof x === "object" && x !== null;

function isRef(x: unknown): x is TargetRef {
  return (
    isObject(x) &&
    typeof x.selector === "string" &&
    x.selector !== "" &&
    typeof x.text === "string" &&
    typeof x.label === "string"
  );
}

/** Only toggle-optional off and toggle-optout on: a rule can never switch anything else. */
function isToggle(x: unknown): x is LearnedToggle {
  if (!isObject(x) || !isRef(x.ref)) return false;
  const { label } = x.ref;
  return (
    (label === "toggle-optional" && x.to === false) || (label === "toggle-optout" && x.to === true)
  );
}

/** The target's label is the action; toggles come with a save, and a save has some. */
function isStage(x: unknown, actions: readonly string[]): boolean {
  if (!isObject(x) || typeof x.action !== "string" || !actions.includes(x.action)) return false;
  if (!isRef(x.target) || x.target.label !== x.action) return false;
  const toggles = x.toggles;
  if (x.action !== "save") return toggles === undefined;
  return Array.isArray(toggles) && toggles.length > 0 && toggles.every(isToggle);
}

/** A well-formed rule: stage 2 exactly when stage 1 opens settings. */
export function isLearnedRule(x: unknown): x is LearnedRule {
  if (!isObject(x) || typeof x.site !== "string" || x.site === "") return false;
  if (typeof x.createdAt !== "number" || !Number.isFinite(x.createdAt)) return false;
  if (!isStage(x.stage1, ["reject", "settings", "save"])) return false;
  const hop = (x.stage1 as Loose).action === "settings";
  return hop ? isStage(x.stage2, ["reject", "save"]) : x.stage2 === undefined;
}

// --- storage ---

const KEY = "learnedRules";

/**
 * The learned rules, one per site, in local storage. Invalid entries are dropped on read.
 * Read-modify-write cycles are serialised, so rules saved from several tabs at once all land.
 */
export class LearnedRules {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KV) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<Map<string, LearnedRule>> {
    const stored = await this.kv.get<unknown>(KEY);
    const out = new Map<string, LearnedRule>();
    if (!isObject(stored)) return out;
    for (const [site, r] of Object.entries(stored)) {
      if (isLearnedRule(r) && r.site === site) out.set(site, r);
    }
    return out;
  }

  private save(all: Map<string, LearnedRule>): Promise<void> {
    return this.kv.set(KEY, Object.fromEntries(all));
  }

  get(site: string): Promise<LearnedRule | undefined> {
    return this.serial(async () => (await this.load()).get(site));
  }

  /** Replaces the site's rule. Throws for a rule that is not well-formed. */
  put(r: LearnedRule): Promise<void> {
    return this.serial(async () => {
      if (!isLearnedRule(r)) throw new TypeError("not a well-formed learned rule");
      const all = await this.load();
      all.set(r.site, r);
      await this.save(all);
    });
  }

  remove(site: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.load();
      if (all.delete(site)) await this.save(all);
    });
  }

  list(): Promise<LearnedRule[]> {
    return this.serial(async () => [...(await this.load()).values()]);
  }
}

// --- selectors (DOM) ---

/** Steps into an open shadow root: the next segment is resolved in the shadow root found. */
const SHADOW = " >>> ";
const CHILD = " > ";
const SCOPE = ":scope";
/** The attributes, besides `data-*`, kept in a path step. */
const NAMED_ATTRS = new Set(["aria-label", "name", "role", "type"]);
const MAX_ATTR_CHARS = 100;

/**
 * An id or attribute value a framework or build generated, which may differ on the next visit:
 * digits first or a long run of them, React's `:r1:`, a hash, a random token, and a few
 * frameworks' counters.
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

function attrsOf(el: Element): string {
  return [...el.attributes]
    .filter((a) => {
      if (a.value.length > MAX_ATTR_CHARS) return false;
      if (NAMED_ATTRS.has(a.name)) return true;
      return (
        a.name.startsWith("data-") && !a.name.startsWith("data-bouncer") && !looksGenerated(a.value)
      );
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((a) => `[${CSS.escape(a.name)}="${CSS.escape(a.value)}"]`)
    .join("");
}

/** Tag, stable attributes and `:nth-of-type` among the element's siblings. */
function stepFor(el: Element): string {
  let n = 1;
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
    if (s.localName === el.localName) n++;
  }
  return `${CSS.escape(el.localName)}${attrsOf(el)}:nth-of-type(${n})`;
}

/**
 * A stable selector for `el` relative to `root`: `#id` when the id is stable and unique in its
 * tree, else a child path from `root` (`:scope > tag[attrs]:nth-of-type(n) > …`), anchored at
 * the nearest ancestor with such an id. ` >>> ` steps into an open shadow root. Without a shadow
 * root in the way it is plain CSS for `root.querySelectorAll`. Throws if `el` is not under `root`.
 */
export function selectorFor(el: Element, root: Element): string {
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
    steps.unshift(stepFor(n));
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

const childrenOf = (scope: ParentNode) => [...scope.children];

/** Resolves one segment in `scope`: the root itself (`:scope`), an `#id` below it, or its children. */
function resolveSegment(scope: ParentNode, segment: string, root: Element | null): Element[] {
  const [first, ...rest] = segment.split(CHILD);
  if (first === undefined) return [];
  let found: Element[];
  if (first === SCOPE) found = root ? [root] : [];
  else if (first.startsWith("#")) found = [...scope.querySelectorAll(first)];
  else found = childrenOf(scope).filter((c) => c.matches(first));
  for (const step of rest)
    found = found.flatMap((f) => childrenOf(f).filter((c) => c.matches(step)));
  return found;
}

/**
 * The elements `selector` (from `selectorFor`) names under `root`, in order. A selector that
 * crosses into a missing shadow root, or is malformed, finds nothing.
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
    const ref = (el: Element, text: string, label: Label): TargetRef | undefined => {
      const selector = selectorFor(el, root);
      const back = resolveSelector(root, selector);
      return back.length === 1 && back[0] === el ? { selector, text, label } : undefined;
    };
    const t = ref(target.el, target.text, action);
    if (!t) return undefined;
    if (toggles.length === 0) return { action, target: t };
    const refs: LearnedToggle[] = [];
    for (const x of toggles) {
      const r = ref(x.el, x.text, x.label);
      if (!r) return undefined;
      refs.push({ ref: r, to: x.to });
    }
    return { action, target: t, toggles: refs };
  } catch {
    return undefined;
  }
}

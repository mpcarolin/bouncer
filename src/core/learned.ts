// §2h: learned rules. After a verified, deterministic refusal on Bouncer's own path, what worked
// is kept as a local per-site rule: the banner it worked on, each target control by selector,
// expected text and label, and each toggle's target state (never a click). This file is the
// format, its validation and its storage, and is loaded by the service worker too; recording
// selectors is page/selector.ts's, and the replay is pipeline/replay.ts's.
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
 * Which candidate a rule is for. A selector relative to the banner says nothing about which
 * banner, so a replay applies only to a candidate whose visible buttons and links, as
 * `${label}|${normalised text}` with deterministic labels (`other` where the rules leave one to
 * the AI), sorted, are exactly `controls`, and whose text has cookie or consent wording.
 * `locator` is a document-anchored selector for the banner, kept when it is anchored at a stable
 * id, for a later export to autoconsent's `detectPopup`; a replay doesn't require it.
 */
export interface LearnedBanner {
  controls: string[];
  locator?: string;
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
  banner: LearnedBanner;
  stage1: { action: "reject" | "settings" | "save"; target: TargetRef; toggles?: LearnedToggle[] };
  stage2?: { action: "reject" | "save"; target: TargetRef; toggles?: LearnedToggle[] };
}

export type Stage1 = LearnedRule["stage1"];
export type Stage2 = NonNullable<LearnedRule["stage2"]>;
export type LearnedStage = Stage1 | Stage2;

/**
 * A flow as recorded just before each part of it acted (page/selector.ts's `recordStage`): the
 * page as the next visit will find it, not as Bouncer's own clicks and the site's dismissal
 * left it.
 */
export interface RecordedFlow {
  banner: LearnedBanner;
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

/** The rule for `site` from a recorded flow. */
export function recordRule(site: string, flow: RecordedFlow, now = Date.now()): LearnedRule {
  const { banner, stage1, stage2 } = flow;
  return stage2
    ? { site, createdAt: now, banner, stage1, stage2 }
    : { site, createdAt: now, banner, stage1 };
}

// --- validation: a stored or received rule is checked before anything trusts it ---

type Loose = Record<string, unknown>;
const isObject = (x: unknown): x is Loose => typeof x === "object" && x !== null;

const LABELS: Record<Label, true> = {
  accept: true,
  reject: true,
  settings: true,
  save: true,
  close: true,
  acknowledge: true,
  link: true,
  "toggle-optional": true,
  "toggle-optout": true,
  "toggle-necessary": true,
  other: true,
};

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

/** `${label}|${text}` for a known label. */
function isControlKey(x: unknown): boolean {
  if (typeof x !== "string") return false;
  const bar = x.indexOf("|");
  return bar > 0 && Object.hasOwn(LABELS, x.slice(0, bar));
}

function isBanner(x: unknown): x is LearnedBanner {
  if (!isObject(x) || !Array.isArray(x.controls) || x.controls.length === 0) return false;
  if (!x.controls.every(isControlKey)) return false;
  return x.locator === undefined || (typeof x.locator === "string" && x.locator !== "");
}

/** A well-formed rule: a banner fingerprint, and stage 2 exactly when stage 1 opens settings. */
export function isLearnedRule(x: unknown): x is LearnedRule {
  if (!isObject(x) || typeof x.site !== "string" || x.site === "") return false;
  if (typeof x.createdAt !== "number" || !Number.isFinite(x.createdAt)) return false;
  if (!isBanner(x.banner)) return false;
  if (!isStage(x.stage1, ["reject", "settings", "save"])) return false;
  const hop = (x.stage1 as Loose).action === "settings";
  return hop ? isStage(x.stage2, ["reject", "save"]) : x.stage2 === undefined;
}

// --- storage ---

const ruleKey = (site: string) => `learnedRule:${site}`;
/** The sites that have a rule, for `list()`: always a superset of the stored rules. */
const INDEX_KEY = "learnedRuleSites";

/**
 * The learned rules in local storage, one key per site (`learnedRule:<site>`), so `get` (what
 * `hello` needs) reads one key. Invalid entries are ignored on read. Writes are serialised, and
 * the site index is written before a rule is stored and after one is removed, so it never misses
 * a stored rule.
 */
export class LearnedRules {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KV) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sites(): Promise<string[]> {
    const stored = await this.kv.get<unknown>(INDEX_KEY);
    return Array.isArray(stored) ? stored.filter((s): s is string => typeof s === "string") : [];
  }

  async get(site: string): Promise<LearnedRule | undefined> {
    const r = await this.kv.get<unknown>(ruleKey(site));
    return isLearnedRule(r) && r.site === site ? r : undefined;
  }

  /** Replaces the site's rule. Throws for a rule that is not well-formed. */
  put(r: LearnedRule): Promise<void> {
    return this.serial(async () => {
      if (!isLearnedRule(r)) throw new TypeError("not a well-formed learned rule");
      const sites = await this.sites();
      if (!sites.includes(r.site)) await this.kv.set(INDEX_KEY, [...sites, r.site]);
      await this.kv.set(ruleKey(r.site), r);
    });
  }

  remove(site: string): Promise<void> {
    return this.serial(async () => {
      await this.kv.remove(ruleKey(site));
      const sites = await this.sites();
      if (sites.includes(site))
        await this.kv.set(
          INDEX_KEY,
          sites.filter((s) => s !== site),
        );
    });
  }

  /**
   * Removes the site's rule and nothing else: for a caller that is not the background (the
   * settings page). The index is the background's to rewrite, and its write queue doesn't cover
   * this caller, so the index keeps a stale entry, which `list()` skips and the next `put` or
   * `remove` for the site settles.
   */
  removeRuleOnly(site: string): Promise<void> {
    return this.kv.remove(ruleKey(site));
  }

  list(): Promise<LearnedRule[]> {
    return this.serial(async () => {
      const out: LearnedRule[] = [];
      for (const site of await this.sites()) {
        const r = await this.get(site);
        if (r) out.push(r);
      }
      return out;
    });
  }
}

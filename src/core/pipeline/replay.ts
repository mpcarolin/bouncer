// §2h: replaying a learned rule stage by stage, with every §0 guard and no model calls. What is
// the rule's own lives here: which banner it is for, the checks before each stage, and what each
// stage clicks. The claim, the hiding, §2g's verification and the ending are the own path's
// (`OwnPath.act`), the same as for a decision the chooser made; the settings hop and the save are
// settings-hop.ts's.
import { labelDeterministic } from "../label.ts";
import type { LearnedBanner, LearnedRule, LearnedStage, Stage2 } from "../learned.ts";
import { clickability } from "../page/clickable.ts";
import { CONSENT_WORDING } from "../page/detect.ts";
import { locatorFor, resolveSelector } from "../page/selector.ts";
import { type Serialised, serialise, shownOnly } from "../page/serialise.ts";
import { readToggle } from "../page/toggles.ts";
import { normalise } from "../text/normalise.ts";
import type { Outcome } from "../types.ts";
import {
  clickTarget,
  type HopResult,
  type PanelRefusal,
  type Plan,
  type Refuse,
  refuseInPanel,
  saveWithToggles,
  settingsHop,
  wantedToggles,
} from "./settings-hop.ts";

const POLL_MS = 100;

/**
 * The candidate's visible buttons and links as `${label}|${normalised text}`, sorted, labelled
 * as stage 1's chooser labels them (deterministically; `other` where the rules leave a control
 * to the AI). `full` is the candidate serialised with its hidden toggles.
 */
export function bannerControls(full: Serialised): string[] {
  const shown = shownOnly(full);
  const labels = labelDeterministic(shown.banner);
  return shown.banner.controls
    .filter((c) => c.role === "button" || c.role === "link")
    .map((c) => `${labels.get(c.id)?.label ?? "other"}|${normalise(c.text)}`)
    .sort();
}

/**
 * What a rule keeps of the banner it was learned on: its controls, and its locator when stable.
 * Undefined when a replay could never match it (no cookie or consent wording, no controls).
 */
export function recordBanner(el: Element, full: Serialised): LearnedBanner | undefined {
  if (!CONSENT_WORDING.test(full.banner.text)) return undefined;
  const controls = bannerControls(full);
  if (controls.length === 0) return undefined;
  const locator = locatorFor(el);
  return locator ? { controls, locator } : { controls };
}

/**
 * `checkBanner`'s reasons: the candidate is not the rule's banner, which says nothing against the
 * rule. Every other mismatch is the rule's banner no longer fitting the rule.
 */
export const NOT_THE_BANNER: ReadonlySet<string> = new Set([
  "no_consent_wording",
  "banner_changed",
]);

/**
 * Why the rule is not for this candidate, or undefined when it is: the candidate must have cookie
 * or consent wording and exactly the rule's controls. A newsletter modal or age gate built from
 * the same component, whose "No thanks" sits where the banner's reject did, fails this.
 */
export function checkBanner(banner: LearnedBanner, full: Serialised): string | undefined {
  if (!CONSENT_WORDING.test(full.banner.text)) return "no_consent_wording";
  const now = bannerControls(full);
  const same =
    now.length === banner.controls.length && now.every((c, i) => c === banner.controls[i]);
  return same ? undefined : "banner_changed";
}

/** The rule against this candidate: its banner, then stage 1. */
function checkRule(rule: LearnedRule, banner: Element, full: Serialised): StageCheck {
  const other = checkBanner(rule.banner, full);
  return other ? { ok: false, reason: other } : checkStage(rule.stage1, banner, full, true);
}

const serialiseFull = (el: Element) => serialise({ el }, clickability, { hiddenToggles: true });

/** A stage's controls, found in its root and checked: their ids in the root's serialisation. */
export interface Checked {
  ser: Serialised;
  target: number;
  toggles: { id: number; to: boolean }[];
}

export type StageCheck = ({ ok: true } & Checked) | { ok: false; reason: string };

/**
 * §2h's checks of one stage in `root` (the banner, or the panel), which `ser` serialises with its
 * hidden toggles. Reads only. The click target must be found by its selector, be visible, read as
 * recorded, be clickable without navigating, and get its recorded label again from the
 * deterministic labeller with no §0 block (so an accept-all control never passes). Each toggle
 * must be found, have a readable state and its recorded (deterministic) label; it may be hidden.
 * A save's toggles must be every toggle-optional and toggle-optout the root has: one the rule
 * doesn't know means the page changed. With `shownLabels`, the target is labelled as stage 1's
 * chooser saw the banner: from its visible controls only.
 */
export function checkStage(
  stage: LearnedStage,
  root: Element,
  ser: Serialised,
  shownLabels: boolean,
): StageCheck {
  const fail = (reason: string): StageCheck => ({ ok: false, reason });
  const find = (selector: string) => {
    const found = resolveSelector(root, selector);
    return found.length === 1 ? found[0] : undefined;
  };
  const idOf = (el: Element) => {
    for (const [id, e] of ser.elements) if (e === el) return id;
    return undefined;
  };

  const el = find(stage.target.selector);
  if (!el) return fail("target_missing");
  const id = idOf(el);
  const control = ser.banner.controls.find((c) => c.id === id);
  // Only visible buttons and links are serialised: one that isn't was not visible.
  if (id === undefined || !control || control.hidden) return fail("target_hidden");
  if (control.text !== stage.target.text) return fail("text_changed");
  if (control.absent) return fail(`absent_${control.absent}`);
  const labels = labelDeterministic((shownLabels ? shownOnly(ser) : ser).banner);
  const got = labels.get(id);
  if (got?.blocked) return fail(`blocked_${got.blocked}`);
  if (got?.label !== stage.target.label) return fail("label_changed");

  const toggleLabels = shownLabels ? labelDeterministic(ser.banner) : labels;
  const toggles: Checked["toggles"] = [];
  for (const t of stage.toggles ?? []) {
    const tel = find(t.ref.selector);
    const tid = tel && idOf(tel);
    if (!tel || tid === undefined) return fail("toggle_missing");
    if (readToggle(tel) === null) return fail("toggle_unreadable");
    if (toggleLabels.get(tid)?.label !== t.ref.label) return fail("toggle_label_changed");
    toggles.push({ id: tid, to: t.to });
  }
  if (stage.action === "save") {
    const covered = new Set(toggles.map((t) => t.id));
    if (wantedToggles(ser).some((w) => !covered.has(w.id))) return fail("toggle_unrecorded");
  }
  return { ok: true, ser, target: id, toggles };
}

export interface ReplayDeps {
  /** The candidate, and its serialisation with hidden toggles. */
  banner: Element;
  full: Serialised;
  /**
   * §2b's claim wait: how the run ends if Bouncer must stand down (autoconsent took the page, or
   * the pipeline was stopped), else undefined once it may claim.
   */
  wait(): Promise<{ outcome: Outcome; reason?: string } | undefined>;
  /**
   * The own path's machinery: claim the page (standing down if refused), hide the banner,
   * perform `plan`, verify, and say how it ended. Called only once the checks have passed, after
   * the wait.
   */
  act(plan: Plan): Promise<{ outcome: Outcome; reason?: string }>;
}

/**
 * How a replay ended. `discard_and_run_pipeline`: the candidate is not the rule's banner, or
 * stage 1 failed its checks, before anything was touched (before or after the claim wait); the
 * full pipeline decides on it.
 */
export type ReplayResult =
  | { outcome: Outcome; reason?: string }
  | { outcome: "discard_and_run_pipeline"; reason: string };

/**
 * §2h's five steps for `rule` on one candidate, once it is the rule's banner (`checkBanner`):
 * check stage 1 before any action; act (through `d.act`, so only after the claim); after a
 * settings click, wait up to the panel window for stage 2's targets and check them, any failure
 * from there on being `failed`; set toggles to their target states, clicking only those that
 * differ; re-read them (§2f.2) before saving; and verify (§2g). No model call is made.
 *
 * The checks run when the candidate appears and again after the claim wait: a banner that
 * changed during the wait, with nothing touched yet, goes to the pipeline like one that never fit.
 */
export async function replay(rule: LearnedRule, d: ReplayDeps): Promise<ReplayResult> {
  const first = checkRule(rule, d.banner, d.full);
  if (!first.ok) return { outcome: "discard_and_run_pipeline", reason: first.reason };
  const stood = await d.wait();
  if (stood) return stood;
  const now = checkRule(rule, d.banner, serialiseFull(d.banner));
  if (!now.ok) return { outcome: "discard_and_run_pipeline", reason: now.reason };
  return d.act(planFor(rule, d.banner, now));
}

function planFor(rule: LearnedRule, banner: Element, first: Checked): Plan {
  const target = first.ser.elements.get(first.target);
  let now = first;
  return {
    // The banner's and stage 1's checks again, toggles and all, on the same target: the claim
    // wait gave the site time to change the banner, and a replay has no gate to fall back on.
    fresh: () => {
      const again = checkRule(rule, banner, serialiseFull(banner));
      if (!again.ok || again.ser.elements.get(again.target) !== target) return false;
      now = again;
      return true;
    },
    dismissed: "dismissed",
    perform: async (deps) => {
      const { ser, target: id, toggles } = now;
      switch (rule.stage1.action) {
        case "reject":
          return clickTarget(ser, id, banner, false, deps);
        case "save":
          return saveWithToggles({ kind: "save", target: id, toggles }, ser, banner, false, deps);
        case "settings": {
          const ctx = { banner, ser, target: id, aiOnly: false, deps };
          const hop = await settingsHop(ctx, byRule(rule.stage2));
          return hop.ok ? { ok: true, panel: hop.panel, panelKey: hop.panelKey } : hop;
        }
      }
    },
  };
}

/**
 * Stage 2 by the rule: poll its checks in the panel until they pass or the window from the
 * settings click closes (the panel may show before its controls render), then refuse there.
 */
function byRule(stage2: Stage2 | undefined): Refuse {
  return async (panel, { deps }, until): Promise<HopResult> => {
    const fail = (reason: string): HopResult => ({ ok: false, reason, panel });
    if (!stage2) return fail("stage2_missing"); // a well-formed rule always has one here
    const pollMs = deps.panel?.pollMs ?? POLL_MS;
    for (;;) {
      if (deps.stopped()) return fail("stopped");
      const ser = serialiseFull(panel);
      const check = checkStage(stage2, panel, ser, false);
      if (check.ok) {
        const d: PanelRefusal =
          stage2.action === "reject"
            ? { kind: "reject", target: check.target }
            : { kind: "save", target: check.target, toggles: check.toggles };
        return refuseInPanel(panel, check.ser, d, false, deps);
      }
      if (performance.now() >= until) return fail(`stage2_${check.reason}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };
}

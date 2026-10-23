// §2f.2 save with toggles, and §2f.3's settings hop: click settings, find the panel that opens,
// hide it, and refuse there by reject or by save with toggles. One hop at most: once settings
// has been clicked, a panel that offers anything else ends `failed`. A learned rule's replay
// (replay.ts) acts through the same steps.
import {
  type ChooseOpts,
  type Corroboration,
  decide,
  MODEL_REASONS,
  toggleChanges,
} from "../choose.ts";
import { PANEL_WAIT_MS } from "../config.ts";
import { labelDeterministic, mergeAiLabels } from "../label.ts";
import { type LearnedStage, type RecordedFlow, recordStage, type Stage2 } from "../learned.ts";
import type { ClickResult } from "../page/click.ts";
import { clickability } from "../page/clickable.ts";
import { hashText } from "../page/detect.ts";
import { textOf } from "../page/dom.ts";
import type { Hider } from "../page/hide.ts";
import { findPanel, snapshotRendered } from "../page/panel.ts";
import { type Serialised, serialise } from "../page/serialise.ts";
import { readToggle, recheck, setToggles } from "../page/toggles.ts";
import type { Control, Decision, Label, Outcome, SerialisedBanner } from "../types.ts";
import { stillSame } from "./page-checks.ts";

export type SaveDecision = Extract<Decision, { kind: "save" }>;

/** Why a save could not go ahead: a toggle click's own reason, or the §2f.2 re-read. */
export type SaveFailure = "recheck_failed" | NonNullable<ClickResult["reason"]>;

export interface SaveApplied {
  /** `ok`: the re-read passed, so save may be clicked. */
  result: "ok" | SaveFailure;
  /** The toggles the switching actually changed, each with the state it is in now. */
  switched: { id: number; to: boolean }[];
}

type Done = { ok: true } | { ok: false; reason: string };

/** What the own path does for each click and toggle of a flow, so that every one is logged. */
export interface Actions {
  /** Clicks `el` through `safeClick` with a fresh `NavigationWatch`, and records the click. */
  click(el: Element, control: Control, aiOnly: boolean): ClickResult;
  /** Records the toggles the flow changed. */
  toggled(t: { text: string; to: boolean }[]): void;
}

/** A toggle §2f.2 must leave in a state: a toggle-optional off, a toggle-optout on. */
export interface WantedToggle {
  id: number;
  el: Element;
  text: string;
  label: "toggle-optional" | "toggle-optout";
  to: boolean;
}

/**
 * Every toggle-optional off and every toggle-optout on that `s` exposes, hidden ones included:
 * what §2f.2's re-read must find, and the target states a learned rule keeps.
 */
export function wantedToggles(s: Serialised): WantedToggle[] {
  const labels = labelDeterministic(s.banner);
  return s.banner.controls.flatMap((c): WantedToggle[] => {
    const el = s.elements.get(c.id);
    const label = labels.get(c.id)?.label;
    if (c.role !== "toggle" || !el) return [];
    if (label === "toggle-optional") return [{ id: c.id, el, text: c.text, label, to: false }];
    if (label === "toggle-optout") return [{ id: c.id, el, text: c.text, label, to: true }];
    return [];
  });
}

/**
 * §2f.2 steps 1–2 in `container`, which `s` serialises: switch `d.toggles`, then re-read every
 * toggle it exposes, hidden ones included, not only the switched ones. The switching may have run
 * site code, so the container is serialised again and its toggles read too: one the site added
 * on the way (a sub-choice it reveals, already on) fails the re-read like any other. `ok` means
 * every toggle-optional is off and every toggle-optout on, so save may be clicked; save itself
 * is not clicked here.
 */
export function applySave(d: SaveDecision, s: Serialised, container: Element): SaveApplied {
  const targets = d.toggles.flatMap(({ id, to }) => {
    const el = s.elements.get(id);
    return el ? [{ id, el, to, was: readToggle(el) }] : []; // every id was decided from `s`
  });
  const set = setToggles(targets);
  const switched = targets.flatMap(({ id, el, was }) => {
    const now = readToggle(el);
    return now !== null && now !== was ? [{ id, to: now }] : [];
  });
  if (!set.ok) return { result: set.reason, switched };
  const again = serialise({ el: container }, clickability, { hiddenToggles: true });
  const ok = recheck(wantedToggles(s)) && recheck(wantedToggles(again));
  return { result: ok ? "ok" : "recheck_failed", switched };
}

/**
 * A stage-1 save decision, extended to the toggles the banner doesn't show (§2f.2). `full` is
 * the banner serialised with `hiddenToggles`, from which `d` was decided on the visible part.
 */
export function withHiddenToggles(d: SaveDecision, full: Serialised): SaveDecision {
  const hidden = full.banner.controls.filter((c) => c.hidden);
  if (hidden.length === 0) return d;
  return {
    ...d,
    toggles: [...d.toggles, ...toggleChanges(hidden, labelDeterministic(full.banner))],
  };
}

/** Clicks control `id` of `s` if it still reads as it did when `container` was serialised (§0). */
export function clickTarget(
  s: Serialised,
  id: number,
  container: Element,
  aiOnly: boolean,
  act: Actions,
): Done {
  const el = s.elements.get(id);
  const control = s.banner.controls.find((c) => c.id === id);
  if (!el || !control || !stillSame({ el: container }, s, id)) {
    return { ok: false, reason: "stale_target" };
  }
  const click = act.click(el, control, aiOnly);
  return click.ok ? { ok: true } : { ok: false, reason: click.reason ?? "navigation" };
}

/**
 * §2f.2 in `container`: switch the toggles, re-read them all, and click save only if the re-read
 * passed and the save control still reads as it did. The toggles may have run site code. What
 * the switching changed is logged whether or not save follows.
 */
export function saveWithToggles(
  d: SaveDecision,
  s: Serialised,
  container: Element,
  aiOnly: boolean,
  act: Actions,
): Done {
  const { result, switched } = applySave(d, s, container);
  act.toggled(
    switched.map(({ id, to }) => ({
      text: s.banner.controls.find((c) => c.id === id)?.text ?? "",
      to,
    })),
  );
  if (result !== "ok") return { ok: false, reason: result };
  return clickTarget(s, d.target, container, aiOnly, act);
}

/**
 * The stage that `d` acts out in `container` (serialised as `s`), recorded for a learned rule
 * before it acts: its target, and for a save the target state of every toggle-optional and
 * toggle-optout. Undefined when it can't be recorded.
 */
export function recordDecision<A extends LearnedStage["action"]>(
  container: Element,
  s: Serialised,
  d: { kind: A; target: number },
) {
  const el = s.elements.get(d.target);
  const control = s.banner.controls.find((c) => c.id === d.target);
  if (!el || !control) return undefined;
  const toggles = d.kind === "save" ? wantedToggles(s) : [];
  return recordStage(container, d.kind, { el, text: control.text }, toggles);
}

export interface HopDeps extends Actions {
  doc: Document;
  /** The banner's hider: the panel is hidden the same way (§2f.3). */
  hider: Hider;
  /** Candidates judged `not_consent`: never the panel. */
  rejected: Set<Element>;
  choose: Pick<ChooseOpts, "closeAction" | "agreeToDismiss">;
  /** Stage-2 labelling of `ids`: the AI's labels, or why there are none. */
  label(
    b: SerialisedBanner,
    ids: number[],
  ): Promise<Record<number, Label> | "model_timeout" | "model_error">;
  corroborate(
    b: SerialisedBanner,
    control: Control,
    label: "reject" | "save" | "settings",
  ): Promise<Corroboration>;
  note(s: string): void;
  /** The pipeline was stopped: the hop ends before its next action. */
  stopped(): boolean;
  /** `findPanel`'s window; PANEL_WAIT_MS by default. For tests. */
  panel?: { waitMs?: number; pollMs?: number };
}

export interface HopContext {
  /** The stage-1 banner, already hidden. */
  banner: Element;
  /** The banner's serialisation, and its settings control's id in it. */
  ser: Serialised;
  target: number;
  /** The settings label came from the AI alone. */
  aiOnly: boolean;
  deps: HopDeps;
}

/**
 * How the hop ended. `ok`: the panel's reject or save was clicked, and both the banner and
 * `panel` are left for §2g's verification, with `panelKey` (the panel's text hash at the last
 * click) for spotting it put back, and stage 2 as recorded for a learned rule when it could be.
 * Otherwise the reason it is `failed`, and the panel if found.
 */
export type HopResult =
  | { ok: true; panel: Element; panelKey: string; stage2?: Stage2 }
  | { ok: false; reason: string; panel?: Element };

/**
 * Stage 2, in the panel the settings click opened and already hidden: decide there and refuse.
 * `until` is when §2f.3's window, counted from the settings click, closes.
 */
export type Refuse = (panel: Element, ctx: HopContext, until: number) => Promise<HopResult>;

/**
 * §2f.3: click settings, wait for the panel, hide it, then refuse in it. By default that is
 * labelling (no gate), deciding with `allowSettings: false`, and acting; a learned rule's replay
 * passes its own `refuse`. Never throws once the panel is found.
 */
export async function settingsHop(ctx: HopContext, refuse: Refuse = decideIn): Promise<HopResult> {
  const { deps } = ctx;
  // What is visible now, so a newly shown panel can be told apart.
  const before = snapshotRendered(deps.doc);
  const opened = clickTarget(ctx.ser, ctx.target, ctx.banner, ctx.aiOnly, deps);
  if (!opened.ok) return opened;
  const until = performance.now() + (deps.panel?.waitMs ?? PANEL_WAIT_MS);

  const found = await findPanel({
    banner: ctx.banner,
    before,
    rejected: deps.rejected,
    doc: deps.doc,
    ...deps.panel,
  });
  if ("failed" in found) return { ok: false, reason: `panel_${found.failed}` };
  const panel = found.panel;
  try {
    if (deps.stopped()) return { ok: false, reason: "stopped", panel };
    if (panel !== ctx.banner) deps.hider.hide(panel, panel.getRootNode() as Document | ShadowRoot);
    return await refuse(panel, ctx, until);
  } catch (e) {
    deps.note(`exception:${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, reason: "exception", panel };
  }
}

/** A refusal in the panel: what stage 2 may click. */
export type PanelRefusal = Extract<Decision, { kind: "reject" }> | SaveDecision;

/**
 * Stage 2's last step, whoever decided it: refuse in `panel` (which `s` serialises) by `d`, with
 * the same checks at click time.
 */
export function refuseInPanel(
  panel: Element,
  s: Serialised,
  d: PanelRefusal,
  aiOnly: boolean,
  deps: HopDeps,
): HopResult {
  const panelKey = hashText(textOf(panel));
  const done =
    d.kind === "reject"
      ? clickTarget(s, d.target, panel, aiOnly, deps)
      : saveWithToggles(d, s, panel, aiOnly, deps);
  return done.ok ? { ok: true, panel, panelKey } : { ok: false, reason: done.reason, panel };
}

/** The hop's own stage 2: label the panel, decide, and refuse, recording what a rule needs. */
async function decideIn(panel: Element, { deps }: HopContext): Promise<HopResult> {
  const fail = (reason: string): HopResult => ({ ok: false, reason, panel });
  const ser = serialise({ el: panel }, clickability, { hiddenToggles: true });
  const det = labelDeterministic(ser.banner);
  const unlabelled = ser.banner.controls
    .filter((c) => det.get(c.id) === null && !c.absent)
    .map((c) => c.id);
  let given: Record<number, Label> = {};
  if (unlabelled.length > 0) {
    const got = await deps.label(ser.banner, unlabelled);
    if (typeof got === "string") return fail(got);
    given = got;
  }
  const res = await decide(
    ser.banner,
    mergeAiLabels(ser.banner, det, given),
    { ...deps.choose, allowSettings: false },
    (control, label) => deps.corroborate(ser.banner, control, label),
  );
  for (const { id, answer } of res.corroborations) {
    deps.note(`stage2:corroborate:${id}:${answer}`);
  }
  const d = res.decision;
  deps.note(`stage2:${d.kind}${d.kind === "unsure" ? `:${d.reason}` : ""}`);
  if (d.kind === "unsure" && MODEL_REASONS.has(d.reason)) return fail(d.reason);
  if (d.kind !== "reject" && d.kind !== "save") return fail("panel_no_refusal");
  if (deps.stopped()) return fail("stopped");

  // Nothing is learned from an AI-only click, so there is nothing to record for one.
  const stage2 = res.aiOnlyClick ? undefined : recordDecision(panel, ser, d);
  const done = refuseInPanel(panel, ser, d, res.aiOnlyClick, deps);
  return done.ok && stage2 ? { ...done, stage2 } : done;
}

/**
 * How a flow's actions went. `ok`: every click was made, and the banner (and `panel`, after a
 * hop) are left for §2g's verification, with `panelKey` for spotting the panel put back, and
 * `flow` when the flow was recorded for a learned rule. Otherwise why it is `failed`.
 */
export type Performed =
  | { ok: true; panel?: Element; panelKey?: string; flow?: RecordedFlow }
  | { ok: false; reason: string; panel?: Element };

/**
 * What the own path carries out once it has claimed the page and hidden the banner: the
 * chooser's decision, or a learned rule's replay. The claim, the hiding, §2g's verification and
 * the ending are the own path's, and the same for both.
 */
export interface Plan {
  /** The stage-1 target still reads as it did when it was chosen or checked. */
  fresh(): boolean;
  perform(deps: HopDeps): Promise<Performed>;
  /** The outcome once §2g verifies the dismissal. */
  dismissed: Outcome;
}

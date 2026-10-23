// §2f.2 save with toggles, and §2f.3's settings hop: click settings, find the panel that opens,
// hide it, and refuse there by reject or by save with toggles. One hop at most: once settings
// has been clicked, a panel that offers anything else ends `failed`.
import {
  type ChooseOpts,
  type Corroboration,
  decide,
  MODEL_REASONS,
  toggleChanges,
} from "../choose.ts";
import { labelDeterministic, mergeAiLabels } from "../label.ts";
import type { ClickResult } from "../page/click.ts";
import { clickability } from "../page/clickable.ts";
import { hashText } from "../page/detect.ts";
import { textOf } from "../page/dom.ts";
import type { Hider } from "../page/hide.ts";
import { findPanel, snapshotRendered } from "../page/panel.ts";
import { type Serialised, serialise } from "../page/serialise.ts";
import { readToggle, recheck, setToggles, type ToggleTarget } from "../page/toggles.ts";
import type { Control, Decision, Label, SerialisedBanner } from "../types.ts";
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

/** Every toggle-optional off and every toggle-optout on: what §2f.2's re-read must find. */
function wantedStates(s: Serialised): ToggleTarget[] {
  const labels = labelDeterministic(s.banner);
  return s.banner.controls.flatMap((c): ToggleTarget[] => {
    const el = s.elements.get(c.id);
    const label = labels.get(c.id)?.label;
    if (c.role !== "toggle" || !el) return [];
    if (label === "toggle-optional") return [{ el, to: false }];
    if (label === "toggle-optout") return [{ el, to: true }];
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
  const ok = recheck(wantedStates(s)) && recheck(wantedStates(again));
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
function clickTarget(
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
 * click) for spotting it put back. Otherwise the reason it is `failed`, and the panel if found.
 */
export type HopResult =
  | { ok: true; panel: Element; panelKey: string }
  | { ok: false; reason: string; panel?: Element };

/**
 * §2f.3: click settings, wait for the panel, hide it, then label (no gate), decide with
 * `allowSettings: false` and refuse in it. Never throws once the panel is found.
 */
export async function settingsHop(ctx: HopContext): Promise<HopResult> {
  const { deps } = ctx;
  // What is visible now, so a newly shown panel can be told apart.
  const before = snapshotRendered(deps.doc);
  const opened = clickTarget(ctx.ser, ctx.target, ctx.banner, ctx.aiOnly, deps);
  if (!opened.ok) return opened;

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
    return await refuseIn(panel, ctx);
  } catch (e) {
    deps.note(`exception:${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, reason: "exception", panel };
  }
}

/** Stage 2 in the panel that the settings click opened. */
async function refuseIn(panel: Element, { banner, deps }: HopContext): Promise<HopResult> {
  const fail = (reason: string): HopResult => ({ ok: false, reason, panel });
  if (deps.stopped()) return fail("stopped");
  if (panel !== banner) deps.hider.hide(panel, panel.getRootNode() as Document | ShadowRoot);

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

  const panelKey = hashText(textOf(panel));
  const done =
    d.kind === "reject"
      ? clickTarget(ser, d.target, panel, res.aiOnlyClick, deps)
      : saveWithToggles(d, ser, panel, res.aiOnlyClick, deps);
  return done.ok ? { ok: true, panel, panelKey } : fail(done.reason);
}

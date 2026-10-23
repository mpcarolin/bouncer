import { isAllowListed, textSources } from "./text/guards.ts";
import type { Control, Decision, Label, Labelled, SerialisedBanner } from "./types.ts";

export type { Decision } from "./types.ts";

export interface ChooseOpts {
  closeAction: "click" | "leave";
  agreeToDismiss: boolean;
  allowSettings: boolean;
}

export type Corroboration = boolean | "timeout" | "error";

type Corroborate = (
  control: Control,
  label: "reject" | "save" | "settings",
) => Promise<Corroboration>;

interface Entry {
  control: Control;
  labelled: Labelled;
}

const isClickable = (c: Control) => c.role === "button" || c.role === "link";

/** A button first, then a link; null when there is neither. */
function preferButton(entries: Entry[]): Entry | undefined {
  return entries.find((e) => e.control.role === "button") ?? entries[0];
}

/** §2f over labelled controls. Pure; never touches the AI. */
export function choose(
  b: SerialisedBanner,
  labels: Map<number, Labelled>,
  o: ChooseOpts,
): Decision {
  const entries: Entry[] = [];
  for (const control of b.controls) {
    const labelled = labels.get(control.id);
    if (labelled && !control.absent) entries.push({ control, labelled });
  }
  const clickable = entries.filter((e) => isClickable(e.control));
  const pool = clickable.filter((e) => !e.labelled.blocked);
  const withLabel = (...ls: Label[]) => pool.filter((e) => ls.includes(e.labelled.label));

  // 1. Reject.
  const reject = preferButton(withLabel("reject"));
  if (reject) return { kind: "reject", target: reject.control.id };

  // 2. Save with toggles.
  const toggles = entries.filter(
    (e) =>
      e.control.role === "toggle" &&
      (e.labelled.label === "toggle-optional" || e.labelled.label === "toggle-optout"),
  );
  const saves = withLabel("save");
  if (toggles.length > 0 && saves.length > 0) {
    const listed = saves.filter((e) => isAllowListed(textSources(e.control)));
    const pick = saves.length === 1 ? saves[0] : listed.length === 1 ? listed[0] : undefined;
    if (!pick) return { kind: "unsure", reason: "ambiguous_save" };
    const changes = toggles.flatMap(({ control, labelled }) => {
      if (control.disabled) return [];
      if (labelled.label === "toggle-optional" && control.on)
        return [{ id: control.id, to: false }];
      if (labelled.label === "toggle-optout" && control.on === false) {
        return [{ id: control.id, to: true }];
      }
      return [];
    });
    return { kind: "save", target: pick.control.id, toggles: changes };
  }

  // 3. Settings.
  if (o.allowSettings) {
    const settings = preferButton(withLabel("settings"));
    if (settings) return { kind: "settings", target: settings.control.id };
  }

  // A refusal-looking route existed but §0 vetoed it: never fall through to Close.
  const vetoedRefusal = clickable.some(
    (e) =>
      e.labelled.blocked === "accept_verb_veto" &&
      (e.labelled.label === "reject" || (o.allowSettings && e.labelled.label === "settings")),
  );
  if (vetoedRefusal) return { kind: "unsure", reason: "refusal_vetoed" };

  // 4. Close.
  const close = preferButton(withLabel("close"));
  if (close) {
    return o.closeAction === "click"
      ? { kind: "close", target: close.control.id }
      : { kind: "no_option" };
  }

  // 5. No way to refuse. Blocked accept controls still count here.
  const acknowledge = clickable.find((e) => e.labelled.label === "acknowledge");
  const accept = clickable.find((e) => e.labelled.label === "accept");
  if (acknowledge || accept) {
    if (!o.agreeToDismiss) return { kind: "no_option" };
    const agree = acknowledge ?? accept;
    if (agree) return { kind: "agree", target: agree.control.id };
  }

  // 6. Can't tell.
  return { kind: "unsure", reason: "no_usable_control" };
}

const NEEDS_CORROBORATION = new Set<Label>(["reject", "save", "settings"]);

/** `choose`, with §2e's corroboration of any AI-only reject, save or settings target. */
export async function decide(
  b: SerialisedBanner,
  labels: Map<number, Labelled>,
  o: ChooseOpts,
  corroborate: Corroborate,
): Promise<{
  decision: Decision;
  aiOnlyClick: boolean;
  corroborations: { id: number; answer: Corroboration }[];
}> {
  const current = new Map(labels);
  const corroborations: { id: number; answer: Corroboration }[] = [];
  const asked = new Set<number>();
  const done = (decision: Decision) => {
    const target = "target" in decision ? current.get(decision.target) : undefined;
    return { decision, aiOnlyClick: target?.source === "ai", corroborations };
  };

  // Each pass either returns or demotes one never-asked control, so this bound is never reached.
  for (let pass = 0; pass <= b.controls.length; pass++) {
    const decision = choose(b, current, o);
    if (!("target" in decision)) return done(decision);
    const labelled = current.get(decision.target);
    const control = b.controls.find((c) => c.id === decision.target);
    if (
      !labelled ||
      !control ||
      labelled.source !== "ai" ||
      labelled.corroborated ||
      !NEEDS_CORROBORATION.has(labelled.label) ||
      asked.has(control.id)
    ) {
      return done(decision);
    }
    asked.add(control.id);
    const answer = await corroborate(control, labelled.label as "reject" | "save" | "settings");
    corroborations.push({ id: control.id, answer });
    if (answer === "timeout" || answer === "error") {
      const reason = answer === "timeout" ? "model_timeout" : "model_error";
      return { decision: { kind: "unsure", reason }, aiOnlyClick: false, corroborations };
    }
    current.set(
      control.id,
      answer ? { ...labelled, corroborated: true } : { label: "other", source: "ai" },
    );
  }
  return done({ kind: "unsure", reason: "corroboration_loop" });
}

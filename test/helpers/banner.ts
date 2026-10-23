import { labelDeterministic, mergeAiLabels } from "../../src/core/label.ts";
import type { Control, Label, Labelled, SerialisedBanner } from "../../src/core/types.ts";

export type Draft = Omit<Control, "id">;
type Extra = Partial<Omit<Control, "id" | "role" | "text">>;

export const btn = (text: string, extra: Extra = {}): Draft => ({ role: "button", text, ...extra });
export const lnk = (text: string, extra: Extra = {}): Draft => ({ role: "link", text, ...extra });
export const tog = (text: string, extra: Extra = {}): Draft => ({ role: "toggle", text, ...extra });

/** A banner whose controls get ids 0, 1, 2 … in order. */
export function b(drafts: Draft[]): SerialisedBanner {
  return { text: "We use cookies.", controls: drafts.map((d, id) => ({ id, ...d })) };
}

/** The deterministic labels with no AI help: what a control ends up as when the AI says nothing. */
export function lab(drafts: Draft[], ai: Record<number, Label> = {}): Labelled[] {
  const banner = b(drafts);
  const merged = mergeAiLabels(banner, labelDeterministic(banner), ai);
  return banner.controls.map((c) => merged.get(c.id) as Labelled);
}

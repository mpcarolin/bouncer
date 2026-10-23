import type { DecisionKind, Label, SerialisedBanner } from "./types.ts";

/**
 * A captured or hand-written banner with its ground truth. Labels are what each control really
 * does (§2e), not what any regex says. `expectedDecision` is §2f with default options.
 */
export interface BannerFixture {
  id: string;
  kind: "positive" | "negative";
  /** 1 = the banner as first seen, 2 = the panel after a settings click. */
  stage: 1 | 2;
  /** Hand-written rather than captured from a live site. */
  synthetic?: boolean;
  note: string;
  /** What the gate should say. */
  gate: "consent" | "other";
  banner: SerialisedBanner;
  /** Per control id. Every control on a positive. */
  expectedLabels?: Record<number, Label>;
  expectedDecision?: DecisionKind | "not_consent";
}

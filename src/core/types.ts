export type Role = "button" | "link" | "toggle" | "other";

export type AbsentReason = "navigates" | "submit" | "reset";

export interface Control {
  id: number;
  role: Role;
  text: string;
  ariaLabel?: string;
  title?: string;
  on?: boolean;
  disabled?: boolean;
  domId?: string;
  absent?: AbsentReason;
  /**
   * A toggle the user cannot see (a collapsed section, a hidden tab), serialised only so a save
   * covers it (§2f.2). Hidden toggles follow every visible control.
   */
  hidden?: true;
}

export interface SerialisedBanner {
  text: string;
  controls: Control[];
}

export type Label =
  | "accept"
  | "reject"
  | "settings"
  | "save"
  | "close"
  | "acknowledge"
  | "link"
  | "toggle-optional"
  | "toggle-necessary"
  | "toggle-optout"
  | "other";

/** What the chooser (§2f) decided, or `no_option`/`unsure` when it did not click anything. */
export type Decision =
  | { kind: "reject"; target: number }
  | { kind: "save"; target: number; toggles: { id: number; to: boolean }[] }
  | { kind: "settings"; target: number }
  | { kind: "close"; target: number }
  | { kind: "agree"; target: number }
  | { kind: "no_option" }
  | { kind: "unsure"; reason: string };

export type DecisionKind = Decision["kind"];

export type LabelSource = "rule" | "regex" | "ai";

export type BlockReason = "accept_all" | "accept_verb_veto" | "do_not_sell";

export interface Labelled {
  label: Label;
  source: LabelSource;
  blocked?: BlockReason;
  corroborated?: boolean;
}

export type Outcome =
  | "dismissed"
  | "dismissed_unverified"
  | "dismissed_close"
  | "dismissed_agreed"
  | "dismissed_late"
  | "deferred"
  | "not_consent"
  | "no_option"
  | "unsure"
  | "failed"
  | "model_unavailable";

/**
 * The outcomes in which the banner was dismissed, by either path: the own path's ending, its
 * scroll unlock, and the latch on autoconsent's outcome all read this one set.
 */
export const DISMISSED: ReadonlySet<Outcome> = new Set<Outcome>([
  "dismissed",
  "dismissed_unverified",
  "dismissed_close",
  "dismissed_agreed",
  "dismissed_late",
]);

/** Injected for fake timers. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

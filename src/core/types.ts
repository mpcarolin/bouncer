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

/** Injected for fake timers. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

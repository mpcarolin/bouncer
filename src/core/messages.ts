import type { AiResult, AiStatus } from "./ai.ts";
import type { LearnedRule } from "./learned.ts";
import type { LogEntry } from "./log.ts";
import type { Settings } from "./settings.ts";
import type { Control, Label, Outcome, SerialisedBanner } from "./types.ts";

/** Arguments per AI operation; mirrors `AiProvider`. */
export interface AiOps {
  status: [];
  isConsentDialog: [banner: SerialisedBanner];
  labelControls: [banner: SerialisedBanner, controlIds: number[]];
  corroborate: [banner: SerialisedBanner, control: Control, label: "reject" | "save" | "settings"];
}

export type AiRequest = {
  [K in keyof AiOps]: { type: "ai"; op: K; args: AiOps[K] };
}[keyof AiOps];

export type ToBackground =
  | { type: "hello" }
  | { type: "claim" }
  | AiRequest
  | { type: "log"; entry: Omit<LogEntry, "id"> }
  | { type: "logPatch"; id: string; patch: Partial<LogEntry> }
  | { type: "saveRule"; rule: LearnedRule }
  | { type: "discardRule"; site: string };

export type ToContent =
  | { type: "acDetected" } // top-frame cmpDetected: freeze the scroll snapshot
  | { type: "acPopupFound" } // record the inline values for unlocking
  | { type: "acDetectionEnded" }
  | { type: "acOutcome"; outcome: Outcome }
  | { type: "restoreAcStyles" };

const TO_BACKGROUND_TYPES: Record<ToBackground["type"], true> = {
  hello: true,
  claim: true,
  ai: true,
  log: true,
  logPatch: true,
  saveRule: true,
  discardRule: true,
};

const TO_CONTENT_TYPES: Record<ToContent["type"], true> = {
  acDetected: true,
  acPopupFound: true,
  acDetectionEnded: true,
  acOutcome: true,
  restoreAcStyles: true,
};

function hasKnownType(m: unknown, known: Record<string, true>): boolean {
  if (typeof m !== "object" || m === null) return false;
  const type = (m as { type?: unknown }).type;
  return typeof type === "string" && Object.hasOwn(known, type);
}

/**
 * True for Bouncer's own messages. Anything else on the same channel (autoconsent's protocol) is
 * not ours. Only the `type` is checked, so a malformed Bouncer message still counts as ours.
 */
export function isToBackground(m: unknown): m is ToBackground {
  return hasKnownType(m, TO_BACKGROUND_TYPES);
}

/** As `isToBackground`, for the background-to-content direction. */
export function isToContent(m: unknown): m is ToContent {
  return hasKnownType(m, TO_CONTENT_TYPES);
}

export interface AiReplies {
  status: AiStatus;
  isConsentDialog: AiResult<boolean>;
  labelControls: AiResult<Record<number, Label>>;
  corroborate: AiResult<boolean>;
}

interface Replies {
  hello: { enabled: boolean; settings: Settings; learnedRule?: LearnedRule };
  claim: { granted: boolean; reason?: "autoconsent" | "already" | "stale" };
  log: { id: string };
  logPatch: void;
  saveRule: void;
  discardRule: void;
}

/** The reply type for a message, chosen by its `type` (and, for `ai`, its `op`). */
export type ReplyOf<M extends ToBackground> = M extends {
  type: "ai";
  op: infer O extends keyof AiReplies;
}
  ? AiReplies[O]
  : M extends { type: infer T extends keyof Replies }
    ? Replies[T]
    : never;

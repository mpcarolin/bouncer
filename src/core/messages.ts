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

export interface AiReplies {
  status: AiStatus;
  isConsentDialog: AiResult<boolean>;
  labelControls: AiResult<Record<number, Label>>;
  corroborate: AiResult<boolean>;
}

interface Replies {
  hello: { enabled: boolean; settings: Settings; learnedRule?: LearnedRule };
  claim: { granted: boolean; reason?: "autoconsent" | "already" };
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

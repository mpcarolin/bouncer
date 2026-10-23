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

// autoconsent's protocol, as @duckduckgo/autoconsent 16.59 defines it (dist/types/messages.d.ts
// and types.d.ts). The core keeps its own copy so it never imports autoconsent; the compile-time
// checks in test/unit/autoconsent-bg.test.ts keep the two in step.

/** autoconsent's `LifecycleState`, carried by its `report` messages. */
export type AcLifecycle =
  | "loading"
  | "initialized"
  | "waitingForInitResponse"
  | "started"
  | "nothingDetected"
  | "cmpDetected"
  | "openPopupDetected"
  | "runningOptOut"
  | "runningOptIn"
  | "optOutSucceeded"
  | "optOutFailed"
  | "optInSucceeded"
  | "optInFailed"
  | "done";

/** autoconsent's `Config`, sent in every `initResp`. */
export interface AutoconsentConfig {
  enabled: boolean;
  autoAction: "optOut" | "optIn" | null;
  disabledCmps: string[];
  enablePrehide: boolean;
  enableCosmeticRules: boolean;
  enableGeneratedRules: boolean;
  detectRetries: number;
  isMainWorld: boolean;
  prehideTimeout: number;
  enableHeuristicDetection: boolean;
  enablePopupMutationObserver: boolean;
  visualTest: boolean;
  logs: {
    lifecycle: boolean;
    rulesteps: boolean;
    detectionsteps: boolean;
    evals: boolean;
    errors: boolean;
    messages: boolean;
    waits: boolean;
  };
  performanceLoggingEnabled: boolean;
  heuristicPopupSearchTimeout: number;
  heuristicMode: "off" | "reject" | "tier1" | "tier2";
}

/** What autoconsent's content script sends the background (its `ContentScriptMessage`). */
export type AcMessage =
  | { type: "init"; url: string }
  | { type: "eval"; id: string; code: string; snippetId?: string }
  | { type: "visualDelay"; timeout: number }
  | { type: "cmpDetected"; cmp: string; url: string }
  | { type: "popupFound"; cmp: string; url: string }
  | { type: "optOutResult"; cmp: string; result: boolean; scheduleSelfTest: boolean; url: string }
  | { type: "optInResult"; cmp: string; result: boolean; scheduleSelfTest: boolean; url: string }
  | { type: "selfTestResult"; cmp: string; result: boolean; url: string }
  | {
      type: "autoconsentDone";
      cmp: string;
      isCosmetic: boolean;
      url: string;
      duration: number;
      totalClicks: number;
    }
  | { type: "autoconsentError"; details: unknown }
  | {
      type: "report";
      instanceId: string;
      url: string;
      mainFrame: boolean;
      /** autoconsent's `ConsentState`; Bouncer reads only these fields. */
      state: { lifecycle: AcLifecycle; detectedCmps: string[] };
    };

/**
 * What Bouncer sends autoconsent's content script: part of its `BackgroundMessage`. `optIn` is
 * deliberately absent, so Bouncer cannot ask autoconsent to accept.
 */
export type ToAutoconsent =
  | {
      type: "initResp";
      /** A `RuleBundle`: autoconsent's compact rules for the frame, or none when it is disabled. */
      rules: { autoconsent: []; compact?: unknown };
      config: AutoconsentConfig;
    }
  | { type: "evalResp"; id: string; result: unknown }
  | { type: "optOut" }
  | { type: "selfTest" };

/** Anything the background sends one frame: Bouncer's content script and autoconsent's share it. */
export type FrameMessage = ToContent | ToAutoconsent;

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

const AC_MESSAGE_TYPES: Record<AcMessage["type"], true> = {
  init: true,
  eval: true,
  visualDelay: true,
  cmpDetected: true,
  popupFound: true,
  optOutResult: true,
  optInResult: true,
  selfTestResult: true,
  autoconsentDone: true,
  autoconsentError: true,
  report: true,
};

/** True for autoconsent's messages to the background, by `type` as `isToBackground` does. */
export function isAcMessage(m: unknown): m is AcMessage {
  return hasKnownType(m, AC_MESSAGE_TYPES);
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
  /** `stored`: the background stored the rule (or removed it) for the sender's own site. */
  saveRule: { stored: boolean };
  discardRule: { stored: boolean };
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

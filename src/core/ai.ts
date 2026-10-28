import type { Control, Label, SerialisedBanner } from "./types.ts";

export interface AiMeta {
  ms: number;
  cold: boolean;
  onDevice: boolean;
}

export type AiResult<T> =
  | { kind: "answer"; value: T; meta: AiMeta }
  | { kind: "timeout"; meta: AiMeta }
  | { kind: "error"; error: string; meta: AiMeta };

export interface AiStatus {
  state: "available" | "downloadable" | "downloading" | "unavailable";
  reason?: string;
  onDevice: boolean;
}

export interface AiProvider {
  status(): Promise<AiStatus>;
  /**
   * Loads the model ahead of the next decision, if it can; never throws. For keeping the model
   * loaded (Settings' `keepModelWarm`). A provider with nothing to load leaves it out.
   */
  warmUp?(): Promise<void>;
  isConsentDialog(b: SerialisedBanner): Promise<AiResult<boolean>>;
  labelControls(
    b: SerialisedBanner,
    controlIds: number[],
  ): Promise<AiResult<Record<number, Label>>>;
  corroborate(
    b: SerialisedBanner,
    control: Control,
    label: "reject" | "save" | "settings",
  ): Promise<AiResult<boolean>>;
}

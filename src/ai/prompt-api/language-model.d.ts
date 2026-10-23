// Only the slice of Chrome's Prompt API (Gemini Nano) that the provider uses.
// Kept here so the core never sees it.

export type LanguageModelAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export interface LanguageModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LanguageModelLanguages {
  expectedInputs?: { type: "text"; languages?: string[] }[];
  expectedOutputs?: { type: "text"; languages?: string[] }[];
}

export interface LanguageModelCreateOptions extends LanguageModelLanguages {
  initialPrompts?: LanguageModelMessage[];
  monitor?: (m: EventTarget) => void;
}

export interface LanguageModelSession {
  clone(): Promise<LanguageModelSession>;
  prompt(input: string, options?: { responseConstraint?: unknown }): Promise<string>;
  destroy(): void;
}

export interface LanguageModelStatic {
  availability(options?: LanguageModelLanguages): Promise<LanguageModelAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

declare global {
  var LanguageModel: LanguageModelStatic | undefined;
}

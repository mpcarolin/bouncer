import type { AiProvider, AiStatus } from "../core/ai.ts";
import { MockProvider, mockDownload } from "./mock/provider.ts";
import { PromptApiProvider } from "./prompt-api/provider.ts";

/** The single composition point. Static `if`s let the Store build drop the mock. */
export function createProvider(): AiProvider {
  if (import.meta.env.VITE_AI_PROVIDER === "mock") {
    return new MockProvider();
  }
  return new PromptApiProvider();
}

/**
 * Downloads the on-device model, reporting a 0 to 1 fraction as it arrives. It is for an
 * extension page to call from a user's click, and it never rejects. Not part of `AiProvider`:
 * only the Prompt API has a download.
 */
export type Downloader = (onProgress: (loaded: number) => void) => Promise<AiStatus>;

export function createDownloader(): Downloader {
  if (import.meta.env.VITE_AI_PROVIDER === "mock") {
    return mockDownload;
  }
  const provider = new PromptApiProvider();
  return (onProgress) => provider.download(onProgress);
}

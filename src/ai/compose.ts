import type { AiProvider } from "../core/ai.ts";
import { MockProvider } from "./mock/provider.ts";
import { PromptApiProvider } from "./prompt-api/provider.ts";

/** The single composition point. Static `if`s let the Store build drop the mock. */
export function createProvider(): AiProvider {
  if (import.meta.env.VITE_AI_PROVIDER === "mock") {
    return new MockProvider();
  }
  return new PromptApiProvider();
}

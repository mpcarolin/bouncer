import type { AiProvider } from "../core/ai.ts";
import { MockProvider } from "./mock/provider.ts";

/** Stand-in until Task 10 adds the Prompt API provider. */
const unavailable: AiProvider = {
  status: async () => ({ state: "unavailable", reason: "not_implemented", onDevice: true }),
  isConsentDialog: async () => unavailableResult(),
  labelControls: async () => unavailableResult(),
  corroborate: async () => unavailableResult(),
};

function unavailableResult() {
  return {
    kind: "error" as const,
    error: "unavailable",
    meta: { ms: 0, cold: false, onDevice: true },
  };
}

/** The single composition point. Static `if`s let the Store build drop the mock. */
export function createProvider(): AiProvider {
  if (import.meta.env.VITE_AI_PROVIDER === "mock") {
    return new MockProvider();
  }
  return unavailable;
}

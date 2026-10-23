import { afterEach, describe, expect, it, vi } from "vitest";
import { createDownloader } from "../../src/ai/compose.ts";
import { fakeLanguageModel } from "../helpers/fake-language-model.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("createDownloader", () => {
  it("downloads through the Prompt API in the Chrome build", async () => {
    const { lm, state } = fakeLanguageModel({
      availability: "downloadable",
      downloadProgress: [0.5, 1],
    });
    vi.stubGlobal("LanguageModel", lm);
    const seen: number[] = [];
    expect(await createDownloader()((f) => seen.push(f))).toEqual({
      state: "available",
      onDevice: true,
    });
    expect(seen).toEqual([0.5, 1]);
    expect(state.createCalls).toHaveLength(1);
  });

  it("is the mock's in the e2e build: it resolves without a Prompt API", async () => {
    vi.stubEnv("VITE_AI_PROVIDER", "mock");
    expect(globalThis.LanguageModel).toBeUndefined();
    const seen: number[] = [];
    expect(await createDownloader()((f) => seen.push(f))).toEqual({
      state: "available",
      onDevice: true,
    });
    expect(seen).toEqual([1]);
  });
});

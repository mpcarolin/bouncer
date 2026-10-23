import { afterEach, describe, expect, it, vi } from "vitest";
import { MockProvider } from "../../src/ai/mock/provider.ts";
import { RemoteAiProvider, serveAi } from "../../src/core/ai-remote.ts";
import type { AiProvider } from "../../src/core/ai.ts";
import { ModelBudget } from "../../src/core/budget.ts";
import { CREATE_TIMEOUT_MS, PROMPT_TIMEOUT_MS } from "../../src/core/config.ts";
import type { ContentPlatform } from "../../src/core/platform.ts";
import type { SerialisedBanner } from "../../src/core/types.ts";
import { fakeBackground, fakeContent } from "../helpers/fake-platform.ts";

const banner: SerialisedBanner = {
  text: "We use cookies",
  controls: [
    { id: 0, role: "button", text: "Proceed" },
    { id: 1, role: "button", text: "Not now" },
  ],
};

afterEach(() => vi.useRealTimers());

function wired(provider: AiProvider) {
  const bg = fakeBackground();
  bg.onMessage((msg) => {
    const m = msg as { type: string; op: string; args: unknown[] };
    return m.type === "ai" ? serveAi(provider, m.op, m.args) : undefined;
  });
  return { bg, remote: new RemoteAiProvider(fakeContent(bg)) };
}

describe("RemoteAiProvider", () => {
  it("round-trips every op and preserves meta", async () => {
    const meta = { ms: 42, cold: true, onDevice: true };
    const stub: AiProvider = {
      status: async () => ({ state: "downloadable", reason: "r", onDevice: true }),
      isConsentDialog: async () => ({ kind: "answer", value: true, meta }),
      labelControls: async (_b, ids) => ({ kind: "answer", value: { [ids[0]!]: "reject" }, meta }),
      corroborate: async () => ({ kind: "timeout", meta }),
    };
    const { remote } = wired(stub);
    expect(await remote.status()).toEqual({ state: "downloadable", reason: "r", onDevice: true });
    expect(await remote.isConsentDialog(banner)).toEqual({ kind: "answer", value: true, meta });
    expect(await remote.labelControls(banner, [0])).toEqual({
      kind: "answer",
      value: { 0: "reject" },
      meta,
    });
    expect(await remote.corroborate(banner, banner.controls[1]!, "reject")).toEqual({
      kind: "timeout",
      meta,
    });
  });

  it("passes arguments through to the real provider", async () => {
    const { remote } = wired(new MockProvider());
    expect(await remote.corroborate(banner, banner.controls[1]!, "reject")).toMatchObject({
      kind: "answer",
      value: true,
    });
  });

  it("a rejected send (no handler after a worker restart) ends as a time-out", async () => {
    const { bg, remote } = wired(new MockProvider());
    bg.restart();
    expect(await remote.isConsentDialog(banner)).toMatchObject({ kind: "timeout" });
    expect(await remote.labelControls(banner, [0])).toMatchObject({ kind: "timeout" });
    expect(await remote.status()).toEqual({
      state: "unavailable",
      reason: "transport",
      onDevice: false,
    });
  });

  it("a send that never settles ends as a time-out after the combined timeout", async () => {
    vi.useFakeTimers();
    const hang: ContentPlatform = { send: () => new Promise(() => {}), onMessage: () => {} };
    const remote = new RemoteAiProvider(hang);
    const pending = remote.isConsentDialog(banner);
    const status = remote.status();
    await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS + PROMPT_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ kind: "timeout" });
    expect(await status).toMatchObject({ state: "unavailable", reason: "transport" });
  });
});

describe("serveAi", () => {
  it("returns unknown_op for an unknown op", async () => {
    expect(await serveAi(new MockProvider(), "nope", [])).toMatchObject({
      kind: "error",
      error: "unknown_op",
    });
  });

  it("turns a throwing provider into an error result", async () => {
    const boom = new MockProvider();
    boom.isConsentDialog = async () => {
      throw new Error("boom");
    };
    expect(await serveAi(boom, "isConsentDialog", [banner])).toMatchObject({
      kind: "error",
      error: "boom",
    });
  });
});

describe("ModelBudget", () => {
  it("allows exactly 8 model calls, then budget_exhausted; status is free", async () => {
    const wrapped = new ModelBudget().wrap(new MockProvider());
    for (let i = 0; i < 8; i++) {
      expect((await wrapped.isConsentDialog(banner)).kind).toBe("answer");
    }
    expect(await wrapped.isConsentDialog(banner)).toMatchObject({
      kind: "error",
      error: "budget_exhausted",
    });
    expect(await wrapped.labelControls(banner, [0])).toMatchObject({ error: "budget_exhausted" });
    for (let i = 0; i < 20; i++) expect((await wrapped.status()).state).toBe("available");
  });

  it("shares the budget across ops and honours a custom max", async () => {
    const wrapped = new ModelBudget(2).wrap(new MockProvider());
    await wrapped.isConsentDialog(banner);
    await wrapped.labelControls(banner, [0]);
    expect(await wrapped.corroborate(banner, banner.controls[0]!, "reject")).toMatchObject({
      error: "budget_exhausted",
    });
  });
});

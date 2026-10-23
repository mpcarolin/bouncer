import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATE_SCHEMA, GATE_SYSTEM } from "../../src/ai/prompt-api/prompts.ts";
import { PromptApiProvider } from "../../src/ai/prompt-api/provider.ts";
import { TIMEOUT, timebox } from "../../src/ai/prompt-api/timebox.ts";
import { b, btn, lnk, tog } from "../helpers/banner.ts";
import { fakeLanguageModel, namedError } from "../helpers/fake-language-model.ts";
import type { FakeOptions } from "../helpers/fake-language-model.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const banner = b([btn("Proceed"), lnk("Privacy"), btn("", { ariaLabel: "Close" })]);

function make(o: FakeOptions = {}) {
  const fake = fakeLanguageModel(o);
  return { ...fake, p: new PromptApiProvider(fake.lm) };
}

describe("timebox", () => {
  it("returns TIMEOUT when the promise is too slow, the value otherwise", async () => {
    const slow = timebox(new Promise(() => {}), 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await slow).toBe(TIMEOUT);
    expect(await timebox(Promise.resolve(7), 100)).toBe(7);
  });
});

describe("status", () => {
  it("availability that never resolves is unavailable/availability_timeout within the limit", async () => {
    const { p } = make({ availability: "never" });
    const s = p.status();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await s).toEqual({
      state: "unavailable",
      reason: "availability_timeout",
      onDevice: true,
    });
  });

  it("maps availability() and is always on-device", async () => {
    expect(await make({ availability: "downloadable" }).p.status()).toEqual({
      state: "downloadable",
      onDevice: true,
    });
    expect((await new PromptApiProvider(undefined).status()).state).toBe("unavailable");
  });

  it("ops return error 'unavailable' without prompting unless available", async () => {
    const { p, state } = make({ availability: "downloadable" });
    const r = await p.isConsentDialog(banner);
    expect(r).toMatchObject({ kind: "error", error: "unavailable" });
    expect((await p.corroborate(banner, banner.controls[0]!, "reject")).kind).toBe("error");
    expect((await p.labelControls(banner, [0])).kind).toBe("error");
    expect(state.createCalls).toHaveLength(0);
    expect(state.prompts).toHaveLength(0);
  });
});

describe("gate", () => {
  it("is cold on the first call, warm on the second, and creates one base session", async () => {
    const { p, state } = make({ createMs: 500 });
    const pending = p.isConsentDialog(banner);
    await vi.advanceTimersByTimeAsync(500);
    const first = await pending;
    const second = await p.isConsentDialog(banner);
    expect(first).toMatchObject({
      kind: "answer",
      value: true,
      meta: { cold: true, onDevice: true },
    });
    expect(second).toMatchObject({ kind: "answer", meta: { cold: false } });
    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0]?.initialPrompts).toEqual([
      { role: "system", content: GATE_SYSTEM },
    ]);
  });

  it("counts creation time in ms", async () => {
    const { p } = make({ createMs: 500 });
    const r = p.isConsentDialog(banner);
    await vi.advanceTimersByTimeAsync(500);
    expect((await r).meta.ms).toBeGreaterThanOrEqual(500);
  });

  it("passes the gate schema and the formatted input", async () => {
    const { p, state } = make();
    await p.isConsentDialog(banner);
    expect(state.prompts[0]?.constraint).toEqual(GATE_SCHEMA);
    expect(state.prompts[0]?.input).toBe(
      'Text: We use cookies.\nControls:\n[0] button "Proceed"\n[1] link "Privacy"\n[2] button "Close"',
    );
  });

  it("maps yes to true and no to false; anything else is an error", async () => {
    expect(await make({ answers: ['"yes"'] }).p.isConsentDialog(banner)).toMatchObject({
      value: true,
    });
    expect(await make({ answers: ['"no"'] }).p.isConsentDialog(banner)).toMatchObject({
      value: false,
    });
    expect(await make({ answers: ['"maybe"'] }).p.isConsentDialog(banner)).toMatchObject({
      kind: "error",
      error: "bad_answer",
    });
  });

  it("destroys every clone, including after an error", async () => {
    const { p, state } = make({ throwOn: { prompt: namedError("QuotaExceededError") } });
    await p.isConsentDialog(banner);
    expect(state.cloned).toBe(1);
    expect(state.destroyed).toBe(1);
  });

  it("a prompt throwing QuotaExceededError is an error carrying that name", async () => {
    const { p } = make({ throwOn: { prompt: namedError("QuotaExceededError") } });
    expect(await p.isConsentDialog(banner)).toMatchObject({
      kind: "error",
      error: "QuotaExceededError",
    });
  });

  it("a create taking 31 s is a timeout, and the late base is not kept", async () => {
    const { p, state } = make({ createMs: 31_000 });
    const r = p.isConsentDialog(banner);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await r).toMatchObject({ kind: "timeout", meta: { cold: true } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.destroyed).toBe(1); // the late session destroyed itself
    // The next call starts a fresh create instead of reusing a half-created base.
    const again = p.isConsentDialog(banner);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(state.createCalls).toHaveLength(2);
    await again;
  });

  it("a create that throws is an error and is retried next call", async () => {
    const { p, state } = make({ throwOn: { create: namedError("NotAllowedError") } });
    expect(await p.isConsentDialog(banner)).toMatchObject({
      kind: "error",
      error: "NotAllowedError",
    });
    await p.isConsentDialog(banner);
    expect(state.createCalls).toHaveLength(2);
  });

  it("a clone that throws is an error", async () => {
    const { p } = make({ throwOn: { clone: namedError("InvalidStateError") } });
    expect(await p.isConsentDialog(banner)).toMatchObject({
      kind: "error",
      error: "InvalidStateError",
    });
  });
});

describe("labelControls", () => {
  const lb = b([btn("Proceed"), tog("Ads"), lnk("Policy"), btn("", { ariaLabel: "Close" })]);

  it("lists only the requested controls and maps labels back to ids", async () => {
    const { p, state } = make({ answers: ['{"labels":["reject","close"]}'] });
    const r = await p.labelControls(lb, [0, 3]);
    expect(r).toMatchObject({ kind: "answer", value: { 0: "reject", 3: "close" } });
    expect(state.prompts[0]?.input).toBe(
      'Text: We use cookies.\nControls:\n[0] button "Proceed"\n[3] button "Close"',
    );
  });

  it("offers no toggle labels", async () => {
    const { p, state } = make({ answers: ['{"labels":["other"]}'] });
    await p.labelControls(lb, [0]);
    const labels = (
      state.prompts[0]?.constraint as { properties: { labels: { items: { enum: string[] } } } }
    ).properties.labels.items.enum;
    expect(labels).toEqual([
      "accept",
      "reject",
      "settings",
      "save",
      "close",
      "acknowledge",
      "link",
      "other",
    ]);
  });

  it("retries without minItems/maxItems on NotSupportedError", async () => {
    const { p, state } = make({ rejectMinMax: true, answers: ['{"labels":["reject"]}'] });
    const r = await p.labelControls(lb, [0]);
    expect(r).toMatchObject({ kind: "answer", value: { 0: "reject" } });
    expect(state.prompts).toHaveLength(2);
    const second = state.prompts[1]?.constraint as { properties: { labels: object } };
    expect(second.properties.labels).not.toHaveProperty("minItems");
    expect(state.destroyed).toBe(1);
  });

  it("a label outside the enum, or a wrong length, is an error", async () => {
    expect(
      (await make({ answers: ['{"labels":["toggle-optional"]}'] }).p.labelControls(lb, [0])).kind,
    ).toBe("error");
    expect(
      (await make({ answers: ['{"labels":["reject","link"]}'] }).p.labelControls(lb, [0])).kind,
    ).toBe("error");
    expect((await make({ answers: ["not json"] }).p.labelControls(lb, [0])).kind).toBe("error");
  });

  it("with nothing to label it answers empty without prompting", async () => {
    const { p, state } = make();
    expect(await p.labelControls(lb, [])).toMatchObject({ kind: "answer", value: {} });
    expect(state.prompts).toHaveLength(0);
  });
});

describe("corroborate", () => {
  it("asks the §2e question with the control's text", async () => {
    const { p, state } = make({ answers: ['"no"'] });
    const r = await p.corroborate(banner, banner.controls[0]!, "reject");
    expect(r).toMatchObject({ kind: "answer", value: false });
    expect(state.prompts[0]?.input).toContain("Does clicking «Proceed» refuse optional cookies?");
    expect(state.prompts[0]?.constraint).toEqual(GATE_SCHEMA);
  });

  it("falls back to the aria-label when the text is empty, and covers save and settings", async () => {
    const { p, state } = make();
    const c = banner.controls[2]!;
    await p.corroborate(banner, c, "save");
    await p.corroborate(banner, c, "settings");
    expect(state.prompts[0]?.input).toContain(
      "Does clicking «Close» save the choices shown, without accepting everything?",
    );
    expect(state.prompts[1]?.input).toContain(
      "Does clicking «Close» open cookie choices without accepting?",
    );
  });
});

describe("prompts", () => {
  it("the gate prompt keeps the spec's two edits", () => {
    expect(GATE_SYSTEM).not.toContain('"Do not sell or share" choices');
    expect(GATE_SYSTEM).toContain("cookie preference centres)");
    expect(GATE_SYSTEM).toMatch(
      /NO:.*standalone US "Do not sell or share my personal information"/,
    );
  });
});

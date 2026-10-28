import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CORROBORATE_SYSTEM,
  corroborateInput,
  GATE_SCHEMA,
  GATE_SYSTEM,
  gateInput,
  LABELS_SYSTEM,
  labelInput,
} from "../../src/ai/prompt-api/prompts.ts";
import { PromptApiProvider } from "../../src/ai/prompt-api/provider.ts";
import { TIMEOUT, timebox } from "../../src/ai/prompt-api/timebox.ts";
import { CREATE_TIMEOUT_MS, GATE_TEXT_CHARS, LABEL_TEXT_CHARS } from "../../src/core/config.ts";
import type { Control } from "../../src/core/types.ts";
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

describe("download", () => {
  it("creates one session with a monitor, forwards the progress, and destroys the session", async () => {
    const { p, state } = make({ availability: "downloadable", downloadProgress: [0, 0.25, 1] });
    const seen: number[] = [];
    expect(await p.download((f) => seen.push(f))).toEqual({ state: "available", onDevice: true });
    expect(seen).toEqual([0, 0.25, 1]);
    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0]).toMatchObject({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
    expect(state.sessions).toBe(1);
    expect(state.destroyed).toBe(1);
  });

  it("is not time-boxed: a download far past the create limit still resolves", async () => {
    const { p } = make({
      availability: "downloadable",
      downloadProgress: [1],
      createMs: 10 * CREATE_TIMEOUT_MS,
    });
    const pending = p.download(() => {});
    await vi.advanceTimersByTimeAsync(10 * CREATE_TIMEOUT_MS);
    expect(await pending).toEqual({ state: "available", onDevice: true });
  });

  it("never throws: a failed create resolves the current status, with the error as the reason", async () => {
    const { p } = make({
      availability: "downloadable",
      throwOn: { create: namedError("NotAllowedError") },
    });
    expect(await p.download(() => {})).toEqual({
      state: "downloadable",
      reason: "download_error:NotAllowedError",
      onDevice: true,
    });
  });

  it("without the Prompt API resolves unavailable", async () => {
    expect(await new PromptApiProvider(undefined).download(() => {})).toEqual({
      state: "unavailable",
      reason: "no_language_model",
      onDevice: true,
    });
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

  it("is cold for every call that waits on the base's creation, not only the one that began it", async () => {
    const { p, state } = make({ createMs: 500 });
    const first = p.isConsentDialog(banner);
    const second = p.isConsentDialog(banner);
    await vi.advanceTimersByTimeAsync(500);
    expect(await first).toMatchObject({ kind: "answer", meta: { cold: true } });
    expect(await second).toMatchObject({ kind: "answer", meta: { cold: true } });
    expect(state.createCalls).toHaveLength(1);
    expect(await p.isConsentDialog(banner)).toMatchObject({ meta: { cold: false } });
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

  it("a base that can't be cloned is destroyed, and the next call primes a new one", async () => {
    const o: FakeOptions = { throwOn: { clone: namedError("InvalidStateError") } };
    const { p, state } = make(o);
    await p.isConsentDialog(banner);
    expect(state.destroyed).toBe(1);
    delete o.throwOn?.clone;
    expect(await p.isConsentDialog(banner)).toMatchObject({ kind: "answer", meta: { cold: true } });
    expect(state.createCalls).toHaveLength(2);
  });
});

describe("warmUp", () => {
  const SYSTEMS = (state: ReturnType<typeof make>["state"]) =>
    state.createCalls.map((c) => c.initialPrompts?.[0]?.content);

  it("primes a base for every kind of question, so the first decision after it is warm", async () => {
    const { p, state } = make({ createMs: 500 });
    const warming = p.warmUp();
    await vi.advanceTimersByTimeAsync(500);
    await warming;
    expect(SYSTEMS(state)).toEqual([GATE_SYSTEM, LABELS_SYSTEM, CORROBORATE_SYSTEM]);
    expect(await p.isConsentDialog(banner)).toMatchObject({
      kind: "answer",
      meta: { cold: false },
    });
    expect(await p.labelControls(banner, [0])).toMatchObject({ meta: { cold: false } });
    expect(state.createCalls).toHaveLength(3);
  });

  it("creates nothing again: not on a second warm-up, nor for a decision that waits on the first", async () => {
    const { p, state } = make({ createMs: 500 });
    const warming = [p.warmUp(), p.warmUp()];
    const decision = p.isConsentDialog(banner);
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(warming);
    expect(await decision).toMatchObject({ kind: "answer", meta: { cold: true } });
    await p.warmUp();
    expect(state.createCalls).toHaveLength(3);
  });

  it("does nothing, and resolves, when the model isn't there", async () => {
    for (const availability of ["downloadable", "downloading", "unavailable"] as const) {
      const { p, state } = make({ availability });
      await p.warmUp();
      expect(state.createCalls).toHaveLength(0);
    }
    const hung = make({ availability: "never" });
    const warming = hung.p.warmUp();
    await vi.advanceTimersByTimeAsync(1500);
    await warming;
    expect(hung.state.createCalls).toHaveLength(0);
    expect(await new PromptApiProvider(undefined).warmUp()).toBeUndefined();
  });

  it("never throws: a failed create is left for the next decision to try again", async () => {
    const o: FakeOptions = { throwOn: { create: namedError("NotAllowedError") } };
    const { p, state } = make(o);
    await expect(p.warmUp()).resolves.toBeUndefined();
    delete o.throwOn?.create;
    expect(await p.isConsentDialog(banner)).toMatchObject({ kind: "answer", meta: { cold: true } });
    expect(state.createCalls).toHaveLength(4);
  });

  it("stops waiting at the create limit, but keeps a base that lands later", async () => {
    const { p, state } = make({ createMs: CREATE_TIMEOUT_MS + 5_000 });
    const warming = p.warmUp();
    await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);
    await warming;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.destroyed).toBe(0);
    expect(await p.isConsentDialog(banner)).toMatchObject({
      kind: "answer",
      meta: { cold: false },
    });
    expect(state.createCalls).toHaveLength(3);
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
  it("give the gate 150 characters of banner text and labelling and corroboration 300, from config", () => {
    expect([GATE_TEXT_CHARS, LABEL_TEXT_CHARS]).toEqual([150, 300]);
    const long = { ...banner, text: "x".repeat(400) };
    const textOf = (input: string) => input.split("\n")[0];
    expect(textOf(gateInput(long))).toBe(`Text: ${"x".repeat(GATE_TEXT_CHARS)}…`);
    const label = `Text: ${"x".repeat(LABEL_TEXT_CHARS)}…`;
    expect(textOf(labelInput(long, long.controls))).toBe(label);
    expect(textOf(corroborateInput(long, long.controls[0] as Control, "reject"))).toBe(label);
  });

  it("the gate prompt keeps the spec's two edits", () => {
    expect(GATE_SYSTEM).not.toContain('"Do not sell or share" choices');
    expect(GATE_SYSTEM).toContain("cookie preference centres)");
    expect(GATE_SYSTEM).toMatch(
      /NO:.*standalone US "Do not sell or share my personal information"/,
    );
  });
});

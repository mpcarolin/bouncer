import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/ai/mock/provider.ts";
import type { AiProvider, AiResult } from "../../src/core/ai.ts";
import { runBenchmark } from "../../src/core/bench.ts";
import type { BannerFixture } from "../../src/core/fixture.ts";
import { labelDeterministic } from "../../src/core/label.ts";
import type { Control, Label, SerialisedBanner } from "../../src/core/types.ts";
import { loadFixtures } from "../fixtures/load.ts";
import { b, btn, type Draft, lnk } from "../helpers/banner.ts";

const answer = <T>(value: T, ms = 1, cold = false): AiResult<T> => ({
  kind: "answer",
  value,
  meta: { ms, cold, onDevice: true },
});
const timeout = (ms = 8000): AiResult<never> => ({
  kind: "timeout",
  meta: { ms, cold: false, onDevice: true },
});
const failure = (error: string): AiResult<never> => ({
  kind: "error",
  error,
  meta: { ms: 2, cold: false, onDevice: true },
});

/** What the stub was asked, so a test can see which controls reached the model. */
interface Asked {
  gate: string[];
  labels: number[][];
  corroborate: { id: number; label: string }[];
}

interface Script {
  gate?: (b: SerialisedBanner, n: number) => AiResult<boolean>;
  labels?: (b: SerialisedBanner, ids: number[], n: number) => AiResult<Record<number, Label>>;
  corroborate?: (b: SerialisedBanner, c: Control, n: number) => AiResult<boolean>;
}

/** A provider whose every answer a test scripts. `n` counts that op's calls from 1. */
function stub(script: Script = {}): { provider: AiProvider; asked: Asked } {
  const asked: Asked = { gate: [], labels: [], corroborate: [] };
  const provider: AiProvider = {
    async status() {
      return { state: "available", onDevice: true };
    },
    async isConsentDialog(banner) {
      asked.gate.push(banner.text);
      return (script.gate ?? (() => answer(true)))(banner, asked.gate.length);
    },
    async labelControls(banner, ids) {
      asked.labels.push(ids);
      return (script.labels ?? (() => answer({})))(banner, ids, asked.labels.length);
    },
    async corroborate(banner, control, label) {
      asked.corroborate.push({ id: control.id, label });
      return (script.corroborate ?? (() => answer(false)))(
        banner,
        control,
        asked.corroborate.length,
      );
    },
  };
  return { provider, asked };
}

/** A hand-built fixture. `labels` is ground truth per control id, in the order the drafts come. */
function fixture(
  id: string,
  kind: "positive" | "negative",
  drafts: Draft[],
  labels: Label[] = [],
  gate: "consent" | "other" = kind === "positive" ? "consent" : "other",
): BannerFixture {
  const banner = { ...b(drafts), text: `banner ${id}` };
  return {
    id,
    kind,
    stage: 1,
    note: "built by the test",
    gate,
    banner,
    ...(kind === "positive"
      ? { expectedLabels: Object.fromEntries(labels.map((label, i) => [i, label])) }
      : {}),
  };
}

// Control 0 the rules label (regex reject); controls 1 and 2 they leave to the AI.
const mixed = (id: string) =>
  fixture(
    id,
    "positive",
    [btn("Reject all"), btn("Continue to site"), lnk("Cookie Policy")],
    ["reject", "accept", "link"],
  );

describe("runBenchmark on the real fixtures", () => {
  const fixtures = loadFixtures();

  it("counts one gate trial per fixture, and the controls the rules leave null on positives", async () => {
    const report = await runBenchmark(new MockProvider(), fixtures, 1);
    const nulls = fixtures
      .filter((f) => f.kind === "positive")
      .flatMap((f) => [...labelDeterministic(f.banner).values()])
      .filter((label) => label === null).length;
    expect(nulls).toBeGreaterThan(0);
    expect(report.gate.total).toBe(fixtures.length);
    expect(report.labeller.total).toBe(nulls);
    expect(report.gate.correct).toBeLessThanOrEqual(report.gate.total);
    expect(report.labeller.correct).toBeLessThanOrEqual(report.labeller.total);
    expect(typeof report.gate.medianMs).toBe("number");
    expect(typeof report.gate.p90Ms).toBe("number");
    expect(report.perFixture.map((f) => f.id)).toEqual(fixtures.map((f) => f.id));
  });

  it("asks corroboration where the mock says reject, and sets aside what the guards block", async () => {
    const report = await runBenchmark(new MockProvider(), fixtures, 1);
    const by = (id: string) => report.perFixture.find((f) => f.id === id);
    // The mock labels "Continue to site" reject and does not corroborate it.
    expect(by("adv-continue-to-site")?.corroboration).toMatchObject([
      { id: 1, label: "reject", answer: false },
    ]);
    // It labels "Fine by me" save, but the accept-wording guard blocks that before anyone is asked.
    expect(by("adv-fine-by-me")?.corroboration).toEqual([]);
    expect(by("adv-fine-by-me")?.blocked).toMatchObject([
      { id: 1, label: "save", reason: "accept_all" },
    ]);
    expect(report.corroboration.adversarialConfirmed).toEqual([]);
    // Only the seven adversarial fixtures are corroborated.
    const corroborated = report.perFixture.filter((f) => f.corroboration.length > 0);
    expect(corroborated.every((f) => f.id.startsWith("adv-"))).toBe(true);
  });

  it("counts every call by temperature", async () => {
    const report = await runBenchmark(new MockProvider(), fixtures, 1);
    const calls = report.perFixture.reduce(
      (n, f) => n + f.gate.length + f.labeller.length + f.corroboration.length,
      0,
    );
    expect(report.cold).toBe(0);
    expect(report.warm).toBe(calls);
  });
});

describe("runBenchmark: repetitions", () => {
  it("counts every repetition as a trial, in gate, labeller and latency", async () => {
    const fixtures = [mixed("p1"), mixed("p2"), fixture("n1", "negative", [btn("Sign up")])];
    const { provider, asked } = stub({
      gate: (_b, n) => answer(true, n * 10),
      labels: () => answer({ 1: "accept", 2: "link" }),
    });
    const progress: [number, number][] = [];
    const report = await runBenchmark(provider, fixtures, 3, (done, total) =>
      progress.push([done, total]),
    );
    expect(asked.gate).toHaveLength(9);
    expect(report.gate.total).toBe(9);
    expect(report.labeller).toEqual({ correct: 12, total: 12 });
    expect(report.perFixture.map((f) => f.gate.length)).toEqual([3, 3, 3]);
    expect(report.perFixture.map((f) => f.labeller.length)).toEqual([3, 3, 0]);
    // 10, 20 … 90 ms: the median is the 5th of nine; the 90th percentile is the 9th.
    expect(report.gate.medianMs).toBe(50);
    expect(report.gate.p90Ms).toBe(90);
    expect(progress.at(0)).toEqual([1, 9]);
    expect(progress.at(-1)).toEqual([9, 9]);
  });

  it("defaults to three repetitions", async () => {
    const { provider } = stub();
    const report = await runBenchmark(provider, [mixed("p1")]);
    expect(report.gate.total).toBe(3);
    expect(report.labeller.total).toBe(6);
  });

  it("takes the median of an even count as the mean of the middle two", async () => {
    const { provider } = stub({ gate: (_b, n) => answer(true, [10, 20, 30, 40][n - 1] as number) });
    const report = await runBenchmark(
      provider,
      [mixed("a"), mixed("b"), mixed("c"), mixed("d")],
      1,
    );
    expect(report.gate.medianMs).toBe(25);
  });
});

describe("runBenchmark: the gate", () => {
  it("counts a consent verdict on a non-consent banner as a false positive", async () => {
    const fixtures = [mixed("p1"), fixture("n1", "negative", [btn("Sign up")])];
    const { provider } = stub({ gate: () => answer(true) });
    const report = await runBenchmark(provider, fixtures, 1);
    expect(report.gate).toMatchObject({ correct: 1, total: 2, falsePositives: 1 });
    expect(report.perFixture[1]?.gate).toMatchObject([{ said: "consent", correct: false }]);
  });

  it("counts a miss on a consent banner as incorrect but not a false positive", async () => {
    const { provider } = stub({ gate: () => answer(false) });
    const report = await runBenchmark(provider, [mixed("p1")], 1);
    expect(report.gate).toMatchObject({ correct: 0, total: 1, falsePositives: 0 });
  });

  it("counts a timeout or an error as incorrect, never as a false positive, and times it", async () => {
    const fixtures = [
      fixture("n1", "negative", [btn("Sign up")]),
      fixture("n2", "negative", [btn("Sign up")]),
      fixture("n3", "negative", [btn("Sign up")]),
      fixture("n4", "negative", [btn("Sign up")]),
    ];
    const { provider } = stub({
      gate: (_b, n) =>
        [answer(false, 10), answer(false, 20), timeout(8000), failure("boom")][n - 1]!,
    });
    const report = await runBenchmark(provider, fixtures, 1);
    expect(report.gate).toMatchObject({ correct: 2, total: 4, falsePositives: 0 });
    expect(report.perFixture[2]?.gate).toEqual([
      { ms: 8000, cold: false, outcome: "timeout", correct: false },
    ]);
    expect(report.perFixture[3]?.gate).toMatchObject([
      { outcome: "error", error: "boom", correct: false },
    ]);
    // The wait a user would have sat through counts: the timed-out call is the slowest.
    expect(report.gate.p90Ms).toBe(8000);
    expect(report.gate.medianMs).toBe(15);
  });
});

describe("runBenchmark: the labeller", () => {
  it("sends and scores only the controls the rules leave to the AI", async () => {
    const { provider, asked } = stub({ labels: () => answer({ 1: "accept", 2: "other" }) });
    const report = await runBenchmark(provider, [mixed("p1")], 1);
    expect(asked.labels).toEqual([[1, 2]]);
    expect(report.labeller).toEqual({ correct: 1, total: 2 });
    expect(report.perFixture[0]?.labeller).toMatchObject([
      {
        controls: [
          { id: 1, expected: "accept", got: "accept", correct: true },
          { id: 2, expected: "link", got: "other", correct: false },
        ],
      },
    ]);
  });

  it("counts a control the model did not answer for as incorrect", async () => {
    const { provider } = stub({ labels: () => answer({ 1: "accept" }) });
    const report = await runBenchmark(provider, [mixed("p1")], 1);
    expect(report.labeller).toEqual({ correct: 1, total: 2 });
  });

  it("counts every control incorrect when the call times out, and keeps the total", async () => {
    const { provider } = stub({ labels: () => timeout() });
    const report = await runBenchmark(provider, [mixed("p1")], 2);
    expect(report.labeller).toEqual({ correct: 0, total: 4 });
    expect(report.perFixture[0]?.labeller).toHaveLength(2);
    expect(report.perFixture[0]?.labeller[0]).toMatchObject({ outcome: "timeout" });
  });

  it("does not call the model for a positive with nothing left to it, or for a negative", async () => {
    const fixtures = [
      fixture("p1", "positive", [btn("Reject all")], ["reject"]),
      fixture("n1", "negative", [btn("Continue to site")]),
    ];
    const { provider, asked } = stub();
    const report = await runBenchmark(provider, fixtures, 1);
    expect(asked.labels).toEqual([]);
    expect(report.labeller).toEqual({ correct: 0, total: 0 });
  });
});

describe("runBenchmark: corroboration of adversarial controls", () => {
  const adv = () =>
    fixture(
      "adv-test",
      "positive",
      [btn("Continue to site"), btn("OK, allow all cookies"), btn("Proceed")],
      ["accept", "accept", "accept"],
    );
  const sayReject = () => answer<Record<number, Label>>({ 0: "reject", 1: "reject", 2: "reject" });

  it("lists each AI reject, save or settings label corroboration would confirm", async () => {
    const { provider, asked } = stub({
      labels: sayReject,
      corroborate: (_b, c) => answer(c.id === 0),
    });
    const report = await runBenchmark(provider, [adv()], 1);
    expect(report.corroboration.adversarialConfirmed).toEqual(["adv-test:0 reject"]);
    expect(asked.corroborate).toEqual([
      { id: 0, label: "reject" },
      { id: 2, label: "reject" },
    ]);
  });

  it("does not list, or ask about, a control the guards block, and records it", async () => {
    const { provider, asked } = stub({ labels: sayReject, corroborate: () => answer(true) });
    const report = await runBenchmark(provider, [adv()], 1);
    // Control 1 ("OK, allow all cookies") is accept wording: blocked before corroboration.
    expect(asked.corroborate.map((q) => q.id)).toEqual([0, 2]);
    expect(report.corroboration.adversarialConfirmed).toEqual([
      "adv-test:0 reject",
      "adv-test:2 reject",
    ]);
    expect(report.perFixture[0]?.blocked).toEqual([
      { rep: 0, id: 1, label: "reject", reason: "accept_all" },
    ]);
  });

  it("lists a case once even when several repetitions confirm it", async () => {
    const { provider } = stub({
      labels: sayReject,
      corroborate: (_b, c) => answer(c.id === 0),
    });
    const report = await runBenchmark(provider, [adv()], 3);
    expect(report.corroboration.adversarialConfirmed).toEqual(["adv-test:0 reject"]);
    expect(report.perFixture[0]?.corroboration.filter((t) => t.answer === true)).toHaveLength(3);
  });

  it("counts a confirmation from any repetition", async () => {
    const { provider } = stub({
      labels: sayReject,
      corroborate: (_b, c, n) => answer(c.id === 2 && n > 2),
    });
    const report = await runBenchmark(provider, [adv()], 2);
    expect(report.corroboration.adversarialConfirmed).toEqual(["adv-test:2 reject"]);
  });

  it("does not list a timeout or an error, and does not ask for a label the model withheld", async () => {
    const { provider, asked } = stub({
      labels: () => answer<Record<number, Label>>({ 0: "reject", 2: "accept" }),
      corroborate: () => timeout(),
    });
    const report = await runBenchmark(provider, [adv()], 1);
    expect(report.corroboration.adversarialConfirmed).toEqual([]);
    expect(asked.corroborate).toEqual([{ id: 0, label: "reject" }]);
    expect(report.perFixture[0]?.corroboration).toMatchObject([{ id: 0, outcome: "timeout" }]);
  });

  it("asks nothing when the labelling call fails", async () => {
    const { provider, asked } = stub({ labels: () => failure("boom") });
    const report = await runBenchmark(provider, [adv()], 1);
    expect(asked.corroborate).toEqual([]);
    expect(report.corroboration.adversarialConfirmed).toEqual([]);
  });

  it("leaves a positive that is not adversarial alone", async () => {
    const plain = { ...adv(), id: "plain" };
    const { provider, asked } = stub({ labels: sayReject, corroborate: () => answer(true) });
    const report = await runBenchmark(provider, [plain], 1);
    expect(asked.corroborate).toEqual([]);
    expect(report.corroboration.adversarialConfirmed).toEqual([]);
  });
});

describe("runBenchmark: cold and warm", () => {
  it("counts every call of every kind by the temperature the provider reports", async () => {
    const advOnly = fixture("adv-test", "positive", [btn("Continue to site")], ["accept"]);
    const { provider } = stub({
      gate: (_b, n) => answer(true, n === 1 ? 900 : 100, n === 1),
      labels: () => answer({ 0: "reject" }, 400, true),
      corroborate: () => answer(false, 200),
    });
    const report = await runBenchmark(provider, [advOnly], 2);
    // Per repetition: a gate call, a labelling call, a corroboration call.
    expect(report.cold + report.warm).toBe(6);
    expect(report.cold).toBe(3);
    expect(report.warm).toBe(3);
    expect(report.latency).toEqual({ coldMedianMs: 400, warmMedianMs: 200 });
  });

  it("reports no latency for a temperature that never occurred", async () => {
    const { provider } = stub();
    const report = await runBenchmark(provider, [mixed("p1")], 1);
    expect(report.cold).toBe(0);
    expect(report.latency.coldMedianMs).toBeNull();
    expect(report.latency.warmMedianMs).toBe(1);
  });
});

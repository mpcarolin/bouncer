import { describe, expect, test, vi } from "vitest";
import { type ChooseOpts, choose, decide } from "../../src/core/choose.ts";
import { labelDeterministic, mergeAiLabels } from "../../src/core/label.ts";
import type { Control, Label, Labelled } from "../../src/core/types.ts";
import { loadFixtures } from "../fixtures/load.ts";
import { b, btn, type Draft, lnk, toLabelled, tog } from "../helpers/banner.ts";

const DEFAULTS: ChooseOpts = { closeAction: "click", agreeToDismiss: false, allowSettings: true };

function labelled(drafts: Draft[], ai: Record<number, Label> = {}) {
  const banner = b(drafts);
  return { banner, labels: mergeAiLabels(banner, labelDeterministic(banner), ai) };
}
function run(drafts: Draft[], o: Partial<ChooseOpts> = {}, ai: Record<number, Label> = {}) {
  const { banner, labels } = labelled(drafts, ai);
  return choose(banner, labels, { ...DEFAULTS, ...o });
}

describe("fixtures", () => {
  test.each(loadFixtures().filter((f) => f.expectedDecision && f.kind === "positive"))(
    "fixture decision $id",
    (f) => {
      const o = { ...DEFAULTS, allowSettings: f.stage === 1 };
      expect(choose(f.banner, toLabelled(f.expectedLabels ?? {}), o).kind).toBe(f.expectedDecision);
    },
  );
});

describe("choose", () => {
  test("vetoed reject loses to plain reject", () => {
    expect(run([btn("Weigeren"), btn("Doorgaan met aanvaarden")])).toEqual({
      kind: "reject",
      target: 0,
    });
  });

  test("only refusal vetoed -> unsure, not close", () => {
    expect(run([btn("Doorgaan met aanvaarden"), btn("Close")])).toEqual({
      kind: "unsure",
      reason: "refusal_vetoed",
    });
  });

  test("settings beats close", () => {
    expect(run([btn("Cookie settings"), btn("×")])).toEqual({ kind: "settings", target: 0 });
  });

  test("close default and leave", () => {
    const drafts = [btn("×"), btn("Accept")];
    expect(run(drafts)).toEqual({ kind: "close", target: 0 });
    expect(run(drafts, { closeAction: "leave" })).toEqual({ kind: "no_option" });
  });

  test("agree-only is no_option even though accept is blocked", () => {
    expect(labelled([btn("Agree")]).labels.get(0)?.blocked).toBe("accept_all");
    expect(run([btn("Agree")])).toEqual({ kind: "no_option" });
  });

  test("agree to dismiss prefers acknowledge, else accept", () => {
    const o = { agreeToDismiss: true };
    expect(run([btn("Accept all"), btn("OK")], o)).toEqual({ kind: "agree", target: 1 });
    expect(run([btn("Accept all")], o)).toEqual({ kind: "agree", target: 0 });
  });

  test("an empty or unrecognised banner is unsure", () => {
    expect(run([btn("Hmm")], {}, { 0: "other" })).toMatchObject({ kind: "unsure" });
  });

  test("button preferred over link for reject", () => {
    expect(run([lnk("Reject all"), btn("Reject all")])).toEqual({ kind: "reject", target: 1 });
  });

  test("save toggles: optional on->off, optout off->on, necessary and disabled untouched", () => {
    const d = run([
      tog("Analytics", { on: true }),
      tog("Marketing", { on: false }),
      tog("Do not sell my data", { on: false }),
      tog("Strictly necessary", { on: true, disabled: true }),
      btn("Save preferences"),
    ]);
    expect(d).toEqual({
      kind: "save",
      target: 4,
      toggles: [
        { id: 0, to: false },
        { id: 2, to: true },
      ],
    });
    const d2 = run([tog("Analytics", { on: true }), btn("Save preferences")]);
    expect(d2).toEqual({ kind: "save", target: 1, toggles: [{ id: 0, to: false }] });
  });

  test("two save candidates, one allow-listed -> it; two allow-listed -> unsure", () => {
    const toggle = tog("Analytics", { on: true });
    expect(run([toggle, btn("Save"), btn("Allow selection")])).toMatchObject({
      kind: "save",
      target: 2,
    });
    expect(run([toggle, btn("Allow selection"), btn("Allow selection")])).toEqual({
      kind: "unsure",
      reason: "ambiguous_save",
    });
    expect(run([toggle, btn("Save"), btn("Save now")])).toMatchObject({ kind: "unsure" });
  });

  test("stage 2 never hops again", () => {
    expect(run([btn("Cookie settings")], { allowSettings: false })).toEqual({
      kind: "unsure",
      reason: "no_usable_control",
    });
  });

  describe("any §0 block on a refusal route ends unsure", () => {
    const vetoed = { kind: "unsure", reason: "refusal_vetoed" };
    test("AI reject that is accept-all, next to Close", () => {
      const drafts = [btn("Accept cookies and continue to site"), btn("Close")];
      const { labels } = labelled(drafts, { 0: "reject" });
      expect(labels.get(0)?.blocked).toBe("accept_all");
      expect(run(drafts, {}, { 0: "reject" })).toEqual(vetoed);
    });
    test("vetoed settings next to Close", () => {
      const drafts = [btn("Accept and customize"), btn("Close")];
      expect(labelled(drafts).labels.get(0)).toMatchObject({ label: "settings" });
      expect(run(drafts)).toEqual(vetoed);
    });
    test("save with toggles still wins over a vetoed reject", () => {
      const r = run([
        btn("Doorgaan met aanvaarden"),
        tog("Analytics", { on: true }),
        btn("Save preferences"),
      ]);
      expect(r).toMatchObject({ kind: "save", target: 2 });
    });
    test("closeAction leave does not turn it into no_option", () => {
      expect(run([btn("Doorgaan met aanvaarden"), btn("Close")], { closeAction: "leave" })).toEqual(
        vetoed,
      );
    });
    test("agreeToDismiss does not agree past a vetoed reject", () => {
      expect(
        run([btn("Doorgaan met aanvaarden"), btn("Accept all")], { agreeToDismiss: true }),
      ).toEqual(vetoed);
    });
    test("a do-not-sell control does not veto Close", () => {
      expect(run([btn("Do Not Sell My Personal Information"), btn("Close")])).toEqual({
        kind: "close",
        target: 1,
      });
    });
  });

  test("absent controls are ignored", () => {
    expect(run([btn("Reject all", { absent: "submit" }), btn("Close")])).toEqual({
      kind: "close",
      target: 1,
    });
  });
});

describe("decide", () => {
  const ask = (answer: boolean | "timeout" | "error") =>
    vi.fn<
      (c: Control, l: "reject" | "save" | "settings") => Promise<boolean | "timeout" | "error">
    >(async () => answer);

  test("an AI reject that corroborates stands, marked corroborated and AI-only", async () => {
    const { banner, labels } = labelled([btn("Proceed"), btn("Accept all")], { 0: "reject" });
    const corroborate = ask(true);
    const r = await decide(banner, labels, DEFAULTS, corroborate);
    expect(r.decision).toEqual({ kind: "reject", target: 0 });
    expect(r.aiOnlyClick).toBe(true);
    expect(r.corroborations).toEqual([{ id: 0, answer: true }]);
    expect(corroborate).toHaveBeenCalledOnce();
    expect(labels.get(0)?.corroborated).toBeUndefined();
  });

  test("corroboration no relabels and re-chooses", async () => {
    const { banner, labels } = labelled([btn("Proceed"), btn("Cookie settings")], { 0: "reject" });
    const corroborate = ask(false);
    const r = await decide(banner, labels, DEFAULTS, corroborate);
    expect(r.decision).toEqual({ kind: "settings", target: 1 });
    expect(r.aiOnlyClick).toBe(false);
    expect(corroborate).toHaveBeenCalledTimes(1);
    expect(r.corroborations).toEqual([{ id: 0, answer: false }]);
  });

  test("returns the labels it decided on: denied ones demoted, confirmed ones marked", async () => {
    const { banner, labels } = labelled([btn("Proceed"), btn("Go on"), btn("Reject all")], {
      0: "reject",
      1: "reject",
    });
    const corroborate = vi.fn(async (c: Control) => c.id === 1);
    const r = await decide(banner, labels, DEFAULTS, corroborate);
    expect(r.decision).toEqual({ kind: "reject", target: 1 });
    expect(r.labels.get(0)).toEqual({ label: "other", source: "ai" });
    expect(r.labels.get(1)).toEqual({ label: "reject", source: "ai", corroborated: true });
    expect(r.labels.get(2)).toEqual(labels.get(2));
    // The caller's map is left as it was.
    expect(labels.get(0)).toEqual({ label: "reject", source: "ai" });
  });

  test("two AI labels both denied end without looping", async () => {
    const { banner, labels } = labelled([btn("Proceed"), btn("Go on")], {
      0: "reject",
      1: "reject",
    });
    const corroborate = ask(false);
    const r = await decide(banner, labels, DEFAULTS, corroborate);
    expect(r.decision.kind).toBe("unsure");
    expect(corroborate).toHaveBeenCalledTimes(2);
  });

  test("corroboration timeout and error -> unsure", async () => {
    const { banner, labels } = labelled([btn("Proceed")], { 0: "reject" });
    expect((await decide(banner, labels, DEFAULTS, ask("timeout"))).decision).toEqual({
      kind: "unsure",
      reason: "model_timeout",
    });
    expect((await decide(banner, labels, DEFAULTS, ask("error"))).decision).toEqual({
      kind: "unsure",
      reason: "model_error",
    });
  });

  test("regex labels are not corroborated", async () => {
    const { banner, labels } = labelled([btn("Reject all"), btn("Accept all")]);
    const corroborate = ask(false);
    const r = await decide(banner, labels, DEFAULTS, corroborate);
    expect(r.decision).toEqual({ kind: "reject", target: 0 });
    expect(r.aiOnlyClick).toBe(false);
    expect(corroborate).not.toHaveBeenCalled();
  });

  test("an AI-only agree is flagged but not corroborated", async () => {
    const { banner, labels } = labelled([btn("Fine by me")], { 0: "acknowledge" });
    const corroborate = ask(false);
    const o = { ...DEFAULTS, agreeToDismiss: true };
    const r = await decide(banner, labels, o, corroborate);
    expect(r.decision).toEqual({ kind: "agree", target: 0 });
    expect(r.aiOnlyClick).toBe(true);
    expect(corroborate).not.toHaveBeenCalled();
  });
});

// Compile-time check that Labelled stays what the chooser consumes.
const _l: Labelled = { label: "other", source: "rule" };
void _l;

import { describe, expect, test } from "vitest";
import { idsLeftToAi, labelDeterministic, mergeAiLabels } from "../../src/core/label.ts";
import { loadFixtures } from "../fixtures/load.ts";
import { b, btn, lab, lnk, tog } from "../helpers/banner.ts";

describe("fixtures", () => {
  test.each(loadFixtures().filter((f) => f.kind === "positive"))(
    "deterministic labels agree with expectations: $id",
    (f) => {
      const det = labelDeterministic(f.banner);
      for (const [id, l] of det) {
        if (l) expect(l.label, `control ${id}`).toBe(f.expectedLabels?.[id]);
      }
    },
  );
});

test("the AI is left the controls the rules leave open, never an absent one or a toggle", () => {
  const banner = b([
    btn("Reject all"),
    btn("Continue to site"),
    btn("Proceed", { absent: "navigates" }),
    lnk("Cookie Policy"),
    tog("Marketing"),
  ]);
  expect(idsLeftToAi(banner, labelDeterministic(banner))).toEqual([1, 3]);
});

test("toggles are deterministic", () => {
  const l = lab([
    tog("Marketing", { disabled: true }),
    tog("Strictly necessary"),
    tog("Do not sell my data"),
    tog("Analytics"),
    tog("Allow analytics cookies"),
    tog("Non-essential cookies"),
  ]);
  expect(l.map((x) => x.label)).toEqual([
    "toggle-necessary",
    "toggle-necessary",
    "toggle-optout",
    "toggle-optional",
    "toggle-optional",
    "toggle-optional",
  ]);
  expect(l.every((x) => x.source === "rule" && !x.blocked)).toBe(true);
});

test("close before regex", () => expect(lab([btn("Close")])[0]?.label).toBe("close"));

test("× with accept aria-label is blocked", () =>
  expect(lab([btn("×", { ariaLabel: "Accept and continue browsing" })])[0]?.blocked).toBe(
    "accept_all",
  ));

test("save needs toggles", () => {
  expect(lab([btn("Save settings"), tog("Analytics")])[0]?.label).toBe("save");
  expect(lab([btn("Save settings")])[0]?.label).not.toBe("save");
});

test("everything word is never save", () => {
  const l = lab([btn("Save all"), tog("Analytics")])[0];
  expect(l?.blocked).toBe("accept_all");
  expect(l?.label).not.toBe("save");
});

test("do not sell is never reject", () =>
  expect(lab([lnk("Do not sell or share my personal information")])[0]).toMatchObject({
    label: "other",
    blocked: "do_not_sell",
  }));

test("vetoed regex reject keeps label, is blocked", () =>
  expect(lab([btn("Doorgaan met aanvaarden")])[0]).toMatchObject({
    label: "reject",
    blocked: "accept_verb_veto",
  }));

test("unknown wording goes to the AI", () =>
  expect(labelDeterministic(b([btn("Continue to site")])).get(0)).toBeNull());

test("regex class comes from the first source that is not other", () =>
  expect(lab([btn("×!", { ariaLabel: "Reject all" })])[0]?.label).toBe("reject"));

test("AI close becomes other; AI never labels toggles", () => {
  const banner = b([btn("Proceed"), tog("Ads")]);
  const m = mergeAiLabels(banner, labelDeterministic(banner), { 0: "close", 1: "reject" });
  expect(m.get(0)).toEqual({ label: "other", source: "ai" });
  expect(m.get(1)).toEqual({ label: "toggle-optional", source: "rule" });
});

test("a missing AI label is other", () =>
  expect(lab([btn("Proceed")])[0]).toEqual({ label: "other", source: "ai" }));

test("AI labels pass the block rules", () =>
  expect(lab([btn("Sounds good")], { 0: "reject" })[0]).toMatchObject({
    label: "reject",
    source: "ai",
    blocked: "accept_all",
  }));

test("do not sell is blocked whatever the regex class or AI label", () => {
  expect(lab([lnk("Don't sell my data")], { 0: "settings" })[0]).toMatchObject({
    label: "other",
    blocked: "do_not_sell",
  });
  expect(lab([lnk("Don't sell my data")], { 0: "reject" })[0]).toMatchObject({
    label: "other",
    blocked: "do_not_sell",
  });
});

test("AI settings or reject with an accept verb is vetoed", () => {
  expect(lab([btn("Anpassen und akzeptieren")], { 0: "settings" })[0]).toMatchObject({
    label: "settings",
    blocked: "accept_verb_veto",
  });
  expect(lab([btn("Manage and agree")], { 0: "reject" })[0]?.blocked).toBe("accept_verb_veto");
});

test("regex settings with an accept verb is vetoed", () => {
  expect(lab([btn("Customize and agree")])[0]).toMatchObject({
    label: "settings",
    source: "regex",
    blocked: "accept_verb_veto",
  });
});

test("hide wording is close, in the same anchored form as close and dismiss", () => {
  for (const t of ["Hide", "Hide this message", "Hide cookie message", "Hide the cookie message"]) {
    expect(lab([btn(t)])[0]?.label, t).toBe("close");
  }
  for (const t of ["Hide details", "Hide purposes", "Hide greeting"]) {
    expect(lab([btn(t)])[0]?.label, t).not.toBe("close");
  }
});

test("Schließen is close", () => {
  expect(lab([btn("Schließen")])[0]?.label).toBe("close");
  expect(lab([btn("Schliessen")])[0]?.label).toBe("close");
});

import { describe, expect, test } from "vitest";
import { labelDeterministic, mergeAiLabels } from "../../src/core/label.ts";
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

import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { portFixtures } from "../../scripts/port-fixtures.ts";
import type { BannerFixture } from "../../src/core/fixture.ts";
import type { DecisionKind, Label } from "../../src/core/types.ts";
import { loadFixtures } from "../fixtures/load.ts";
import { validateFixture } from "../fixtures/schema.ts";

const SPIKE_DIR = "spike/prompt-variants/fixtures";
const BANNERS_DIR = "test/fixtures/banners";

const fixtures = loadFixtures();
const byId = new Map(fixtures.map((f) => [f.id, f]));
const get = (id: string): BannerFixture => {
  const f = byId.get(id);
  if (!f) throw new Error(`missing fixture ${id}`);
  return f;
};

const NEW_NEGATIVES = [
  "neg-notification-prompt",
  "neg-app-install",
  "neg-survey",
  "neg-privacy-policy-update",
  "neg-us-do-not-sell",
];

const ADVERSARIAL: Record<string, string> = {
  "adv-continue-to-site": "Continue to site",
  "adv-proceed": "Proceed",
  "adv-fine-by-me": "Fine by me",
  "adv-douisuru": "同意する",
  "adv-hyvaksy": "Hyväksy",
  "adv-elfogadom": "Elfogadom",
  "adv-sounds-good": "Sounds good",
};

/**
 * A minimal §2f over ground-truth labels (default options), to catch a hand-written
 * `expectedDecision` that contradicts the labels. Not the production chooser.
 */
function decide(f: BannerFixture): DecisionKind {
  const labels = f.expectedLabels ?? {};
  const withLabel = (...ls: Label[]) =>
    f.banner.controls.filter((c) => ls.includes(labels[c.id] as Label));
  const clickable = (ls: Label[]) =>
    withLabel(...ls).filter((c) => c.role === "button" || c.role === "link");
  if (clickable(["reject"]).length > 0) return "reject";
  const optional = withLabel("toggle-optional", "toggle-optout");
  if (optional.length > 0 && clickable(["save"]).length > 0) return "save";
  if (f.stage === 1 && clickable(["settings"]).length > 0) return "settings";
  if (clickable(["close"]).length > 0) return "close";
  if (clickable(["accept", "acknowledge"]).length > 0) return "no_option";
  return "unsure";
}

describe("fixture corpus", () => {
  test("loads and validates every fixture, with unique ids", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(27);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    for (const f of fixtures) expect(validateFixture(f), f.id).toEqual([]);
  });

  test("holds the 27 ported spike fixtures: 16 positive, 11 negative", async () => {
    const ids = (
      JSON.parse(await readFile(join(SPIKE_DIR, "index.json"), "utf8")) as string[]
    ).sort();
    expect(ids).toHaveLength(27);
    for (const id of ids) expect(byId.has(id), id).toBe(true);
    const ported = ids.map(get);
    expect(ported.filter((f) => f.kind === "positive")).toHaveLength(16);
    expect(ported.filter((f) => f.kind === "negative")).toHaveLength(11);
    expect(ported.some((f) => f.synthetic)).toBe(false);
  });

  test("every positive labels every control, and toggle labels sit on toggles only", () => {
    for (const f of fixtures.filter((x) => x.kind === "positive")) {
      for (const c of f.banner.controls) {
        const label = f.expectedLabels?.[c.id];
        expect(label, `${f.id}#${c.id}`).toBeDefined();
        expect(label?.startsWith("toggle-") ?? false, `${f.id}#${c.id}`).toBe(c.role === "toggle");
      }
    }
  });

  test("a disabled toggle is toggle-necessary", () => {
    for (const f of fixtures.filter((x) => x.kind === "positive")) {
      for (const c of f.banner.controls.filter((x) => x.role === "toggle" && x.disabled)) {
        expect(f.expectedLabels?.[c.id], `${f.id}#${c.id}`).toBe("toggle-necessary");
      }
    }
  });

  test("expectedDecision agrees with a hand-run of §2f over the labels", () => {
    for (const f of fixtures.filter((x) => x.kind === "positive")) {
      expect(f.expectedDecision, f.id).toBe(decide(f));
    }
  });

  test("negatives expect not_consent and gate 'other'; positives gate 'consent'", () => {
    for (const f of fixtures) {
      expect(f.gate, f.id).toBe(f.kind === "negative" ? "other" : "consent");
      if (f.kind === "negative") expect(f.expectedDecision, f.id).toBe("not_consent");
    }
  });

  test.each(NEW_NEGATIVES)("%s exists as a hand-written negative", (id) => {
    const f = get(id);
    expect(f.kind).toBe("negative");
    expect(f.gate).toBe("other");
    expect(f.synthetic).toBe(true);
  });

  test("the do-not-sell negative offers no refusal-looking cookie control", () => {
    const f = get("neg-us-do-not-sell");
    expect(f.banner.text.toLowerCase()).toContain("do not sell");
    expect(f.banner.controls.some((c) => /do not sell/i.test(c.text))).toBe(true);
  });

  test.each(Object.entries(ADVERSARIAL))(
    "%s: %s is the only refusal-looking control",
    (id, wording) => {
      const f = get(id);
      expect(f.synthetic).toBe(true);
      expect(f.kind).toBe("positive");
      expect(f.expectedDecision).toBe("no_option");
      const named = f.banner.controls.filter((c) => c.text === wording);
      expect(named).toHaveLength(1);
      expect(f.expectedLabels?.[named[0]?.id ?? -1]).toBe("accept");
      const others = f.banner.controls.filter((c) => c.text !== wording);
      expect(others.length).toBeGreaterThanOrEqual(1);
      expect(others.length).toBeLessThanOrEqual(2);
      for (const c of others) expect(f.expectedLabels?.[c.id], `${id}#${c.id}`).toBe("link");
    },
  );
});

describe("validateFixture", () => {
  const base = (): BannerFixture => structuredClone(get("nvidia"));

  test("rejects a positive control with no label", () => {
    const f = base();
    delete f.expectedLabels?.[4];
    expect(validateFixture(f).join()).toContain("control 4");
  });

  test("rejects a toggle label on a button and a plain label on a toggle", () => {
    const f = base();
    if (f.expectedLabels) f.expectedLabels[4] = "toggle-optional";
    expect(validateFixture(f).join()).toContain("control 4");
    const g = structuredClone(get("pfa-cookiebot"));
    if (g.expectedLabels) g.expectedLabels[7] = "other";
    expect(validateFixture(g).join()).toContain("control 7");
  });

  test("rejects a negative that is not not_consent, and a positive that is", () => {
    const f = structuredClone(get("neg-survey"));
    f.expectedDecision = "reject";
    expect(validateFixture(f).length).toBeGreaterThan(0);
    const g = base();
    g.expectedDecision = "not_consent";
    expect(validateFixture(g).length).toBeGreaterThan(0);
  });

  test("rejects non-sequential control ids", () => {
    const f = base();
    const first = f.banner.controls[0];
    if (first) first.id = 7;
    expect(validateFixture(f).join()).toContain("ids");
  });
});

describe("scripts/port-fixtures", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("converts a spike fixture: i→id, label→text, id→domId, select/tab→other", async () => {
    dir = await mkdtemp(join(tmpdir(), "bouncer-port-"));
    await portFixtures({ srcDir: SPIKE_DIR, outDir: dir });
    const out = JSON.parse(
      await readFile(join(dir, "pfa-cookiebot.json"), "utf8"),
    ) as BannerFixture;
    expect(out.expectedLabels).toBeUndefined();
    expect(out.expectedDecision).toBeUndefined();
    expect(out.banner.controls[1]).toEqual({
      id: 1,
      role: "other",
      text: "Consent",
      domId: "CybotCookiebotDialogNavDeclaration",
    });
    const sel = JSON.parse(
      await readFile(join(dir, "neg-jackdaniels-agegate.json"), "utf8"),
    ) as BannerFixture;
    expect(sel.banner.controls[1]?.role).toBe("other");
    expect(sel.kind).toBe("negative");
    expect(sel.gate).toBe("other");
  });

  test("is idempotent and keeps hand-filled labels, decisions and hand-written files", async () => {
    dir = await mkdtemp(join(tmpdir(), "bouncer-port-"));
    await cp(BANNERS_DIR, dir, { recursive: true });
    await portFixtures({ srcDir: SPIKE_DIR, outDir: dir });
    const names = (await readdir(BANNERS_DIR)).sort();
    expect((await readdir(dir)).sort()).toEqual(names);
    for (const name of names) {
      expect(await readFile(join(dir, name), "utf8"), name).toBe(
        await readFile(join(BANNERS_DIR, name), "utf8"),
      );
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  isLearnedRule,
  type LearnedBanner,
  type LearnedRule,
  LearnedRules,
  learnable,
  recordRule,
  type TargetRef,
} from "../../src/core/learned.ts";
import type { LogEntry } from "../../src/core/log.ts";
import type { KV } from "../../src/core/platform.ts";
import { MemoryKV } from "../helpers/fake-platform.ts";

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: "e1",
  at: 0,
  site: "example.com",
  url: "https://example.com/",
  path: "ai",
  clicked: [{ id: 1, text: "Reject all", aiOnly: false }],
  toggles: [],
  t: {},
  modelCalls: [],
  verification: "verified",
  outcome: "dismissed",
  notes: [],
  ...over,
});

const ref = (selector: string, text: string, label: TargetRef["label"]): TargetRef => ({
  selector,
  text,
  label,
});

const banner: LearnedBanner = {
  controls: ["accept|accept all", "reject|reject all"],
  locator: "#cookie-notice",
};

const rejectRule = (site = "example.com"): LearnedRule => ({
  site,
  createdAt: 1,
  banner,
  stage1: {
    action: "reject",
    target: ref(":scope > button:nth-of-type(2)", "Reject all", "reject"),
  },
});

const settingsRule = (): LearnedRule => ({
  site: "example.com",
  createdAt: 1,
  banner: { controls: ["accept|accept", "settings|cookie settings"] },
  stage1: { action: "settings", target: ref("#prefs-open", "Cookie settings", "settings") },
  stage2: {
    action: "save",
    target: ref(":scope > button:nth-of-type(1)", "Save choices", "save"),
    toggles: [
      { ref: ref("#c-ana", "Analytics cookies", "toggle-optional"), to: false },
      { ref: ref("#c-dns", "Do not sell", "toggle-optout"), to: true },
    ],
  },
});

describe("learnable", () => {
  it("is true for a verified, regex-only reject, on the AI path and the fast path", () => {
    expect(learnable(entry())).toBe(true);
    expect(learnable(entry({ path: "heuristic", gate: "skipped" }))).toBe(true);
  });

  it("is false for dismissed_close, dismissed_agreed and failed", () => {
    expect(learnable(entry({ outcome: "dismissed_close" }))).toBe(false);
    expect(learnable(entry({ outcome: "dismissed_agreed" }))).toBe(false);
    expect(learnable(entry({ outcome: "failed", verification: "not_gone" }))).toBe(false);
  });

  it("is false for a flow with any AI-only click, in stage 1 or stage 2", () => {
    const first = [{ id: 1, text: "Proceed", aiOnly: true }];
    expect(learnable(entry({ clicked: first }))).toBe(false);
    const second = [
      { id: 0, text: "Cookie settings", aiOnly: false },
      { id: 5, text: "Proceed", aiOnly: true },
    ];
    expect(learnable(entry({ clicked: second }))).toBe(false);
  });

  it("is false for a successful replay (it is not saved again), and without a verified click", () => {
    expect(learnable(entry({ path: "learned" }))).toBe(false);
    expect(learnable(entry({ path: "autoconsent" }))).toBe(false);
    expect(learnable(entry({ clicked: [] }))).toBe(false);
    expect(learnable(entry({ verification: undefined }))).toBe(false);
  });
});

describe("recordRule", () => {
  it("dates the recorded stages and names the site", () => {
    const { banner: b, stage1, stage2 } = settingsRule();
    const rule = recordRule("example.com", { banner: b, stage1, stage2 }, 42);
    expect(rule).toEqual({ site: "example.com", createdAt: 42, banner: b, stage1, stage2 });
    expect(isLearnedRule(rule)).toBe(true);
    expect(recordRule("example.com", { banner, stage1: rejectRule().stage1 }, 1)).toEqual(
      rejectRule(),
    );
  });
});

describe("isLearnedRule", () => {
  it("accepts a reject rule and a settings → save rule", () => {
    expect(isLearnedRule(rejectRule())).toBe(true);
    expect(isLearnedRule(settingsRule())).toBe(true);
  });

  it("refuses a toggle whose target state is not its label's: an optional toggle is only ever switched off", () => {
    const r = settingsRule();
    const toggles = [{ ref: ref("#c-ana", "Analytics cookies", "toggle-optional"), to: true }];
    expect(isLearnedRule({ ...r, stage2: { ...r.stage2, toggles } })).toBe(false);
    const necessary = [{ ref: ref("#c-nec", "Necessary", "toggle-necessary"), to: false }];
    expect(isLearnedRule({ ...r, stage2: { ...r.stage2, toggles: necessary } })).toBe(false);
  });

  it("refuses a target whose label is not the stage's action, or one labelled accept", () => {
    const r = rejectRule();
    const accept = { ...r.stage1, target: ref("#a", "Accept all", "accept") };
    expect(isLearnedRule({ ...r, stage1: accept })).toBe(false);
    const close = { action: "close", target: ref("#x", "×", "close") };
    expect(isLearnedRule({ ...r, stage1: close })).toBe(false);
  });

  it("needs stage 2 exactly when stage 1 opens settings, and toggles exactly on a save", () => {
    const s = settingsRule();
    expect(isLearnedRule({ ...s, stage2: undefined })).toBe(false);
    expect(isLearnedRule({ ...rejectRule(), stage2: s.stage2 })).toBe(false);
    expect(isLearnedRule({ ...s, stage2: { ...s.stage2, toggles: [] } })).toBe(false);
    const withToggles = { ...rejectRule().stage1, toggles: s.stage2?.toggles };
    expect(isLearnedRule({ ...rejectRule(), stage1: withToggles })).toBe(false);
  });

  it("needs the banner's fingerprint: label|text controls with known labels, and a locator if any", () => {
    const r = rejectRule();
    expect(isLearnedRule({ ...r, banner: { controls: ["reject|reject all"] } })).toBe(true);
    for (const bad of [
      undefined,
      {},
      { controls: [] },
      { controls: ["reject all"] },
      { controls: ["|reject all"] },
      { controls: ["refuse|reject all"] },
      { controls: ["constructor|x"] },
      { controls: [3] },
      { controls: "reject|reject all" },
      { controls: ["reject|reject all"], locator: "" },
      { controls: ["reject|reject all"], locator: 7 },
    ]) {
      expect(isLearnedRule({ ...r, banner: bad })).toBe(false);
    }
  });

  it("refuses malformed values", () => {
    for (const bad of [
      null,
      "rule",
      {},
      { ...rejectRule(), site: "" },
      { ...rejectRule(), createdAt: "now" },
      {
        ...rejectRule(),
        stage1: { action: "reject", target: { selector: "", text: "x", label: "reject" } },
      },
    ]) {
      expect(isLearnedRule(bad)).toBe(false);
    }
  });
});

describe("LearnedRules", () => {
  it("stores one rule per site: put, get, list, remove", async () => {
    const rules = new LearnedRules(new MemoryKV());
    expect(await rules.get("example.com")).toBeUndefined();
    await rules.put(rejectRule());
    await rules.put(rejectRule("other.example"));
    expect(await rules.get("example.com")).toEqual(rejectRule());
    expect(await rules.list()).toHaveLength(2);

    await rules.put(settingsRule()); // replaces example.com's
    expect(await rules.get("example.com")).toEqual(settingsRule());
    await rules.remove("example.com");
    expect(await rules.get("example.com")).toBeUndefined();
    expect(await rules.list()).toEqual([rejectRule("other.example")]);
    await rules.remove("never.example"); // nothing to remove is fine
  });

  it("keeps its rules in the KV it was given, across instances", async () => {
    const kv = new MemoryKV();
    await new LearnedRules(kv).put(rejectRule());
    expect(await new LearnedRules(kv).get("example.com")).toEqual(rejectRule());
  });

  it("concurrent writes from different tabs lose nothing", async () => {
    const rules = new LearnedRules(new MemoryKV());
    await Promise.all(["a", "b", "c", "d"].map((s) => rules.put(rejectRule(`${s}.example`))));
    expect((await rules.list()).map((r) => r.site).sort()).toEqual([
      "a.example",
      "b.example",
      "c.example",
      "d.example",
    ]);
  });

  it("keeps one key per site, plus an index of the sites, and get reads only the site's key", async () => {
    const kv = new MemoryKV();
    const read: string[] = [];
    const watched: KV = {
      get: (k) => {
        read.push(k);
        return kv.get(k);
      },
      set: (k, v) => kv.set(k, v),
      remove: (k) => kv.remove(k),
    };
    const rules = new LearnedRules(watched);
    await rules.put(rejectRule());
    await rules.put(rejectRule("other.example"));
    expect(await kv.get("learnedRule:example.com")).toEqual(rejectRule());
    expect(await kv.get("learnedRuleSites")).toEqual(["example.com", "other.example"]);

    read.length = 0;
    expect(await rules.get("other.example")).toEqual(rejectRule("other.example"));
    expect(read).toEqual(["learnedRule:other.example"]);

    await rules.remove("example.com");
    expect(await kv.get("learnedRule:example.com")).toBeUndefined();
    expect(await kv.get("learnedRuleSites")).toEqual(["other.example"]);
  });

  it("removeRuleOnly drops one site's rule and leaves the index and every other rule alone", async () => {
    const kv = new MemoryKV();
    const rules = new LearnedRules(kv);
    await rules.put(rejectRule());
    await rules.put(rejectRule("other.example"));
    const sets: string[] = [];
    const set = kv.set.bind(kv);
    kv.set = async (k, v) => {
      sets.push(k);
      return set(k, v);
    };

    await rules.removeRuleOnly("example.com");

    expect(sets).toEqual([]); // no read-modify-write of anything the background also writes
    expect(await kv.get("learnedRule:example.com")).toBeUndefined();
    expect(await kv.get("learnedRuleSites")).toEqual(["example.com", "other.example"]);
    expect(await rules.list()).toEqual([rejectRule("other.example")]);
    expect(await rules.get("example.com")).toBeUndefined();

    // The stale index entry is harmless: the site learns a rule again, once in the index.
    await rules.put(rejectRule());
    expect(await kv.get("learnedRuleSites")).toEqual(["example.com", "other.example"]);
    expect((await rules.list()).map((r) => r.site)).toEqual(["example.com", "other.example"]);
  });

  it("ignores stored entries that aren't valid rules, or are filed under another site", async () => {
    const kv = new MemoryKV();
    await kv.set("learnedRuleSites", [
      "example.com",
      "bad.example",
      "moved.example",
      "gone.example",
    ]);
    await kv.set("learnedRule:example.com", rejectRule());
    await kv.set("learnedRule:bad.example", { site: "bad.example" });
    await kv.set("learnedRule:moved.example", rejectRule("elsewhere.example"));
    const rules = new LearnedRules(kv);
    expect(await rules.list()).toEqual([rejectRule()]);
    expect(await rules.get("bad.example")).toBeUndefined();
    expect(await rules.get("moved.example")).toBeUndefined();
    const { banner: _, ...noBanner } = rejectRule("old.example");
    await kv.set("learnedRule:old.example", noBanner); // the format before banners
    expect(await rules.get("old.example")).toBeUndefined();
  });

  it("refuses to store an invalid rule, and inherited names are not sites", async () => {
    const rules = new LearnedRules(new MemoryKV());
    await expect(rules.put({ ...rejectRule(), site: "" })).rejects.toThrow();
    expect(await rules.get("constructor")).toBeUndefined();
    expect(await rules.get("__proto__")).toBeUndefined();
  });
});

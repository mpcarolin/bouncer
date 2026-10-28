import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockProvider } from "../../src/ai/mock/provider.ts";
import type { AiStatus } from "../../src/core/ai.ts";
import { startBackground } from "../../src/core/background-app.ts";
import { LOG_RETENTION_MS } from "../../src/core/config.ts";
import { type LearnedRule, LearnedRules } from "../../src/core/learned.ts";
import { DecisionLog, type LogEntry } from "../../src/core/log.ts";
import type { KV } from "../../src/core/platform.ts";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../src/core/settings.ts";
import { renderSettings } from "../../src/pages/settings/render.ts";
import { type FakeBackground, fakeBackground, fakePage } from "../helpers/fake-platform.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

/** The background's provider, reporting whatever model status the test needs. */
class StatusProvider extends MockProvider {
  constructor(private readonly reported: AiStatus) {
    super();
  }
  override async status(): Promise<AiStatus> {
    return this.reported;
  }
}

let bg: FakeBackground;
beforeEach(() => {
  bg = fakeBackground();
});
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

async function open(opts: { status?: AiStatus; site?: string } = {}) {
  startBackground(bg, new StatusProvider(opts.status ?? { state: "available", onDevice: true }));
  const root = mount("");
  const page = fakePage(bg);
  await renderSettings(root, page, { site: opts.site, download: async () => ready });
  return { root, page };
}

const ready: AiStatus = { state: "available", onDevice: true };
const saved = () => loadSettings(bg.local);

const label = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("label")].find((l) => l.textContent?.includes(text));
const input = (root: ParentNode, text: string) => {
  const found = label(root, text)?.querySelector("input");
  if (!found) throw new Error(`no input labelled "${text}"`);
  return found;
};
const group = (root: ParentNode, legend: string) => {
  const found = [...root.querySelectorAll("fieldset")].find((f) =>
    f.querySelector("legend")?.textContent?.includes(legend),
  );
  if (!found) throw new Error(`no group "${legend}"`);
  return found;
};

describe("settings page: the switches", () => {
  it("shows the stored settings", async () => {
    await saveSettings(bg.local, {
      enabled: false,
      disabledSites: [],
      closeAction: "leave",
      agreeToDismiss: true,
      onFailed: "keep_hidden",
      keepModelWarm: true,
    });
    const { root } = await open();
    expect(input(root, "Bouncer is on").checked).toBe(false);
    expect(input(root, "Keep the on-device model loaded").checked).toBe(true);
    expect(input(group(root, "only Close"), "leave it").checked).toBe(true);
    expect(input(group(root, "no way to refuse"), "agree to dismiss").checked).toBe(true);
    expect(input(group(root, "dismissal fails"), "keep it hidden").checked).toBe(true);
  });

  it("shows the defaults when nothing is stored", async () => {
    const { root } = await open();
    expect(input(root, "Bouncer is on").checked).toBe(true);
    expect(input(group(root, "only Close"), "click Close").checked).toBe(true);
    expect(input(group(root, "no way to refuse"), "leave it").checked).toBe(true);
    expect(input(group(root, "dismissal fails"), "put it back").checked).toBe(true);
    expect(input(root, "Keep the on-device model loaded").checked).toBe(false);
  });

  it("keeping the model loaded persists, and the background keeps running while it is on", async () => {
    const { root } = await open();
    expect(root.textContent).toContain("stays in memory");
    input(root, "Keep the on-device model loaded").click();
    await vi.waitFor(async () => expect((await saved()).keepModelWarm).toBe(true));
    await vi.waitFor(() => expect(bg.running).toBe(1));
    input(root, "Keep the on-device model loaded").click();
    await vi.waitFor(async () => expect((await saved()).keepModelWarm).toBe(false));
    await vi.waitFor(() => expect(bg.running).toBe(0));
  });

  it("the global switch persists", async () => {
    const { root } = await open();
    input(root, "Bouncer is on").click();
    await vi.waitFor(async () => expect((await saved()).enabled).toBe(false));
    input(root, "Bouncer is on").click();
    await vi.waitFor(async () => expect((await saved()).enabled).toBe(true));
  });

  it("the Close choice persists", async () => {
    const { root } = await open();
    input(group(root, "only Close"), "leave it").click();
    await vi.waitFor(async () => expect((await saved()).closeAction).toBe("leave"));
    input(group(root, "only Close"), "click Close").click();
    await vi.waitFor(async () => expect((await saved()).closeAction).toBe("click"));
  });

  it("the no-option choice persists", async () => {
    const { root } = await open();
    input(group(root, "no way to refuse"), "agree to dismiss").click();
    await vi.waitFor(async () => expect((await saved()).agreeToDismiss).toBe(true));
    input(group(root, "no way to refuse"), "leave it").click();
    await vi.waitFor(async () => expect((await saved()).agreeToDismiss).toBe(false));
  });

  it("the failed choice persists", async () => {
    const { root } = await open();
    input(group(root, "dismissal fails"), "keep it hidden").click();
    await vi.waitFor(async () => expect((await saved()).onFailed).toBe("keep_hidden"));
    input(group(root, "dismissal fails"), "put it back").click();
    await vi.waitFor(async () => expect((await saved()).onFailed).toBe("restore"));
  });

  it("changing one setting leaves the others as they were stored", async () => {
    await saveSettings(bg.local, { ...DEFAULT_SETTINGS, disabledSites: ["news.example"] });
    const { root } = await open();
    input(group(root, "only Close"), "leave it").click();
    await vi.waitFor(async () => expect((await saved()).closeAction).toBe("leave"));
    expect(await saved()).toEqual({
      ...DEFAULT_SETTINGS,
      disabledSites: ["news.example"],
      closeAction: "leave",
    });
  });

  it("quick successive changes all land", async () => {
    const { root } = await open();
    input(root, "Bouncer is on").click();
    input(group(root, "only Close"), "leave it").click();
    input(group(root, "dismissal fails"), "keep it hidden").click();
    await vi.waitFor(async () =>
      expect(await saved()).toMatchObject({
        enabled: false,
        closeAction: "leave",
        onFailed: "keep_hidden",
      }),
    );
  });
});

describe("settings page: this site", () => {
  it("offers nothing without a site", async () => {
    const { root } = await open();
    expect(label(root, "Disable on this site")).toBeUndefined();
  });

  it("disables the site by its bare hostname, and enables it again", async () => {
    const { root } = await open({ site: "www.Example.com" });
    const box = input(root, "Disable on this site");
    expect(label(root, "Disable on this site")?.textContent).toContain("example.com");
    expect(box.checked).toBe(false);
    box.click();
    await vi.waitFor(async () => expect((await saved()).disabledSites).toEqual(["example.com"]));
    box.click();
    await vi.waitFor(async () => expect((await saved()).disabledSites).toEqual([]));
  });

  it("shows a site that is already disabled as disabled, even if stored with www.", async () => {
    await saveSettings(bg.local, {
      ...DEFAULT_SETTINGS,
      disabledSites: ["other.example", "www.example.com"],
    });
    const { root } = await open({ site: "example.com" });
    const box = input(root, "Disable on this site");
    expect(box.checked).toBe(true);
    box.click();
    await vi.waitFor(async () => expect((await saved()).disabledSites).toEqual(["other.example"]));
  });

  it("offers nothing for an empty site", async () => {
    const { root } = await open({ site: "" });
    expect(label(root, "Disable on this site")).toBeUndefined();
  });
});

const rule = (site: string): LearnedRule => ({
  site,
  createdAt: Date.now(),
  banner: { controls: ["reject|reject all"] },
  stage1: {
    action: "reject",
    target: { selector: ":scope > button", text: "Reject all", label: "reject" },
  },
});

const hopRule = (site: string): LearnedRule => ({
  site,
  createdAt: Date.now(),
  banner: { controls: ["settings|cookie settings"] },
  stage1: {
    action: "settings",
    target: { selector: "#prefs", text: "Cookie settings", label: "settings" },
  },
  stage2: {
    action: "save",
    target: { selector: ":scope > button", text: "Save choices", label: "save" },
    toggles: [
      { ref: { selector: "#ana", text: "Analytics", label: "toggle-optional" }, to: false },
    ],
  },
});

const ruleItems = (root: ParentNode) => [...root.querySelectorAll(".rules li")];

describe("settings page: learned rules", () => {
  it("says so when there are none", async () => {
    const { root } = await open();
    expect(ruleItems(root)).toHaveLength(0);
    expect(root.textContent).toContain("No learned rules");
  });

  it("lists each rule with its site and what it does", async () => {
    const rules = new LearnedRules(bg.local);
    await rules.put(rule("a.example"));
    await rules.put(hopRule("b.example"));
    const { root } = await open();
    const [a, b] = ruleItems(root);
    expect(a?.textContent).toContain("a.example");
    expect(a?.textContent).toContain("Reject all");
    expect(b?.textContent).toContain("b.example");
    expect(b?.textContent).toContain("Cookie settings");
    expect(b?.textContent).toContain("Save choices");
  });

  it("deleting a rule removes it, and leaves the other sites' rules and the index alone", async () => {
    const rules = new LearnedRules(bg.local);
    for (const site of ["a.example", "b.example", "c.example"]) await rules.put(rule(site));
    const { root } = await open();

    const b = ruleItems(root).find((li) => li.textContent?.includes("b.example"));
    (b?.querySelector("button") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(ruleItems(root)).toHaveLength(2));
    expect(ruleItems(root).some((li) => li.textContent?.includes("b.example"))).toBe(false);
    expect((await rules.list()).map((r) => r.site)).toEqual(["a.example", "c.example"]);
    expect(await rules.get("b.example")).toBeUndefined();
    expect(await bg.local.get("learnedRuleSites")).toEqual(["a.example", "b.example", "c.example"]);
  });

  it("deleting the last rule says there are none", async () => {
    await new LearnedRules(bg.local).put(rule("a.example"));
    const { root } = await open();
    (ruleItems(root)[0]?.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(root.textContent).toContain("No learned rules"));
  });
});

const NOW = Date.now();

const logEntry = (over: Partial<Omit<LogEntry, "id">> = {}): Omit<LogEntry, "id"> => ({
  at: NOW - 1000,
  site: "example.com",
  url: "https://example.com/",
  path: "ai",
  clicked: [],
  toggles: [],
  t: {},
  modelCalls: [],
  outcome: "dismissed",
  notes: [],
  ...over,
});

async function logged(...entries: Omit<LogEntry, "id">[]) {
  const log = new DecisionLog(bg.local);
  for (const e of entries) await log.add(e);
  return log;
}

const headers = (root: ParentNode) =>
  [...root.querySelectorAll(".log thead th")].map((th) => th.textContent);
const rows = (root: ParentNode) => [...root.querySelectorAll(".log tbody tr")];
const cell = (root: ParentNode, row: Element, column: string) => {
  const found = row.children[headers(root).indexOf(column)];
  if (!found) throw new Error(`no column "${column}"`);
  return found;
};
const parts = (el: Element) => [...el.children].map((c) => c.textContent);

describe("settings page: the decision log", () => {
  it("says so when there are no decisions", async () => {
    const { root } = await open();
    expect(rows(root)).toHaveLength(0);
    expect(root.textContent).toContain("No decisions");
  });

  it("has a column for everything the spec lists, and the labels", async () => {
    await logged(logEntry());
    const { root } = await open();
    expect(headers(root)).toEqual([
      "Site",
      "Time",
      "Path",
      "Gate",
      "Labels",
      "Clicked",
      "Toggles",
      "Timings",
      "Model calls",
      "Verification",
      "Outcome",
    ]);
  });

  it("renders no_option, unsure and the other non-clicking outcomes as distinct text", async () => {
    const outcomes = ["no_option", "unsure", "not_consent", "failed", "working"] as const;
    await logged(...outcomes.map((outcome, i) => logEntry({ outcome, at: NOW - 10_000 + i })));
    const { root } = await open();
    const shown = rows(root).map((r) => cell(root, r, "Outcome").firstElementChild?.textContent);
    // newest first
    expect(shown).toEqual(["working", "failed", "not consent", "unsure", "no option"]);
    expect(new Set(shown).size).toBe(outcomes.length);
  });

  it("spells out the dismissed variants and a model that was unavailable", async () => {
    const outcomes = [
      "dismissed",
      "dismissed_unverified",
      "dismissed_close",
      "dismissed_agreed",
      "dismissed_late",
      "deferred",
      "model_unavailable",
    ] as const;
    await logged(...outcomes.map((outcome, i) => logEntry({ outcome, at: NOW - 10_000 + i })));
    const { root } = await open();
    expect(rows(root).map((r) => cell(root, r, "Outcome").firstElementChild?.textContent)).toEqual([
      "model unavailable",
      "deferred",
      "dismissed (late)",
      "dismissed (agreed)",
      "dismissed (close)",
      "dismissed (unverified)",
      "dismissed",
    ]);
  });

  it("shows each field of a decision", async () => {
    const found = NOW - 5000;
    await logged(
      logEntry({
        site: "news.example",
        path: "autoconsent",
        rule: "OneTrust",
        gate: "consent",
        labels: {
          1: { label: "reject", source: "rule" },
          2: { label: "accept", source: "regex", blocked: "accept_all" },
          3: { label: "settings", source: "ai", corroborated: true },
        },
        clicked: [
          { id: 1, text: "Reject all", aiOnly: false },
          { id: 4, text: "Proceed", aiOnly: true },
        ],
        toggles: [
          { text: "Analytics", to: false },
          { text: "Do not sell", to: true },
        ],
        t: { found, decided: found + 310, gone: found + 1200 },
        modelCalls: [
          { op: "isConsentDialog", ms: 9120, cold: true, result: "answer" },
          { op: "labelControls", ms: 440.4, cold: false, result: "timeout" },
        ],
        verification: "verified",
        outcome: "failed",
        reason: "model_timeout",
      }),
    );
    const { root } = await open();
    const [row] = rows(root);
    if (!row) throw new Error("no row");
    expect(cell(root, row, "Site").textContent).toBe("news.example");
    expect(cell(root, row, "Time").textContent).not.toBe("");
    expect(cell(root, row, "Path").textContent).toBe("autoconsent: OneTrust");
    expect(cell(root, row, "Gate").textContent).toBe("consent");
    expect(parts(cell(root, row, "Labels"))).toEqual([
      "#1 reject (rule)",
      "#2 accept (regex, blocked: accept_all)",
      "#3 settings (ai, corroborated)",
    ]);
    expect(parts(cell(root, row, "Clicked"))).toEqual(["Reject all (#1)", "Proceed (#4, AI-only)"]);
    expect(parts(cell(root, row, "Toggles"))).toEqual(["Analytics: off", "Do not sell: on"]);
    const timings = parts(cell(root, row, "Timings"));
    expect(timings[0]).toMatch(/^found \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(timings.slice(1)).toEqual(["decided +310 ms", "gone +1200 ms"]);
    expect(parts(cell(root, row, "Model calls"))).toEqual([
      "isConsentDialog 9120 ms cold answer",
      "labelControls 440 ms warm timeout",
    ]);
    expect(cell(root, row, "Verification").textContent).toBe("verified");
    expect(parts(cell(root, row, "Outcome"))).toEqual(["failed", "model_timeout"]);
  });

  it("names the path of each kind of decision", async () => {
    const paths = ["heuristic", "ai", "learned", "deferred"] as const;
    await logged(...paths.map((path, i) => logEntry({ path, at: NOW - 10_000 + i })));
    const { root } = await open();
    expect(rows(root).map((r) => cell(root, r, "Path").textContent)).toEqual([
      "deferred",
      "learned rule",
      "AI",
      "heuristic",
    ]);
  });

  it("marks what a decision lacks", async () => {
    await logged(logEntry({ gate: undefined, verification: undefined }));
    const { root } = await open();
    const [row] = rows(root);
    if (!row) throw new Error("no row");
    for (const column of ["Gate", "Labels", "Clicked", "Toggles", "Model calls", "Verification"]) {
      expect(cell(root, row, column).textContent).toBe("–");
    }
    expect(cell(root, row, "Timings").textContent).toBe("–");
  });

  it("shows page text as text, never as markup", async () => {
    const hostile = `<img src=x onerror="document.title='pwned'">`;
    await logged(
      logEntry({
        site: hostile,
        clicked: [{ id: 1, text: "<b>bold</b>", aiOnly: false }],
        reason: hostile,
      }),
    );
    const { root } = await open();
    expect(root.querySelector(".log img, .log b")).toBeNull();
    const [row] = rows(root);
    if (!row) throw new Error("no row");
    expect(cell(root, row, "Site").textContent).toBe(hostile);
    expect(parts(cell(root, row, "Clicked"))).toEqual(["<b>bold</b> (#1)"]);
  });

  it("lists newest first, and leaves out what is past retention without deleting it", async () => {
    await bg.local.set("decisionLog", [
      { id: "old", ...logEntry({ site: "expired.test", at: NOW - LOG_RETENTION_MS - 60_000 }) },
      { id: "a", ...logEntry({ site: "first.test", at: NOW - 3000 }) },
      { id: "b", ...logEntry({ site: "second.test", at: NOW - 2000 }) },
    ]);
    const { root } = await open();
    expect(rows(root).map((r) => cell(root, r, "Site").textContent)).toEqual([
      "second.test",
      "first.test",
    ]);
    // Reading is not pruning: that write belongs to the background.
    expect(await bg.local.get<LogEntry[]>("decisionLog")).toHaveLength(3);
  });

  it("a decision the background logs while the page reads is not lost", async () => {
    const background = new DecisionLog(bg.local);
    await bg.local.set("decisionLog", [
      { id: "old", ...logEntry({ site: "expired.test", at: NOW - LOG_RETENTION_MS - 60_000 }) },
      { id: "a", ...logEntry({ site: "first.test" }) },
    ]);
    startBackground(bg, new StatusProvider(ready));

    // The page's read of the log is held until the background has logged a new decision.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes: string[] = [];
    const page = fakePage(bg);
    const slow: KV = {
      async get<T>(k: string) {
        const found = await bg.local.get<T>(k);
        if (k === "decisionLog") await held;
        return found;
      },
      set: async (k, v) => {
        writes.push(k);
        await bg.local.set(k, v);
      },
      remove: (k) => bg.local.remove(k),
    };
    const root = mount("");
    const rendering = renderSettings(
      root,
      { ...page, local: slow },
      { download: async () => ready },
    );

    await background.add(logEntry({ site: "second.test" }));
    release();
    await rendering;

    expect(writes).not.toContain("decisionLog");
    expect((await bg.local.get<LogEntry[]>("decisionLog"))?.map((e) => e.site)).toEqual([
      "first.test",
      "second.test",
    ]);
  });
});

describe("settings page: Export JSON", () => {
  async function exported(root: ParentNode) {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const button = [...root.querySelectorAll("button")].find(
      (b) => b.textContent === "Export JSON",
    );
    if (!button) throw new Error("no Export JSON button");
    button.click();
    await vi.waitFor(() => expect(clicked).toHaveLength(1));
    const [link] = clicked;
    if (!link) throw new Error("no download link");
    return { name: link.download, text: await (await fetch(link.href)).text() };
  }

  it("downloads the log as valid JSON of exactly what list() returns", async () => {
    const log = await logged(
      logEntry({ site: "a.test", path: "autoconsent", rule: "r" }),
      logEntry({
        site: "b.test",
        outcome: "no_option",
        clicked: [{ id: 1, text: "OK", aiOnly: false }],
        labels: { 1: { label: "acknowledge", source: "regex" } },
      }),
    );
    const { root } = await open();
    const { name, text } = await exported(root);
    expect(name).toMatch(/\.json$/);
    expect(JSON.parse(text)).toEqual(await log.list());
    expect(JSON.parse(text)).toHaveLength(2);
  });

  it("exports an empty log as an empty list", async () => {
    const { root } = await open();
    expect(JSON.parse((await exported(root)).text)).toEqual([]);
  });
});

describe("settings page: the model", () => {
  it("shows its state and whether it runs on this device", async () => {
    const { root } = await open({ status: { state: "available", onDevice: true } });
    expect(root.querySelector(".model")?.textContent).toContain("available");
    expect(root.querySelector(".model")?.textContent).toContain("Runs on this device: yes");
  });

  it("offers the download when the model is downloadable", async () => {
    const download = vi.fn(async (): Promise<AiStatus> => ready);
    startBackground(bg, new StatusProvider({ state: "downloadable", onDevice: true }));
    const root = mount("");
    await renderSettings(root, fakePage(bg), { download });
    expect(download).not.toHaveBeenCalled();
    const button = root.querySelector<HTMLButtonElement>(".model button");
    expect(button?.textContent).toContain("Download");
    button?.click();
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(root.querySelector(".model button")).toBeNull());
  });

  it("says plainly when the background could not answer", async () => {
    // No background is listening: the message rejects.
    const root = mount("");
    await renderSettings(root, fakePage(bg), { download: async () => ready });
    expect(root.querySelector(".model")?.textContent).toContain("couldn't read");
    expect(input(root, "Bouncer is on").checked).toBe(true); // the rest of the page still renders
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  enabledFor,
  loadSettings,
  saveSettings,
} from "../../src/core/settings.ts";
import { fakeBackground } from "../helpers/fake-platform.ts";

describe("settings", () => {
  it("defaults match the spec", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      enabled: true,
      disabledSites: [],
      closeAction: "click",
      agreeToDismiss: false,
      onFailed: "restore",
      keepModelWarm: false,
    });
  });

  it("reads a record stored before keepModelWarm existed as off", async () => {
    const { local } = fakeBackground();
    const { keepModelWarm: _, ...older } = DEFAULT_SETTINGS;
    await local.set("settings", { ...older, closeAction: "leave" });
    expect(await loadSettings(local)).toMatchObject({ closeAction: "leave", keepModelWarm: false });
  });

  it("loads defaults when nothing is stored, and round-trips a save", async () => {
    const { local } = fakeBackground();
    expect(await loadSettings(local)).toEqual(DEFAULT_SETTINGS);
    const s = { ...DEFAULT_SETTINGS, closeAction: "leave" as const, disabledSites: ["a.com"] };
    await saveSettings(local, s);
    expect(await loadSettings(local)).toEqual(s);
  });

  it("fills missing fields of a stored partial record from the defaults", async () => {
    const { local } = fakeBackground();
    await local.set("settings", { agreeToDismiss: true });
    expect(await loadSettings(local)).toEqual({ ...DEFAULT_SETTINGS, agreeToDismiss: true });
  });

  it("drops a stored disabledSites that isn't a list, and entries that aren't names", async () => {
    const { local } = fakeBackground();
    const cases: [unknown, string[]][] = [
      [7, []],
      [{ 0: "a.com" }, []],
      ["a.com", []],
      [
        ["a.com", 3, null, { site: "x" }, "b.com"],
        ["a.com", "b.com"],
      ],
    ];
    for (const [stored, sites] of cases) {
      await local.set("settings", { ...DEFAULT_SETTINGS, disabledSites: stored });
      const s = await loadSettings(local);
      expect(s.disabledSites).toEqual(sites);
      // The verdict, which every page's hello asks for, still comes.
      expect(enabledFor(s, "https://c.com/")).toBe(true);
    }
  });

  it("enabledFor ignores www. and honours disabledSites", () => {
    const s = { ...DEFAULT_SETTINGS, disabledSites: ["example.com"] };
    expect(enabledFor(s, "https://www.example.com/x")).toBe(false);
    expect(enabledFor(s, "https://example.com/")).toBe(false);
    expect(enabledFor(s, "https://other.com/")).toBe(true);
    expect(enabledFor(s, "https://sub.example.com/")).toBe(true);
  });

  it("enabledFor is false when globally disabled or the URL is unparseable", () => {
    expect(enabledFor({ ...DEFAULT_SETTINGS, enabled: false }, "https://a.com/")).toBe(false);
    expect(enabledFor(DEFAULT_SETTINGS, "not a url")).toBe(false);
  });
});

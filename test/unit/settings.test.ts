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
    });
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

import { afterEach, describe, expect, test } from "vitest";
import { clickability } from "../../src/core/page/clickable.ts";
import { serialise } from "../../src/core/page/serialise.ts";
import { applySave } from "../../src/core/pipeline/settings-hop.ts";
import { mount, mountPage } from "../helpers/mount.ts";
import { Agreeable, byId, cleanup, HIDDEN, start } from "../helpers/pipeline.ts";

declare global {
  interface Window {
    otCloseMs?: number;
    otClosedAt?: number;
    otConsent?: string;
    __consent?: string;
  }
}

const startUrl = location.href;

afterEach(() => {
  cleanup();
  history.replaceState(null, "", startUrl);
  delete window.otCloseMs;
  delete window.otClosedAt;
  delete window.otConsent;
  delete window.__consent;
});

const checked = (id: string) => (byId(id) as HTMLInputElement).checked;

describe("save with toggles and the settings hop", () => {
  test("custom-settings: settings → toggles → save gives ana=false,mkt=false,dns=true, dismissed, scroll unlocked", async () => {
    mountPage("custom-settings");
    const bar = byId("cookie-bar");
    const prefs = byId("cookie-prefs");
    const h = await start();
    document.body.style.overflow = "hidden"; // the banner locks scroll until consent

    const e = await h.path.done;
    expect(byId("status").textContent).toBe("consent: ana=false,mkt=false,dns=true");
    expect(e).toMatchObject({
      outcome: "dismissed",
      verification: "verified",
      clicked: [
        { text: "Cookie settings", aiOnly: false },
        { text: "Save choices", aiOnly: false },
      ],
      toggles: [
        { text: "Analytics cookies", to: false },
        { text: "Marketing cookies", to: false },
        { text: "Do not sell or share my personal information", to: true },
      ],
    });
    expect(e.reason).toBeUndefined();
    expect(e.notes).toContain("scroll:unlocked");
    expect(document.body.style.overflow).toBe("");
    expect(h.hidden).toEqual([bar, prefs]); // the panel is hidden the same way as the banner
    expect(bar.hasAttribute(HIDDEN) || prefs.hasAttribute(HIDDEN)).toBe(false);
    expect(document.querySelector("style[data-bouncer]")).toBeNull();
    expect(checked("c-nec")).toBe(true); // necessary is never touched
  });

  test("OneTrust-style: the banner vanishes when the panel opens; verification waits for the panel", async () => {
    mountPage("settings-onetrust");
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      clicked: [{ text: "Cookie Settings" }, { text: "Confirm My Choices" }],
      toggles: [
        { text: "Performance Cookies", to: false },
        { text: "Targeting Cookies", to: false },
      ],
    });
    expect(window.otConsent).toBe("perf=false,tgt=false");
    // The banner was gone from the settings click on; the dismissal is dated by the panel.
    expect(e.t.gone).toBeGreaterThanOrEqual(window.otClosedAt as number);
  });

  test("OneTrust-style: a panel that never closes is failed although the banner is gone", async () => {
    mountPage("settings-onetrust");
    window.otCloseMs = -1;
    const banner = byId("onetrust-banner-sdk");
    const pc = byId("onetrust-pc-sdk");
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "failed", reason: "not_gone", verification: "not_gone" });
    expect(getComputedStyle(banner).display).toBe("none");
    // Put back: the site's panel stays open, and visible, for the user.
    expect(getComputedStyle(pc).display).toBe("block");
    expect(pc.hasAttribute(HIDDEN)).toBe(false);
    expect(e.t.gone).toBeUndefined();
  });

  test("a panel with neither reject nor save → failed; nothing else clicked, the panel left visible", async () => {
    mountPage("settings-no-refusal");
    const banner = byId("cookie-banner");
    const panel = byId("cookie-panel");
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "panel_no_refusal",
      clicked: [{ text: "Manage cookies" }],
      toggles: [],
    });
    expect(e.notes).toContain("stage2:no_option");
    expect(window.__clicked).toBeUndefined();
    expect(h.clicks.every((el) => !panel.contains(el))).toBe(true);
    expect(checked("np-ana")).toBe(true);
    expect(h.hidden).toEqual([banner, panel]);
    expect(banner.hasAttribute(HIDDEN) || panel.hasAttribute(HIDDEN)).toBe(false);
    expect(getComputedStyle(panel).display).toBe("block");
  });

  test("the site re-enables Analytics after Bouncer's click → recheck_failed → failed, save not clicked", async () => {
    mountPage("settings-reenable");
    const save = byId("re-save");
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "recheck_failed",
      clicked: [{ text: "Cookie settings" }],
      toggles: [
        { text: "Analytics cookies", to: false },
        { text: "Marketing cookies", to: false },
      ],
    });
    expect(checked("re-ana")).toBe(true);
    expect(checked("re-mkt")).toBe(false);
    expect(window.__clicked).toBeUndefined();
    expect(h.clicks).not.toContain(save);
  });

  test('the panel offers only "Save & accept all" → failed, never clicked, no toggle touched', async () => {
    mountPage("settings-accept-all");
    const save = byId("aa-save");
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "panel_no_refusal",
      clicked: [{ text: "Cookie settings" }],
      toggles: [],
    });
    expect(window.__clicked).toBeUndefined();
    expect(h.clicks).not.toContain(save);
    expect([checked("aa-ana"), checked("aa-ads")]).toEqual([true, true]);
  });

  test('"Close" next to "Cookie settings" → it goes through settings', async () => {
    mountPage("settings-close");
    const close = byId("cookie-banner").querySelector('[aria-label="Close"]');
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      clicked: [{ text: "Cookie settings" }, { text: "Reject all" }],
    });
    expect(e.labels?.[1]).toMatchObject({ label: "close" }); // Close was there, and passed over
    expect(window.__clicked).toBe("reject");
    expect(h.clicks).not.toContain(close);
  });

  test("a stage-2 [mock:timeout] → failed, reason model_timeout", async () => {
    mountPage("custom-settings");
    const prefs = byId("cookie-prefs");
    // A control only the AI can label, so stage 2 has to ask the model.
    prefs.insertAdjacentHTML("beforeend", "<button>Vendor list</button> [mock:timeout]");
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "model_timeout",
      clicked: [{ text: "Cookie settings" }],
      toggles: [],
    });
    expect(e.modelCalls).toEqual([
      expect.objectContaining({ op: "isConsentDialog", result: "answer" }),
      expect.objectContaining({ op: "labelControls", result: "timeout" }),
    ]);
    expect(checked("c-ana")).toBe(true);
    expect(byId("status").textContent).toBe("consent: unset");
    expect(prefs.hasAttribute(HIDDEN)).toBe(false);
    expect(getComputedStyle(prefs).display).toBe("block");
  });

  test("an AI-only reject in the panel is corroborated, clicked and marked aiOnly", async () => {
    mountPage("custom-settings");
    const prefs = byId("cookie-prefs");
    prefs.insertAdjacentHTML("beforeend", "<button id=proceed>Proceed</button>");
    byId("proceed").addEventListener("click", () => {
      prefs.style.display = "none";
    });
    const h = await start({ provider: new Agreeable() });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      clicked: [
        { text: "Cookie settings", aiOnly: false },
        { text: "Proceed", aiOnly: true },
      ],
      toggles: [],
    });
    expect(e.modelCalls.map((m) => m.op)).toEqual([
      "isConsentDialog",
      "labelControls",
      "corroborate",
    ]);
    expect(e.notes).toContain("stage2:corroborate:5:true");
  });

  test("a settings control that opens nothing → failed panel_none, the banner put back", async () => {
    mountPage("custom-settings");
    const bar = byId("cookie-bar");
    (bar.querySelector("button") as HTMLButtonElement).removeAttribute("onclick");
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "panel_none",
      clicked: [{ text: "Cookie settings" }],
    });
    expect(bar.hasAttribute(HIDDEN)).toBe(false);
    expect(h.hidden).toEqual([bar]);
  });

  test("optional toggles in a collapsed <details> and a hidden tab are switched off before save", async () => {
    mountPage("settings-details");
    const h = await start();

    const e = await h.path.done;
    expect(window.__consent).toBe("ana=false,ads=false,social=false,nec=true");
    expect(e).toMatchObject({
      outcome: "dismissed",
      clicked: [{ text: "Cookie settings" }, { text: "Save choices" }],
      toggles: [
        { text: "Analytics cookies", to: false },
        { text: "Personalised advertising", to: false },
        { text: "Social media cookies", to: false },
      ],
    });
    expect((byId("dt-more") as HTMLDetailsElement).open).toBe(false); // never expanded
  });

  test("stage 1: a banner with toggles and save, but no reject, saves in place (collapsed toggle too)", async () => {
    mountPage("settings-in-banner");
    const h = await start();

    const e = await h.path.done;
    expect(window.__consent).toBe("ana=false,ads=false");
    expect(e).toMatchObject({
      outcome: "dismissed",
      clicked: [{ text: "Save choices", aiOnly: false }],
      toggles: [
        { text: "Analytics", to: false },
        { text: "Advertising", to: false },
      ],
    });
    // The gate saw only what the banner shows.
    expect(Object.keys(e.labels ?? {})).toHaveLength(3);
  });
});

describe("applySave", () => {
  const panel = (html: string) => {
    const box = mount(`<div>Cookie choices ${html}<button>Save choices</button></div>`);
    return serialise({ el: box.firstElementChild as Element }, clickability, {
      hiddenToggles: true,
    });
  };

  test("re-reads every toggle the panel exposes, not only the ones it switched", () => {
    const s = panel(`<label><input type=checkbox id=a checked> Analytics</label>
      <label><input type=checkbox id=b checked> Ads</label>`);
    // A decision that switches only Analytics leaves Ads on: the re-read fails it.
    expect(applySave({ kind: "save", target: 2, toggles: [{ id: 0, to: false }] }, s)).toBe(
      "recheck_failed",
    );
    expect(checked("a")).toBe(false);
    expect(applySave({ kind: "save", target: 2, toggles: [{ id: 1, to: false }] }, s)).toBe("ok");
  });

  test("a toggle click that navigates stops there, with its reason", () => {
    const s =
      panel(`<label><input type=checkbox id=a checked onclick="location.hash = 'moved'"> Analytics</label>
      <label><input type=checkbox id=b checked> Ads</label>`);
    const d = {
      kind: "save" as const,
      target: 2,
      toggles: [
        { id: 0, to: false },
        { id: 1, to: false },
      ],
    };
    expect(applySave(d, s)).toBe("navigation");
    expect(checked("b")).toBe(true); // nothing more is clicked after a navigation
  });
});

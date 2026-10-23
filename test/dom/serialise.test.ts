import { afterEach, describe, expect, it } from "vitest";
import { findCandidates } from "../../src/core/page/detect.ts";
import { isVisible, serialise } from "../../src/core/page/serialise.ts";
import type { AbsentReason } from "../../src/core/types.ts";
import { mount, mountPage, unmountAll } from "../helpers/mount.ts";

afterEach(unmountAll);

const BAR = "position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:8px;";
const none = () => null;

function ser(html: string, clickability: (el: Element) => AbsentReason | null = none) {
  mount(`<div id="b" style="${BAR}">${html}</div>`);
  const c = findCandidates(document)[0];
  if (!c) throw new Error("no candidate");
  return serialise(c, clickability);
}

describe("serialise", () => {
  it("serialises a toggle with on and disabled", () => {
    const { banner } = ser(`We use cookies.
      <label><input type="checkbox" id="ana" checked> Analytics</label>
      <label><input type="checkbox" id="nec" checked disabled> Necessary</label>
      <div role="switch" aria-checked="false" aria-disabled="true" tabindex="0">Ads</div>
      <button>Save</button>`);
    expect(banner.controls.map((c) => [c.role, c.text, c.on, c.disabled, c.domId])).toEqual([
      ["toggle", "Analytics", true, undefined, "ana"],
      ["toggle", "Necessary", true, true, "nec"],
      ["toggle", "Ads", false, true, undefined],
      ["button", "Save", undefined, undefined, undefined],
    ]);
  });

  it("keeps aria-label and title separate from text", () => {
    const { banner } = ser(`Cookies <button aria-label="Close dialog" title="Dismiss">X</button>`);
    expect(banner.controls[0]).toMatchObject({
      role: "button",
      text: "X",
      ariaLabel: "Close dialog",
      title: "Dismiss",
    });
  });

  it("maps roles per the rulings and keeps button elements as buttons", () => {
    const { banner } = ser(`Cookies
      <a href="/privacy">Policy</a>
      <span role="link">Span link</span>
      <span role="button">Span button</span>
      <input type="submit" value="Send">
      <button role="tab">Tab</button>
      <button role="alert">Alerting</button>`);
    expect(banner.controls.map((c) => [c.text, c.role])).toEqual([
      ["Policy", "link"],
      ["Span link", "link"],
      ["Span button", "button"],
      ["Send", "button"],
      ["Tab", "other"],
      ["Alerting", "button"],
    ]);
  });

  it("marks controls absent from clickability, but not toggles", () => {
    const asked: string[] = [];
    const { banner } = ser(
      `Cookies <button id="go">Go</button><a href="/x">Out</a><label><input type="checkbox"> Opt</label>`,
      (el) => {
        asked.push(el.tagName);
        return el.tagName === "A" ? "navigates" : null;
      },
    );
    expect(banner.controls.map((c) => c.absent)).toEqual([undefined, "navigates", undefined]);
    expect(asked).toEqual(["BUTTON", "A"]);
  });

  it("maps ids back to elements, caps text, and skips nested duplicates", () => {
    const long = "x".repeat(300);
    const { banner, elements } = ser(
      `Cookies <button><span role="button">${long}</span></button><button>Two</button>`,
    );
    expect(banner.controls).toHaveLength(2);
    expect(banner.controls[0]?.text).toHaveLength(120);
    expect(elements.get(1)?.textContent).toBe("Two");
  });

  it("caps banner text at 2000 characters", () => {
    const { banner } = ser(`Cookies ${"word ".repeat(1000)}<button>OK</button>`);
    expect(banner.text.length).toBe(2000);
  });

  it("omits invisible controls", () => {
    const { banner } = ser(
      `Cookies <button>Shown</button><button style="display:none">Hidden</button>`,
    );
    expect(banner.controls.map((c) => c.text)).toEqual(["Shown"]);
  });

  it("serialises controls inside a shadow root", () => {
    const box = mount("<div id='host'></div>");
    const root = box.querySelector("#host")?.attachShadow({ mode: "open" }) as ShadowRoot;
    root.innerHTML = `<div style="${BAR}">Cookies <button>OK</button></div>`;
    const c = findCandidates(document)[0];
    expect(c && serialise(c, none).banner.controls.map((x) => x.text)).toEqual(["OK"]);
  });
});

describe("isVisible", () => {
  it("is false for display:none and zero-size elements", () => {
    const box = mount(
      `<p id="a">hi</p><p id="b" style="display:none">hi</p><p id="c" style="height:0;overflow:hidden">x</p>`,
    );
    expect(isVisible(box.querySelector("#a") as Element)).toBe(true);
    expect(isVisible(box.querySelector("#b") as Element)).toBe(false);
    expect(isVisible(box.querySelector("#c") as Element)).toBe(false);
  });
});

describe("custom-settings page", () => {
  it("is detected and serialised in under 20 ms", () => {
    mountPage("custom-settings");
    findCandidates(document); // warm up style/layout caches the way a live page has them
    const t0 = performance.now();
    const c = findCandidates(document)[0];
    if (!c) throw new Error("no candidate");
    const { banner } = serialise(c, none);
    const ms = performance.now() - t0;
    expect(banner.controls.map((x) => x.text)).toEqual(["Cookie settings", "Accept"]);
    expect(banner.text).toContain("This website uses cookies");
    expect(ms).toBeLessThan(20);
  });
});

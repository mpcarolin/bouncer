import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NavigationWatch } from "../../src/core/page/click.ts";
import {
  autoconsentHides,
  autoconsentStyleTouches,
  isGoneBySite,
  verifyDismissed,
} from "../../src/core/page/verify.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

let nav: NavigationWatch;
beforeEach(() => {
  nav = new NavigationWatch(window);
});
afterEach(() => {
  nav.dispose();
  unmountAll();
  for (const s of document.querySelectorAll(
    "style#autoconsent-prehide, style#autoconsent-css-rules",
  ))
    s.remove();
  window.scrollTo(0, 0);
});

const mk = (style = "") =>
  mount(`<div id=b style="width:200px;height:50px;${style}">cookies</div>`).querySelector(
    "#b",
  ) as HTMLElement;
const fast = { goneMs: 600, stayMs: 400 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("isGoneBySite", () => {
  test("a visible element is not gone", () => {
    expect(isGoneBySite(mk())).toBe(false);
  });
  test("detached", () => {
    const b = mk();
    b.remove();
    expect(isGoneBySite(b)).toBe(true);
  });
  test("display:none, own or an ancestor's", () => {
    expect(isGoneBySite(mk("display:none"))).toBe(true);
    const box = mount('<div style="display:none"><p id=b>x</p></div>');
    expect(isGoneBySite(box.querySelector("#b") as Element)).toBe(true);
  });
  test("visibility:hidden", () => {
    expect(isGoneBySite(mk("visibility:hidden"))).toBe(true);
  });
  test("opacity 0", () => {
    expect(isGoneBySite(mk("opacity:0"))).toBe(true);
  });
  test("zero width or zero height", () => {
    expect(isGoneBySite(mk("height:0;overflow:hidden"))).toBe(true);
    expect(isGoneBySite(mk("width:0;overflow:hidden"))).toBe(true);
  });
  test("fixed and fully off-viewport", () => {
    expect(isGoneBySite(mk("position:fixed;left:-1000px;top:0"))).toBe(true);
    expect(isGoneBySite(mk("position:fixed;top:0;left:0"))).toBe(false);
  });
  test("a static element scrolled out of view is not gone", () => {
    const b = mk("margin-top:5000px");
    expect(b.getBoundingClientRect().top).toBeGreaterThan(innerHeight);
    expect(isGoneBySite(b)).toBe(false);
  });
  test("clip-path and pointer-events (Bouncer's own hiding) do not count", () => {
    expect(isGoneBySite(mk("clip-path:inset(100%);pointer-events:none"))).toBe(false);
  });
});

const inject = (root: ParentNode, id: string, css: string) => {
  const s = document.createElement("style");
  s.id = id;
  s.textContent = css;
  (root instanceof Document ? document.head : root).append(s);
  return s;
};

describe("autoconsentStyleTouches", () => {
  test("matches by selector, in either autoconsent style", () => {
    const b = mk();
    expect(autoconsentStyleTouches(b)).toBe(false);
    const s = inject(document, "autoconsent-css-rules", "#b { display:none }");
    expect(autoconsentStyleTouches(b)).toBe(true);
    s.remove();
  });
  test("non-matching rules and nested @media rules", () => {
    const b = mk();
    const s = inject(
      document,
      "autoconsent-prehide",
      "#nope{display:none} @media all { #b{display:none} }",
    );
    expect(autoconsentStyleTouches(b)).toBe(true);
    s.remove();
    const s2 = inject(document, "autoconsent-prehide", "#nope{display:none}");
    expect(autoconsentStyleTouches(b)).toBe(false);
    s2.remove();
  });
  test("the shadow root the element lives in", () => {
    const host = mount("<div id=h></div>").querySelector("#h") as HTMLElement;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<div id=b>x</div>";
    const b = sr.querySelector("#b") as Element;
    expect(autoconsentStyleTouches(b)).toBe(false);
    inject(sr, "autoconsent-css-rules", ".x{} #b{display:none}");
    expect(autoconsentStyleTouches(b)).toBe(true);
  });
  test("an unrelated style with another id is ignored", () => {
    const b = mk();
    const s = inject(document, "something-else", "#b{display:none}");
    expect(autoconsentStyleTouches(b)).toBe(false);
    s.remove();
  });
});

describe("autoconsentHides", () => {
  const banner = () =>
    mount(
      `<div id=wrap><div id=b class=banner>cookies <span id=inner>x</span></div></div><div id=sib>y</div>`,
    ).querySelector("#b") as HTMLElement;
  const prehide = (sel: string) => inject(document, "autoconsent-prehide", `${sel}{opacity:0}`);

  test("when autoconsent's styles match the element, one it sits in, or one inside it", () => {
    const b = banner();
    expect(autoconsentHides(b)).toBe(false);
    for (const sel of ["#b", "#wrap", "#inner"]) {
      const s = prehide(sel);
      expect(autoconsentHides(b), sel).toBe(true);
      s.remove();
    }
  });

  test("not when they match only something beside it, or come from another style", () => {
    const b = banner();
    const s = prehide("#sib");
    expect(autoconsentHides(b)).toBe(false);
    s.remove();
    const other = inject(document, "something-else", "#b{opacity:0}");
    expect(autoconsentHides(b)).toBe(false);
    other.remove();
  });

  test("across a shadow root: the host it sits in counts", () => {
    const host = mount("<div id=h></div>").querySelector("#h") as HTMLElement;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<div id=b>cookies</div>";
    const b = sr.querySelector("#b") as Element;
    expect(autoconsentHides(b)).toBe(false);
    prehide("#h");
    expect(autoconsentHides(b)).toBe(true);
  });
});

describe("verifyDismissed", () => {
  test("a site that removes the banner passes", async () => {
    const b = mk();
    setTimeout(() => b.remove(), 50);
    expect(await verifyDismissed([b], { ...fast, nav })).toEqual({ ok: true });
  });
  test("every element must be gone; one that stays gives not_gone", async () => {
    const a = mk();
    const b = mk();
    setTimeout(() => a.remove(), 20);
    expect(await verifyDismissed([a, b], { ...fast, nav })).toEqual({
      ok: false,
      reason: "not_gone",
    });
  });
  test("a site that hides it (display:none) passes", async () => {
    const b = mk();
    setTimeout(() => {
      b.style.display = "none";
    }, 50);
    expect((await verifyDismissed([b], { ...fast, nav })).ok).toBe(true);
  });
  test("an element removed then re-added fails with came_back", async () => {
    const b = mk();
    const parent = b.parentElement as Element;
    b.remove();
    setTimeout(() => parent.append(b), 250);
    expect(await verifyDismissed([b], { ...fast, nav })).toEqual({
      ok: false,
      reason: "came_back",
    });
  });
  test("navigation at any point gives navigation", async () => {
    const b = mk();
    b.remove();
    setTimeout(() => window.dispatchEvent(new Event("beforeunload")), 150);
    expect(await verifyDismissed([b], { ...fast, nav })).toEqual({
      ok: false,
      reason: "navigation",
    });
  });
  test("a banner re-inserted as a new element: reappeared() gives came_back; without it, ok", async () => {
    const run = async (reappeared?: () => boolean) => {
      const b = mk();
      const parent = b.parentElement as Element;
      b.remove();
      setTimeout(() => {
        const clone = b.cloneNode(true) as Element;
        clone.id = "clone";
        parent.append(clone);
      }, 200);
      return verifyDismissed([b], { ...fast, nav, reappeared });
    };
    const seen = () => document.querySelector("#clone") !== null;
    expect(await run(seen)).toEqual({ ok: false, reason: "came_back" });
    document.querySelector("#clone")?.remove();
    expect(await run()).toEqual({ ok: true });
  });
  test("no elements is not a dismissal", async () => {
    expect(await verifyDismissed([], { ...fast, nav })).toEqual({ ok: false, reason: "not_gone" });
  });
  test("an autoconsent style matching the element fails with autoconsent_style", async () => {
    const b = mk();
    setTimeout(() => {
      const s = document.createElement("style");
      s.id = "autoconsent-prehide";
      s.textContent = "#b{display:none!important}";
      document.head.append(s);
    }, 50);
    expect(await verifyDismissed([b], { ...fast, nav })).toEqual({
      ok: false,
      reason: "autoconsent_style",
    });
  });
  test("Bouncer's own hiding alone is not a dismissal", async () => {
    const b = mk("clip-path:inset(100%)");
    expect((await verifyDismissed([b], { ...fast, nav })).reason).toBe("not_gone");
  });
  test("default bounds: a 1 s site passes, a 3.5 s site fails with not_gone", async () => {
    const slow = mk();
    setTimeout(() => slow.remove(), 1000);
    const t0 = performance.now();
    expect(await verifyDismissed([slow], { nav })).toEqual({ ok: true });
    expect(performance.now() - t0).toBeGreaterThan(2900); // 1 s to go, then 2 s stay
    const late = mk();
    setTimeout(() => late.remove(), 3500);
    expect(await verifyDismissed([late], { nav })).toEqual({ ok: false, reason: "not_gone" });
    await sleep(600);
  }, 15000);
});

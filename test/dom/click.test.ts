import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NavigationWatch, captureFocus, safeClick } from "../../src/core/page/click.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

let nav: NavigationWatch;
let startUrl: string;

beforeEach(() => {
  startUrl = location.href;
  nav = new NavigationWatch(window);
});
afterEach(() => {
  nav.dispose();
  unmountAll();
  history.replaceState(null, "", startUrl);
  window.scrollTo(0, 0);
});

const link = (html = '<a id=t href="#cc">x</a>') => mount(html).querySelector("#t") as HTMLElement;

describe("safeClick", () => {
  test("hash guard prevents a fragment jump; site listener on the target sees defaultPrevented false", () => {
    const t = link();
    let seen: boolean | undefined;
    t.addEventListener("click", (e) => {
      seen = e.defaultPrevented;
    });
    expect(safeClick(t, nav)).toEqual({ ok: true, hashGuardUsed: true });
    expect(seen).toBe(false);
    expect(location.hash).toBe("");
  });

  test("delegated document listener sees defaultPrevented true", () => {
    const t = link();
    let seen: boolean | undefined;
    const on = (e: Event) => {
      seen = e.defaultPrevented;
    };
    document.addEventListener("click", on);
    try {
      safeClick(t, nav);
    } finally {
      document.removeEventListener("click", on);
    }
    expect(seen).toBe(true);
  });

  test("stopImmediatePropagation on the target defeats the guard -> hash change detected -> not ok", () => {
    const t = link();
    t.addEventListener("click", (e) => e.stopImmediatePropagation());
    expect(safeClick(t, nav)).toEqual({ ok: false, reason: "hash_changed", hashGuardUsed: true });
    expect(location.hash).toBe("#cc");
  });

  test("scroll-lock library restoring scrollY in its handler with guard flag set -> ok", () => {
    mount('<div style="height:3000px"></div>');
    window.scrollTo(0, 100);
    const t = link();
    t.addEventListener("click", () => window.scrollTo(0, 40));
    expect(safeClick(t, nav).ok).toBe(true);
    expect(window.scrollY).toBe(40);
  });

  test("guard listener is removed when the click never reached it", () => {
    const t = link();
    const block = (e: Event) => e.stopImmediatePropagation();
    t.addEventListener("click", block);
    safeClick(t, nav);
    t.removeEventListener("click", block);
    history.replaceState(null, "", startUrl);
    let seen: boolean | undefined;
    t.addEventListener("click", (e) => {
      seen = e.defaultPrevented;
    });
    const later = (e: Event) => {
      seen = e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener("click", later, { once: true });
    t.click();
    expect(seen).toBe(false);
  });

  test("detached element is never clicked", () => {
    const t = link('<button id=t type="button">x</button>');
    let clicks = 0;
    t.addEventListener("click", () => clicks++);
    t.remove();
    expect(safeClick(t, nav)).toEqual({ ok: false, reason: "stale_target", hashGuardUsed: false });
    expect(clicks).toBe(0);
  });

  test("a click that starts a script navigation is reported as navigation", () => {
    const t = link('<button id=t type="button">x</button>');
    t.addEventListener("click", () => {
      (
        window as unknown as { navigation: { navigate(u: string, o: object): void } }
      ).navigation.navigate("#away", { history: "replace" });
    });
    expect(nav.started()).toBe(false);
    expect(safeClick(t, nav)).toEqual({ ok: false, reason: "navigation", hashGuardUsed: false });
  });

  test("a plain button click is ok", () => {
    expect(safeClick(link('<button id=t type="button">x</button>'), nav)).toEqual({
      ok: true,
      hashGuardUsed: false,
    });
  });
});

describe("NavigationWatch", () => {
  test("beforeunload marks started; dispose stops listening", () => {
    const w = new NavigationWatch(window);
    window.dispatchEvent(new Event("beforeunload"));
    expect(w.started()).toBe(true);
    const w2 = new NavigationWatch(window);
    w2.dispose();
    window.dispatchEvent(new Event("beforeunload"));
    expect(w2.started()).toBe(false);
    w.dispose();
  });
});

describe("captureFocus", () => {
  test("focus moved into banner is restored without scrolling", () => {
    const box = mount(
      '<input id=a><div style="height:3000px"></div><div id=banner><button id=b>x</button></div>',
    );
    const a = box.querySelector("#a") as HTMLElement;
    a.focus();
    const restore = captureFocus(document);
    const b = box.querySelector("#b") as HTMLElement;
    b.focus({ preventScroll: true });
    window.scrollTo(0, 500);
    restore([box.querySelector("#banner") as Element]);
    expect(document.activeElement).toBe(a);
    expect(window.scrollY).toBe(500);
  });

  test("focus elsewhere is left alone", () => {
    const box = mount("<input id=a><input id=c><div id=banner></div>");
    (box.querySelector("#a") as HTMLElement).focus();
    const restore = captureFocus(document);
    const c = box.querySelector("#c") as HTMLElement;
    c.focus();
    restore([box.querySelector("#banner") as Element]);
    expect(document.activeElement).toBe(c);
  });

  test("focus inside a shadow root of a touched host is restored", () => {
    const box = mount("<input id=a><div id=host></div>");
    const a = box.querySelector("#a") as HTMLElement;
    const host = box.querySelector("#host") as HTMLElement;
    host.attachShadow({ mode: "open" }).innerHTML = "<button>x</button>";
    a.focus();
    const restore = captureFocus(document);
    (host.shadowRoot?.querySelector("button") as HTMLElement).focus();
    restore([host]);
    expect(document.activeElement).toBe(a);
  });
});

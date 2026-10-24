import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readToggle, recheck, setToggles } from "../../src/core/page/toggles.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

let startUrl: string;

beforeEach(() => {
  startUrl = location.href;
});
afterEach(() => {
  unmountAll();
  history.replaceState(null, "", startUrl);
  window.scrollTo(0, 0);
});

describe("toggles", () => {
  test("reads checkboxes, ARIA switches and unreadable elements", () => {
    const box = mount(`
      <input id=a type=checkbox checked><input id=b type=checkbox>
      <div id=c role=switch aria-checked=true></div><div id=d role=checkbox aria-checked=false></div>
      <div id=e role=switch></div><button id=f>x</button>`);
    const r = (id: string) => readToggle(box.querySelector(`#${id}`) as Element);
    expect([r("a"), r("b"), r("c"), r("d"), r("e"), r("f")]).toEqual([
      true,
      false,
      true,
      false,
      null,
      null,
    ]);
  });

  test("reads and sets a toggle inside a collapsed <details>", () => {
    const box = mount(
      "<details><summary>More</summary><input id=t type=checkbox checked></details>",
    );
    const t = box.querySelector("#t") as HTMLInputElement;
    expect(box.querySelector("details")?.open).toBe(false);
    expect(readToggle(t)).toBe(true);
    expect(setToggles([{ el: t, to: false }])).toEqual({ ok: true });
    expect(t.checked).toBe(false);
    expect(recheck([{ el: t, to: false }])).toBe(true);
  });

  test("clicks only where the state differs", () => {
    const box = mount(`<input id=a type=checkbox checked><input id=b type=checkbox checked>`);
    const a = box.querySelector("#a") as HTMLInputElement;
    const b = box.querySelector("#b") as HTMLInputElement;
    let clicks = 0;
    for (const el of [a, b]) el.addEventListener("click", () => clicks++);
    setToggles([
      { el: a, to: true },
      { el: b, to: false },
    ]);
    expect(clicks).toBe(1);
    expect([a.checked, b.checked]).toEqual([true, false]);
  });

  test("switches an ARIA switch via its click handler", () => {
    const box = mount(
      `<div id=s role=switch aria-checked=true onclick="this.setAttribute('aria-checked','false')"></div>`,
    );
    const s = box.querySelector("#s") as Element;
    setToggles([{ el: s, to: false }]);
    expect(readToggle(s)).toBe(false);
  });

  test("never clicks an aria-disabled switch, or one inside an aria-disabled container", () => {
    const flip = `onclick="this.setAttribute('aria-checked','false')"`;
    const box = mount(
      `<div id=a role=switch aria-checked=true aria-disabled=true ${flip}></div>
       <div aria-disabled=true><div id=b role=switch aria-checked=true ${flip}></div></div>`,
    );
    const a = box.querySelector("#a") as Element;
    const b = box.querySelector("#b") as Element;
    let clicks = 0;
    for (const el of [a, b]) el.addEventListener("click", () => clicks++);
    const targets = [
      { el: a, to: false },
      { el: b, to: false },
    ];
    expect(setToggles(targets)).toEqual({ ok: true });
    expect(clicks).toBe(0);
    expect([readToggle(a), readToggle(b)]).toEqual([true, true]);
    expect(recheck(targets)).toBe(false);
  });

  test("switches a switch whose click would submit its form, behind the submit guard", async () => {
    // A <button> with no type is a submit button; the guard cancels the form's submission.
    const box = mount(`<form id=f action="/accept-all">
      <button id=s role=switch aria-checked=true onclick="this.setAttribute('aria-checked','false')">Ads</button>
      <input id=c type=checkbox checked></form>`);
    const s = box.querySelector("#s") as Element;
    const c = box.querySelector("#c") as HTMLInputElement;
    let submitted = 0;
    box.querySelector("#f")?.addEventListener("submit", () => submitted++);
    // A navigation that got past the guard would take the test page away: cancel it, and count it.
    const navigation = (window as unknown as { navigation: EventTarget }).navigation;
    let leaked = 0;
    const onNavigate = (e: Event) => {
      if (!e.defaultPrevented) leaked++;
      e.preventDefault();
    };
    navigation.addEventListener("navigate", onNavigate);
    try {
      const targets = [
        { el: s, to: false },
        { el: c, to: false },
      ];
      expect(setToggles(targets)).toEqual({ ok: true });
      expect(submitted).toBe(1); // the page's own handler saw the submission
      expect(recheck(targets)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(leaked).toBe(0);
      expect(location.href).toBe(startUrl);
    } finally {
      navigation.removeEventListener("navigate", onNavigate);
    }
  });

  test("skips a switch inside a link that would navigate", () => {
    const box = mount(
      `<a id=l href="/x"><div id=s role=switch aria-checked=true onclick="this.setAttribute('aria-checked','false')"></div></a>`,
    );
    const s = box.querySelector("#s") as Element;
    // Safety net for a failing run only: stops the page itself navigating away.
    box.querySelector("#l")?.addEventListener("click", (e) => e.preventDefault());
    let clicks = 0;
    s.addEventListener("click", () => clicks++);
    expect(setToggles([{ el: s, to: false }])).toEqual({ ok: true });
    expect(clicks).toBe(0);
    expect(readToggle(s)).toBe(true);
  });

  test("a click that changes the hash stops the loop and reports why", () => {
    const box = mount(`<a href="#cc"><div id=s role=switch aria-checked=true></div></a>
      <input id=c type=checkbox checked>`);
    const s = box.querySelector("#s") as Element;
    const c = box.querySelector("#c") as HTMLInputElement;
    // Defeats the hash guard (see click.test.ts), so the link's jump goes through.
    s.addEventListener("click", (e) => e.stopImmediatePropagation());
    let clicks = 0;
    c.addEventListener("click", () => clicks++);
    const r = setToggles([
      { el: s, to: false },
      { el: c, to: false },
    ]);
    expect(r).toEqual({ ok: false, reason: "hash_changed" });
    expect(clicks).toBe(0);
    expect(c.checked).toBe(true);
  });

  test("does not scroll", () => {
    const box = mount(
      `<div style="height:3000px"></div><input id=t type=checkbox checked><div style="height:3000px"></div>`,
    );
    const t = box.querySelector("#t") as HTMLInputElement;
    setToggles([{ el: t, to: false }]);
    expect(window.scrollY).toBe(0);
    expect(t.checked).toBe(false);
  });

  test("recheck fails when the site re-enables a toggle in its change handler", () => {
    const box = mount(`<input id=t type=checkbox checked onchange="this.checked=true">`);
    const t = box.querySelector("#t") as HTMLInputElement;
    const targets = [{ el: t, to: false }];
    setToggles(targets);
    expect(t.checked).toBe(true);
    expect(recheck(targets)).toBe(false);
  });

  test("recheck fails for an unreadable or detached target", () => {
    const box = mount(`<button id=b>x</button><input id=t type=checkbox>`);
    const t = box.querySelector("#t") as HTMLInputElement;
    expect(recheck([{ el: box.querySelector("#b") as Element, to: false }])).toBe(false);
    t.remove();
    expect(recheck([{ el: t, to: false }])).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { readToggle, recheck, setToggles } from "../../src/core/page/toggles.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

afterEach(() => {
  unmountAll();
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
    setToggles([{ el: t, to: false }]);
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

  test("never clicks a disabled toggle, and recheck then fails", () => {
    const box = mount(
      `<input id=a type=checkbox checked disabled><div id=b role=switch aria-checked=true aria-disabled=true></div>`,
    );
    const a = box.querySelector("#a") as HTMLInputElement;
    const b = box.querySelector("#b") as Element;
    let clicks = 0;
    for (const el of [a, b]) el.addEventListener("click", () => clicks++);
    const targets = [
      { el: a, to: false },
      { el: b, to: false },
    ];
    setToggles(targets);
    expect(clicks).toBe(0);
    expect(recheck(targets)).toBe(false);
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

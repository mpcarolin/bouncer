import { afterEach, describe, expect, test } from "vitest";
import { clickability, submitterOf } from "../../src/core/page/clickable.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

afterEach(unmountAll);

/** Mounts `html` and returns its last element, the innermost control for the nested cases. */
function mountTarget(html: string): Element {
  const box = mount(html);
  const all = box.querySelectorAll("*");
  const el = all[all.length - 1];
  if (!el) throw new Error("empty");
  return el;
}

describe("clickability", () => {
  test.each([
    ['<button type="button">x</button>', null],
    // A submit control is clickable: `safeClick` guards its click (§0's submit guard).
    ["<form><button>x</button></form>", null],
    ["<button>x</button>", null],
    ["<form id=f></form><button form=f>x</button>", null],
    ["<a>x</a>", null],
    ['<a href="javascript:void 0">x</a>', null],
    ['<a href="#cc">x</a>', null],
    ['<a href="/privacy">x</a>', "navigates"],
    ['<a href="#x" target=_blank>x</a>', "navigates"],
    ['<a href="/privacy"><div role=button>x</div></a>', "navigates"],
    ["<form><input type=submit></form>", null],
    ["<form><input type=image></form>", null],
    ["<form><button type=reset>x</button></form>", "reset"],
    ["<div role=button>x</div>", null],
    ['<form><button type="button">x</button></form>', null],
    ["<form><button><span>x</span></button></form>", null],
    // A submit control doesn't hide what lies beyond it.
    ['<a href="/p"><form><button>x</button></form></a>', "navigates"],
    ["<form><button type=reset><span>x</span></button></form>", "reset"],
    ['<a href="#x"><div role=button>x</div></a>', null],
    ['<a href=" JavaScript:void 0">x</a>', null],
    ['<a href="java\tscript:void 0">x</a>', null],
    ['<a href="\u00a0javascript:void 0">x</a>', "navigates"],
    ['<a href="#x" target=_top>x</a>', "navigates"],
    ['<a href="/p" target=_self>x</a>', "navigates"],
    ['<base target=_blank><a href="#x">x</a>', "navigates"],
    ['<map><area href="/p"></map>', "navigates"],
    ["<map><area></map>", null],
    ['<svg><a href="/p"><text>x</text></a></svg>', "navigates"],
    ['<svg><a href="#x"><text>x</text></a></svg>', null],
  ] as const)("%s -> %s", (html, want) => {
    expect(clickability(mountTarget(html))).toBe(want);
  });

  test("a <base href> elsewhere makes #x cross-document", () => {
    const base = document.createElement("base");
    base.href = "https://example.com/";
    document.head.append(base);
    try {
      expect(clickability(mountTarget('<a href="#x">x</a>'))).toBe("navigates");
    } finally {
      base.remove();
    }
  });

  test("submitterOf names the submit control a click presses, if it has a form", () => {
    const box = mount(`<form><button id=s><span id=in>x</span></button><input id=i type=image>
      <button id=b type=button>x</button></form><button id=lone>x</button>`);
    const el = (id: string) => box.querySelector(`#${id}`) as Element;
    expect(submitterOf(el("in"))).toBe(el("s"));
    expect(submitterOf(el("i"))).toBe(el("i"));
    expect(submitterOf(el("b"))).toBeNull();
    expect(submitterOf(el("lone"))).toBeNull();
  });

  test("ancestor rule crosses a shadow boundary", () => {
    const box = mount('<a href="/x"><span id=h></span></a>');
    const root = (box.querySelector("#h") as HTMLElement).attachShadow({ mode: "open" });
    root.innerHTML = "<div role=button>x</div>";
    expect(clickability(root.querySelector("div") as Element)).toBe("navigates");
  });
});

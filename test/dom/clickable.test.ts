import { afterEach, describe, expect, test } from "vitest";
import { clickability } from "../../src/core/page/clickable.ts";
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
    ["<form><button>x</button></form>", "submit"],
    ["<button>x</button>", null],
    ["<form id=f></form><button form=f>x</button>", "submit"],
    ["<a>x</a>", null],
    ['<a href="javascript:void 0">x</a>', null],
    ['<a href="#cc">x</a>', null],
    ['<a href="/privacy">x</a>', "navigates"],
    ['<a href="#x" target=_blank>x</a>', "navigates"],
    ['<a href="/privacy"><div role=button>x</div></a>', "navigates"],
    ["<form><input type=submit></form>", "submit"],
    ["<form><input type=image></form>", "submit"],
    ["<form><button type=reset>x</button></form>", "reset"],
    ["<div role=button>x</div>", null],
    ['<form><button type="button">x</button></form>', null],
    ["<form><button><span>x</span></button></form>", "submit"],
    ['<a href="#x"><div role=button>x</div></a>', null],
  ] as const)("%s -> %s", (html, want) => {
    expect(clickability(mountTarget(html))).toBe(want);
  });

  test("ancestor rule crosses a shadow boundary", () => {
    const box = mount('<a href="/x"><span id=h></span></a>');
    const root = (box.querySelector("#h") as HTMLElement).attachShadow({ mode: "open" });
    root.innerHTML = "<div role=button>x</div>";
    expect(clickability(root.querySelector("div") as Element)).toBe("navigates");
  });
});

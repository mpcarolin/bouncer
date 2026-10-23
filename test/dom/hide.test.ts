import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hider } from "../../src/core/page/hide.ts";
import { isGoneBySite } from "../../src/core/page/verify.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

let hider: Hider;
beforeEach(() => {
  hider = new Hider();
});
afterEach(() => {
  hider.unhideAll();
  unmountAll();
});

const banner = (html = '<div id=b style="width:200px;height:50px">cookies</div>') =>
  mount(html).querySelector("#b") as HTMLElement;

describe("Hider", () => {
  test("hiding leaves display, visibility, opacity and size readable; the site is not credited", () => {
    const b = banner();
    hider.hide(b, document);
    const cs = getComputedStyle(b);
    expect(b.hasAttribute("data-bouncer-hidden")).toBe(true);
    expect(cs.clipPath).toBe("inset(100%)");
    expect(cs.pointerEvents).toBe("none");
    expect(cs.display).toBe("block");
    expect(cs.visibility).toBe("visible");
    expect(cs.opacity).toBe("1");
    expect(b.getBoundingClientRect().width).toBe(200);
    expect(b.getBoundingClientRect().height).toBe(50);
    expect(isGoneBySite(b)).toBe(false);
    expect(hider.hiddenCount()).toBe(1);
  });

  test("one style element per root, however many elements are hidden", () => {
    const box = mount("<div id=a>a</div><div id=b>b</div>");
    hider.hide(box.querySelector("#a") as Element, document);
    hider.hide(box.querySelector("#b") as Element, document);
    expect(document.querySelectorAll("style[data-bouncer]").length).toBe(1);
    expect(hider.hiddenCount()).toBe(2);
  });

  test("unhideAll removes the attributes and the style elements", () => {
    const b = banner();
    hider.hide(b, document);
    hider.unhideAll();
    expect(b.hasAttribute("data-bouncer-hidden")).toBe(false);
    expect(document.querySelector("style[data-bouncer]")).toBeNull();
    expect(hider.hiddenCount()).toBe(0);
    expect(getComputedStyle(b).clipPath).toBe("none");
  });

  test("a banner in a shadow root gets the style injected into that root", () => {
    const host = mount("<div id=h></div>").querySelector("#h") as HTMLElement;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = '<div id=b style="width:100px;height:40px">cookies</div>';
    const b = sr.querySelector("#b") as HTMLElement;
    hider.hide(b, sr);
    expect(sr.querySelector("style[data-bouncer]")).not.toBeNull();
    expect(getComputedStyle(b).clipPath).toBe("inset(100%)");
    hider.unhideAll();
    expect(sr.querySelector("style[data-bouncer]")).toBeNull();
    expect(b.hasAttribute("data-bouncer-hidden")).toBe(false);
  });

  test("a host whose shadow root holds only the banner is hidden too", () => {
    const host = mount("<div id=h></div>").querySelector("#h") as HTMLElement;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<style>:host{display:block}</style><div><div id=b>cookies</div></div> ";
    hider.hide(sr.querySelector("#b") as Element, sr);
    expect(host.hasAttribute("data-bouncer-hidden")).toBe(true);
    expect(document.querySelector("style[data-bouncer]")).not.toBeNull();
    hider.unhideAll();
    expect(host.hasAttribute("data-bouncer-hidden")).toBe(false);
    expect(document.querySelector("style[data-bouncer]")).toBeNull();
  });

  test("a host holding other shadow content is not hidden", () => {
    const host = mount("<div id=h></div>").querySelector("#h") as HTMLElement;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<main>the app</main><div id=b>cookies</div>";
    hider.hide(sr.querySelector("#b") as Element, sr);
    expect(host.hasAttribute("data-bouncer-hidden")).toBe(false);
    expect(document.querySelector("style[data-bouncer]")).toBeNull();
    expect(hider.hiddenCount()).toBe(1);
  });

  test("a host with light-DOM content is not hidden", () => {
    const host = mount("<div id=h><p>slotted page</p></div>").querySelector("#h") as HTMLElement;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<slot></slot><div id=b>cookies</div>";
    hider.hide(sr.querySelector("#b") as Element, sr);
    expect(host.hasAttribute("data-bouncer-hidden")).toBe(false);
  });

  test("an outer host is not hidden when an inner host also holds other content", () => {
    const outer = mount("<div id=o></div>").querySelector("#o") as HTMLElement;
    const osr = outer.attachShadow({ mode: "open" });
    osr.innerHTML = "<div id=i></div><nav>menu</nav>";
    const inner = osr.querySelector("#i") as HTMLElement;
    const isr = inner.attachShadow({ mode: "open" });
    isr.innerHTML = "<div id=b>cookies</div>";
    hider.hide(isr.querySelector("#b") as Element, isr);
    expect(inner.hasAttribute("data-bouncer-hidden")).toBe(true);
    expect(outer.hasAttribute("data-bouncer-hidden")).toBe(false);
  });
});

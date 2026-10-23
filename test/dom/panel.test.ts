import { afterEach, describe, expect, test } from "vitest";
import { findPanel, snapshotRendered } from "../../src/core/page/panel.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

afterEach(unmountAll);

const fast = { waitMs: 400, pollMs: 20 };
const show = (el: Element | null) => ((el as HTMLElement).style.display = "block");
const bannerHtml = `<div id=banner style="width:300px;height:60px">We use cookies <button>Settings</button></div>`;

function setup(extra = "") {
  const box = mount(bannerHtml + extra);
  const banner = box.querySelector("#banner") as Element;
  const before = snapshotRendered(document);
  return {
    box,
    banner,
    before,
    base: {
      banner,
      before,
      bannerControlCount: 1,
      rejected: new Set<Element>(),
      doc: document,
      ...fast,
    },
  };
}

describe("findPanel", () => {
  test("a pre-rendered hidden panel that becomes visible is found; inner containers do not count", async () => {
    const { box, base } = setup(`
      <div id=onetrust-pc-sdk style="display:none;width:300px;height:200px">
        <div class=inner style="height:50px">Your cookie choices <input type=checkbox></div>
        <div class=inner2 style="height:50px">Cookie list</div>
      </div>`);
    const pc = box.querySelector("#onetrust-pc-sdk");
    setTimeout(() => show(pc), 50);
    const r = await findPanel(base);
    expect(r).toEqual({ panel: pc });
  });

  test("the banner itself gaining toggles makes it the panel", async () => {
    const { banner, base } = setup();
    setTimeout(() => banner.insertAdjacentHTML("beforeend", "<input type=checkbox> Analytics"), 50);
    expect(await findPanel(base)).toEqual({ panel: banner });
  });

  test("a newsletter modal mentioning only a privacy policy yields none", async () => {
    const { box, base } = setup(
      `<div id=news style="display:none;width:300px;height:100px">Join us! See our Privacy Policy. <button>No thanks</button></div>`,
    );
    setTimeout(() => show(box.querySelector("#news")), 50);
    expect(await findPanel(base)).toEqual({ failed: "none" });
  });

  test("two new qualifying panels are ambiguous", async () => {
    const { box, base } = setup(`
      <div id=p1 style="display:none;width:200px;height:50px">cookie options</div>
      <div id=p2 style="display:none;width:200px;height:50px">Consent <input type=checkbox></div>`);
    setTimeout(() => {
      show(box.querySelector("#p1"));
      show(box.querySelector("#p2"));
    }, 50);
    expect(await findPanel(base)).toEqual({ failed: "ambiguous" });
  });

  test("a rejected candidate is excluded, including anything inside it", async () => {
    const { box, base } = setup(
      `<div id=r style="display:none;width:200px;height:50px"><p id=in style="height:20px">cookie settings</p></div>`,
    );
    base.rejected.add(box.querySelector("#r") as Element);
    setTimeout(() => show(box.querySelector("#r")), 50);
    expect(await findPanel(base)).toEqual({ failed: "none" });
  });

  test("a panel appended to the DOM after the click is found", async () => {
    const { box, base } = setup();
    setTimeout(
      () =>
        box.insertAdjacentHTML(
          "beforeend",
          `<div id=late style="width:200px;height:50px">Manage cookies</div>`,
        ),
      50,
    );
    expect(await findPanel(base)).toEqual({ panel: box.querySelector("#late") });
  });

  test("nothing within the wait is none, and only at the deadline", async () => {
    const { base } = setup();
    const t0 = performance.now();
    expect(await findPanel(base)).toEqual({ failed: "none" });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(380);
  });

  test("elements visible before the click are not new", async () => {
    const { base } = setup(`<div style="width:200px;height:50px">Cookie policy</div>`);
    expect(await findPanel(base)).toEqual({ failed: "none" });
  });
});

describe("snapshotRendered", () => {
  test("holds visible elements only, shadow content included", () => {
    const box = mount(`
      <div id=v style="width:50px;height:50px">v</div>
      <div id=h style="display:none;width:50px;height:50px"><b id=hc>x</b></div>
      <div id=host></div>`);
    const root = (box.querySelector("#host") as HTMLElement).attachShadow({ mode: "open" });
    root.innerHTML = `<p id=s style="width:50px;height:50px">s</p>`;
    const snap = snapshotRendered(document);
    expect(snap.has(box.querySelector("#v") as Element)).toBe(true);
    expect(snap.has(box.querySelector("#h") as Element)).toBe(false);
    expect(snap.has(box.querySelector("#hc") as Element)).toBe(false);
    expect(snap.has(root.querySelector("#s") as Element)).toBe(true);
  });
});

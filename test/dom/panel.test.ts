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

  test.each([
    ["German", "Newsletter abonnieren! Siehe Datenschutzerklärung.", "Nein danke"],
    ["French", "Abonnez-vous ! Voir la politique de confidentialité.", "Non merci"],
    ["Spanish", "¡Suscríbete! Consulta la política de privacidad.", "No, gracias"],
  ])("a %s newsletter modal mentioning only a privacy policy yields none", async (_l, text, no) => {
    const { box, base } = setup(
      `<div id=news style="display:none;width:300px;height:100px">${text} <button>${no}</button></div>`,
    );
    setTimeout(() => show(box.querySelector("#news")), 50);
    expect(await findPanel(base)).toEqual({ failed: "none" });
  });

  test.each([
    ["opacity:0", "opacity:0;position:absolute;width:20px;height:20px"],
    ["clipped", "position:absolute;clip:rect(0 0 0 0);width:1px;height:1px;overflow:hidden"],
  ])(
    "the banner gaining a custom switch whose native input is hidden (%s) is the panel",
    async (_l, hide) => {
      const { banner, base } = setup();
      setTimeout(
        () =>
          banner.insertAdjacentHTML(
            "beforeend",
            `<label><input type=checkbox style="${hide}"><span style="display:inline-block;width:30px;height:16px"></span> Analytics</label>`,
          ),
        50,
      );
      expect(await findPanel(base)).toEqual({ panel: banner });
    },
  );

  test("a custom switch the banner already had is not a gain", async () => {
    const { base } = setup();
    const label = `<label><input type=checkbox style="opacity:0;position:absolute"><span style="display:inline-block;width:30px;height:16px"></span> Ads</label>`;
    base.banner.insertAdjacentHTML("beforeend", label);
    base.before = snapshotRendered(document);
    expect(await findPanel(base)).toEqual({ failed: "none" });
  });

  test("a control the banner had hidden and now shows counts as new", async () => {
    const { banner, base } = setup();
    banner.insertAdjacentHTML("beforeend", `<button id=save style="display:none">Save</button>`);
    base.before = snapshotRendered(document);
    setTimeout(() => show(banner.querySelector("#save")), 50);
    expect(await findPanel(base)).toEqual({ panel: banner });
  });

  test("a descendant of a rejected element that becomes visible is excluded", async () => {
    const { box, base } = setup(
      `<div id=r style="width:200px;height:80px"><p id=in style="display:none;height:20px">cookie settings</p></div>`,
    );
    base.rejected.add(box.querySelector("#r") as Element);
    setTimeout(() => show(box.querySelector("#in")), 50);
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

  test("an error while looking resolves none and stops looking", async () => {
    const { box, base } = setup(
      `<div id=p style="display:none;width:200px;height:50px">cookie options</div>`,
    );
    let calls = 0;
    const rejected = {
      has: () => {
        calls++;
        throw new Error("boom");
      },
    } as unknown as Set<Element>;
    setTimeout(() => show(box.querySelector("#p")), 30);
    expect(await findPanel({ ...base, rejected })).toEqual({ failed: "none" });
    const settled = calls;
    expect(settled).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(settled);
  });

  test("a burst of mutations does not cost a check each", async () => {
    const { box, banner, base } = setup();
    // The walk asks `before` about the banner exactly once per check.
    const times: number[] = [];
    const has = base.before.has.bind(base.before);
    base.before.has = (el) => {
      if (el === banner) times.push(performance.now());
      return has(el);
    };
    let mutations = 0;
    const storm = setInterval(() => box.setAttribute("data-n", String(mutations++)), 2);
    const r = await findPanel({ ...base, waitMs: 400, pollMs: 50 });
    clearInterval(storm);
    expect(r).toEqual({ failed: "none" });
    expect(mutations).toBeGreaterThan(60);
    // About one check per poll interval (8), twice that at worst; a check per mutation is ~200.
    expect(times.length).toBeLessThanOrEqual(24);
  });
});

/** The elements a walk reaches: everything not under a display:none element. */
function walked(): Element[] {
  return [...document.querySelectorAll("*")].filter((el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (getComputedStyle(n).display === "none") return false;
    }
    return true;
  });
}

const footerHtml = `<footer id=foot style="width:200px;height:30px">Cookie statement</footer>`;

describe("findPanel with a truncated snapshot", () => {
  test("an element beyond the cap is unknown, not new: a footer link never becomes the panel", async () => {
    const { box, base } = setup(footerHtml);
    const foot = box.querySelector("#foot") as Element;
    expect(walked().at(-1)).toBe(foot);
    const before = snapshotRendered(document, walked().length - 1);
    expect(before.truncated).toBe(true);
    expect(before.has(foot)).toBe(false);
    expect(await findPanel({ ...base, before })).toEqual({ failed: "none" });
  });

  test("an element the snapshot saw hidden is still new, so a real panel is found", async () => {
    const { box, base } = setup(
      `<div id=pc style="display:none;width:300px;height:100px">Your cookie choices</div>${footerHtml}`,
    );
    const before = snapshotRendered(document, walked().length - 1);
    expect(before.truncated).toBe(true);
    setTimeout(() => show(box.querySelector("#pc")), 50);
    expect(await findPanel({ ...base, before })).toEqual({ panel: box.querySelector("#pc") });
  });

  test("a control under an ancestor the snapshot saw hidden counts toward the banner's gain", async () => {
    const { banner, base } = setup(footerHtml);
    banner.insertAdjacentHTML(
      "beforeend",
      `<div id=more style="display:none"><button id=save>Save</button></div>`,
    );
    const before = snapshotRendered(document, walked().length - 1);
    expect(before.truncated).toBe(true);
    expect(before.has(banner.querySelector("#save") as Element)).toBe(false);
    setTimeout(() => show(banner.querySelector("#more")), 50);
    expect(await findPanel({ ...base, before })).toEqual({ panel: banner });
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
    expect(snap.truncated).toBe(false);
    expect(snap.has(box.querySelector("#v") as Element)).toBe(true);
    expect(snap.has(box.querySelector("#h") as Element)).toBe(false);
    expect(snap.has(box.querySelector("#hc") as Element)).toBe(false);
    expect(snap.has(root.querySelector("#s") as Element)).toBe(true);
    expect(snap.hidden.has(box.querySelector("#h") as Element)).toBe(true);
  });

  test("records that the cap cut it short, and only then", () => {
    mount(`<div style="width:50px;height:50px">a</div><div style="width:50px;height:50px">b</div>`);
    const total = walked().length;
    expect(snapshotRendered(document, total).truncated).toBe(false);
    expect(snapshotRendered(document, total - 1).truncated).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "vitest";
import type { AiResult } from "../../src/core/ai.ts";
import { CLAIM_WAIT_MS } from "../../src/core/config.ts";
import type { LearnedBanner, LearnedRule } from "../../src/core/learned.ts";
import type { LogEntry } from "../../src/core/log.ts";
import { clickability } from "../../src/core/page/clickable.ts";
import { resolveSelector, selectorFor } from "../../src/core/page/selector.ts";
import { serialise } from "../../src/core/page/serialise.ts";
import { recordBanner, replay } from "../../src/core/pipeline/replay.ts";
import type { ContentPlatform } from "../../src/core/platform.ts";
import { siteOf } from "../../src/core/settings.ts";
import type { Clock, Label, SerialisedBanner } from "../../src/core/types.ts";
import { mount, mountPage } from "../helpers/mount.ts";
import {
  Agreeable,
  byId,
  Counting,
  cleanup,
  fastClock,
  HIDDEN,
  type Harness,
  prehideAtClaimWait,
  type StartOpts,
  setAsideAt,
  start,
} from "../helpers/pipeline.ts";

declare global {
  interface Window {
    __consent?: string;
    __newsletter?: string;
  }
}

const site = siteOf(location.href);

afterEach(() => {
  cleanup();
  delete window.__consent;
  delete window.__newsletter;
});

/** A first visit: the pipeline refuses on `page`, and what it learned is returned. */
async function learn(page: string, prepare?: () => void) {
  mountPage(page);
  prepare?.();
  const h = await start();
  const entry = await h.path.done;
  expect(entry.outcome).toBe("dismissed");
  const rule = await h.app.rules.get(site);
  if (!rule) throw new Error(`nothing was learned on ${page}`);
  expect(entry.notes).toContain("learned:saved");
  cleanup();
  delete window.__consent;
  return { rule, entry };
}

/** A platform that records the type of every message the pipeline sends, in order. */
function recording(sent: string[]): StartOpts["platform"] {
  return (content) => ({
    onMessage: (fn) => content.onMessage(fn),
    send: ((m) => {
      sent.push(m.type);
      return content.send(m);
    }) as ContentPlatform["send"],
  });
}

const ruleChanges = (sent: string[]) => sent.filter((t) => t === "saveRule" || t === "discardRule");
/** Corroborates everything, and labels "Keep these" (which no rule labels) save. */
class KeepTheseIsSave extends Agreeable {
  override async labelControls(
    b: SerialisedBanner,
    ids: number[],
  ): Promise<AiResult<Record<number, Label>>> {
    const r = await super.labelControls(b, ids);
    if (r.kind !== "answer") return r;
    const value = { ...r.value };
    for (const id of ids) {
      if (b.controls.find((c) => c.id === id)?.text === "Keep these") value[id] = "save";
    }
    return { ...r, value };
  }
}

/** The fingerprint a rule learned on `el` would carry, for rules written by hand. */
function bannerOf(el: Element): LearnedBanner {
  const b = recordBanner(el, serialise({ el }, clickability, { hiddenToggles: true }));
  if (!b) throw new Error("not a banner a rule could be learned on");
  return b;
}

const checked = (id: string) => (byId(id) as HTMLInputElement).checked;
const buttons = (id: string) => [...byId(id).querySelectorAll("button")];

describe("selectorFor", () => {
  test("a stable id that is unique in its root is used as it is", () => {
    const root = mount(`<div><p>Cookies <button id="reject-btn">Reject</button></p></div>`);
    const el = byId("reject-btn");
    expect(selectorFor(el, root)).toBe("#reject-btn");
    expect(resolveSelector(root, "#reject-btn")).toEqual([el]);
  });

  test("a generated or duplicated id gives a path of tags and :nth-of-type, anchored at a stable id above", () => {
    const root = mount(`<div>
      <p><button id="12345">A</button><button id="btn-3f9a8c7d2e">B</button></p>
      <p><button id=":r1:">C</button><button id="dup">D</button><span id="dup"></span></p>
      <section id="prefs"><button id="ember42">E</button></section></div>`);
    const [a, b, c, d, e] = [...root.querySelectorAll("button")] as Element[];
    const wrapper = root.firstElementChild as Element;
    expect(selectorFor(a as Element, root)).toBe(
      ":scope > div:nth-of-type(1) > p:nth-of-type(1) > button:nth-of-type(1)",
    );
    expect(selectorFor(b as Element, root)).toBe(
      ":scope > div:nth-of-type(1) > p:nth-of-type(1) > button:nth-of-type(2)",
    );
    expect(selectorFor(e as Element, root)).toBe("#prefs > button:nth-of-type(1)");
    for (const el of [a, b, c, d, e] as Element[]) {
      const sel = selectorFor(el, root);
      expect(resolveSelector(root, sel)).toEqual([el]);
      // With no shadow root in the way, it is plain CSS relative to the root.
      expect([...root.querySelectorAll(sel)]).toEqual([el]);
    }
    expect(resolveSelector(wrapper, selectorFor(c as Element, wrapper))).toEqual([c]);
  });

  test("keeps data-*, aria-label, name, type and role; leaves out Bouncer's attribute, state attributes, and generated names and values", () => {
    const root = mount(`<div><span data-bouncer-hidden data-testid="row" data-uid="a8f3c9d2e1"
      data-state="open" data-v-7ba5bd90>
      <button type="button" name="deny" role="button" aria-label="Reject all cookies"
        data-action="reject" data-headlessui-state="active" data-focused="true" data-hovered
        data-pressed="false" class="btn" onclick="void 0">Reject</button></span></div>`);
    const el = root.querySelector("button") as Element;
    const sel = selectorFor(el, root);
    expect(sel).toBe(
      ':scope > div:nth-of-type(1) > span[data-testid="row"]:nth-of-type(1) > ' +
        'button[aria-label="Reject\\ all\\ cookies"][data-action="reject"][name="deny"][role="button"][type="button"]:nth-of-type(1)',
    );
    expect(resolveSelector(root, sel)).toEqual([el]);
    el.setAttribute("data-action", "accept");
    expect(resolveSelector(root, sel)).toEqual([]);
  });

  test("crosses open shadow roots inside the banner, and works for a banner that is itself in one", () => {
    const root = mount(`<div><p>We use cookies</p><x-choices></x-choices></div>`);
    const host = root.querySelector("x-choices") as Element;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<div><button>Accept</button><button>Reject</button></div><button id="more">More</button>`;
    const reject = sr.querySelectorAll("button")[1] as Element;
    const more = sr.getElementById("more") as Element;
    const sel = selectorFor(reject, root);
    expect(sel).toBe(
      ":scope > div:nth-of-type(1) > x-choices:nth-of-type(1) >>> div:nth-of-type(1) > button:nth-of-type(2)",
    );
    expect(resolveSelector(root, sel)).toEqual([reject]);
    expect(selectorFor(more, root)).toBe(
      ":scope > div:nth-of-type(1) > x-choices:nth-of-type(1) >>> #more",
    );
    expect(resolveSelector(root, selectorFor(more, root))).toEqual([more]);

    // The banner is the shadow host: its controls are in its own shadow root.
    expect(selectorFor(more, host)).toBe(":scope >>> #more");
    expect(resolveSelector(host, ":scope >>> #more")).toEqual([more]);

    // The banner sits inside a shadow root.
    const outer = mount("<div></div>").firstElementChild as Element;
    const osr = outer.attachShadow({ mode: "open" });
    osr.innerHTML = `<section><p>cookies</p><button id="r">Reject</button><button>Accept</button></section>`;
    const banner = osr.querySelector("section") as Element;
    const [r, accept] = [...banner.querySelectorAll("button")] as Element[];
    expect(selectorFor(r as Element, banner)).toBe("#r");
    expect(resolveSelector(banner, "#r")).toEqual([r]);
    expect(resolveSelector(banner, selectorFor(accept as Element, banner))).toEqual([accept]);
  });

  test("finds nothing outside the root, and nothing for a selector outside its own grammar", () => {
    mount(`<div id="outside-el"><button id="x">Out</button></div>`);
    const root = mount(`<div><button id="in">In</button></div>`);
    expect(resolveSelector(root, "#outside-el")).toEqual([]);
    expect(resolveSelector(root, "#x, body button")).toEqual([]);
    expect(resolveSelector(root, "#in, body button")).toEqual([]);
    expect(resolveSelector(root, ":scope > div:nth-of-type(1) > button, body button")).toEqual([]);
    expect(resolveSelector(root, ":scope button")).toEqual([]);
    expect(resolveSelector(root, ":scope > div:nth-of-type(1) > button:hover")).toEqual([]);
    expect(resolveSelector(root, "div:nth-of-type(1) > button:nth-of-type(1)")).toEqual([]);
    // What selectorFor writes for the same control still works.
    expect(resolveSelector(root, "#in")).toEqual([byId("in")]);
  });

  test("a toggle's path leaves out data-* and aria-label: its state shows there", () => {
    const root = mount(`<div><button role="switch" aria-checked="true" data-state="checked"
      aria-label="Analytics: on">Analytics</button></div>`);
    const sw = root.querySelector("button") as Element;
    const sel = selectorFor(sw, root, { toggle: true });
    expect(sel).toBe(':scope > div:nth-of-type(1) > button[role="switch"]:nth-of-type(1)');
    sw.setAttribute("data-state", "unchecked");
    sw.setAttribute("aria-label", "Analytics: off");
    expect(resolveSelector(root, sel)).toEqual([sw]);
  });

  test("a malformed or dangling selector finds nothing", () => {
    const root = mount(`<div><button>Reject</button></div>`);
    expect(resolveSelector(root, ":scope > button[")).toEqual([]);
    expect(resolveSelector(root, ":scope > div:nth-of-type(1) >>> button")).toEqual([]);
    expect(resolveSelector(root, "#nope")).toEqual([]);
  });
});

describe("learned rules (§2h)", () => {
  test("replay on the same page → dismissed with zero model calls, through the claim and the hiding", async () => {
    const { rule } = await learn("custom-reject");
    expect(rule).toMatchObject({
      site,
      banner: {
        controls: ["accept|accept all", "reject|reject all"],
        locator: "#my-cookie-notice",
      },
      stage1: { action: "reject", target: { text: "Reject all", label: "reject" } },
    });
    expect(rule.stage2).toBeUndefined();

    mountPage("custom-reject");
    const banner = byId("my-cookie-notice");
    let hiddenAtClick: boolean | undefined;
    banner.addEventListener("click", () => (hiddenAtClick = banner.hasAttribute(HIDDEN)), true);
    const h = await start({ rules: [rule] });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "learned",
      gate: "skipped",
      verification: "verified",
      clicked: [{ text: "Reject all", aiOnly: false }],
      modelCalls: [],
    });
    expect(h.provider.calls).toEqual([]);
    expect(window.__clicked).toBe("reject");
    expect(hiddenAtClick).toBe(true);
    expect(await h.app.arbiter.owner(1)).toBe("bouncer");
    expect(banner.hasAttribute(HIDDEN)).toBe(false);
    // A successful replay is not saved again.
    expect(e.notes).not.toContain("learned:saved");
    expect(await h.app.rules.get(site)).toEqual(rule);
  });

  test("replay of a settings flow: settings → toggles → save, with zero model calls", async () => {
    const { rule } = await learn("custom-settings");
    mountPage("custom-settings");
    const bar = byId("cookie-bar");
    const prefs = byId("cookie-prefs");
    const h = await start({ rules: [rule] });

    const e = await h.path.done;
    expect(byId("status").textContent).toBe("consent: ana=false,mkt=false,dns=true");
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "learned",
      verification: "verified",
      clicked: [{ text: "Cookie settings" }, { text: "Save choices" }],
      toggles: [
        { text: "Analytics cookies", to: false },
        { text: "Marketing cookies", to: false },
        { text: "Do not sell or share my personal information", to: true },
      ],
      modelCalls: [],
    });
    expect(h.provider.calls).toEqual([]);
    expect(h.hidden).toEqual([bar, prefs]); // the panel is hidden as on the pipeline's hop
    expect(checked("c-nec")).toBe(true);
  });

  test("a recorded settings flow stores the toggles' target states, never clicks", async () => {
    // Marketing is already off: the first visit never clicks it, yet the rule still holds it.
    const { rule, entry } = await learn("custom-settings", () => {
      (byId("c-mkt") as HTMLInputElement).checked = false;
    });
    expect(entry.toggles.map((t) => t.text)).toEqual([
      "Analytics cookies",
      "Do not sell or share my personal information",
    ]);
    expect(rule.stage1).toMatchObject({
      action: "settings",
      target: { text: "Cookie settings", label: "settings" },
    });
    expect(rule.stage1.toggles).toBeUndefined();
    expect(rule.stage2).toMatchObject({
      action: "save",
      target: { text: "Save choices", label: "save" },
    });
    const toggles = rule.stage2?.toggles ?? [];
    expect(toggles.map(({ ref, to }) => [ref.text, ref.label, to])).toEqual([
      ["Analytics cookies", "toggle-optional", false],
      ["Marketing cookies", "toggle-optional", false],
      ["Do not sell or share my personal information", "toggle-optout", true],
    ]);
    // A target state per toggle (necessary ones are never in it), not a list of clicks.
    for (const t of toggles) expect(Object.keys(t).sort()).toEqual(["ref", "to"]);

    // The selectors are relative to the banner and the panel, and find the same controls again.
    mountPage("custom-settings");
    expect(resolveSelector(byId("cookie-bar"), rule.stage1.target.selector)).toEqual([
      buttons("cookie-bar")[0],
    ]);
    expect(toggles.map((t) => resolveSelector(byId("cookie-prefs"), t.ref.selector))).toEqual([
      [byId("c-ana")],
      [byId("c-mkt")],
      [byId("c-dns")],
    ]);
  });

  test("stage-1 text changed → discard_and_run_pipeline, nothing touched", async () => {
    const { rule } = await learn("custom-reject");
    mountPage("custom-reject");
    const banner = byId("my-cookie-notice");
    (buttons("my-cookie-notice")[1] as Element).textContent = "Decline all";

    // The check alone: it never acts. A changed text changes the banner's fingerprint; with the
    // same controls in other places, stage 1's own text check catches it.
    let acted = false;
    const tryIt = () =>
      replay(rule, {
        banner,
        full: serialise({ el: banner }, clickability, { hiddenToggles: true }),
        wait: async () => undefined,
        act: async () => {
          acted = true;
          return { outcome: "dismissed" };
        },
      });
    expect(await tryIt()).toEqual({
      outcome: "discard_and_run_pipeline",
      reason: "banner_changed",
    });
    const [first, second] = buttons("my-cookie-notice") as Element[] as [Element, Element];
    first.textContent = "Reject all";
    second.textContent = "Accept all";
    expect(await tryIt()).toEqual({ outcome: "discard_and_run_pipeline", reason: "text_changed" });
    expect(acted).toBe(false);
    first.textContent = "Accept all";
    second.textContent = "Decline all";

    // In the pipeline: the rule goes, and the full pipeline runs on the same banner untouched.
    const provider = new Counting();
    let h: Harness | undefined;
    let touchedAtGate: number | undefined;
    provider.onCall = (op) => {
      if (op === "isConsentDialog" && h) touchedAtGate = h.clicks.length + h.hidden.length;
    };
    const sent: string[] = [];
    h = await start({ rules: [rule], provider, platform: recording(sent) });

    const e = await h.path.done;
    expect(touchedAtGate).toBe(0);
    expect(e.notes).toContain("learned:mismatch:banner_changed");
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "ai",
      gate: "consent",
      clicked: [{ text: "Decline all", aiOnly: false }],
    });
    expect(window.__clicked).toBe("reject");
    // Its controls changed, so this is not the rule's banner: the rule is kept, and the
    // pipeline's own refusal is learned over it.
    expect(ruleChanges(sent)).toEqual(["saveRule"]);
    expect((await h.app.rules.get(site))?.stage1.target.text).toBe("Decline all");
  });

  test("stage-2 target missing after the settings click → failed, and the rule is discarded", async () => {
    const { rule } = await learn("custom-settings");
    mountPage("custom-settings");
    const prefs = byId("cookie-prefs");
    prefs.querySelector("button")?.remove();
    const sent: string[] = [];
    const h = await start({ rules: [rule], platform: recording(sent) });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "stage2_target_missing",
      path: "learned",
      clicked: [{ text: "Cookie settings" }],
      toggles: [],
    });
    // The page has been clicked: the pipeline does not run again.
    expect(h.provider.calls).toEqual([]);
    expect(await h.entries()).toHaveLength(1);
    expect(ruleChanges(sent)).toEqual(["discardRule"]);
    expect(await h.app.rules.get(site)).toBeUndefined();
    expect(checked("c-ana")).toBe(true); // no toggle touched
    // Put back: the site's own panel is left open for the user.
    expect(prefs.hasAttribute(HIDDEN)).toBe(false);
    expect(getComputedStyle(prefs).display).toBe("block");
  });

  test("stage-2 targets that render after the panel appears are waited for, within the panel window", async () => {
    const { rule } = await learn("custom-settings");
    mountPage("custom-settings");
    const prefs = byId("cookie-prefs");
    const save = prefs.querySelector("button") as HTMLButtonElement;
    save.remove();
    (buttons("cookie-bar")[0] as Element).addEventListener("click", () => {
      setTimeout(() => prefs.append(save), 150);
    });
    const h = await start({ rules: [rule] });

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "dismissed", path: "learned", modelCalls: [] });
    expect(byId("status").textContent).toBe("consent: ana=false,mkt=false,dns=true");
  });

  test("a toggle already in its target state isn't clicked", async () => {
    const { rule } = await learn("custom-settings");
    mountPage("custom-settings");
    const ana = byId("c-ana") as HTMLInputElement;
    ana.checked = false;
    const h = await start({ rules: [rule] });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "learned",
      toggles: [
        { text: "Marketing cookies", to: false },
        { text: "Do not sell or share my personal information", to: true },
      ],
    });
    expect(h.clicks).not.toContain(ana);
    expect(h.clicks).toContain(byId("c-mkt"));
    expect(byId("status").textContent).toBe("consent: ana=false,mkt=false,dns=true");
  });

  test("a stage-1 save in the banner replays, the collapsed toggle included", async () => {
    const { rule } = await learn("settings-in-banner");
    expect(rule.stage1).toMatchObject({ action: "save", target: { text: "Save choices" } });
    expect(rule.stage1.toggles?.map((t) => [t.ref.text, t.to])).toEqual([
      ["Analytics", false],
      ["Advertising", false],
    ]);
    mountPage("settings-in-banner");
    const h = await start({ rules: [rule] });

    const e = await h.path.done;
    expect(window.__consent).toBe("ana=false,ads=false");
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "learned",
      clicked: [{ text: "Save choices" }],
      modelCalls: [],
    });
  });

  test("a toggle the rule doesn't know fails the stage-1 check: nothing switched, the pipeline decides", async () => {
    const { rule } = await learn("settings-in-banner");
    mountPage("settings-in-banner");
    byId("cookie-banner")
      .querySelector("details")
      ?.insertAdjacentHTML(
        "beforeend",
        '<label><input type="checkbox" id="ib-soc" checked> Social media</label>',
      );
    const social = byId("ib-soc") as HTMLInputElement; // the banner removes itself on save
    const provider = new Counting();
    let h: Harness | undefined;
    let touchedAtGate: number | undefined;
    provider.onCall = (op) => {
      if (op === "isConsentDialog" && h) touchedAtGate = h.clicks.length;
    };
    h = await start({ rules: [rule], provider });

    const e = await h.path.done;
    expect(touchedAtGate).toBe(0);
    expect(e.notes).toContain("learned:mismatch:toggle_unrecorded");
    expect(e).toMatchObject({ outcome: "dismissed", path: "ai" });
    expect(social.checked).toBe(false); // the pipeline covered it
  });

  test("stage 1 is checked again after the claim: a toggle added meanwhile → unsure stale_target, nothing touched", async () => {
    const { rule } = await learn("settings-in-banner");
    mountPage("settings-in-banner");
    const banner = byId("cookie-banner");
    const h = await start({
      rules: [rule],
      // The site adds a choice, already on, just as Bouncer claims the page.
      platform: (content) => ({
        onMessage: (fn) => content.onMessage(fn),
        send: ((m) => {
          if (m.type === "claim") {
            banner.insertAdjacentHTML(
              "afterbegin",
              '<label><input type="checkbox" id="ib-soc" checked> Social media</label>',
            );
          }
          return content.send(m);
        }) as ContentPlatform["send"],
      }),
    });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "unsure",
      reason: "stale_target",
      path: "learned",
      clicked: [],
    });
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect([checked("ib-ana"), checked("ib-ads"), checked("ib-soc")]).toEqual([true, true, true]);
    expect(window.__consent).toBeUndefined();
  });

  test("the banner is checked again after the claim: a control added meanwhile → unsure stale_target", async () => {
    const { rule } = await learn("custom-reject");
    mountPage("custom-reject");
    const banner = byId("my-cookie-notice");
    const h = await start({
      rules: [rule],
      // Just as Bouncer claims the page, the banner becomes another one: it gains a control.
      platform: (content) => ({
        onMessage: (fn) => content.onMessage(fn),
        send: ((m) => {
          if (m.type === "claim")
            banner.insertAdjacentHTML("beforeend", "<button>Customise</button>");
          return content.send(m);
        }) as ContentPlatform["send"],
      }),
    });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "unsure",
      reason: "stale_target",
      path: "learned",
      clicked: [],
    });
    expect(h.clicks).toEqual([]);
    expect(window.__clicked).toBeUndefined();
  });

  test("a replay whose target now reads accept-all fails the §0 guard → discard and run the pipeline", async () => {
    const { rule } = await learn("custom-reject");
    mountPage("custom-reject");
    // Still "Reject all" on screen, but its aria-label is accept-all.
    (buttons("my-cookie-notice")[1] as Element).setAttribute("aria-label", "Accept all cookies");
    const sent: string[] = [];
    const h = await start({ rules: [rule], platform: recording(sent) });

    const e = await h.path.done;
    expect(e.notes).toContain("learned:mismatch:blocked_accept_all");
    // The pipeline ran on the same banner, and §0 vetoes that control there too.
    expect(h.provider.calls[0]).toBe("isConsentDialog");
    expect(e).toMatchObject({
      outcome: "unsure",
      reason: "refusal_vetoed",
      path: "ai",
      clicked: [],
    });
    expect(h.clicks).toEqual([]);
    expect(window.__clicked).toBeUndefined();
    expect(ruleChanges(sent)).toEqual(["discardRule"]);
    expect(await h.app.rules.get(site)).toBeUndefined();
  });

  test('a rule whose reject target is an "Accept all" control never clicks it', async () => {
    mountPage("custom-reject");
    const banner = byId("my-cookie-notice");
    const accept = buttons("my-cookie-notice")[0] as Element;
    const selector = selectorFor(accept, banner);
    const rule: LearnedRule = {
      site,
      createdAt: Date.now(),
      banner: bannerOf(banner),
      stage1: { action: "reject", target: { selector, text: "Accept all", label: "reject" } },
    };
    const h = await start({ rules: [rule] });

    const e = await h.path.done;
    expect(e.notes).toContain("learned:mismatch:blocked_accept_all");
    expect(h.clicks).not.toContain(accept);
    expect(e).toMatchObject({ outcome: "dismissed", path: "ai" });
    expect(window.__clicked).toBe("reject");
  });

  test("a failed replay discards the rule; a failed flow is never learned", async () => {
    mountPage("broken-reject");
    let h = await start();
    expect((await h.path.done).outcome).toBe("failed");
    expect(await h.app.rules.list()).toEqual([]);
    cleanup();

    mountPage("broken-reject");
    const banner = byId("cookie-broken");
    const reject = buttons("cookie-broken")[0] as Element;
    const rule: LearnedRule = {
      site,
      createdAt: Date.now(),
      banner: bannerOf(banner),
      stage1: {
        action: "reject",
        target: { selector: selectorFor(reject, banner), text: "Reject all", label: "reject" },
      },
    };
    const sent: string[] = [];
    h = await start({ rules: [rule], platform: recording(sent) });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "not_gone",
      path: "learned",
      clicked: [{ text: "Reject all" }],
    });
    expect(h.provider.calls).toEqual([]);
    expect(ruleChanges(sent)).toEqual(["discardRule"]);
    expect(await h.app.rules.get(site)).toBeUndefined();
    expect(banner.hasAttribute(HIDDEN)).toBe(false);
  });

  test("a login wall before the banner: its mismatch keeps the rule, which replays on the banner", async () => {
    const { rule } = await learn("custom-reject");
    mountPage("login-wall");
    mountPage("custom-reject");
    const sent: string[] = [];
    const h = await start({ rules: [rule], platform: recording(sent) });

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "dismissed", path: "learned", modelCalls: [] });
    const all = await h.entries();
    expect(all.map((x: LogEntry) => [x.outcome, x.path])).toEqual([
      ["not_consent", "ai"],
      ["dismissed", "learned"],
    ]);
    expect(all[0]?.notes).toContain("learned:mismatch:no_consent_wording");
    expect(window.__clicked).toBe("reject");
    expect(ruleChanges(sent)).toEqual([]);
    expect(await h.app.rules.get(site)).toEqual(rule);
  });

  test("a stage-1 mismatch on a candidate the gate couldn't judge keeps the rule: only the banner's own mismatch discards it", async () => {
    const { rule } = await learn("custom-reject");
    mountPage("custom-reject");
    const banner = byId("my-cookie-notice");
    // The same controls (so the same fingerprint), but the reject is no longer where it was.
    const [first, second] = buttons("my-cookie-notice") as Element[] as [Element, Element];
    first.textContent = "Reject all";
    second.textContent = "Accept all";
    banner.append(" [mock:timeout]");
    const sent: string[] = [];
    const h = await start({ rules: [rule], platform: recording(sent) });

    const e = await h.path.done;
    expect(e.notes).toContain("learned:mismatch:text_changed");
    expect(e).toMatchObject({ outcome: "unsure", reason: "model_timeout", clicked: [] });
    expect(ruleChanges(sent)).toEqual([]);
    expect(await h.app.rules.get(site)).toEqual(rule);
  });

  test("a same-site newsletter modal whose control collides with the rule's target is not replayed; the real banner is", async () => {
    const { rule } = await learn("cookie-no-thanks");
    expect(rule.stage1.target).toMatchObject({ text: "No thanks", label: "reject" });
    // Built from the same component: the "No thanks" sits where the banner's reject does, with
    // the same text and the same regex label.
    const decoy = (text: string, first: string) =>
      mount(`<div class="modal" style="position:fixed;inset:10% 20%;background:#fff;z-index:10000">${text}
        <button onclick="window.__newsletter='${first}'">${first}</button>
        <button onclick="window.__newsletter='no'; this.parentElement.remove()">No thanks</button></div>`)
        .firstElementChild as Element;
    // No cookie or consent wording, though the controls are the banner's own.
    const promo = decoy("Get 10% off your first order. See our privacy policy.", "Accept all");
    // Cookie wording, but other controls.
    const news = decoy("Cookie recipes every week in our newsletter. Privacy policy.", "Subscribe");
    mountPage("cookie-no-thanks");
    const [promoNo, newsNo] = [promo, news].map((m) => m.querySelectorAll("button")[1]);
    expect(resolveSelector(promo, rule.stage1.target.selector)).toEqual([promoNo]);
    expect(resolveSelector(news, rule.stage1.target.selector)).toEqual([newsNo]);
    const sent: string[] = [];
    const h = await start({ rules: [rule], platform: recording(sent) });

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "dismissed", path: "learned", modelCalls: [] });
    expect(window.__clicked).toBe("reject");
    expect(window.__newsletter).toBeUndefined();
    expect(h.clicks).not.toContain(promoNo);
    expect(h.clicks).not.toContain(newsNo);
    const all = await h.entries();
    expect(
      all.map((x: LogEntry) => [x.outcome, x.path, x.notes.find((n) => n.startsWith("learned:"))]),
    ).toEqual([
      ["not_consent", "ai", "learned:mismatch:no_consent_wording"],
      ["not_consent", "ai", "learned:mismatch:banner_changed"],
      ["dismissed", "learned", undefined],
    ]);
    expect(ruleChanges(sent)).toEqual([]);
    expect(await h.app.rules.get(site)).toEqual(rule);
  });

  test("a Radix-style switch recorded on, and off on the next visit, is still found and not clicked", async () => {
    const { rule } = await learn("settings-radix");
    expect(window.__consent).toBeUndefined(); // cleared after the first visit
    const [toggle] = rule.stage1.toggles ?? [];
    expect(toggle).toMatchObject({
      ref: { text: "Analytics", label: "toggle-optional" },
      to: false,
    });
    expect(toggle?.ref.selector).not.toContain("data-state");

    mountPage("settings-radix");
    const sw = byId("rx-banner").querySelector('[role="switch"]') as Element;
    sw.setAttribute("aria-checked", "false");
    sw.setAttribute("data-state", "unchecked");
    const h = await start({ rules: [rule] });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "learned",
      clicked: [{ text: "Save choices" }],
      toggles: [],
    });
    expect(h.clicks).not.toContain(sw);
    expect(window.__consent).toBe("ana=false");
  });

  test("an AI-only stage-1 settings click, or an AI-only stage-2 save, is never learned", async () => {
    for (const [prepare, aiOnlyAt] of [
      [() => ((buttons("cookie-bar")[0] as Element).textContent = "Our partners"), 0],
      [
        () =>
          ((byId("cookie-prefs").querySelector("button") as Element).textContent = "Keep these"),
        1,
      ],
    ] as const) {
      mountPage("custom-settings");
      prepare();
      const sent: string[] = [];
      const h = await start({ provider: new KeepTheseIsSave(), platform: recording(sent) });

      const e = await h.path.done;
      expect(e.outcome).toBe("dismissed");
      expect(e.clicked.map((c) => c.aiOnly)).toEqual([aiOnlyAt === 0, aiOnlyAt === 1]);
      expect(ruleChanges(sent)).toEqual([]);
      expect(e.notes.filter((n) => n.startsWith("learned:"))).toEqual([]);
      expect(await h.app.rules.list()).toEqual([]);
      cleanup();
    }
  });

  test("the notes say what the background did: save_failed, discard_failed, and an unrecordable flow", async () => {
    mountPage("custom-reject");
    let h = await start({
      platform: (content) => ({
        onMessage: (fn) => content.onMessage(fn),
        send: ((m) =>
          m.type === "saveRule"
            ? Promise.resolve({ stored: false })
            : content.send(m)) as ContentPlatform["send"],
      }),
    });
    let e = await h.path.done;
    expect(e.outcome).toBe("dismissed");
    expect(e.notes).toContain("learned:save_failed");
    expect(e.notes).not.toContain("learned:saved");
    cleanup();

    // "Tracking" passes the gate, but with no cookie or consent wording a replay could never
    // recognise the banner, so there is no rule to record.
    mount(`<div class="banner" id="trk" style="position:fixed;bottom:0;left:0;right:0;z-index:9999">
      We use tracking technologies. See our privacy notice.
      <button onclick="window.__clicked='reject'; this.parentElement.remove()">Reject all</button></div>`);
    const sent: string[] = [];
    h = await start({ platform: recording(sent) });
    e = await h.path.done;
    expect(e).toMatchObject({ outcome: "dismissed", path: "ai" });
    expect(e.notes).toContain("learned:unrecordable");
    expect(ruleChanges(sent)).toEqual([]);
    cleanup();

    // A failed replay whose discard the background refuses.
    mountPage("broken-reject");
    const broken = byId("cookie-broken");
    const rule: LearnedRule = {
      site,
      createdAt: Date.now(),
      banner: bannerOf(broken),
      stage1: {
        action: "reject",
        target: {
          selector: selectorFor(buttons("cookie-broken")[0] as Element, broken),
          text: "Reject all",
          label: "reject",
        },
      },
    };
    h = await start({
      rules: [rule],
      platform: (content) => ({
        onMessage: (fn) => content.onMessage(fn),
        send: ((m) =>
          m.type === "discardRule"
            ? Promise.resolve({ stored: false })
            : content.send(m)) as ContentPlatform["send"],
      }),
    });
    e = await h.path.done;
    expect(e).toMatchObject({ outcome: "failed", path: "learned" });
    expect(e.notes).toContain("learned:discard_failed");
    expect(e.notes).not.toContain("learned:discarded");
  });

  test("a banner whose controls change during the claim wait goes to the pipeline, nothing touched", async () => {
    const { rule } = await learn("custom-reject");
    mountPage("custom-reject");
    const banner = byId("my-cookie-notice");
    // The site adds a control just as the claim wait ends: after the replay's first check passed,
    // before anything is claimed or touched.
    const clock: Clock = {
      ...fastClock,
      setTimeout: (fn, ms) =>
        fastClock.setTimeout(
          ms === CLAIM_WAIT_MS
            ? () => {
                banner.insertAdjacentHTML("beforeend", "<button>Customise</button>");
                fn();
              }
            : fn,
          ms,
        ),
    };
    const provider = new Counting();
    let h: Harness | undefined;
    let touchedAtGate: number | undefined;
    provider.onCall = (op) => {
      if (op === "isConsentDialog" && h) touchedAtGate = h.clicks.length + h.hidden.length;
    };
    const sent: string[] = [];
    h = await start({ rules: [rule], clock, provider, platform: recording(sent) });

    const e = await h.path.done;
    expect(touchedAtGate).toBe(0);
    expect(e.notes).toContain("learned:mismatch:banner_changed");
    // The pipeline decided on the banner as it is now, Customise included.
    expect(e).toMatchObject({ outcome: "dismissed", path: "ai", gate: "consent" });
    expect(e.clicked).toEqual([expect.objectContaining({ text: "Reject all", aiOnly: false })]);
    expect(Object.values(e.labels ?? {}).map((l) => l.label)).toContain("settings");
    expect(sent.filter((t) => t === "claim")).toHaveLength(1);
    expect(ruleChanges(sent)).toEqual(["saveRule"]);
    expect((await h.app.rules.get(site))?.banner.controls).toContain("settings|customise");
  });

  test("autoconsent's prehide lands on the banner during the claim wait: the rule is kept and replays once it lifts", async () => {
    const { rule } = await learn("custom-reject");
    mountPage("custom-reject");
    const sent: string[] = [];
    const t0 = Date.now();
    const clock = prehideAtClaimWait("#my-cookie-notice");
    const h = await start({ rules: [rule], clock, platform: recording(sent) });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "learned",
      verification: "verified",
      clicked: [{ text: "Reject all", aiOnly: false }],
      modelCalls: [],
    });
    expect(ruleChanges(sent)).toEqual([]);
    expect(await h.app.rules.get(site)).toEqual(rule);
    expect(await h.entries()).toEqual([e]);
    const first = setAsideAt(e) ?? Number.NaN;
    expect(first).toBeGreaterThanOrEqual(t0);
    expect((e.t.found ?? 0) - first).toBeGreaterThanOrEqual(200);
  });

  test("autoconsent owns the page: the replay stands down at the claim, nothing touched, rule kept", async () => {
    const { rule } = await learn("custom-reject");
    mountPage("custom-reject");
    const h = await start({
      rules: [rule],
      before: ({ app }) => app.arbiter.cmpDetected(1, 0, "doc-1"),
    });

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "deferred", reason: "autoconsent", clicked: [] });
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect(await h.app.rules.get(site)).toEqual(rule);
  });
});

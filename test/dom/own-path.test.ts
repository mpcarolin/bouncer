import { afterEach, describe, expect, test } from "vitest";
import { MockProvider } from "../../src/ai/mock/provider.ts";
import type { AiProvider, AiResult } from "../../src/core/ai.ts";
import type { ContentPlatform } from "../../src/core/platform.ts";
import type { Clock } from "../../src/core/types.ts";
import type { FakeBackground } from "../helpers/fake-platform.ts";
import { mount, mountPage, unmountAll } from "../helpers/mount.ts";
import {
  Agreeable,
  byId,
  Counting,
  cleanup,
  fastClock,
  HIDDEN,
  noClaimCap,
  prehide,
  prehideAtClaimWait,
  setAsideAt,
  sleep,
  start,
  stopAll,
  Unavailable,
  until,
} from "../helpers/pipeline.ts";

afterEach(cleanup);

describe("OwnPath, stage 1", () => {
  test("custom reject: gate yes → reject clicked → dismissed, hidden attr removed after", async () => {
    mountPage("custom-reject");
    const banner = byId("my-cookie-notice");
    let hiddenAtClick: boolean | undefined;
    banner.addEventListener("click", () => (hiddenAtClick = banner.hasAttribute(HIDDEN)), true);
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "ai",
      gate: "consent",
      verification: "verified",
      clicked: [{ text: "Reject all", aiOnly: false }],
    });
    expect(window.__clicked).toBe("reject");
    expect(hiddenAtClick).toBe(true); // hidden before the click
    expect(h.hidden).toEqual([banner]);
    expect(banner.hasAttribute(HIDDEN)).toBe(false); // and unhidden after the verified dismissal
    expect(document.querySelector("style[data-bouncer]")).toBeNull();
    expect(await h.entries()).toEqual([e]);
    expect(await h.app.arbiter.owner(1)).toBe("bouncer");
  });

  test("model unavailable + regex reject button → fast path dismisses with zero model calls", async () => {
    mountPage("custom-reject");
    const h = await start({ provider: new Unavailable() });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "heuristic",
      gate: "skipped",
      clicked: [{ text: "Reject all", aiOnly: false }],
      modelCalls: [],
    });
    expect(h.provider.calls).toEqual([]);
    expect(window.__clicked).toBe("reject");
  });

  test("model unavailable + reject only as link → model_unavailable, nothing touched", async () => {
    mountPage("reject-link");
    const banner = byId("cookie-link");
    const h = await start({ provider: new Unavailable() });

    await until(async () => (await h.entries()).length === 1);
    const [e] = await h.entries();
    expect(e).toMatchObject({
      outcome: "model_unavailable",
      path: "heuristic",
      gate: "skipped",
      clicked: [],
      modelCalls: [],
    });
    expect(h.provider.calls).toEqual([]);
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect(banner.isConnected).toBe(true);
    expect(window.__clicked).toBeUndefined();
  });

  test("model unavailable is per candidate: a login wall first, then a banner the fast path takes", async () => {
    // Neither offers a reject button: the login wall's text even matches autoconsent's "by
    // continuing … privacy" pattern. Both end model_unavailable, which is logged once.
    mountPage("login-wall");
    mountPage("reject-link");
    const login = byId("login");
    const link = byId("cookie-link");
    const h = await start({ provider: new Unavailable() });
    await until(async () => (await h.entries()).length >= 1);
    await sleep(200); // both candidates handled, the page still open

    mountPage("custom-reject");
    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "dismissed", path: "heuristic", modelCalls: [] });
    expect(window.__clicked).toBe("reject");
    expect((await h.entries()).map((x) => x.outcome)).toEqual(["model_unavailable", "dismissed"]);
    expect(h.hidden).toEqual([expect.any(HTMLElement)]);
    expect(h.hidden).not.toContain(login);
    expect(h.hidden).not.toContain(link);
    expect(h.clicks.every((el) => !login.contains(el) && !link.contains(el))).toBe(true);
    expect(h.provider.calls).toEqual([]);
  });

  test("login wall then cookie banner: first not_consent, second dismissed", async () => {
    mountPage("login-wall");
    const login = byId("login");
    const h = await start();
    await until(async () => (await h.entries()).length === 1);
    const [first] = await h.entries();
    expect(first).toMatchObject({ outcome: "not_consent", gate: "other", clicked: [] });

    mountPage("custom-reject");
    const e = await h.path.done;
    expect(e.outcome).toBe("dismissed");
    expect(window.__clicked).toBe("reject");
    expect((await h.entries()).map((x) => x.outcome)).toEqual(["not_consent", "dismissed"]);
    expect(login.isConnected).toBe(true);
    expect(h.hidden).not.toContain(login);
    expect(h.clicks.every((el) => !login.contains(el))).toBe(true);
  });

  test("chat widget and cookie banner together: only banner touched", async () => {
    mountPage("chat-and-banner");
    const chat = byId("chat-widget");
    const banner = byId("cookie-notice");
    const h = await start();

    const e = await h.path.done;
    expect(e.outcome).toBe("dismissed");
    expect(window.__clicked).toBe("reject");
    expect(window.__chatClicked).toBeUndefined();
    expect(chat.isConnected).toBe(true);
    expect(h.hidden).toEqual([banner]);
    expect(h.clicks.every((el) => !chat.contains(el))).toBe(true);
    expect((await h.entries()).map((x) => x.outcome)).toEqual(["not_consent", "dismissed"]);
  });

  test("agree-only → no_option, no click; agreeToDismiss → dismissed_agreed", async () => {
    mountPage("agree-only");
    let h = await start();
    let e = await h.path.done;
    expect(e).toMatchObject({ outcome: "no_option", clicked: [] });
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect(await h.app.arbiter.owner(1)).toBe("none"); // nothing to act on, so no claim
    unmountAll();
    stopAll();

    mountPage("agree-only");
    h = await start({ settings: { agreeToDismiss: true } });
    e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed_agreed",
      clicked: [{ text: "I agree", aiOnly: false }],
    });
    expect(window.__clicked).toBe("agree");
  });

  test("close only → dismissed_close; closeAction leave → no_option", async () => {
    mountPage("close-only");
    let h = await start();
    let e = await h.path.done;
    expect(e).toMatchObject({ outcome: "dismissed_close", clicked: [{ text: "×" }] });
    expect(window.__clicked).toBe("close");
    unmountAll();
    stopAll();
    delete window.__clicked;

    mountPage("close-only");
    h = await start({ settings: { closeAction: "leave" } });
    e = await h.path.done;
    expect(e).toMatchObject({ outcome: "no_option", clicked: [] });
    expect(h.clicks).toEqual([]);
    expect(window.__clicked).toBeUndefined();
  });

  test("broken reject → failed, banner restored; onFailed keep_hidden → stays hidden", async () => {
    mountPage("broken-reject");
    let banner = byId("cookie-broken");
    let h = await start();
    let e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "not_gone",
      verification: "not_gone",
      clicked: [{ text: "Reject all" }],
    });
    expect(window.__clicked).toBe("reject");
    expect(h.hidden).toEqual([banner]);
    expect(banner.hasAttribute(HIDDEN)).toBe(false);
    expect(document.querySelector("style[data-bouncer]")).toBeNull();
    unmountAll();
    stopAll();

    mountPage("broken-reject");
    banner = byId("cookie-broken");
    h = await start({ settings: { onFailed: "keep_hidden" } });
    e = await h.path.done;
    expect(e.outcome).toBe("failed");
    expect(banner.hasAttribute(HIDDEN)).toBe(true);
    expect(document.querySelector("style[data-bouncer]")).not.toBeNull();
  });

  test("form-submit reject → clicked behind the submit guard; the page's handler refuses → dismissed", async () => {
    mountPage("form-reject");
    const h = await start();
    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      verification: "verified",
      clicked: [{ text: "Reject all", aiOnly: false }],
    });
    expect(e.notes).not.toContain("submit_guard:cancelled");
    expect(window.__clicked).toBe("submitted");
  });

  test("form-submit reject the page doesn't handle → the guard cancels it, noted; failed, restored", async () => {
    // A navigation that got past the guard would take the test page away: cancel it, and count it.
    const navigation = (window as unknown as { navigation: EventTarget }).navigation;
    let leaked = 0;
    const onNavigate = (e: Event) => {
      if (!e.defaultPrevented) leaked++;
      e.preventDefault();
    };
    navigation.addEventListener("navigate", onNavigate);
    try {
      mount(`<div id="cookie-native" style="position:fixed;bottom:0;left:0;right:0;z-index:9999">
        We use cookies for analytics. <form action="/accept-all"><button>Reject all</button></form>
        <button type="button">Accept all</button></div>`);
      const h = await start();
      const e = await h.path.done;
      expect(e).toMatchObject({
        outcome: "failed",
        reason: "not_gone",
        clicked: [{ text: "Reject all", aiOnly: false }],
      });
      expect(e.notes).toEqual(expect.arrayContaining(["submit_guard:cancelled", "restored"]));
      await sleep(50);
      expect(leaked).toBe(0);
    } finally {
      navigation.removeEventListener("navigate", onNavigate);
    }
  });

  test("acDetected during wait → deferred, nothing touched", async () => {
    mountPage("custom-reject");
    const provider = new Counting();
    let bg: FakeBackground | undefined;
    // autoconsent's top-frame cmpDetected lands while the gate is being asked. The arbiter is
    // left alone, so only the notice can stop the claim.
    provider.onCall = (op) => {
      if (op === "isConsentDialog") void bg?.sendToFrame(1, 0, { type: "acDetected" });
    };
    const h = await start({ provider, before: (x) => void (bg = x.bg) });

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "deferred", path: "deferred", clicked: [] });
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect(await h.app.arbiter.owner(1)).toBe("none"); // never claimed
  });

  test("acDetected during the gate → deferred before the labels are used: no corroboration", async () => {
    mountPage("continue-to-site"); // "Continue to site" would need corroborating
    const provider = new Counting();
    let bg: FakeBackground | undefined;
    provider.onCall = (op) => {
      if (op === "isConsentDialog") void bg?.sendToFrame(1, 0, { type: "acDetected" });
    };
    const h = await start({ provider, before: (x) => void (bg = x.bg) });

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "deferred", reason: "autoconsent_detected" });
    expect(h.provider.calls).toEqual(["isConsentDialog", "labelControls"]);
    expect(h.clicks).toEqual([]);
  });

  test("claim refused → deferred", async () => {
    mountPage("custom-reject");
    // autoconsent took the page first; its notice to the frame never arrived.
    const h = await start({ before: ({ app }) => app.arbiter.cmpDetected(1, 0, "doc-1") });

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "deferred", reason: "autoconsent", clicked: [] });
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect(window.__clicked).toBeUndefined();
  });

  test("[mock:timeout] gate → unsure model_timeout, no fast path", async () => {
    mountPage("custom-reject");
    byId("my-cookie-notice").append(" [mock:timeout]");
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "unsure", reason: "model_timeout", clicked: [] });
    expect(e.modelCalls).toContainEqual(
      expect.objectContaining({ op: "isConsentDialog", result: "timeout" }),
    );
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
  });

  test("[mock:error] gate → unsure model_error, page untouched, no exception escapes", async () => {
    mountPage("custom-reject");
    const banner = byId("my-cookie-notice");
    banner.append(" [mock:error]");
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "unsure", reason: "model_error", clicked: [] });
    expect(e.notes.join(" ")).toContain("mock_error");
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect(banner.isConnected).toBe(true);
    await sleep(50);
    expect(h.escaped).toEqual([]);
  });

  test("a provider that throws, or answers malformed output → unsure model_error, nothing escapes", async () => {
    const throwing: AiProvider = {
      ...new MockProvider(),
      status: async () => ({ state: "available", onDevice: true }),
      isConsentDialog: async () => {
        throw new Error("provider exploded");
      },
      labelControls: async () => ({
        kind: "answer",
        value: {},
        meta: { ms: 0, cold: false, onDevice: true },
      }),
      corroborate: async () => ({
        kind: "answer",
        value: true,
        meta: { ms: 0, cold: false, onDevice: true },
      }),
    };
    const malformed: AiProvider = {
      ...throwing,
      isConsentDialog: async () => ({ kind: "answer" }) as unknown as AiResult<boolean>,
    };
    for (const [ai, note] of [
      [throwing, "isConsentDialog:provider exploded"],
      [malformed, "isConsentDialog:malformed_result"],
    ] as const) {
      mountPage("custom-reject");
      const banner = byId("my-cookie-notice");
      const h = await start({ ai });
      const e = await h.path.done;
      expect(e).toMatchObject({ outcome: "unsure", reason: "model_error", clicked: [] });
      expect(e.notes).toContain(note);
      expect(h.clicks).toEqual([]);
      expect(h.hidden).toEqual([]);
      expect(banner.isConnected).toBe(true);
      await sleep(50);
      expect(h.escaped).toEqual([]);
      unmountAll();
      stopAll();
    }
  });

  test("banner re-rendered before the claim → unsure stale_target, and no claim is made", async () => {
    mountPage("custom-reject");
    const provider = new Counting();
    // The site swaps in a new copy of the banner while the gate is being asked.
    provider.onCall = (op) => {
      if (op !== "isConsentDialog") return;
      const old = byId("my-cookie-notice");
      old.replaceWith(old.cloneNode(true));
    };
    const h = await start({ provider });

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "unsure", reason: "stale_target", clicked: [] });
    expect(await h.app.arbiter.owner(1)).toBe("none");
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect(window.__clicked).toBeUndefined();
  });

  test("banner re-rendered after the click → failed came_back", async () => {
    mountPage("custom-reject");
    const banner = byId("my-cookie-notice");
    const parent = banner.parentElement as Element;
    const copy = banner.cloneNode(true) as Element;
    // The page removes the banner on the click, then renders it again as a new element.
    banner.querySelectorAll("button")[1]?.addEventListener("click", () => {
      setTimeout(() => parent.append(copy), 50);
    });
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "came_back",
      verification: "came_back",
      clicked: [{ text: "Reject all" }],
    });
    expect(window.__clicked).toBe("reject");
    expect(copy.isConnected).toBe(true);
    expect(copy.hasAttribute(HIDDEN)).toBe(false);
    expect(e.t.gone).toBeUndefined();
  });

  test("banner re-rendered after decision, before click → unsure stale_target", async () => {
    mountPage("custom-reject");
    let fresh: Element | undefined;
    const h = await start({
      // The site swaps in a new copy of the banner just as Bouncer claims the page.
      platform: (content) => ({
        onMessage: (fn) => content.onMessage(fn),
        send: ((m) => {
          if (m.type === "claim") {
            const old = byId("my-cookie-notice");
            fresh = old.cloneNode(true) as Element;
            old.replaceWith(fresh);
          }
          return content.send(m);
        }) as ContentPlatform["send"],
      }),
    });

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "unsure", reason: "stale_target", clicked: [] });
    expect(fresh?.isConnected).toBe(true);
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
    expect(window.__clicked).toBeUndefined();
  });

  test("one decision per page: a second banner after dismissed is ignored", async () => {
    mountPage("custom-reject");
    const h = await start();
    expect((await h.path.done).outcome).toBe("dismissed");
    delete window.__clicked;

    mountPage("custom-reject");
    const second = byId("my-cookie-notice");
    await sleep(400); // several detection passes at the test clock's speed
    expect(second.isConnected).toBe(true);
    expect(second.hasAttribute(HIDDEN)).toBe(false);
    expect(window.__clicked).toBeUndefined();
    expect(await h.entries()).toHaveLength(1);
  });

  test('AI-only reject "Continue to site": corroborate false → no click', async () => {
    mountPage("continue-to-site");
    const h = await start();

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "unsure", reason: "no_usable_control", clicked: [] });
    expect(h.provider.calls).toEqual(["isConsentDialog", "labelControls", "corroborate"]);
    // The label logged is the one the chooser was left with: corroboration demoted it.
    expect(e.labels?.[1]).toEqual({ label: "other", source: "ai" });
    expect(e.notes).toContain("corroborate:1:false");
    expect(h.clicks).toEqual([]);
    expect(window.__clicked).toBeUndefined();
  });

  test("log entry has found/decided/gone, modelCalls with cold flag, aiOnly marks", async () => {
    mountPage("proceed");
    const before = Date.now();
    const h = await start({ provider: new Agreeable() });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "ai",
      clicked: [{ id: 1, text: "Proceed", aiOnly: true }],
      modelCalls: [
        { op: "isConsentDialog", ms: 9, cold: true, result: "answer" },
        { op: "labelControls", ms: 5, cold: false, result: "answer" },
        { op: "corroborate", ms: 4, cold: false, result: "answer" },
      ],
    });
    const { found, decided, gone } = e.t;
    expect(found).toBeGreaterThanOrEqual(before);
    expect(decided).toBeGreaterThanOrEqual(found as number);
    expect(gone).toBeGreaterThanOrEqual(decided as number);
    expect(gone).toBeLessThanOrEqual(Date.now());
    expect(window.__clicked).toBe("proceed");
    expect(e.labels?.[1]).toEqual({ label: "reject", source: "ai", corroborated: true });
    // What the background stored is what `done` reports.
    expect(await h.entries()).toEqual([e]);
  });

  test("acOutcome: a failed one doesn't use up the unlock; dismissed_late then unlocks, once", async () => {
    mount('<div style="height:5000px"></div>');
    const h = await start();
    document.body.style.overflow = "hidden"; // autoconsent's banner locks scroll
    const tell = (msg: Parameters<FakeBackground["sendToFrame"]>[2]) => h.bg.sendToFrame(1, 0, msg);
    await tell({ type: "acDetected" });
    await tell({ type: "acPopupFound" });
    await tell({ type: "acOutcome", outcome: "failed" });
    expect(document.body.style.overflow).toBe("hidden");
    await tell({ type: "acOutcome", outcome: "dismissed_late" });
    expect(document.body.style.overflow).toBe("");
    // A repeat (a worker restart re-sends it) is ignored.
    document.body.style.overflow = "hidden";
    await tell({ type: "acOutcome", outcome: "dismissed_late" });
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("autoconsent's prehide lands on the banner during the claim wait: nothing touched, nothing logged, and the banner is refused once it lifts", async () => {
    mountPage("custom-reject");
    const t0 = Date.now();
    const h = await start({ clock: prehideAtClaimWait("#my-cookie-notice") });

    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      path: "ai",
      verification: "verified",
      clicked: [{ text: "Reject all", aiOnly: false }],
    });
    expect(window.__clicked).toBe("reject");
    // The banner was looked at again once shown: gated a second time, and logged once.
    expect(h.provider.calls.filter((op) => op === "isConsentDialog")).toHaveLength(2);
    expect(await h.entries()).toEqual([e]);
    expect(h.clicks).toHaveLength(1);
    // The entry says it was set aside, and when it was first found: before the (fast) claim wait
    // of 150 ms and the prehide's 100 ms. `t.found` is still when this run found it.
    const first = setAsideAt(e) ?? Number.NaN;
    expect(first).toBeGreaterThanOrEqual(t0);
    expect((e.t.found ?? 0) - first).toBeGreaterThanOrEqual(200);
  });

  test("autoconsent's prehide on a banner waiting its turn: it is handled once the prehide lifts", async () => {
    mountPage("login-wall");
    mountPage("custom-reject");
    const provider = new Counting();
    let lift: (() => void) | undefined;
    // The login wall is judged first; meanwhile autoconsent prehides the banner queued after it.
    provider.onCall = (op) => {
      if (op === "isConsentDialog" && !lift) lift = prehide("#my-cookie-notice");
    };
    // The prehide lifts once the login wall is logged: in a later task than the banner's turn,
    // which comes straight after.
    const platform = (content: ContentPlatform): ContentPlatform => ({
      onMessage: (fn) => content.onMessage(fn),
      send: (async (m) => {
        const reply = await content.send(m);
        if (m.type === "log" && m.entry.outcome === "not_consent") setTimeout(() => lift?.(), 0);
        return reply;
      }) as ContentPlatform["send"],
    });
    const t0 = Date.now();
    const h = await start({ provider, platform });

    await until(async () => (await h.entries()).some((e) => e.outcome === "dismissed"), 2000);
    const [login, banner] = await h.entries();
    expect([login?.outcome, banner?.outcome]).toEqual(["not_consent", "dismissed"]);
    expect(window.__clicked).toBe("reject");
    // Only the banner was set aside; it was first found with the login wall, before the lift.
    expect(login && setAsideAt(login)).toBeUndefined();
    const first = (banner && setAsideAt(banner)) ?? Number.NaN;
    expect(first).toBeGreaterThanOrEqual(t0);
    expect(first).toBeLessThan(banner?.t.found ?? 0);
  });

  test("a dismissal restores the scroll the banner locked", async () => {
    mountPage("custom-reject");
    const h = await start();
    document.body.style.overflow = "hidden"; // the banner locks scroll as it appears
    const e = await h.path.done;
    expect(e.outcome).toBe("dismissed");
    expect(e.notes).toContain("scroll:unlocked");
    expect(document.body.style.overflow).toBe("");
  });
});

describe("OwnPath: a banner that confirms the refusal (§2g)", () => {
  test("a new Hide in the still-shown banner is clicked once → dismissed, both clicks logged", async () => {
    mountPage("confirmation");
    const banner = byId("cookie-confirm");
    const h = await start();
    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed",
      verification: "verified",
      clicked: [
        { text: "Reject additional cookies", aiOnly: false },
        { text: "Hide", aiOnly: false },
      ],
    });
    expect(e.notes).toContain("confirmation:closed");
    expect(window.__clicked).toBe("hide");
    expect(banner.hidden).toBe(true);
    expect(banner.hasAttribute(HIDDEN)).toBe(false);
  });

  test("with Close set to leave it, Hide is not clicked → dismissed_unverified, noted", async () => {
    mountPage("confirmation");
    const banner = byId("cookie-confirm");
    const h = await start({ settings: { closeAction: "leave" } });
    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "dismissed_unverified",
      clicked: [{ text: "Reject additional cookies", aiOnly: false }],
    });
    expect(e.notes).toContain("confirmation:left");
    expect(window.__clicked).toBe("reject");
    expect(h.clicks).not.toContain(byId("hide-banner"));
    // The confirmation is the user's to close: shown again, untouched.
    expect(banner.hidden).toBe(false);
    expect(banner.hasAttribute(HIDDEN)).toBe(false);
  });

  test("a close control the banner had before the click doesn't count → failed, not_gone", async () => {
    mount(`<div id="cookie-had-hide" style="position:fixed;bottom:0;left:0;right:0;z-index:9999">
      <p id="msg">We use cookies for analytics.</p>
      <button onclick="document.getElementById('msg').textContent='You rejected cookies.'">Reject all</button>
      <button onclick="window.__clicked='hide'">Hide</button></div>`);
    const h = await start();
    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "not_gone",
      clicked: [{ text: "Reject all", aiOnly: false }],
    });
    expect(e.notes.some((n) => n.startsWith("confirmation:"))).toBe(false);
    expect(window.__clicked).toBeUndefined();
  });

  test("a settings panel opened in the banner: its × was there before the save → failed, not_gone", async () => {
    mount(`<div id="cookie-inline" style="position:fixed;bottom:0;left:0;right:0;z-index:9999">
      <p>We use cookies for analytics.</p>
      <button onclick="document.getElementById('prefs').hidden=false">Cookie settings</button>
      <button onclick="window.__clicked='accept'; this.parentElement.remove()">Accept all</button>
      <div id="prefs" hidden><label><input type="checkbox" checked> Analytics cookies</label>
        <button onclick="window.__clicked='save'">Save choices</button>
        <button aria-label="Close" onclick="window.__clicked='close'; this.closest('#cookie-inline').remove()">×</button>
      </div></div>`);
    const h = await start();
    const e = await h.path.done;
    expect(e).toMatchObject({
      outcome: "failed",
      reason: "not_gone",
      clicked: [{ text: "Cookie settings" }, { text: "Save choices" }],
    });
    expect(e.notes.some((n) => n.startsWith("confirmation:"))).toBe(false);
    expect(window.__clicked).toBe("save");
  });
});

describe("OwnPath: the claim wait ends at autoconsent's look (§2b)", () => {
  const looked = (startedAt: number) => ({ type: "acLooked" as const, startedAt });

  /** Starts on custom-reject; `onGate` runs as the gate is asked, after the candidate was found. */
  async function startWith(onGate: (bg: FakeBackground) => void, clock = noClaimCap) {
    mountPage("custom-reject");
    const provider = new Counting();
    let bg: FakeBackground | undefined;
    provider.onCall = (op) => {
      if (op === "isConsentDialog" && bg) onGate(bg);
    };
    return start({ provider, clock, before: (x) => void (bg = x.bg) });
  }

  test("a look that began after the candidate was found, recognising nothing, ends it: Bouncer acts without the safety net", async () => {
    const h = await startWith((bg) => void bg.sendToFrame(1, 0, looked(Date.now())));

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "dismissed", path: "ai" });
    expect(e.notes).toContainEqual(expect.stringMatching(/^claim_wait:autoconsent_looked:\d+$/));
    expect(window.__clicked).toBe("reject");
  });

  test("a look that began after the page last changed ends it, though it began before the candidate was found", async () => {
    // Nothing on the page changes once Bouncer starts watching; its first pass is held back 200 ms.
    const held: Clock = {
      ...noClaimCap,
      setTimeout: (fn, ms) => noClaimCap.setTimeout(fn, ms === 0 ? 2000 : ms),
    };
    let watching = 0;
    const h = await startWith((bg) => void bg.sendToFrame(1, 0, looked(watching)), held);
    watching = Date.now();

    const e = await h.path.done;
    expect(e.outcome).toBe("dismissed");
    expect(e.notes).toContainEqual(expect.stringMatching(/^claim_wait:autoconsent_looked:\d+$/));
  });

  test("a look that began before the page last changed doesn't end it", async () => {
    const h = await startWith((bg) => void bg.sendToFrame(1, 0, looked(Date.now() - 60_000)));
    await until(() => h.provider.calls.includes("isConsentDialog"));
    await sleep(300);
    expect(h.clicks).toEqual([]);
    expect(await h.app.arbiter.owner(1)).toBe("none");

    void h.bg.sendToFrame(1, 0, looked(Date.now()));
    const e = await h.path.done;
    expect(e.outcome).toBe("dismissed");
  });

  test("autoconsent's detection ending ends it, and the entry says so", async () => {
    const h = await startWith((bg) => void bg.sendToFrame(1, 0, { type: "acDetectionEnded" }));

    const e = await h.path.done;
    expect(e.outcome).toBe("dismissed");
    expect(e.notes).toContainEqual(expect.stringMatching(/^claim_wait:autoconsent_ended:\d+$/));
  });

  test("with no look, the safety net ends it, and the entry says so", async () => {
    const h = await startWith(() => {}, fastClock);

    const e = await h.path.done;
    expect(e.outcome).toBe("dismissed");
    expect(e.notes).toContainEqual(expect.stringMatching(/^claim_wait:timed_out:\d+$/));
  });

  test("autoconsent recognising the banner after its look still stands Bouncer down", async () => {
    const h = await startWith((bg) => {
      void bg.sendToFrame(1, 0, looked(Date.now()));
      void bg.sendToFrame(1, 0, { type: "acDetected" });
    });

    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "deferred", reason: "autoconsent_detected" });
    expect(h.clicks).toEqual([]);
  });
});

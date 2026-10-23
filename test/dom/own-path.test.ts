import { afterEach, describe, expect, test } from "vitest";
import { MockProvider } from "../../src/ai/mock/provider.ts";
import type { AiProvider, AiResult, AiStatus } from "../../src/core/ai.ts";
import { RemoteAiProvider } from "../../src/core/ai-remote.ts";
import { type BackgroundApp, startBackground } from "../../src/core/background-app.ts";
import type { LogEntry } from "../../src/core/log.ts";
import { OwnPath } from "../../src/core/pipeline/own-path.ts";
import type { ContentPlatform } from "../../src/core/platform.ts";
import { DEFAULT_SETTINGS, type Settings } from "../../src/core/settings.ts";
import type { Clock, Control, Label, SerialisedBanner } from "../../src/core/types.ts";
import {
  type FakeBackground,
  type FakeContent,
  fakeBackground,
  fakeContent,
} from "../helpers/fake-platform.ts";
import { mount, mountPage, unmountAll } from "../helpers/mount.ts";

declare global {
  interface Window {
    __clicked?: string;
    __chatClicked?: string;
  }
}

/** Real timers, ten times faster: the claim wait is 150 ms and detection watches for 2 s. */
const fastClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms / 10),
  clearTimeout: (id) => window.clearTimeout(id),
};
const VERIFY = { goneMs: 500, stayMs: 200 };
const HIDDEN = "data-bouncer-hidden";

/** MockProvider that records every model call (not `status`) and can run a hook on each. */
class Counting extends MockProvider {
  calls: string[] = [];
  onCall?: (op: string) => void;

  private note(op: string) {
    this.calls.push(op);
    this.onCall?.(op);
  }

  override isConsentDialog(b: SerialisedBanner) {
    this.note("isConsentDialog");
    return super.isConsentDialog(b);
  }

  override labelControls(b: SerialisedBanner, ids: number[]) {
    this.note("labelControls");
    return super.labelControls(b, ids);
  }

  override corroborate(b: SerialisedBanner, c: Control, l: "reject" | "save" | "settings") {
    this.note("corroborate");
    return super.corroborate(b, c, l);
  }
}

/** The model is not available: only the fast path may act. */
class Unavailable extends Counting {
  override async status(): Promise<AiStatus> {
    return { state: "unavailable", reason: "test", onDevice: true };
  }
}

/** Corroborates every AI-only label, and reports the gate's call as a cold start. */
class Agreeable extends Counting {
  override async isConsentDialog(b: SerialisedBanner): Promise<AiResult<boolean>> {
    const r = await super.isConsentDialog(b);
    return { ...r, meta: { ...r.meta, ms: 9, cold: true } };
  }

  override async labelControls(
    b: SerialisedBanner,
    ids: number[],
  ): Promise<AiResult<Record<number, Label>>> {
    const r = await super.labelControls(b, ids);
    return { ...r, meta: { ...r.meta, ms: 5 } };
  }

  override async corroborate(
    b: SerialisedBanner,
    c: Control,
    l: "reject" | "save" | "settings",
  ): Promise<AiResult<boolean>> {
    await super.corroborate(b, c, l);
    return { kind: "answer", value: true, meta: { ms: 4, cold: false, onDevice: true } };
  }
}

interface Harness {
  bg: FakeBackground;
  app: BackgroundApp;
  content: FakeContent;
  provider: Counting;
  path: OwnPath;
  /** Every element clicked while the harness ran (Bouncer is the only clicker in these tests). */
  clicks: Element[];
  /** Every element that was given Bouncer's hiding attribute. */
  hidden: Element[];
  /** Errors and rejections that reached the page. */
  escaped: unknown[];
  entries(): Promise<LogEntry[]>;
}

interface StartOpts {
  provider?: Counting;
  settings?: Partial<Settings>;
  /** Runs after `hello`, before the pipeline starts. */
  before?: (h: { bg: FakeBackground; app: BackgroundApp; content: FakeContent }) => unknown;
  /** Wraps the content platform the pipeline talks through. */
  platform?: (content: FakeContent) => ContentPlatform;
  /** The pipeline's AI, in place of `RemoteAiProvider` over the fake background. */
  ai?: AiProvider;
}

const teardown: (() => void)[] = [];

afterEach(() => {
  for (const t of teardown.splice(0)) t();
  unmountAll();
  for (const s of document.querySelectorAll("style[data-bouncer]")) s.remove();
  delete window.__clicked;
  delete window.__chatClicked;
  document.body.style.removeProperty("overflow");
});

async function start(o: StartOpts = {}): Promise<Harness> {
  const bg = fakeBackground();
  const provider = o.provider ?? new Counting();
  const app = startBackground(bg, provider);
  const content = fakeContent(bg);
  // The content entry's hello: it records the page with the arbiter, so a claim can be granted.
  await content.send({ type: "hello" });
  await o.before?.({ bg, app, content });

  const clicks: Element[] = [];
  const hidden: Element[] = [];
  const escaped: unknown[] = [];
  const onClick = (e: Event) => clicks.push(e.composedPath()[0] as Element);
  const onError = (e: ErrorEvent) => escaped.push(e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent) => escaped.push(e.reason);
  document.addEventListener("click", onClick, true);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const mo = new MutationObserver((records) => {
    for (const r of records) if (r.oldValue === null) hidden.push(r.target as Element);
  });
  mo.observe(document, {
    subtree: true,
    attributes: true,
    attributeFilter: [HIDDEN],
    attributeOldValue: true,
  });

  const path = new OwnPath({
    doc: document,
    win: window,
    platform: o.platform?.(content) ?? content,
    ai: o.ai ?? new RemoteAiProvider(content),
    settings: { ...DEFAULT_SETTINGS, ...o.settings },
    clock: fastClock,
    verify: VERIFY,
  });
  teardown.push(() => {
    path.stop();
    mo.disconnect();
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  });
  path.start();
  return {
    bg,
    app,
    content,
    provider,
    path,
    clicks,
    hidden,
    escaped,
    entries: () => app.log.list(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;

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
    for (const t of teardown.splice(0)) t();

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
    for (const t of teardown.splice(0)) t();
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
    for (const t of teardown.splice(0)) t();

    mountPage("broken-reject");
    banner = byId("cookie-broken");
    h = await start({ settings: { onFailed: "keep_hidden" } });
    e = await h.path.done;
    expect(e.outcome).toBe("failed");
    expect(banner.hasAttribute(HIDDEN)).toBe(true);
    expect(document.querySelector("style[data-bouncer]")).not.toBeNull();
  });

  test("form-submit reject → absent; logged reason submit", async () => {
    mountPage("form-reject");
    const h = await start();
    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "no_option", reason: "submit", clicked: [] });
    expect(e.labels?.[0]).toMatchObject({ label: "reject", source: "regex" });
    expect(h.clicks).toEqual([]);
    expect(window.__clicked).toBeUndefined();
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
      for (const t of teardown.splice(0)) t();
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
    expect(e.labels?.[1]).toMatchObject({ label: "reject", source: "ai" });
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
    // What the background stored is what `done` reports.
    expect(await h.entries()).toEqual([e]);
  });

  test("a settings decision ends unsure settings_not_implemented until Task 19", async () => {
    mountPage("custom-settings");
    const h = await start();
    const e = await h.path.done;
    expect(e).toMatchObject({ outcome: "unsure", reason: "settings_not_implemented" });
    expect(h.clicks).toEqual([]);
    expect(h.hidden).toEqual([]);
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

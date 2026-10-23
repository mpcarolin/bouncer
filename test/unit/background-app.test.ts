import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiMeta, AiProvider } from "../../src/core/ai.ts";
import type { AcLib } from "../../src/core/autoconsent-bg.ts";
import { startBackground } from "../../src/core/background-app.ts";
import { MAX_MODEL_CALLS_PER_PAGE } from "../../src/core/config.ts";
import type { LearnedRule } from "../../src/core/learned.ts";
import type { LogEntry } from "../../src/core/log.ts";
import { DEFAULT_SETTINGS, saveSettings } from "../../src/core/settings.ts";
import type { SerialisedBanner } from "../../src/core/types.ts";
import { type FakeBackground, fakeBackground, fakeContent } from "../helpers/fake-platform.ts";

afterEach(() => vi.restoreAllMocks());

const META: AiMeta = { ms: 3, cold: false, onDevice: true };
const banner: SerialisedBanner = { text: "We use cookies", controls: [] };

/** A provider that counts the model calls that reach it. */
function countingProvider() {
  const calls = { model: 0, status: 0 };
  const provider: AiProvider = {
    status: async () => {
      calls.status++;
      return { state: "available", onDevice: true };
    },
    isConsentDialog: async () => {
      calls.model++;
      return { kind: "answer", value: true, meta: META };
    },
    labelControls: async () => {
      calls.model++;
      return { kind: "answer", value: {}, meta: META };
    },
    corroborate: async () => {
      calls.model++;
      return { kind: "answer", value: true, meta: META };
    },
  };
  return { provider, calls };
}

function started(over: Parameters<typeof startBackground>[2] = {}) {
  const bg = fakeBackground();
  const { provider, calls } = countingProvider();
  const app = startBackground(bg, provider, over);
  return { bg, app, calls, provider };
}

/** A reply that must have come: fails the test on `undefined`, which is what a failed background sends. */
async function replied<T>(reply: Promise<T | undefined>): Promise<T> {
  const r = await reply;
  if (r === undefined) throw new Error("expected a reply, got undefined");
  return r;
}

const entry = (site: string): Omit<LogEntry, "id"> => ({
  at: Date.now(),
  site,
  url: `https://${site}/`,
  path: "heuristic",
  clicked: [],
  toggles: [],
  t: {},
  modelCalls: [],
  outcome: "unsure",
  notes: [],
});

describe("hello", () => {
  it("from the top frame records the document: a new document resets the page's claim", async () => {
    const { bg, app } = started();
    const top = fakeContent(bg, { tabId: 1, frameId: 0, documentId: "d1" });
    await top.send({ type: "hello" });
    expect(await top.send({ type: "claim" })).toEqual({ granted: true });
    expect(await app.arbiter.owner(1)).toBe("bouncer");

    top.sender.documentId = "d2"; // the tab navigated
    await top.send({ type: "hello" });
    expect(await app.arbiter.owner(1)).toBe("none");
    expect(await top.send({ type: "claim" })).toEqual({ granted: true });
  });

  it("repeated for the same document leaves its claim alone", async () => {
    const { bg } = started();
    const top = fakeContent(bg, { documentId: "d1" });
    await top.send({ type: "hello" });
    await top.send({ type: "claim" });
    await top.send({ type: "hello" });
    expect(await top.send({ type: "claim" })).toEqual({ granted: false, reason: "already" });
  });

  it("from a child frame does not touch the page's state", async () => {
    const { bg } = started();
    const top = fakeContent(bg, { tabId: 1, frameId: 0, documentId: "d1" });
    const child = fakeContent(bg, { tabId: 1, frameId: 3, documentId: "child-doc" });
    await top.send({ type: "hello" });
    await top.send({ type: "claim" });
    expect(await child.send({ type: "hello" })).toMatchObject({ enabled: true });
    expect(await top.send({ type: "claim" })).toEqual({ granted: false, reason: "already" });
  });

  it("judges a child frame by the tab's site, not the frame's own", async () => {
    const { bg } = started();
    await saveSettings(bg.local, { ...DEFAULT_SETTINGS, disabledSites: ["news.example"] });
    const tabUrl = "https://news.example/story";
    // A CMP's iframe and an about:blank frame, both on a page whose site is disabled.
    const cmp = fakeContent(bg, {
      frameId: 2,
      documentId: "c",
      url: "https://cmp.vendor.test/x",
      tabUrl,
    });
    const blank = fakeContent(bg, { frameId: 3, documentId: "b", url: "about:blank", tabUrl });
    for (const frame of [cmp, blank]) {
      expect(await frame.send({ type: "hello" })).toMatchObject({ enabled: false });
    }
    // With no tab URL to go on, the frame's own URL is what is judged.
    const noTabUrl = (url: string) =>
      fakeContent(bg, { frameId: 4, documentId: "n", url, tabUrl: "" }).send({ type: "hello" });
    expect(await noTabUrl("https://news.example/f")).toMatchObject({ enabled: false });
    expect(await noTabUrl("https://fine.example/f")).toMatchObject({ enabled: true });
    // ...and the other way round: a frame served from a disabled host, on a page that isn't.
    const embedded = fakeContent(bg, {
      frameId: 5,
      documentId: "e",
      url: "https://news.example/widget",
      tabUrl: "https://other.example/",
    });
    expect(await embedded.send({ type: "hello" })).toMatchObject({ enabled: true });
  });

  it("replies with the settings, the verdict for the sender's URL, and no learned rule when none is stored", async () => {
    const { bg } = started();
    await saveSettings(bg.local, { ...DEFAULT_SETTINGS, disabledSites: ["off.example"] });
    const on = await fakeContent(bg, { url: "https://on.example/page" }).send({ type: "hello" });
    expect(on).toEqual({
      enabled: true,
      settings: { ...DEFAULT_SETTINGS, disabledSites: ["off.example"] },
      learnedRule: undefined,
    });
    const off = await fakeContent(bg, { url: "https://www.off.example/" }).send({ type: "hello" });
    expect(off?.enabled).toBe(false);
  });

  it("replies enabled: false everywhere when Bouncer is switched off globally", async () => {
    const { bg } = started();
    await saveSettings(bg.local, { ...DEFAULT_SETTINGS, enabled: false });
    const reply = await replied(fakeContent(bg).send({ type: "hello" }));
    expect(reply.enabled).toBe(false);
    expect(reply.settings.enabled).toBe(false);
  });

  it("still records the document when the site is disabled", async () => {
    const { bg, app } = started();
    await saveSettings(bg.local, { ...DEFAULT_SETTINGS, disabledSites: ["example.com"] });
    const top = fakeContent(bg, { documentId: "d1" });
    expect((await top.send({ type: "hello" }))?.enabled).toBe(false);
    expect(await app.arbiter.claimForBouncer(1, "d1")).toEqual({ granted: true });
  });

  it("from a sender with no tab stands down and leaves no state behind", async () => {
    const { bg } = started();
    const page = fakeContent(bg, { tabId: -1, frameId: -1, documentId: "popup-doc" });
    const reply = await replied(page.send({ type: "hello" }));
    expect(reply.enabled).toBe(false);
    expect(reply.settings).toEqual(DEFAULT_SETTINGS);
    expect(await bg.session.get("arb:-1")).toBeUndefined();
  });
});

describe("claim", () => {
  it("before any hello, or from a document that is no longer the page's, is stale", async () => {
    const { bg } = started();
    const top = fakeContent(bg, { documentId: "d1" });
    expect(await top.send({ type: "claim" })).toEqual({ granted: false, reason: "stale" });
    await top.send({ type: "hello" });
    top.sender.documentId = "d2";
    await top.send({ type: "hello" });
    top.sender.documentId = "d1"; // a message from the previous page, arriving late
    expect(await top.send({ type: "claim" })).toEqual({ granted: false, reason: "stale" });
    top.sender.documentId = "d2";
    expect(await top.send({ type: "claim" })).toEqual({ granted: true });
  });

  it("from a child frame is stale: only the top document can be claimed", async () => {
    const { bg } = started();
    const top = fakeContent(bg, { frameId: 0, documentId: "d1" });
    const child = fakeContent(bg, { frameId: 2, documentId: "child-doc" });
    await top.send({ type: "hello" });
    expect(await child.send({ type: "claim" })).toEqual({ granted: false, reason: "stale" });
    expect(await top.send({ type: "claim" })).toEqual({ granted: true });
  });

  it("from a sender with no tab is stale and records nothing", async () => {
    const { bg } = started();
    const page = fakeContent(bg, { tabId: -1, frameId: -1, documentId: "popup-doc" });
    expect(await page.send({ type: "claim" })).toEqual({ granted: false, reason: "stale" });
    expect(await bg.session.get("arb:-1")).toBeUndefined();
  });

  it("is atomic: of two simultaneous claims for one page, exactly one is granted", async () => {
    const { bg } = started();
    const top = fakeContent(bg, { documentId: "d1" });
    await top.send({ type: "hello" });
    const replies = await Promise.all([
      replied(top.send({ type: "claim" })),
      replied(top.send({ type: "claim" })),
    ]);
    expect(replies.filter((r) => r.granted)).toHaveLength(1);
    expect(replies.find((r) => !r.granted)?.reason).toBe("already");
  });

  it("is remembered across a service-worker restart", async () => {
    const { bg } = started();
    const top = fakeContent(bg, { documentId: "d1" });
    await top.send({ type: "hello" });
    await top.send({ type: "claim" });
    bg.restart();
    startBackground(bg, countingProvider().provider);
    expect(await top.send({ type: "claim" })).toEqual({ granted: false, reason: "already" });
  });
});

describe("ai", () => {
  const ask = (c: ReturnType<typeof fakeContent>) =>
    replied(c.send({ type: "ai", op: "isConsentDialog", args: [banner] }));

  it("serves each op through the provider", async () => {
    const { bg } = started();
    const top = fakeContent(bg);
    expect(await top.send({ type: "ai", op: "status", args: [] })).toEqual({
      state: "available",
      onDevice: true,
    });
    expect(await ask(top)).toEqual({ kind: "answer", value: true, meta: META });
    expect(await top.send({ type: "ai", op: "labelControls", args: [banner, [0]] })).toEqual({
      kind: "answer",
      value: {},
      meta: META,
    });
  });

  it("allows 8 model calls on a page, then answers budget_exhausted without reaching the model", async () => {
    const { bg, calls } = started();
    const top = fakeContent(bg, { documentId: "d1" });
    for (let i = 0; i < MAX_MODEL_CALLS_PER_PAGE; i++) {
      expect((await ask(top)).kind).toBe("answer");
    }
    const ninth = await ask(top);
    expect(ninth).toMatchObject({ kind: "error", error: "budget_exhausted" });
    expect(calls.model).toBe(MAX_MODEL_CALLS_PER_PAGE);
  });

  it("does not count status against the budget, and still answers it when the budget is spent", async () => {
    const { bg, calls } = started();
    const top = fakeContent(bg);
    for (let i = 0; i < MAX_MODEL_CALLS_PER_PAGE + 1; i++) await ask(top);
    expect(await top.send({ type: "ai", op: "status", args: [] })).toMatchObject({
      state: "available",
    });
    expect(calls.status).toBe(1);
  });

  it("gives a new top document a fresh budget", async () => {
    const { bg, calls } = started();
    const top = fakeContent(bg, { documentId: "d1" });
    await top.send({ type: "hello" });
    for (let i = 0; i < MAX_MODEL_CALLS_PER_PAGE; i++) await ask(top);
    expect(await ask(top)).toMatchObject({ error: "budget_exhausted" });

    top.sender.documentId = "d2";
    await top.send({ type: "hello" });
    expect((await ask(top)).kind).toBe("answer");
    expect(calls.model).toBe(MAX_MODEL_CALLS_PER_PAGE + 1);
  });

  it("keeps a document's budget through a repeated hello, but forgets it once the next document says hello", async () => {
    const { bg } = started();
    const top = fakeContent(bg, { documentId: "d1" });
    await top.send({ type: "hello" });
    for (let i = 0; i < MAX_MODEL_CALLS_PER_PAGE; i++) await ask(top);
    await top.send({ type: "hello" });
    expect(await ask(top)).toMatchObject({ error: "budget_exhausted" });

    const next = fakeContent(bg, { documentId: "d2" });
    await next.send({ type: "hello" });
    // d1 is gone: nothing of it is kept, so a straggler from it starts from scratch.
    expect((await ask(top)).kind).toBe("answer");
  });

  it("keeps a budget per tab", async () => {
    const { bg } = started();
    const a = fakeContent(bg, { tabId: 1, documentId: "d1" });
    const b = fakeContent(bg, { tabId: 2, documentId: "d1" });
    for (let i = 0; i < MAX_MODEL_CALLS_PER_PAGE; i++) await ask(a);
    expect(await ask(a)).toMatchObject({ error: "budget_exhausted" });
    expect((await ask(b)).kind).toBe("answer");
  });

  it("drops a tab's budget when the tab is removed", async () => {
    const { bg } = started();
    const top = fakeContent(bg, { tabId: 4, documentId: "d1" });
    for (let i = 0; i < MAX_MODEL_CALLS_PER_PAGE; i++) await ask(top);
    expect(await ask(top)).toMatchObject({ error: "budget_exhausted" });
    bg.removeTab(4);
    expect((await ask(top)).kind).toBe("answer");
  });

  it("refuses model ops from a child frame with not_top_frame, spending nothing", async () => {
    const { bg, calls } = started();
    const child = fakeContent(bg, { tabId: 1, frameId: 5, documentId: "child-doc" });
    expect(await ask(child)).toMatchObject({ kind: "error", error: "not_top_frame" });
    expect(
      await child.send({ type: "ai", op: "labelControls", args: [banner, [0]] }),
    ).toMatchObject({ kind: "error", error: "not_top_frame" });
    expect(calls.model).toBe(0);
    // ...and it didn't take anything from the top frame's budget.
    const top = fakeContent(bg, { tabId: 1, frameId: 0, documentId: "d1" });
    for (let i = 0; i < MAX_MODEL_CALLS_PER_PAGE; i++) {
      expect((await ask(top)).kind).toBe("answer");
    }
  });

  it("serves status to a child frame, and to a sender with no tab", async () => {
    const { bg } = started();
    const child = fakeContent(bg, { frameId: 5 });
    const popup = fakeContent(bg, { tabId: -1, frameId: -1, documentId: "popup-doc" });
    for (const c of [child, popup]) {
      expect(await c.send({ type: "ai", op: "status", args: [] })).toMatchObject({
        state: "available",
      });
    }
  });

  it("refuses model ops from a sender with no tab", async () => {
    const { bg, calls } = started();
    const popup = fakeContent(bg, { tabId: -1, frameId: -1, documentId: "popup-doc" });
    expect(await ask(popup)).toMatchObject({ kind: "error", error: "no_tab" });
    expect(calls.model).toBe(0);
  });

  it("replies with an error result for an unknown op instead of throwing", async () => {
    const { bg } = started();
    const reply = await fakeContent(bg).send({ type: "ai", op: "dance", args: [] } as never);
    expect(reply).toMatchObject({ kind: "error", error: "unknown_op" });
  });

  it("replies with an error result when the provider throws", async () => {
    const bg = fakeBackground();
    const provider: AiProvider = {
      ...countingProvider().provider,
      isConsentDialog: async () => {
        throw new Error("model fell over");
      },
    };
    startBackground(bg, provider);
    expect(await ask(fakeContent(bg))).toMatchObject({ kind: "error", error: "model fell over" });
  });
});

describe("log and logPatch", () => {
  it("adds an entry, returns its id, and patches it", async () => {
    const { bg, app } = started();
    const top = fakeContent(bg);
    const { id } = await replied(top.send({ type: "log", entry: entry("a.example") }));
    await top.send({ type: "logPatch", id, patch: { outcome: "dismissed", t: { gone: 900 } } });
    const [saved] = await app.log.list();
    expect(saved).toMatchObject({ id, site: "a.example", outcome: "dismissed", t: { gone: 900 } });
  });

  it("serialises simultaneous writes, so none is lost", async () => {
    const { bg, app } = started();
    const top = fakeContent(bg);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        top.send({ type: "log", entry: entry(`s${i}.example`) }),
      ),
    );
    expect(await app.log.list()).toHaveLength(12);
  });

  it("keeps the log in local storage, which survives a browser restart", async () => {
    const { bg } = started();
    await fakeContent(bg).send({ type: "log", entry: entry("a.example") });
    expect(await bg.local.get("decisionLog")).toHaveLength(1);
    expect(await bg.session.get("decisionLog")).toBeUndefined();
  });
});

describe("saveRule and discardRule", () => {
  const rule = (site: string): LearnedRule => ({
    site,
    createdAt: 1,
    stage1: {
      action: "reject",
      target: { selector: ":scope > button:nth-of-type(2)", text: "Reject all", label: "reject" },
    },
  });

  it("saveRule stores the top frame's rule; hello then returns it for the site, www. or not", async () => {
    const { bg, app } = started();
    const top = fakeContent(bg, { url: "https://www.shop.example/cart" });
    expect(await top.send({ type: "saveRule", rule: rule("shop.example") })).toBeUndefined();
    expect(await app.rules.get("shop.example")).toEqual(rule("shop.example"));

    const next = fakeContent(bg, { tabId: 2, url: "https://shop.example/" });
    expect(await next.send({ type: "hello" })).toMatchObject({
      enabled: true,
      learnedRule: rule("shop.example"),
    });
  });

  it("ignores a rule for another site, an invalid one, and one from a child frame", async () => {
    const { bg, app } = started();
    const top = fakeContent(bg, { url: "https://shop.example/" });
    await top.send({ type: "saveRule", rule: rule("other.example") });
    // A reject needs no second stage: a rule that has one is malformed.
    const stage2 = { action: "reject" as const, target: rule("x").stage1.target };
    await top.send({ type: "saveRule", rule: { ...rule("shop.example"), stage2 } });
    const child = fakeContent(bg, {
      frameId: 3,
      url: "https://shop.example/frame",
      tabUrl: "https://shop.example/",
    });
    await child.send({ type: "saveRule", rule: rule("shop.example") });
    expect(await app.rules.list()).toEqual([]);
  });

  it("discardRule removes the sender's site's rule, and only that", async () => {
    const { bg, app } = started();
    await app.rules.put(rule("shop.example"));
    await app.rules.put(rule("other.example"));
    const top = fakeContent(bg, { url: "https://shop.example/" });
    expect(await top.send({ type: "discardRule", site: "other.example" })).toBeUndefined();
    expect(await app.rules.list()).toHaveLength(2);
    await top.send({ type: "discardRule", site: "shop.example" });
    expect(await app.rules.list()).toEqual([rule("other.example")]);
  });

  it("hello gives no rule to a child frame, a disabled site, or a sender with no tab", async () => {
    const { bg, app } = started();
    await app.rules.put(rule("shop.example"));
    const child = fakeContent(bg, {
      frameId: 3,
      url: "https://cmp.example/",
      tabUrl: "https://shop.example/",
    });
    expect((await child.send({ type: "hello" }))?.learnedRule).toBeUndefined();
    const popup = fakeContent(bg, { tabId: -1, frameId: -1, url: "https://shop.example/" });
    expect((await popup.send({ type: "hello" }))?.learnedRule).toBeUndefined();
    await saveSettings(bg.local, { ...DEFAULT_SETTINGS, disabledSites: ["shop.example"] });
    const top = fakeContent(bg, { url: "https://shop.example/" });
    expect((await top.send({ type: "hello" }))?.learnedRule).toBeUndefined();
  });

  it("keeps the rules in local storage, which survives a browser restart", async () => {
    const { bg } = started();
    await fakeContent(bg, { url: "https://shop.example/" }).send({
      type: "saveRule",
      rule: rule("shop.example"),
    });
    expect(await bg.local.get("learnedRules")).toEqual({ "shop.example": rule("shop.example") });
    expect(await bg.session.get("learnedRules")).toBeUndefined();
  });
});

describe("the message handler's contract with the platform", () => {
  const from = {
    tabId: 1,
    frameId: 0,
    documentId: "d1",
    url: "https://example.com/",
    tabUrl: "https://example.com/",
  };

  function handlerOf() {
    const bg = fakeBackground();
    let handler: Parameters<FakeBackground["onMessage"]>[0] | undefined;
    const register = bg.onMessage;
    bg.onMessage = (h) => {
      handler = h;
      register(h);
    };
    startBackground(bg, countingProvider().provider);
    if (!handler) throw new Error("no message handler registered");
    return handler;
  }

  it("returns undefined, not a promise, when there is nothing to wait for", () => {
    const handle = handlerOf();
    expect(handle({ type: "popupFound", cmp: "onetrust" }, from)).toBeUndefined();
  });

  it("returns a promise when there is a reply to wait for", async () => {
    const handle = handlerOf();
    for (const msg of [
      { type: "hello" },
      { type: "claim" },
      { type: "ai", op: "status", args: [] },
      // Stored before the reply, so a discard and a save sent in turn land in that order.
      { type: "saveRule", rule: {} },
      { type: "discardRule", site: "a.example" },
    ]) {
      const reply = handle(msg, from);
      expect(reply).toBeInstanceOf(Promise);
      await reply;
    }
  });
});

describe("tab removal", () => {
  it("forgets the tab's arbiter state, and only on removal", async () => {
    const { bg, app } = started();
    const forget = vi.spyOn(app.arbiter, "forget");
    const top = fakeContent(bg, { tabId: 3, documentId: "d1" });
    await top.send({ type: "hello" });
    await top.send({ type: "claim" });
    top.sender.documentId = "d2"; // navigation is not removal
    await top.send({ type: "hello" });
    expect(forget).not.toHaveBeenCalled();

    bg.removeTab(3);
    expect(forget).toHaveBeenCalledExactlyOnceWith(3);
    expect(await app.arbiter.owner(3)).toBe("none");
    expect(await bg.session.get("arb:3")).toBeUndefined();
  });

  it("logs a failure to forget instead of throwing", async () => {
    const { bg, app } = started();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(app.arbiter, "forget").mockRejectedValue(new Error("storage gone"));
    bg.removeTab(3);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
  });
});

describe("toolbar icon and install", () => {
  it("opens settings for the active tab's site", async () => {
    const { bg } = started();
    bg.clickAction({ url: "https://news.example.com/story?id=1" });
    expect(bg.openedWith).toEqual([{ page: "settings", query: { site: "news.example.com" } }]);
  });

  it("opens settings with no site when there is no usable URL", async () => {
    const { bg } = started();
    for (const url of [undefined, "", "not a url", "about:blank", "chrome://extensions/"]) {
      bg.clickAction({ url });
    }
    expect(bg.openedWith).toHaveLength(5);
    for (const call of bg.openedWith) expect(call).toEqual({ page: "settings", query: undefined });
  });

  it("opens onboarding on install, and on nothing else", async () => {
    const { bg } = started();
    bg.install("update");
    bg.install("chrome_update");
    expect(bg.opened).toEqual([]);
    bg.install("install");
    expect(bg.opened).toEqual(["onboarding"]);
    expect(bg.openedWith[0]?.query).toBeUndefined();
  });

  it("logs a failure to open a page instead of throwing", async () => {
    const { bg } = started();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    bg.openPage = () => Promise.reject(new Error("no tabs"));
    bg.install("install");
    bg.clickAction({ url: "https://a.example/" });
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
  });
});

describe("autoconsent messages", () => {
  const popupFound = { type: "popupFound", cmp: "onetrust", url: "https://example.com/" };
  const init = (url: string) => ({ type: "init", url }) as never;

  /** An autoconsent library that records what it is asked to filter. */
  function recordingLib() {
    const asked: { url: string; mainFrame: boolean }[] = [];
    const acLib: AcLib = {
      filterRules: async (url, mainFrame) => {
        asked.push({ url, mainFrame });
        return { rulesFor: url };
      },
    };
    return { acLib, asked };
  }

  it("reply at once and touch none of Bouncer's state when no autoconsent library is given", async () => {
    const { bg, app } = started();
    const top = fakeContent(bg, { documentId: "d1" });
    await top.send({ type: "hello" });
    const before = structuredClone(await bg.session.get("arb:1"));
    expect(await top.send(popupFound as never)).toBeUndefined();
    expect(await bg.session.get("arb:1")).toEqual(before);
    expect(await app.log.list()).toEqual([]);
    expect(app.autoconsent).toBeUndefined();
  });

  it("reach the autoconsent host with their sender: an init is answered in that frame", async () => {
    const { acLib, asked } = recordingLib();
    const { bg } = started({ acLib });
    const frame = fakeContent(bg, {
      tabId: 6,
      frameId: 2,
      documentId: "f",
      url: "https://x.test/",
      tabUrl: "https://page.test/",
    });
    expect(await frame.send(init("https://x.test/"))).toBeUndefined();
    await vi.waitFor(() => expect(frame.inbox).toHaveLength(1));
    expect(frame.inbox[0]).toMatchObject({
      type: "initResp",
      rules: { compact: { rulesFor: "https://x.test/" } },
      config: { enabled: true, autoAction: null },
    });
    expect(asked).toEqual([{ url: "https://x.test/", mainFrame: false }]);
  });

  it("share the one arbiter: autoconsent's popupFound makes Bouncer's own claim stand down", async () => {
    const { bg, app } = started(recordingLib());
    const top = fakeContent(bg, { tabId: 3, frameId: 0, documentId: "d1" });
    await top.send({ type: "hello" });
    await top.send(init("https://example.com/"));
    await top.send(popupFound as never);
    await vi.waitFor(() => expect(top.inbox.map((m) => m.type)).toContain("optOut"));
    expect(await top.send({ type: "claim" })).toEqual({ granted: false, reason: "autoconsent" });
    await vi.waitFor(async () =>
      expect(await app.log.list()).toMatchObject([{ path: "autoconsent", outcome: "working" }]),
    );
  });

  it("are not held up by a slow host: the reply comes at once", async () => {
    const { bg } = started({ acLib: { filterRules: () => new Promise(() => {}) } });
    expect(await fakeContent(bg).send(init("https://example.com/"))).toBeUndefined();
  });

  it("still reply when the host throws or rejects, and the failure is logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const { bg } = started({
      acLib: {
        filterRules: () => {
          if (n++ === 0) throw new Error("sync");
          return Promise.reject(new Error("async"));
        },
      },
    });
    const frame = fakeContent(bg);
    expect(await frame.send(init("https://example.com/"))).toBeUndefined();
    expect(await frame.send(init("https://example.com/"))).toBeUndefined();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
  });

  it("ignore messages that are neither Bouncer's nor autoconsent's", async () => {
    const error = vi.spyOn(console, "error");
    const { bg, app } = started(recordingLib());
    const frame = fakeContent(bg);
    for (const junk of [undefined, "hello", { type: "nope" }, { type: 7 }]) {
      expect(await frame.send(junk as never)).toBeUndefined();
    }
    await app.autoconsent?.idle();
    expect(frame.inbox).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it("a closed tab's autoconsent state is forgotten, and its pending opt-out ended", async () => {
    const { bg, app } = started(recordingLib());
    const top = fakeContent(bg, { tabId: 6, frameId: 0, documentId: "d1" });
    await top.send(init("https://example.com/"));
    await top.send(popupFound as never);
    await vi.waitFor(async () => expect(await bg.session.get("ac:6")).toBeDefined());
    bg.removeTab(6);
    await vi.waitFor(async () => expect(await bg.session.get("ac:6")).toBeUndefined());
    expect(await app.log.list()).toMatchObject([{ outcome: "failed", reason: "tab_closed" }]);
  });
});

describe("a failing message", () => {
  function brokenStorage(bg: FakeBackground) {
    vi.spyOn(bg.local, "get").mockRejectedValue(new Error("disk full"));
    vi.spyOn(bg.local, "set").mockRejectedValue(new Error("disk full"));
  }

  it("still gets a reply, so the content script's promise settles", async () => {
    const { bg } = started();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    brokenStorage(bg);
    const top = fakeContent(bg);
    expect(await top.send({ type: "hello" })).toBeUndefined();
    expect(await top.send({ type: "log", entry: entry("a.example") })).toBeUndefined();
    expect(await top.send({ type: "logPatch", id: "x", patch: {} })).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(3);
  });

  it("does not stop later messages from being served", async () => {
    const { bg } = started();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const get = vi.spyOn(bg.local, "get").mockRejectedValueOnce(new Error("blip"));
    const top = fakeContent(bg);
    expect(await top.send({ type: "hello" })).toBeUndefined();
    get.mockRestore();
    expect((await top.send({ type: "hello" }))?.enabled).toBe(true);
  });
});

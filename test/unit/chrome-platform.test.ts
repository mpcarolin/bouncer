import { readFileSync } from "node:fs";
import { evalSnippets, filterCompactRules, type IndexedCMPRuleset } from "@duckduckgo/autoconsent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiProvider } from "../../src/core/ai.ts";
import { startBackground } from "../../src/core/background-app.ts";
import { DEFAULT_SETTINGS } from "../../src/core/settings.ts";
import { chromeAcLib, chromeBackground } from "../../src/platform/chrome/background.ts";
import { chromeContent } from "../../src/platform/chrome/content.ts";
import { chromePage } from "../../src/platform/chrome/page.ts";
import { EXTENSION_ORIGIN, installFakeChrome } from "../helpers/fake-chrome.ts";

/** autoconsent's compact rules, as the build ships them. */
const raw = readFileSync("node_modules/@duckduckgo/autoconsent/rules/compact-rules.json", "utf8");
const rules = JSON.parse(raw) as IndexedCMPRuleset;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chromeBackground storage", () => {
  it("keeps local and session apart, returns undefined for a missing key, and removes", async () => {
    const fc = installFakeChrome();
    const bg = chromeBackground();
    expect(await bg.local.get("k")).toBeUndefined();
    await bg.local.set("k", { a: [1, 2] });
    await bg.session.set("k", "session value");
    expect(await bg.local.get("k")).toEqual({ a: [1, 2] });
    expect(await bg.session.get("k")).toBe("session value");
    expect(fc.local.keys()).toEqual(["k"]);
    await bg.local.remove("k");
    expect(await bg.local.get("k")).toBeUndefined();
    expect(await bg.session.get("k")).toBe("session value");
  });
});

describe("chromeBackground.onMessage", () => {
  it("also accepts the port autoconsent's content script opens on start, and leaves it open", () => {
    const fc = installFakeChrome();
    expect(fc.connect("instance-before").accepted).toBe(false);
    chromeBackground().onMessage(() => undefined);
    expect(fc.connect("instance-abc123")).toEqual({ accepted: true, disconnected: false });
  });

  it("hands the handler Chrome's sender as Bouncer's Sender, the frame's URL and the tab's apart", async () => {
    const fc = installFakeChrome();
    const seen: unknown[] = [];
    chromeBackground().onMessage((msg, from) => {
      seen.push({ msg, from });
      return undefined;
    });
    fc.deliver(
      { type: "hello" },
      {
        tab: { id: 7, url: "https://tab.example/" },
        frameId: 3,
        documentId: "doc-9",
        url: "https://frame.example/x",
      },
    );
    expect(seen).toEqual([
      {
        msg: { type: "hello" },
        from: {
          tabId: 7,
          frameId: 3,
          documentId: "doc-9",
          url: "https://frame.example/x",
          tabUrl: "https://tab.example/",
        },
      },
    ]);
  });

  it("gives a sender with no tab or frame tabId -1 and frameId -1, and its own URL as both", () => {
    const fc = installFakeChrome();
    const froms: unknown[] = [];
    chromeBackground().onMessage((_m, from) => {
      froms.push(from);
      return undefined;
    });
    fc.deliver({ type: "hello" }, { url: "chrome-extension://fake-extension-id/popup.html" });
    expect(froms).toEqual([
      {
        tabId: -1,
        frameId: -1,
        documentId: "",
        url: "chrome-extension://fake-extension-id/popup.html",
        tabUrl: "chrome-extension://fake-extension-id/popup.html",
      },
    ]);
  });

  it("falls back from the frame's URL to the tab's, and from the tab's to the frame's", () => {
    const fc = installFakeChrome();
    const urls: { url: string; tabUrl: string }[] = [];
    chromeBackground().onMessage((_m, from) => {
      urls.push({ url: from.url, tabUrl: from.tabUrl });
      return undefined;
    });
    fc.deliver({}, { tab: { id: 1, url: "https://tab.example/" }, frameId: 0 });
    fc.deliver({}, { tab: { id: 1 }, frameId: 0, url: "https://frame.example/" });
    fc.deliver({}, { tab: { id: 1 }, frameId: 0 });
    expect(urls).toEqual([
      { url: "https://tab.example/", tabUrl: "https://tab.example/" },
      { url: "https://frame.example/", tabUrl: "https://frame.example/" },
      { url: "", tabUrl: "" },
    ]);
  });

  it("replies at once and closes the channel when the handler returns undefined", async () => {
    const fc = installFakeChrome();
    chromeBackground().onMessage(() => undefined);
    const d = fc.deliver({ type: "x" });
    expect(d.repliedSync).toBe(true);
    expect(d.returned).not.toBe(true);
    expect(d.responses).toEqual([[]]);
    expect(await d.reply).toBeUndefined();
  });

  it("keeps the channel open and replies later when the handler returns a promise", async () => {
    const fc = installFakeChrome();
    chromeBackground().onMessage(async () => ({ granted: true }));
    const d = fc.deliver({ type: "claim" });
    expect(d.repliedSync).toBe(false);
    expect(d.returned).toBe(true);
    expect(await d.reply).toEqual({ granted: true });
    expect(d.responses).toEqual([[{ granted: true }]]);
  });

  it("still replies when the handler throws", async () => {
    const fc = installFakeChrome();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    chromeBackground().onMessage(() => {
      throw new Error("sync boom");
    });
    const d = fc.deliver({ type: "x" });
    expect(d.returned).not.toBe(true);
    expect(await d.reply).toBeUndefined();
    expect(d.responses).toEqual([[]]);
    expect(error).toHaveBeenCalledOnce();
  });

  it("still replies when the handler's promise rejects", async () => {
    const fc = installFakeChrome();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    chromeBackground().onMessage(() => Promise.reject(new Error("async boom")));
    const d = fc.deliver({ type: "x" });
    expect(d.returned).toBe(true);
    expect(await d.reply).toBeUndefined();
    expect(d.responses).toEqual([[]]);
    expect(error).toHaveBeenCalledOnce();
  });
});

describe("chromeBackground events and actions", () => {
  it("sendToFrame passes { frameId } and the message, and surfaces a missing receiver", async () => {
    const fc = installFakeChrome();
    const bg = chromeBackground();
    await bg.sendToFrame(5, 3, { type: "acDetected" });
    expect(fc.sent).toEqual([{ tabId: 5, msg: { type: "acDetected" }, options: { frameId: 3 } }]);
    fc.sendError = new Error("Could not establish connection. Receiving end does not exist.");
    await expect(bg.sendToFrame(5, 4, { type: "restoreAcStyles" })).rejects.toThrow(
      "Receiving end does not exist",
    );
  });

  it("sendToFrame with a documentId passes it beside the frameId", async () => {
    const fc = installFakeChrome();
    await chromeBackground().sendToFrame(5, 3, { type: "optOut" }, "doc-7");
    expect(fc.sent).toEqual([
      { tabId: 5, msg: { type: "optOut" }, options: { frameId: 3, documentId: "doc-7" } },
    ]);
  });

  it("onTabRemoved passes the tab id", () => {
    const fc = installFakeChrome();
    const removed: number[] = [];
    chromeBackground().onTabRemoved((id) => removed.push(id));
    fc.removeTab(12);
    expect(removed).toEqual([12]);
  });

  it("onActionClicked passes only the tab's url", () => {
    const fc = installFakeChrome();
    const tabs: unknown[] = [];
    chromeBackground().onActionClicked((tab) => tabs.push(tab));
    fc.clickAction({ id: 4, url: "https://a.test/page" });
    fc.clickAction({ id: 5 });
    expect(tabs).toEqual([{ url: "https://a.test/page" }, { url: undefined }]);
  });

  it("onInstalled passes the reason", () => {
    const fc = installFakeChrome();
    const reasons: string[] = [];
    chromeBackground().onInstalled((r) => reasons.push(r));
    fc.installed("install");
    fc.installed("update");
    expect(reasons).toEqual(["install", "update"]);
  });

  it("openPage opens the extension page in a new tab, with the query string", async () => {
    const fc = installFakeChrome();
    const bg = chromeBackground();
    await bg.openPage("onboarding");
    await bg.openPage("settings", { site: "news.example.com" });
    await bg.openPage("settings", { site: "a&b=c d", x: "é" });
    await bg.openPage("settings", {});
    expect(fc.created.map((c) => c.url)).toEqual([
      `${EXTENSION_ORIGIN}/onboarding.html`,
      `${EXTENSION_ORIGIN}/settings.html?site=news.example.com`,
      `${EXTENSION_ORIGIN}/settings.html?site=a%26b%3Dc+d&x=%C3%A9`,
      `${EXTENSION_ORIGIN}/settings.html`,
    ]);
    const params = new URL(fc.created[2]?.url ?? "").searchParams;
    expect(params.get("site")).toBe("a&b=c d");
  });

  it("runInMainWorld runs the snippet in the frame's main world and returns its result", async () => {
    const fc = installFakeChrome();
    fc.scriptResult = true;
    expect(await chromeBackground().runInMainWorld(8, 2, "EVAL_0")).toBe(true);
    expect(fc.scripts).toEqual([
      { target: { tabId: 8, frameIds: [2] }, world: "MAIN", func: evalSnippets.EVAL_0 },
    ]);
  });

  it("runInMainWorld returns undefined when the frame reports nothing, and rejects on an unknown snippet or a failed injection", async () => {
    const fc = installFakeChrome();
    const bg = chromeBackground();
    fc.scriptResults = [];
    expect(await bg.runInMainWorld(1, 0, "EVAL_0")).toBeUndefined();
    const before = fc.scripts.length;
    await expect(bg.runInMainWorld(1, 0, "NOT_A_SNIPPET")).rejects.toThrow("NOT_A_SNIPPET");
    expect(fc.scripts).toHaveLength(before);
    fc.scriptError = new Error("Cannot access contents of the page");
    await expect(bg.runInMainWorld(1, 0, "EVAL_0")).rejects.toThrow("Cannot access");
  });
});

describe("chromeAcLib", () => {
  const SHIPPED = `${EXTENSION_ORIGIN}/vendor/autoconsent/compact-rules.json`;

  /** Serves the extension's packaged files; `fail` makes the next reads fail. */
  function serveRules() {
    const reads: string[] = [];
    const served = { fail: 0, reads };
    vi.stubGlobal("fetch", async (url: string) => {
      reads.push(String(url));
      if (served.fail > 0) {
        served.fail--;
        return new Response("", { status: 404 });
      }
      return new Response(raw);
    });
    return served;
  }

  it("reads the rules shipped beside autoconsent's bundle once, and filters them per frame", async () => {
    installFakeChrome();
    const served = serveRules();
    const lib = chromeAcLib();
    const top = await lib.filterRules("https://www.example.com/", true);
    const frame = await lib.filterRules("https://cmp.example/", false);
    expect(served.reads).toEqual([SHIPPED]);
    expect(top).toEqual(
      filterCompactRules(rules, { url: "https://www.example.com/", mainFrame: true }),
    );
    expect(frame).toEqual(
      filterCompactRules(rules, { url: "https://cmp.example/", mainFrame: false }),
    );
    expect(top).not.toEqual(frame);
  });

  it("reads them again after a failed read, rather than failing every frame after it", async () => {
    installFakeChrome();
    const served = serveRules();
    served.fail = 1;
    const lib = chromeAcLib();
    await expect(lib.filterRules("https://a.example/", true)).rejects.toThrow("404");
    expect(await lib.filterRules("https://a.example/", true)).toEqual(
      filterCompactRules(rules, { url: "https://a.example/", mainFrame: true }),
    );
    expect(served.reads).toEqual([SHIPPED, SHIPPED]);
  });
});

describe("chromeContent", () => {
  it("send delivers the message to the background and resolves with its reply", async () => {
    const fc = installFakeChrome();
    chromeBackground().onMessage(async (msg) => ({ echoed: msg }));
    const reply = await chromeContent().send({ type: "claim" });
    expect(reply).toEqual({ echoed: { type: "claim" } });
    expect(fc.messages).toEqual([{ type: "claim" }]);
  });

  it("send rejects when nothing is listening, rather than hanging", async () => {
    installFakeChrome();
    await expect(chromeContent().send({ type: "hello" })).rejects.toThrow("Receiving end");
  });

  it("send rejects, not throws, when the extension context is gone", async () => {
    const fc = installFakeChrome();
    fc.chrome.runtime.sendMessage = () => {
      throw new Error("Extension context invalidated.");
    };
    const pending = chromeContent().send({ type: "hello" });
    await expect(pending).rejects.toThrow("Extension context invalidated");
  });

  it("onMessage passes Bouncer's messages and ignores everything else, and never claims the reply", () => {
    const fc = installFakeChrome();
    const got: unknown[] = [];
    chromeContent().onMessage((m) => got.push(m));
    const mine = fc.deliver({ type: "acOutcome", outcome: "dismissed" });
    const autoconsent = fc.deliver({ type: "initResp", rules: {}, config: {} });
    const junk = fc.deliver("not an object");
    expect(got).toEqual([{ type: "acOutcome", outcome: "dismissed" }]);
    for (const d of [mine, autoconsent, junk]) {
      // autoconsent's own listener shares this world; ours must not hold its channel open.
      expect(d.returned).not.toBe(true);
    }
  });
});

describe("chromePage", () => {
  it("reads the same local storage as the background", async () => {
    installFakeChrome();
    await chromeBackground().local.set("settings", { enabled: false });
    expect(await chromePage().local.get("settings")).toEqual({ enabled: false });
    await chromePage().local.set("settings", { enabled: true });
    expect(await chromeBackground().local.get("settings")).toEqual({ enabled: true });
  });

  it("send reaches the background, and openPage opens an extension page", async () => {
    const fc = installFakeChrome();
    chromeBackground().onMessage(async () => ({ state: "available", onDevice: true }));
    const page = chromePage();
    expect(await page.send({ type: "ai", op: "status", args: [] })).toEqual({
      state: "available",
      onDevice: true,
    });
    await page.openPage("settings", { site: "a.test" });
    expect(fc.created.map((c) => c.url)).toEqual([`${EXTENSION_ORIGIN}/settings.html?site=a.test`]);
  });
});

describe("the background over the Chrome adapters", () => {
  const provider: AiProvider = {
    status: async () => ({ state: "available", onDevice: true }),
    isConsentDialog: async () => ({
      kind: "answer",
      value: true,
      meta: { ms: 1, cold: false, onDevice: true },
    }),
    labelControls: async () => ({
      kind: "answer",
      value: {},
      meta: { ms: 1, cold: false, onDevice: true },
    }),
    corroborate: async () => ({
      kind: "answer",
      value: true,
      meta: { ms: 1, cold: false, onDevice: true },
    }),
  };

  it("registers every listener before startBackground returns", () => {
    const fc = installFakeChrome();
    startBackground(chromeBackground(), provider);
    expect(fc.listenerCounts()).toEqual({
      message: 1,
      connect: 1,
      tabRemoved: 1,
      action: 1,
      installed: 1,
    });
  });

  it("answers a content script's hello and claim through chrome.runtime", async () => {
    installFakeChrome();
    startBackground(chromeBackground(), provider);
    const content = chromeContent();
    expect(await content.send({ type: "claim" })).toEqual({ granted: false, reason: "stale" });
    const hello = await content.send({ type: "hello" });
    expect(hello).toMatchObject({ enabled: true, settings: DEFAULT_SETTINGS });
    expect(await content.send({ type: "claim" })).toEqual({ granted: true });
    expect(await content.send({ type: "claim" })).toEqual({ granted: false, reason: "already" });
  });

  it("opens onboarding on install and settings, for the active site, on a toolbar click", async () => {
    const fc = installFakeChrome();
    startBackground(chromeBackground(), provider);
    fc.installed("install");
    fc.clickAction({ url: "https://www.example.com/a" });
    await vi.waitFor(() => expect(fc.created).toHaveLength(2));
    expect(fc.created.map((c) => c.url)).toEqual([
      `${EXTENSION_ORIGIN}/onboarding.html`,
      `${EXTENSION_ORIGIN}/settings.html?site=www.example.com`,
    ]);
  });

  it("answers autoconsent's init in the sending frame, through tabs.sendMessage", async () => {
    const fc = installFakeChrome();
    vi.stubGlobal("fetch", async () => new Response(raw));
    startBackground(chromeBackground(), provider, { acLib: chromeAcLib() });
    const child = {
      tab: { id: 4, url: "https://www.example.com/" },
      frameId: 3,
      documentId: "c",
      url: "https://cmp.example/",
    };
    fc.deliver({ type: "init", url: "https://cmp.example/" }, child);
    await vi.waitFor(() => expect(fc.sent).toHaveLength(1));
    expect(fc.sent[0]).toMatchObject({
      tabId: 4,
      options: { frameId: 3 },
      msg: {
        type: "initResp",
        rules: {
          autoconsent: [],
          compact: filterCompactRules(rules, { url: "https://cmp.example/", mainFrame: false }),
        },
        config: { enabled: true, autoAction: null },
      },
    });
  });

  it("routes a tab closing to the arbiter", async () => {
    const fc = installFakeChrome();
    startBackground(chromeBackground(), provider);
    const content = chromeContent();
    await content.send({ type: "hello" });
    await content.send({ type: "claim" });
    expect(fc.session.keys()).toContain("arb:1");
    fc.removeTab(1);
    // The tab's state is gone, so its document is no longer on record.
    expect(await content.send({ type: "claim" })).toEqual({ granted: false, reason: "stale" });
    expect(fc.session.keys()).not.toContain("arb:1");
  });
});

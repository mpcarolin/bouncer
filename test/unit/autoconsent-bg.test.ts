import type { BackgroundMessage, Config, ContentScriptMessage } from "@duckduckgo/autoconsent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Arbiter } from "../../src/core/arbiter.ts";
import { type AcLib, AutoconsentHost, acConfig } from "../../src/core/autoconsent-bg.ts";
import { RULE_BADGE } from "../../src/core/badge.ts";
import { AC_OPTOUT_TIMEOUT_MS, PRERENDER_HOLDS_PER_TAB } from "../../src/core/config.ts";
import { DecisionLog, type LogEntry } from "../../src/core/log.ts";
import type {
  AcLifecycle,
  AcMessage,
  AutoconsentConfig,
  FrameMessage,
  ToAutoconsent,
} from "../../src/core/messages.ts";
import type { Sender } from "../../src/core/platform.ts";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type Settings,
  saveSettings,
} from "../../src/core/settings.ts";
import type { Clock } from "../../src/core/types.ts";
import {
  type FakeBackground,
  type FakeContent,
  fakeBackground,
  fakeContent,
} from "../helpers/fake-platform.ts";

// Compile-time checks (`pnpm check`): Bouncer's copy of autoconsent's protocol agrees with
// autoconsent's own types. Everything autoconsent sends is an `AcMessage`, everything Bouncer sends
// is a `BackgroundMessage`, and the config types are the same both ways.
const inbound = (m: ContentScriptMessage): AcMessage => m;
const outbound = (m: Exclude<ToAutoconsent, { type: "initResp" }>): BackgroundMessage => m;
const configIn = (c: Config): AutoconsentConfig => c;
const configOut = (c: AutoconsentConfig): Config => c;
void [inbound, outbound, configIn, configOut];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const TAB = 1;
const PAGE = "https://news.example/story";
const CMP_URL = "https://cmp.vendor.test/frame";

const init = (url: string): AcMessage => ({ type: "init", url });
const cmpDetected = (cmp = "onetrust"): AcMessage => ({ type: "cmpDetected", cmp, url: PAGE });
const popupFound = (cmp = "onetrust"): AcMessage => ({ type: "popupFound", cmp, url: PAGE });
const optOutResult = (result: boolean, scheduleSelfTest = false): AcMessage => ({
  type: "optOutResult",
  cmp: "onetrust",
  result,
  scheduleSelfTest,
  url: PAGE,
});
const selfTestResult = (result: boolean): AcMessage => ({
  type: "selfTestResult",
  cmp: "onetrust",
  result,
  url: PAGE,
});
/** Sent by autoconsent right after a successful `optOutResult`, unless the rule is intermediate. */
const autoconsentDone = (): AcMessage => ({
  type: "autoconsentDone",
  cmp: "onetrust",
  isCosmetic: false,
  url: PAGE,
  duration: 120,
  totalClicks: 1,
});
/**
 * The timers of one service-worker lifetime, over the (faked) global ones. `stop()` drops them
 * all, as Chrome does when it stops the worker; the time itself goes on.
 */
function workerClock() {
  const live = new Set<number>();
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = setTimeout(() => {
        live.delete(id);
        fn();
      }, ms) as unknown as number;
      live.add(id);
      return id;
    },
    clearTimeout(id) {
      live.delete(id);
      clearTimeout(id);
    },
  };
  const stop = () => {
    for (const id of live) clearTimeout(id);
    live.clear();
  };
  return { clock, stop };
}

const report = (lifecycle: AcLifecycle, detectedCmps: string[] = []): AcMessage => ({
  type: "report",
  instanceId: "instance",
  url: PAGE,
  mainFrame: true,
  state: { lifecycle, detectedCmps },
});

/**
 * One tab on PAGE: its top frame and a CMP's iframe (frame 2), each with autoconsent's and
 * Bouncer's content scripts. `inbox` on each frame holds everything the background sent it.
 */
class World {
  readonly bg: FakeBackground = fakeBackground();
  arb = new Arbiter(this.bg.session);
  log = new DecisionLog(this.bg.local);
  /** What the host asked the library to filter, in order. */
  readonly filtered: { url: string; mainFrame: boolean }[] = [];
  readonly lib: AcLib = {
    filterRules: async (url, mainFrame) => {
      this.filtered.push({ url, mainFrame });
      return { rulesFor: url };
    },
  };
  private worker = workerClock();
  host = this.start();
  readonly top = fakeContent(this.bg, { tabId: TAB, frameId: 0, documentId: "top-1", url: PAGE });
  readonly cmp = fakeContent(this.bg, {
    tabId: TAB,
    frameId: 2,
    documentId: "cmp-1",
    url: CMP_URL,
    tabUrl: PAGE,
  });

  start(): AutoconsentHost {
    return new AutoconsentHost(
      this.bg,
      this.arb,
      this.log,
      this.lib,
      () => loadSettings(this.bg.local),
      this.worker.clock,
    );
  }

  /** Delivers `msg` from `frame` (or as `as`, a sender override) and waits for all it set off. */
  async from(frame: FakeContent, msg: AcMessage, as: Partial<Sender> = {}): Promise<void> {
    await this.host.handle(msg, { ...frame.sender, ...as });
    await this.host.idle();
  }

  /** Both frames load: autoconsent's `init` from each. Their inboxes are then emptied. */
  async open(): Promise<void> {
    await this.from(this.top, init(PAGE));
    await this.from(this.cmp, init(CMP_URL));
    this.clearInboxes();
  }

  clearInboxes(): void {
    this.top.inbox.length = 0;
    this.cmp.inbox.length = 0;
  }

  /** Lets time pass, then waits for whatever the timers set off. */
  async wait(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await this.host.idle();
  }

  /**
   * The service worker is stopped, stays down for `downFor` ms, and starts again: its timers and
   * in-memory state are gone, `local` and `session` are kept.
   */
  async restart(downFor = 0, wakeBy?: [FakeContent, AcMessage]): Promise<void> {
    this.worker.stop();
    vi.advanceTimersByTime(downFor);
    this.worker = workerClock();
    this.bg.restart();
    this.arb = new Arbiter(this.bg.session);
    this.log = new DecisionLog(this.bg.local);
    this.host = this.start();
    // The message that woke the worker is handled in its first turn, before the recovery has read
    // the stored deadlines.
    const woken = wakeBy && this.host.handle(wakeBy[1], { ...wakeBy[0].sender });
    await woken;
    await this.host.ready;
    await this.host.idle();
  }

  /** What was sent, delivered or not, as [type, frameId, documentId], minus the given types. */
  sends(...except: FrameMessage["type"][]) {
    return this.bg.frameSends
      .filter((x) => !except.includes(x.msg.type))
      .map((x) => [x.msg.type, x.frameId, x.documentId]);
  }

  async setSettings(s: Partial<Settings>): Promise<void> {
    await saveSettings(this.bg.local, { ...DEFAULT_SETTINGS, ...s });
  }

  async entry(): Promise<LogEntry> {
    const all = await this.log.list();
    expect(all).toHaveLength(1);
    return all[0] as LogEntry;
  }
}

const types = (f: FakeContent) => f.inbox.map((m) => m.type);
const count = (f: FakeContent, type: FrameMessage["type"]) =>
  f.inbox.filter((m) => m.type === type).length;

describe("acConfig", () => {
  it("config is pinned", () => {
    expect(acConfig(true)).toMatchObject({
      autoAction: null,
      enablePrehide: true,
      enablePopupMutationObserver: true,
      heuristicMode: "off",
      enableCosmeticRules: false,
      enableGeneratedRules: true,
    });
    expect(acConfig(true)).toMatchObject({
      enabled: true,
      detectRetries: 20,
      prehideTimeout: 2000,
    });
    const logsOn = Object.entries(acConfig(true).logs).filter(([, on]) => on);
    expect(logsOn).toEqual([["errors", true]]);
    expect(acConfig(false)).toEqual({ ...acConfig(true), enabled: false });
  });
});

describe("init", () => {
  it("answers that frame alone, with the rules filtered for it and the config", async () => {
    const w = new World();
    await w.from(w.top, init(PAGE));
    await w.from(w.cmp, init(CMP_URL));
    expect(w.top.inbox).toEqual([
      {
        type: "initResp",
        rules: { autoconsent: [], compact: { rulesFor: PAGE } },
        config: acConfig(true),
      },
    ]);
    expect(w.cmp.inbox).toEqual([
      {
        type: "initResp",
        rules: { autoconsent: [], compact: { rulesFor: CMP_URL } },
        config: acConfig(true),
      },
    ]);
    expect(w.filtered).toEqual([
      { url: PAGE, mainFrame: true },
      { url: CMP_URL, mainFrame: false },
    ]);
  });

  it("disabled site → enabled:false in initResp", async () => {
    // Review Focus 5: the site's own frames and its CMP iframe (served from elsewhere) alike.
    const w = new World();
    await w.setSettings({ disabledSites: ["news.example"] });
    await w.from(w.top, init(PAGE));
    await w.from(w.cmp, init(CMP_URL));
    for (const frame of [w.top, w.cmp]) {
      expect(frame.inbox).toEqual([
        { type: "initResp", rules: { autoconsent: [] }, config: acConfig(false) },
      ]);
    }
    expect(w.filtered).toEqual([]);

    const off = new World();
    await off.setSettings({ enabled: false });
    await off.from(off.cmp, init(CMP_URL));
    expect(off.cmp.inbox).toEqual([
      { type: "initResp", rules: { autoconsent: [] }, config: acConfig(false) },
    ]);
  });

  it("from the top frame records the page with the arbiter, so an old page's claim is gone", async () => {
    const w = new World();
    await w.arb.topDocument(TAB, "old-page");
    await w.arb.claimForBouncer(TAB, "old-page");
    await w.open();
    expect(await w.arb.owner(TAB)).toBe("none");
    await w.from(w.cmp, popupFound());
    expect(types(w.cmp)).toEqual(["optOut"]);
  });
});

describe("eval", () => {
  it("runs the named snippet in that document's main world and answers with its result", async () => {
    const w = new World();
    w.bg.mainWorldResult = () => true;
    await w.from(w.cmp, { type: "eval", id: "e1", code: "…", snippetId: "EVAL_0" });
    expect(w.bg.mainWorldCalls).toEqual([{ tabId: TAB, documentId: "cmp-1", snippetId: "EVAL_0" }]);
    expect(w.cmp.inbox).toEqual([{ type: "evalResp", id: "e1", result: true }]);
    expect(w.top.inbox).toEqual([]);
  });

  it("a replaced document's late eval never runs in the document that replaced it", async () => {
    const w = new World();
    await w.open();
    w.bg.mainWorldResult = () => true;
    w.cmp.sender.documentId = "cmp-2"; // the iframe loaded another document
    await w.from(
      w.cmp,
      { type: "eval", id: "e1", code: "…", snippetId: "EVAL_0" },
      {
        documentId: "cmp-1",
      },
    );
    expect(w.bg.mainWorldCalls).toEqual([{ tabId: TAB, documentId: "cmp-1", snippetId: "EVAL_0" }]);
    expect(w.cmp.inbox).toEqual([]);
  });

  it("answers false when the snippet can't run, and never runs code that names no snippet", async () => {
    const w = new World();
    w.bg.runInMainWorld = () => Promise.reject(new Error("Cannot access contents of the page"));
    await w.from(w.cmp, { type: "eval", id: "e1", code: "…", snippetId: "EVAL_0" });
    await w.from(w.cmp, { type: "eval", id: "e2", code: "return document.cookie" });
    expect(w.cmp.inbox).toEqual([
      { type: "evalResp", id: "e1", result: false },
      { type: "evalResp", id: "e2", result: false },
    ]);
  });
});

describe("cmpDetected", () => {
  it("from the top frame gives the page to autoconsent and tells the top frame", async () => {
    const w = new World();
    await w.open();
    await w.from(w.top, cmpDetected());
    expect(await w.arb.owner(TAB)).toBe("autoconsent");
    expect(w.top.inbox).toEqual([{ type: "acDetected" }]);
  });

  it("from a child frame changes nothing and sends nothing", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, cmpDetected());
    expect(await w.arb.owner(TAB)).toBe("none");
    expect([...w.top.inbox, ...w.cmp.inbox]).toEqual([]);
  });
});

describe("popupFound", () => {
  it("popupFound → optOut to the sending frame only", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound("onetrust"));
    expect(w.cmp.inbox).toEqual([{ type: "optOut" }]);
    expect(w.top.inbox).toEqual([{ type: "acPopupFound" }]);
    expect(await w.arb.owner(TAB)).toBe("autoconsent");
    expect(await w.entry()).toMatchObject({
      path: "autoconsent",
      rule: "onetrust",
      site: "news.example",
      url: PAGE,
      at: Date.now(),
      t: { found: Date.now() },
      outcome: "working",
      notes: [],
    });
  });

  it("popupFound after bouncer claim → no optOut, note logged", async () => {
    const w = new World();
    await w.open();
    expect(await w.arb.claimForBouncer(TAB, "top-1")).toEqual({ granted: true });
    await w.from(w.cmp, popupFound("onetrust"));
    expect([...w.top.inbox, ...w.cmp.inbox]).toEqual([]);
    expect(await w.entry()).toMatchObject({
      path: "autoconsent",
      rule: "onetrust",
      outcome: "deferred",
      notes: ["popupFound after bouncer claim"],
    });
    // No opt-out, so no deadline either.
    await w.wait(AC_OPTOUT_TIMEOUT_MS * 2);
    expect((await w.entry()).outcome).toBe("deferred");
    expect([...w.top.inbox, ...w.cmp.inbox]).toEqual([]);
  });

  it("a second popupFound from the same document is not a second opt-out", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound("onetrust"));
    await w.from(w.cmp, popupFound("another-rule"));
    expect(count(w.cmp, "optOut")).toBe(1);
    expect((await w.entry()).rule).toBe("onetrust");
  });

  it("never opts out on a site switched off since the page loaded", async () => {
    const w = new World();
    await w.open();
    await w.setSettings({ disabledSites: ["news.example"] });
    await w.from(w.cmp, popupFound());
    expect([...w.top.inbox, ...w.cmp.inbox]).toEqual([]);
    expect(await w.log.list()).toEqual([]);
  });
});

describe("outcomes", () => {
  it("self-test pass → dismissed; no self-test → dismissed_unverified", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.from(w.cmp, optOutResult(true, true));
    await w.from(w.cmp, autoconsentDone());
    expect(w.cmp.inbox).toEqual([{ type: "optOut" }, { type: "selfTest" }]);
    expect((await w.entry()).outcome).toBe("working");
    await w.from(w.cmp, selfTestResult(true));
    expect(await w.entry()).toMatchObject({
      outcome: "dismissed",
      verification: "self_test_passed",
    });
    expect(w.top.inbox).toEqual([
      { type: "acPopupFound" },
      { type: "acOutcome", outcome: "dismissed" },
    ]);

    const u = new World();
    await u.open();
    await u.from(u.top, popupFound());
    await u.from(u.top, optOutResult(true, false));
    await u.from(u.top, autoconsentDone());
    expect(await u.entry()).toMatchObject({
      outcome: "dismissed_unverified",
      verification: "no_self_test",
    });
    expect(u.top.inbox).toEqual([
      { type: "optOut" },
      { type: "acPopupFound" },
      { type: "acOutcome", outcome: "dismissed_unverified" },
    ]);

    // Both ended: their deadlines are cleared, and nothing was put back.
    for (const x of [w, u]) {
      await x.wait(AC_OPTOUT_TIMEOUT_MS * 2);
      expect((await x.entry()).outcome).not.toBe("failed");
      expect(count(x.top, "restoreAcStyles") + count(x.cmp, "restoreAcStyles")).toBe(0);
    }
  });

  it("a false result or a failed self-test is failed, and the frame's styles are put back once", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.from(w.cmp, optOutResult(false));
    expect(await w.entry()).toMatchObject({ outcome: "failed", reason: "opt_out_failed" });
    expect(w.cmp.inbox).toEqual([{ type: "optOut" }, { type: "restoreAcStyles" }]);
    expect(w.top.inbox).toEqual([
      { type: "acPopupFound" },
      { type: "acOutcome", outcome: "failed" },
    ]);
    // The opt-out is over, so autoconsent hides nothing more: no watching, no second restore.
    await w.from(w.cmp, report("optOutFailed", ["onetrust"]));
    expect(count(w.cmp, "restoreAcStyles")).toBe(1);

    const s = new World();
    await s.open();
    await s.from(s.cmp, popupFound());
    await s.from(s.cmp, optOutResult(true, true));
    await s.from(s.cmp, autoconsentDone());
    await s.from(s.cmp, selfTestResult(false));
    expect(await s.entry()).toMatchObject({ outcome: "failed", reason: "self_test_failed" });
    expect(count(s.cmp, "restoreAcStyles")).toBe(1);
    expect(s.top.inbox).toContainEqual({ type: "acOutcome", outcome: "failed" });
  });

  it("with keep_hidden, a failure leaves autoconsent's styles alone", async () => {
    const w = new World();
    await w.setSettings({ onFailed: "keep_hidden" });
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.wait(AC_OPTOUT_TIMEOUT_MS);
    await w.from(w.cmp, report("optOutFailed", ["onetrust"]));
    expect((await w.entry()).outcome).toBe("failed");
    expect(count(w.cmp, "restoreAcStyles") + count(w.top, "restoreAcStyles")).toBe(0);
  });

  it("timeout → failed, restoreAcStyles to that frame, then late success → dismissed_late", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.wait(AC_OPTOUT_TIMEOUT_MS - 1);
    expect((await w.entry()).outcome).toBe("working");
    expect(count(w.cmp, "restoreAcStyles")).toBe(0);

    await w.wait(1);
    expect(await w.entry()).toMatchObject({ outcome: "failed", reason: "opt_out_timeout" });
    expect(w.cmp.inbox).toEqual([{ type: "optOut" }, { type: "restoreAcStyles" }]);
    expect(w.top.inbox).toEqual([
      { type: "acPopupFound" },
      { type: "acOutcome", outcome: "failed" },
    ]);

    await w.from(w.cmp, optOutResult(true));
    // The result alone isn't the end of the opt-out: autoconsentDone is.
    expect((await w.entry()).outcome).toBe("failed");
    await w.from(w.cmp, autoconsentDone());
    expect(await w.entry()).toMatchObject({ outcome: "dismissed_late" });
    expect(w.top.inbox.at(-1)).toEqual({ type: "acOutcome", outcome: "dismissed_late" });
    // A success: what autoconsent hid stays hidden.
    await w.from(w.cmp, report("done", ["onetrust"]));
    expect(count(w.cmp, "restoreAcStyles")).toBe(1);
  });

  it("after restore, a later hide (report runningOptOut→optOutFailed) triggers a second restore", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.wait(AC_OPTOUT_TIMEOUT_MS);
    expect(count(w.cmp, "restoreAcStyles")).toBe(1);
    await w.from(w.cmp, report("runningOptOut", ["onetrust"]));
    expect(count(w.cmp, "restoreAcStyles")).toBe(1);
    await w.from(w.cmp, report("optOutFailed", ["onetrust"]));
    expect(count(w.cmp, "restoreAcStyles")).toBe(2);
    // The opt-out has ended: the watch is over.
    await w.from(w.cmp, report("optOutFailed", ["onetrust"]));
    expect(count(w.cmp, "restoreAcStyles")).toBe(2);
    expect(count(w.top, "restoreAcStyles")).toBe(0);
    expect((await w.entry()).outcome).toBe("failed");
  });

  it("a self-test that never answers leaves the opt-out unverified, and nothing is put back", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.wait(AC_OPTOUT_TIMEOUT_MS - 1);
    // The self-test gets a deadline of its own, from the moment it is asked for.
    await w.from(w.cmp, optOutResult(true, true));
    await w.from(w.cmp, autoconsentDone());
    await w.wait(AC_OPTOUT_TIMEOUT_MS - 1);
    expect((await w.entry()).outcome).toBe("working");
    await w.wait(1);
    expect(await w.entry()).toMatchObject({
      outcome: "dismissed_unverified",
      verification: "self_test_unanswered",
    });
    expect(count(w.cmp, "restoreAcStyles")).toBe(0);
    expect(w.top.inbox.at(-1)).toEqual({ type: "acOutcome", outcome: "dismissed_unverified" });
  });
});

describe("the toolbar badge", () => {
  const marks = (w: World) => w.bg.badgeCalls.filter((c) => c.badge !== null);

  it("marks the tab as handled by a rule when autoconsent's opt-out succeeds, from any frame", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.from(w.cmp, optOutResult(true, true));
    await w.from(w.cmp, autoconsentDone());
    expect(marks(w)).toEqual([]); // not before the self-test says so
    await w.from(w.cmp, selfTestResult(true));
    expect(marks(w)).toEqual([{ tabId: TAB, badge: RULE_BADGE }]);

    const u = new World();
    await u.open();
    await u.from(u.top, popupFound());
    await u.from(u.top, optOutResult(true, false));
    await u.from(u.top, autoconsentDone());
    expect(marks(u)).toEqual([{ tabId: TAB, badge: RULE_BADGE }]);
  });

  it("marks a late success, and nothing for a failure", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.wait(AC_OPTOUT_TIMEOUT_MS);
    expect((await w.entry()).outcome).toBe("failed");
    expect(marks(w)).toEqual([]);
    await w.from(w.cmp, optOutResult(true));
    await w.from(w.cmp, autoconsentDone());
    expect(marks(w)).toEqual([{ tabId: TAB, badge: RULE_BADGE }]);

    const f = new World();
    await f.open();
    await f.from(f.cmp, popupFound());
    await f.from(f.cmp, optOutResult(false));
    expect(marks(f)).toEqual([]);
  });

  it("a mark that can't be set fails nothing: the outcome is still sent and logged", async () => {
    const w = new World();
    w.bg.setBadge = () => Promise.reject(new Error("No tab with id: 1"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await w.open();
    await w.from(w.top, popupFound());
    await w.from(w.top, optOutResult(true, false));
    await w.from(w.top, autoconsentDone());
    expect((await w.entry()).outcome).toBe("dismissed_unverified");
    expect(w.top.inbox.at(-1)).toEqual({ type: "acOutcome", outcome: "dismissed_unverified" });
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
  });
});

describe("the order autoconsent finishes in", () => {
  it("selfTest goes out on autoconsentDone, not on optOutResult", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.from(w.cmp, optOutResult(true, true));
    expect(w.cmp.inbox).toEqual([{ type: "optOut" }]);
    expect((await w.entry()).outcome).toBe("working");
    await w.from(w.cmp, autoconsentDone());
    expect(w.cmp.inbox).toEqual([{ type: "optOut" }, { type: "selfTest" }]);
    await w.from(w.cmp, selfTestResult(true));
    expect(await w.entry()).toMatchObject({
      outcome: "dismissed",
      verification: "self_test_passed",
    });
  });

  it("an intermediate stage (optOutSucceeded in place of autoconsentDone) is failed at once: no selfTest, styles put back", async () => {
    const w = new World();
    await w.open();
    await w.from(w.top, popupFound("TrustArc-top"));
    await w.from(w.top, optOutResult(true, true));
    await w.from(w.top, report("optOutSucceeded", ["TrustArc-top"]));
    expect(await w.entry()).toMatchObject({
      rule: "TrustArc-top",
      outcome: "failed",
      reason: "opt_out_unfinished",
    });
    expect(types(w.top)).toEqual(["optOut", "acPopupFound", "restoreAcStyles", "acOutcome"]);
    // Nothing was left waiting: no self-test, no second put-back, no timeout.
    await w.wait(AC_OPTOUT_TIMEOUT_MS * 2);
    expect(count(w.top, "selfTest")).toBe(0);
    expect(count(w.top, "restoreAcStyles")).toBe(1);
    expect((await w.entry()).reason).toBe("opt_out_unfinished");
  });

  it("a success that never says done is failed at the opt-out's deadline; a late done is dismissed_late", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.wait(1_000);
    await w.from(w.cmp, optOutResult(true, true));
    // The deadline is the one set at popupFound: a result that isn't the end doesn't extend it.
    await w.wait(AC_OPTOUT_TIMEOUT_MS - 1_000 - 1);
    expect((await w.entry()).outcome).toBe("working");
    await w.wait(1);
    expect(await w.entry()).toMatchObject({ outcome: "failed", reason: "opt_out_timeout" });
    expect(count(w.cmp, "selfTest")).toBe(0);
    expect(count(w.cmp, "restoreAcStyles")).toBe(1);
    await w.from(w.cmp, autoconsentDone());
    expect((await w.entry()).outcome).toBe("dismissed_late");
    expect(count(w.cmp, "selfTest")).toBe(0);
  });
});

describe("a restarted service worker", () => {
  it("restart mid opt-out: new host instance still times out from the stored deadline", async () => {
    // Review Focus 2.
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.wait(10_000);
    await w.restart();
    await w.wait(AC_OPTOUT_TIMEOUT_MS - 10_000 - 1);
    expect((await w.entry()).outcome).toBe("working");
    await w.wait(1);
    expect(await w.entry()).toMatchObject({ outcome: "failed", reason: "opt_out_timeout" });
    expect(w.cmp.inbox).toEqual([{ type: "optOut" }, { type: "restoreAcStyles" }]);
    // ...and still watches for autoconsent hiding again.
    await w.from(w.cmp, report("optOutFailed", ["onetrust"]));
    expect(count(w.cmp, "restoreAcStyles")).toBe(2);
  });

  it("ends a deadline that passed while it was down at once, and a result arriving then is late", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.restart(AC_OPTOUT_TIMEOUT_MS + 5_000);
    expect(await w.entry()).toMatchObject({ outcome: "failed", reason: "opt_out_timeout" });
    expect(count(w.cmp, "restoreAcStyles")).toBe(1);
    await w.from(w.cmp, optOutResult(true));
    await w.from(w.cmp, autoconsentDone());
    expect((await w.entry()).outcome).toBe("dismissed_late");
  });

  it("ends an expired deadline on the tab's next message, even with no record of it pending", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    await w.bg.session.remove("ac:pending");
    await w.restart(AC_OPTOUT_TIMEOUT_MS + 1);
    expect((await w.entry()).outcome).toBe("working");
    await w.from(w.cmp, optOutResult(true));
    await w.from(w.cmp, autoconsentDone());
    // The deadline had passed before the result came: failed first, then late.
    expect((await w.entry()).outcome).toBe("dismissed_late");
    expect(w.top.inbox).toContainEqual({ type: "acOutcome", outcome: "failed" });
  });
});

describe("documents", () => {
  it("ignores a message from the top frame's previous document", async () => {
    const w = new World();
    await w.open();
    w.top.sender.documentId = "top-2"; // the tab navigated
    await w.from(w.top, init(PAGE));
    w.clearInboxes();
    await w.from(w.top, popupFound(), { documentId: "top-1" }); // late, from the old page
    await w.from(w.top, cmpDetected(), { documentId: "top-1" });
    expect(w.top.inbox).toEqual([]);
    expect(await w.arb.owner(TAB)).toBe("none");
    expect(await w.log.list()).toEqual([]);
  });

  it("a new page mid opt-out: the old one is failed, and nothing reaches the new page", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    w.clearInboxes();
    w.top.sender.documentId = "top-2";
    await w.from(w.top, init(PAGE));
    expect(await w.entry()).toMatchObject({ outcome: "failed", reason: "navigation" });
    expect(types(w.top)).toEqual(["initResp"]);
    expect(w.cmp.inbox).toEqual([]);
    // Its deadline went with it.
    await w.wait(AC_OPTOUT_TIMEOUT_MS * 2);
    expect(types(w.top)).toEqual(["initResp"]);
    expect(w.cmp.inbox).toEqual([]);
    expect(await w.bg.session.get("ac:pending")).toEqual([]);
  });

  it("an iframe that loads a new document mid opt-out ends that opt-out the same way", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    w.clearInboxes();
    w.cmp.sender.documentId = "cmp-2";
    await w.from(w.cmp, init(CMP_URL));
    expect(await w.entry()).toMatchObject({ outcome: "failed", reason: "navigation" });
    expect(types(w.cmp)).toEqual(["initResp"]);
    // The old document's late result is not the new one's.
    await w.from(w.cmp, optOutResult(true), { documentId: "cmp-1" });
    expect((await w.entry()).outcome).toBe("failed");
    // The new document may opt out on its own.
    await w.from(w.cmp, popupFound());
    expect(types(w.cmp)).toEqual(["initResp", "optOut"]);
  });
});

describe("detection ended", () => {
  it("top-frame nothingDetected → acDetectionEnded to frame 0", async () => {
    const w = new World();
    await w.open();
    await w.from(w.top, report("started"));
    await w.from(w.cmp, report("nothingDetected"));
    expect([...w.top.inbox, ...w.cmp.inbox]).toEqual([]);
    await w.from(w.top, report("nothingDetected"));
    expect(w.top.inbox).toEqual([{ type: "acDetectionEnded" }]);
    expect(w.cmp.inbox).toEqual([]);
  });

  it("also on done with no CMP detected, but not once a CMP has been", async () => {
    const w = new World();
    await w.open();
    await w.from(w.top, report("done", ["onetrust"]));
    await w.from(w.top, report("nothingDetected", ["onetrust"]));
    expect(w.top.inbox).toEqual([]);
    await w.from(w.top, report("done"));
    expect(w.top.inbox).toEqual([{ type: "acDetectionEnded" }]);
  });
});

describe("sends bound to a document", () => {
  it("a deadline that fires after the page was replaced without an init (bfcache) reaches only the old page", async () => {
    const w = new World();
    await w.open();
    await w.from(w.top, popupFound());
    w.clearInboxes();
    w.bg.frameSends.length = 0;
    w.top.sender.documentId = "top-restored"; // back/forward: a cached page, which sends no init
    await w.wait(AC_OPTOUT_TIMEOUT_MS);
    expect(await w.entry()).toMatchObject({ outcome: "failed", reason: "opt_out_timeout" });
    expect(w.sends()).toEqual([
      ["restoreAcStyles", 0, "top-1"],
      ["acOutcome", 0, "top-1"],
    ]);
    expect(w.top.inbox).toEqual([]); // not for the restored page
  });

  it("a reloaded page's init, waking a worker after the deadline, ends the old opt-out as navigation and sends the new page nothing", async () => {
    const w = new World();
    await w.open();
    await w.from(w.top, popupFound());
    w.clearInboxes();
    w.bg.frameSends.length = 0;
    w.top.sender.documentId = "top-2";
    await w.restart(AC_OPTOUT_TIMEOUT_MS + 1, [w.top, init(PAGE)]);
    expect(await w.entry()).toMatchObject({ outcome: "failed", reason: "navigation" });
    expect(w.sends()).toEqual([["initResp", 0, "top-2"]]);
    expect(types(w.top)).toEqual(["initResp"]);
    expect(await w.bg.session.get("ac:pending")).toEqual([]);
  });

  it("every reply and notice names the document it is for", async () => {
    const w = new World();
    await w.open();
    await w.from(w.top, cmpDetected());
    await w.from(w.cmp, popupFound());
    await w.from(w.cmp, optOutResult(true, true));
    await w.from(w.cmp, autoconsentDone());
    await w.from(w.cmp, selfTestResult(true));
    expect(w.sends()).toEqual([
      ["initResp", 0, "top-1"],
      ["initResp", 2, "cmp-1"],
      ["acDetected", 0, "top-1"],
      ["optOut", 2, "cmp-1"],
      ["acPopupFound", 0, "top-1"],
      ["selfTest", 2, "cmp-1"],
      ["acOutcome", 0, "top-1"],
    ]);
  });
});

describe("the page the host and the arbiter mean", () => {
  it("a popupFound for a page the arbiter has moved on from is ignored", async () => {
    const w = new World();
    await w.open();
    // The tab moved on, and Bouncer's hello for the new page has reached the arbiter, but
    // autoconsent's init has not yet reached the host. Then the old page's late messages arrive.
    w.top.sender.documentId = "top-2";
    await w.arb.topDocument(TAB, "top-2");
    await w.from(w.cmp, popupFound());
    await w.from(w.top, cmpDetected(), { documentId: "top-1" });
    expect([...w.top.inbox, ...w.cmp.inbox]).toEqual([]);
    expect(await w.arb.owner(TAB)).toBe("none");
    expect(await w.log.list()).toEqual([]);
  });

  it("ignores messages from a frame with no recorded document, such as the previous page's iframe", async () => {
    const w = new World();
    await w.open();
    w.top.sender.documentId = "top-2";
    await w.from(w.top, init(PAGE)); // the old page's frames are no longer on record
    w.clearInboxes();
    await w.from(w.cmp, popupFound()); // late, from the old page's iframe
    const stranger = fakeContent(w.bg, { tabId: TAB, frameId: 7, documentId: "x", tabUrl: PAGE });
    await w.from(stranger, popupFound()); // never sent an init
    expect([...w.top.inbox, ...w.cmp.inbox, ...stranger.inbox]).toEqual([]);
    expect(await w.arb.owner(TAB)).toBe("none");
    expect(await w.log.list()).toEqual([]);
  });

  it("a refused popupFound is logged once per document", async () => {
    const w = new World();
    await w.open();
    await w.arb.claimForBouncer(TAB, "top-1");
    await w.from(w.cmp, popupFound("onetrust"));
    await w.from(w.cmp, popupFound("another-rule"));
    expect((await w.entry()).notes).toEqual(["popupFound after bouncer claim"]);
  });
});

describe("failures of its own", () => {
  it("records the opt-out before sending optOut: if it can't, nothing is sent", async () => {
    const w = new World();
    await w.open();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const set = w.bg.session.set.bind(w.bg.session);
    vi.spyOn(w.bg.session, "set").mockImplementation((k, v) =>
      k.startsWith("ac:") ? Promise.reject(new Error("quota")) : set(k, v),
    );
    await expect(w.host.handle(popupFound(), { ...w.cmp.sender })).rejects.toThrow("quota");
    await w.host.idle();
    expect(w.cmp.inbox).toEqual([]);
  });

  it("a log or settings store that fails doesn't hold back the put-back", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(w.bg.local, "get").mockRejectedValue(new Error("disk"));
    vi.spyOn(w.bg.local, "set").mockRejectedValue(new Error("disk"));
    await w.from(w.cmp, optOutResult(false));
    expect(w.cmp.inbox).toEqual([{ type: "optOut" }, { type: "restoreAcStyles" }]);
    expect(w.top.inbox.at(-1)).toEqual({ type: "acOutcome", outcome: "failed" });
    expect(error).toHaveBeenCalled();
  });

  it("progress reports queue no work", async () => {
    const w = new World();
    await w.open();
    const get = vi.spyOn(w.bg.session, "get");
    for (const l of ["started", "cmpDetected", "openPopupDetected", "runningOptOut"] as const) {
      await w.from(w.top, report(l, ["onetrust"]));
    }
    expect(get).not.toHaveBeenCalled();
    await w.from(w.top, report("nothingDetected"));
    expect(get).toHaveBeenCalled();
  });
});

describe("prerendered pages", () => {
  const NEXT = "https://next.example/article";
  const NEXT_WIDGET = "https://next.example/widget";

  /**
   * The shown page (PAGE) prerenders NEXT unseen: its top frame (frame 5 while it waits; frame 0
   * once shown) and a same-origin iframe (frame 6). Chrome reports the tab's URL as the shown page's.
   */
  function prerender(w: World) {
    const top = fakeContent(w.bg, {
      tabId: TAB,
      frameId: 5,
      documentId: "pre-top",
      documentLifecycle: "prerender",
      url: NEXT,
      tabUrl: PAGE,
    });
    const widget = fakeContent(w.bg, {
      tabId: TAB,
      frameId: 6,
      documentId: "pre-widget",
      documentLifecycle: "prerender",
      url: NEXT_WIDGET,
      tabUrl: PAGE,
    });
    /** The tab shows NEXT: the same documents, its top now frame 0, all of them active. */
    const activate = () => {
      top.sender = { ...top.sender, frameId: 0, documentLifecycle: "active", tabUrl: NEXT };
      widget.sender = { ...widget.sender, documentLifecycle: "active", tabUrl: NEXT };
      // The shown page's documents are gone from the tab.
      w.bg.contents.delete(w.top);
      w.bg.contents.delete(w.cmp);
    };
    return { top, widget, activate };
  }

  /** Bouncer's hello from `frame`, which its content script sends once the page is shown. */
  async function shown(w: World, frame: FakeContent): Promise<void> {
    await w.host.shown({ ...frame.sender });
    await w.host.idle();
  }

  it("a prerendered document's init gets no reply, and the shown page's record is untouched", async () => {
    const w = new World();
    await w.open();
    w.bg.frameSends.length = 0;
    const next = prerender(w);
    await w.from(next.top, init(NEXT));
    await w.from(next.widget, init(NEXT_WIDGET));
    expect(w.sends()).toEqual([]);
    expect(w.filtered).toEqual([
      { url: PAGE, mainFrame: true },
      { url: CMP_URL, mainFrame: false },
    ]);
    expect(await w.bg.session.get(`ac:${TAB}`)).toEqual({
      frames: { 0: { documentId: "top-1" }, 2: { documentId: "cmp-1" } },
    });
  });

  it("is released by the hello from its top frame, as the page the tab shows, judged by its own site", async () => {
    const w = new World();
    // The shown page's site is switched off, the prerendered one's isn't.
    await w.setSettings({ disabledSites: ["news.example"] });
    await w.open();
    const next = prerender(w);
    await w.from(next.top, init(NEXT));
    await w.from(next.widget, init(NEXT_WIDGET));
    w.bg.frameSends.length = 0;
    next.activate();
    await shown(w, next.top);
    expect(w.sends()).toEqual([
      ["initResp", 0, "pre-top"],
      ["initResp", 6, "pre-widget"],
    ]);
    expect(next.top.inbox).toEqual([
      {
        type: "initResp",
        rules: { autoconsent: [], compact: { rulesFor: NEXT } },
        config: acConfig(true),
      },
    ]);
    expect(next.widget.inbox).toEqual([
      {
        type: "initResp",
        rules: { autoconsent: [], compact: { rulesFor: NEXT_WIDGET } },
        config: acConfig(true),
      },
    ]);
    expect(w.filtered.slice(-2)).toEqual([
      { url: NEXT, mainFrame: true },
      { url: NEXT_WIDGET, mainFrame: false },
    ]);
    // The shown page's frames are gone from the record, and the new page's are on it.
    expect(await w.bg.session.get(`ac:${TAB}`)).toEqual({
      frames: { 0: { documentId: "pre-top" }, 6: { documentId: "pre-widget" } },
    });
    // autoconsent works there as on any page: from frame 0 under the document's own id.
    await w.from(next.top, cmpDetected());
    expect(await w.arb.owner(TAB)).toBe("autoconsent");
    await w.from(next.widget, popupFound());
    expect(next.widget.inbox.at(-1)).toEqual({ type: "optOut" });
    expect(next.top.inbox.at(-1)).toEqual({ type: "acPopupFound" });
    expect(await w.entry()).toMatchObject({ site: "next.example", url: NEXT, outcome: "working" });
  });

  it("its release ends the shown page's opt-out as navigation", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    const next = prerender(w);
    await w.from(next.top, init(NEXT));
    next.activate();
    await shown(w, next.top);
    expect(await w.entry()).toMatchObject({
      site: "news.example",
      outcome: "failed",
      reason: "navigation",
    });
    expect(await w.bg.session.get("ac:pending")).toEqual([]);
  });

  it("a popupFound from the shown page while a prerender is held behaves as before", async () => {
    const w = new World();
    await w.open();
    const next = prerender(w);
    await w.from(next.top, init(NEXT));
    await w.from(next.widget, init(NEXT_WIDGET));
    await w.from(w.cmp, popupFound());
    expect(w.cmp.inbox).toEqual([{ type: "optOut" }]);
    expect(w.top.inbox).toEqual([{ type: "acPopupFound" }]);
    expect(await w.arb.owner(TAB)).toBe("autoconsent");
    expect(await w.entry()).toMatchObject({ site: "news.example", url: PAGE, outcome: "working" });
    expect([...next.top.inbox, ...next.widget.inbox]).toEqual([]);
  });

  it("nothing but its held initResp goes to a prerendered document: no optOut, no claim, no eval", async () => {
    const w = new World();
    await w.open();
    w.bg.frameSends.length = 0;
    const next = prerender(w);
    await w.from(next.top, init(NEXT));
    await w.from(next.widget, init(NEXT_WIDGET));
    // Out of order, as no autoconsent instance sends them before its initResp.
    await w.from(next.top, cmpDetected());
    await w.from(next.widget, popupFound());
    await w.from(next.top, popupFound());
    await w.from(next.widget, { type: "eval", id: "e1", code: "…", snippetId: "EVAL_0" });
    expect(w.sends()).toEqual([]);
    expect(w.bg.mainWorldCalls).toEqual([]);
    expect(await w.arb.owner(TAB)).toBe("none");
    expect(await w.log.list()).toEqual([]);
  });

  it("the shown page's own hello leaves the hold in place", async () => {
    const w = new World();
    await w.open();
    const next = prerender(w);
    await w.from(next.top, init(NEXT));
    await shown(w, w.top);
    next.activate();
    await shown(w, next.top);
    expect(types(next.top)).toEqual(["initResp"]);
  });

  it("is dropped when another page says hello in the tab: that prerender was discarded", async () => {
    const w = new World();
    await w.open();
    const next = prerender(w);
    await w.from(next.top, init(NEXT));
    await w.from(next.widget, init(NEXT_WIDGET));
    // The user went elsewhere: a new page, not the prerendered one.
    w.top.sender.documentId = "top-2";
    await shown(w, w.top);
    w.bg.frameSends.length = 0;
    next.activate();
    await shown(w, next.top);
    expect(w.sends()).toEqual([]);
  });

  it("is dropped when another page loads in the tab and autoconsent's init comes before its hello", async () => {
    const w = new World();
    await w.open();
    const next = prerender(w);
    await w.from(next.top, init(NEXT));
    await w.from(next.widget, init(NEXT_WIDGET));
    // The user went elsewhere, and the new page's autoconsent says init before Bouncer's hello.
    w.top.sender.documentId = "top-2";
    await w.from(w.top, init(PAGE));
    await shown(w, w.top);
    w.bg.frameSends.length = 0;
    next.activate();
    await shown(w, next.top);
    expect(w.sends()).toEqual([]);
  });

  it("is dropped when the tab closes", async () => {
    const w = new World();
    await w.open();
    const next = prerender(w);
    await w.from(next.top, init(NEXT));
    await w.host.forget(TAB);
    next.activate();
    await shown(w, next.top);
    expect(w.sends("initResp")).toEqual([]);
    expect(types(next.top)).toEqual([]);
  });

  it(`holds at most ${PRERENDER_HOLDS_PER_TAB} per tab, dropping the oldest`, async () => {
    const w = new World();
    await w.open();
    const next = prerender(w);
    await w.from(next.top, init(NEXT)); // the oldest
    const frames = Array.from({ length: PRERENDER_HOLDS_PER_TAB }, (_, i) =>
      fakeContent(w.bg, {
        tabId: TAB,
        frameId: 10 + i,
        documentId: `pre-frame-${i}`,
        documentLifecycle: "prerender",
        url: NEXT_WIDGET,
        tabUrl: PAGE,
      }),
    );
    for (const f of frames) await w.from(f, init(NEXT_WIDGET));
    w.bg.frameSends.length = 0;
    next.activate();
    const newest = frames.at(-1) as FakeContent;
    newest.sender = { ...newest.sender, frameId: 0, documentLifecycle: "active", tabUrl: NEXT };
    await shown(w, newest);
    // The newest and the rest it held, but not the oldest, which was dropped.
    const docs = frames.map((f) => f.sender.documentId);
    expect(w.sends().map(([, , documentId]) => documentId)).toEqual([
      docs.at(-1),
      ...docs.slice(0, -1),
    ]);
  });
});

describe("forget", () => {
  it("ends a pending opt-out and drops the tab's state", async () => {
    const w = new World();
    await w.open();
    await w.from(w.cmp, popupFound());
    w.clearInboxes();
    await w.host.forget(TAB);
    expect(await w.entry()).toMatchObject({ outcome: "failed", reason: "tab_closed" });
    expect(await w.bg.session.get(`ac:${TAB}`)).toBeUndefined();
    expect(await w.bg.session.get("ac:pending")).toEqual([]);
    await w.wait(AC_OPTOUT_TIMEOUT_MS * 2);
    expect([...w.top.inbox, ...w.cmp.inbox]).toEqual([]);
  });
});

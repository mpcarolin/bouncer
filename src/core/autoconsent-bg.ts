import type { Arbiter } from "./arbiter.ts";
import { AC_OPTOUT_TIMEOUT_MS } from "./config.ts";
import type { DecisionLog, LogEntry } from "./log.ts";
import type { AcMessage, AutoconsentConfig, FrameMessage } from "./messages.ts";
import type { BackgroundPlatform, Sender } from "./platform.ts";
import { enabledFor, type Settings, siteOf } from "./settings.ts";
import type { Clock, Outcome } from "./types.ts";

/**
 * The parts of autoconsent's library the background needs, built by the browser side so the core
 * never imports autoconsent. `BackgroundPlatform.runInMainWorld` looks up its eval snippets.
 */
export interface AcLib {
  /** autoconsent's compact rules filtered for one frame (`filterCompactRules`). */
  filterRules(url: string, mainFrame: boolean): Promise<unknown>;
}

/**
 * The config in every `initResp` (§1). `autoAction` is always null: autoconsent only detects, and
 * opts out when the background, as the page's one arbiter, sends `optOut`.
 */
export function acConfig(enabled: boolean): AutoconsentConfig {
  return {
    enabled,
    autoAction: null,
    disabledCmps: [],
    enablePrehide: true,
    enableCosmeticRules: false,
    enableGeneratedRules: true,
    detectRetries: 20,
    isMainWorld: false,
    prehideTimeout: 2000,
    enableHeuristicDetection: false,
    enablePopupMutationObserver: true,
    visualTest: false,
    logs: {
      lifecycle: false,
      rulesteps: false,
      detectionsteps: false,
      evals: false,
      errors: true,
      messages: false,
      waits: false,
    },
    performanceLoggingEnabled: false,
    heuristicPopupSearchTimeout: 0,
    heuristicMode: "off",
  };
}

/**
 * - `optingOut`: `optOut` sent, waiting for `optOutResult` until the deadline.
 * - `selfTesting`: opted out, `selfTest` sent, waiting for its result until a fresh deadline.
 * - `timedOut`: the deadline passed first. Logged `failed`, but a late success still counts.
 * - `ended`: the outcome is final.
 */
type Phase = "optingOut" | "selfTesting" | "timedOut" | "ended";

interface OptOut {
  entryId: string;
  phase: Phase;
  /** Epoch ms, from the injected clock. Set only while `optingOut` or `selfTesting`. */
  deadline?: number;
  /** autoconsent's styles were put back while its opt-out still ran: it may hide again. */
  watching?: boolean;
}

interface FrameState {
  documentId: string;
  /** autoconsent opts out at most once per document. */
  optOut?: OptOut;
}

/**
 * One tab, under `ac:<tabId>` in session storage, so a restarted service worker carries on:
 * each frame's current document (recorded at its `init`) and that document's opt-out.
 */
interface TabState {
  frames: Record<number, FrameState>;
}

const tabKey = (tabId: number) => `ac:${tabId}`;
/** The tabs whose state holds a deadline, so a restarted worker can find them. */
const PENDING = "ac:pending";

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
};

function report(what: string, e: unknown): void {
  console.error(`bouncer: ${what}`, e);
}

const hasDeadline = (tab: TabState) =>
  Object.values(tab.frames).some((f) => f.optOut?.deadline !== undefined);

const frames = (tab: TabState) =>
  Object.entries(tab.frames).map(([id, f]) => [Number(id), f] as const);

/** The page the frame is on: a child frame (a CMP's iframe) is judged by the tab's site. */
const pageUrl = (from: Sender) => from.tabUrl || from.url;

/**
 * The background half of autoconsent's protocol (§1), behind the arbiter (§2b). autoconsent's
 * content script runs unmodified in every frame; this answers it in the frame that asked.
 *
 * Each tab's steps run one at a time, over state kept in `p.session` (never in memory), and each
 * step first ends any opt-out whose deadline has passed. Timers only wake a step at a deadline, so
 * one lost with a stopped worker costs nothing: a new host re-arms the stored deadlines (`ready`),
 * and the tab's next message ends an expired one in any case.
 *
 * Messages from a document that is no longer its frame's current one are ignored. A child frame
 * that has sent nothing since the top frame's last `init` has no recorded document, so a late
 * message from the previous page's child frame can't be told apart and is treated as current.
 */
export class AutoconsentHost {
  private readonly chains = new Map<number, Promise<unknown>>();
  private pendingChain: Promise<unknown> = Promise.resolve();
  /** In-memory wake-ups for stored deadlines, by `${tabId}:${frameId}`. */
  private readonly timers = new Map<string, number>();
  /** Settles once the deadlines stored by an earlier worker are re-armed or ended. */
  readonly ready: Promise<void>;

  constructor(
    private readonly p: BackgroundPlatform,
    private readonly arb: Arbiter,
    private readonly log: DecisionLog,
    private readonly lib: AcLib,
    private readonly settings: () => Promise<Settings>,
    private readonly clock: Clock = realClock,
  ) {
    this.ready = this.recover().catch((e) => report("failed to recover autoconsent deadlines", e));
  }

  async handle(msg: AcMessage, from: Sender): Promise<void> {
    if (from.tabId < 0) return; // not a page
    switch (msg.type) {
      case "eval":
        // Not queued behind the tab's other steps: autoconsent waits only a second for it.
        return this.evaluate(msg.id, msg.snippetId, from);
      case "init":
        // The page's bookkeeping is queued; the answer, which needs no state, goes out at once.
        await Promise.all([
          this.withTab(from.tabId, (tab) => this.newDocument(from, tab)),
          this.answerInit(msg.url, from),
        ]);
        return;
      default:
        return this.withTab(from.tabId, (tab) => this.step(msg, from, tab));
    }
  }

  /** The tab closed: its pending opt-outs end, and its state goes. */
  forget(tabId: number): Promise<void> {
    return this.serial(tabId, async () => {
      const tab = await this.load(tabId);
      await this.endFrames(tabId, tab, "tab_closed");
      await this.setPending(tabId, false);
      await this.p.session.remove(tabKey(tabId));
    });
  }

  /** Settles once no step is queued for any tab. For tests. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all(this.chains.values());
  }

  // --- steps ---

  private async step(msg: AcMessage, from: Sender, tab: TabState): Promise<void> {
    const frame = tab.frames[from.frameId];
    // Sent by a document its frame has since replaced.
    if (frame && frame.documentId !== from.documentId) return;
    switch (msg.type) {
      case "cmpDetected":
        if (from.frameId !== 0) return; // a child frame's CMP doesn't stop Bouncer's top-frame path
        await this.arb.cmpDetected(from.tabId, 0);
        this.send(from.tabId, 0, { type: "acDetected" });
        return;
      case "popupFound":
        return this.popupFound(msg.cmp, from, tab);
      case "optOutResult":
        return this.optOutResult(msg.result === true, msg.scheduleSelfTest === true, from, frame);
      case "selfTestResult":
        return this.selfTestResult(msg.result === true, from, frame);
      case "report":
        return this.report(msg.state, from, frame);
      default:
        // visualDelay, optInResult, autoconsentDone, autoconsentError: nothing to do.
        return;
    }
  }

  private async evaluate(id: string, snippetId: string | undefined, from: Sender): Promise<void> {
    let result: unknown = false;
    // Only autoconsent's own snippets run: the code in the message is never used.
    if (snippetId) {
      try {
        result = await this.p.runInMainWorld(from.tabId, from.frameId, snippetId);
      } catch {
        result = false;
      }
    }
    this.send(from.tabId, from.frameId, { type: "evalResp", id, result });
  }

  private async answerInit(url: string, from: Sender): Promise<void> {
    const enabled = enabledFor(await this.settings(), pageUrl(from));
    // A disabled autoconsent reads no rules, so none are filtered or sent.
    const rules = enabled
      ? {
          autoconsent: [] as [],
          compact: await this.lib.filterRules(from.url || url, from.frameId === 0),
        }
      : { autoconsent: [] as [] };
    this.send(from.tabId, from.frameId, { type: "initResp", rules, config: acConfig(enabled) });
  }

  /**
   * autoconsent's `init` opens each document's exchange. (Its constructor sends a `loading` report
   * just before, which `step` drops as coming from a document not yet recorded for the frame.)
   */
  private async newDocument(from: Sender, tab: TabState): Promise<void> {
    const { tabId, frameId, documentId } = from;
    const prev = tab.frames[frameId];
    if (prev?.documentId !== documentId) {
      if (frameId === 0) {
        // A new page: every frame of the old one has gone with it.
        await this.endFrames(tabId, tab, "navigation");
        tab.frames = {};
      } else if (prev) {
        await this.endFrame(tabId, frameId, prev, "navigation");
      }
      tab.frames[frameId] = { documentId };
    }
    // Records the page before autoconsent can claim it, whichever of Bouncer's `hello` and this
    // arrives first. Idempotent for the same document.
    if (frameId === 0) await this.arb.topDocument(tabId, documentId);
  }

  private async popupFound(cmp: string, from: Sender, tab: TabState): Promise<void> {
    const { tabId, frameId, documentId } = from;
    // A second matching rule in the same document: autoconsent opts out once, for the first.
    if (tab.frames[frameId]?.optOut) return;
    // Switched off since the page loaded: never opt out.
    if (!enabledFor(await this.settings(), pageUrl(from))) return;
    const now = this.clock.now();
    const { sendOptOut } = await this.arb.popupFound(tabId, frameId);
    if (!sendOptOut) {
      await this.log.add(
        this.entry(from, cmp, now, {
          outcome: "deferred",
          notes: ["popupFound after bouncer claim"],
        }),
      );
      return;
    }
    this.send(tabId, frameId, { type: "optOut" });
    this.send(tabId, 0, { type: "acPopupFound" });
    const entryId = await this.log.add(
      this.entry(from, cmp, now, { outcome: "working", t: { found: now } }),
    );
    const deadline = now + AC_OPTOUT_TIMEOUT_MS;
    tab.frames[frameId] = { documentId, optOut: { entryId, phase: "optingOut", deadline } };
    this.arm(tabId, frameId, deadline);
  }

  private async optOutResult(
    ok: boolean,
    scheduleSelfTest: boolean,
    from: Sender,
    frame: FrameState | undefined,
  ): Promise<void> {
    const o = frame?.optOut;
    if (!o) return;
    const { tabId, frameId } = from;
    const now = this.clock.now();
    if (o.phase === "optingOut") {
      if (!ok) return this.fail(tabId, frameId, o, "opt_out_failed", false);
      if (!scheduleSelfTest) {
        return this.succeed(tabId, frameId, o, "dismissed_unverified", {
          verification: "no_self_test",
          t: { gone: now },
        });
      }
      o.phase = "selfTesting";
      o.deadline = now + AC_OPTOUT_TIMEOUT_MS;
      this.arm(tabId, frameId, o.deadline);
      this.send(tabId, frameId, { type: "selfTest" });
      await this.log.patch(o.entryId, { t: { gone: now } });
      return;
    }
    if (o.phase === "timedOut" && ok) {
      // It finished after all. What it hid stays hidden.
      o.watching = false;
      return this.succeed(tabId, frameId, o, "dismissed_late", { t: { gone: now } });
    }
    // A late failure: the put-back already happened, and the `report` watch handles any re-hide.
  }

  private async selfTestResult(
    ok: boolean,
    from: Sender,
    frame: FrameState | undefined,
  ): Promise<void> {
    const o = frame?.optOut;
    if (o?.phase !== "selfTesting") return;
    if (ok) {
      return this.succeed(from.tabId, from.frameId, o, "dismissed", {
        verification: "self_test_passed",
      });
    }
    return this.fail(from.tabId, from.frameId, o, "self_test_failed", false);
  }

  private async report(
    state: Extract<AcMessage, { type: "report" }>["state"] | undefined,
    from: Sender,
    frame: FrameState | undefined,
  ): Promise<void> {
    const lifecycle = state?.lifecycle;
    const ended = lifecycle === "nothingDetected" || lifecycle === "done";
    if (from.frameId === 0 && ended && (state?.detectedCmps ?? []).length === 0) {
      // Bouncer's own path may stop waiting for autoconsent (§2b).
      this.send(from.tabId, 0, { type: "acDetectionEnded" });
    }
    const o = frame?.optOut;
    if (!o?.watching) return;
    if (lifecycle === "optOutFailed") {
      // The opt-out ended without success, after autoconsent's `hide` steps may have run again.
      o.watching = false;
      this.send(from.tabId, from.frameId, { type: "restoreAcStyles" });
    } else if (lifecycle === "done" || lifecycle === "optOutSucceeded") {
      o.watching = false;
    }
  }

  // --- outcomes ---

  private async succeed(
    tabId: number,
    frameId: number,
    o: OptOut,
    outcome: Outcome,
    patch: Partial<LogEntry>,
  ): Promise<void> {
    this.stop(tabId, frameId, o, "ended");
    await this.log.patch(o.entryId, { outcome, ...patch });
    this.send(tabId, 0, { type: "acOutcome", outcome });
  }

  /**
   * Logs `failed` and, if the user wants it put back, removes autoconsent's styles in the frame.
   * `stillRunning`: autoconsent may yet finish (a timeout), so a late result still counts and its
   * `report`s are watched for a re-hide.
   */
  private async fail(
    tabId: number,
    frameId: number,
    o: OptOut,
    reason: string,
    stillRunning: boolean,
  ): Promise<void> {
    this.stop(tabId, frameId, o, stillRunning ? "timedOut" : "ended");
    await this.log.patch(o.entryId, { outcome: "failed", reason });
    this.send(tabId, 0, { type: "acOutcome", outcome: "failed" });
    if ((await this.settings()).onFailed !== "restore") return;
    this.send(tabId, frameId, { type: "restoreAcStyles" });
    o.watching = stillRunning;
  }

  /** The deadline passed (§1, "Bouncer's own opt-out timeout"). */
  private timeOut(tabId: number, frameId: number, o: OptOut): Promise<void> {
    if (o.phase === "selfTesting") {
      // The opt-out succeeded; only its check never answered.
      return this.succeed(tabId, frameId, o, "dismissed_unverified", {
        verification: "self_test_unanswered",
      });
    }
    return this.fail(tabId, frameId, o, "opt_out_timeout", true);
  }

  /**
   * The frame's document is gone (`reason`: navigation, tab_closed). Its outcome is logged, but
   * nothing is sent: whatever is in that frame now is another document.
   */
  private async endFrame(
    tabId: number,
    frameId: number,
    frame: FrameState,
    reason: string,
  ): Promise<void> {
    const o = frame.optOut;
    if (!o) return;
    const phase = o.phase;
    this.stop(tabId, frameId, o, "ended");
    o.watching = false;
    if (phase === "optingOut") {
      await this.log.patch(o.entryId, { outcome: "failed", reason });
    } else if (phase === "selfTesting") {
      await this.log.patch(o.entryId, {
        outcome: "dismissed_unverified",
        verification: "self_test_unanswered",
      });
    }
  }

  private async endFrames(tabId: number, tab: TabState, reason: string): Promise<void> {
    for (const [frameId, frame] of frames(tab)) await this.endFrame(tabId, frameId, frame, reason);
  }

  private stop(tabId: number, frameId: number, o: OptOut, phase: Phase): void {
    this.disarm(tabId, frameId);
    delete o.deadline;
    o.phase = phase;
  }

  // --- deadlines ---

  private arm(tabId: number, frameId: number, deadline: number): void {
    this.disarm(tabId, frameId);
    const k = `${tabId}:${frameId}`;
    const ms = Math.max(0, deadline - this.clock.now());
    const id = this.clock.setTimeout(() => {
      this.timers.delete(k);
      // The timer stands for the deadline, so it ends the opt-out even if the clock reads a hair
      // early. A deadline moved since then would have re-armed (and so cleared) this timer.
      this.withTab(tabId, async (tab) => {
        const o = tab.frames[frameId]?.optOut;
        if (o?.deadline !== undefined) await this.timeOut(tabId, frameId, o);
      }).catch((e) => report(`failed to end the opt-out in tab ${tabId}`, e));
    }, ms);
    this.timers.set(k, id);
  }

  private disarm(tabId: number, frameId: number): void {
    const k = `${tabId}:${frameId}`;
    const id = this.timers.get(k);
    if (id === undefined) return;
    this.clock.clearTimeout(id);
    this.timers.delete(k);
  }

  /** Ends the tab's expired opt-outs, and arms a timer for any deadline that has none here. */
  private async settleDeadlines(tabId: number, tab: TabState): Promise<void> {
    for (const [frameId, frame] of frames(tab)) {
      const o = frame.optOut;
      if (o?.deadline === undefined) continue;
      if (o.deadline <= this.clock.now()) await this.timeOut(tabId, frameId, o);
      else if (!this.timers.has(`${tabId}:${frameId}`)) this.arm(tabId, frameId, o.deadline);
    }
  }

  private async recover(): Promise<void> {
    const tabs = (await this.p.session.get<number[]>(PENDING)) ?? [];
    await Promise.all(
      tabs.map((tabId) =>
        this.withTab(tabId, async (tab) => {
          // Listed but holding none (a worker stopped between the two writes): unlist it.
          if (!hasDeadline(tab)) await this.setPending(tabId, false);
        }),
      ),
    );
  }

  // --- state ---

  /** Runs `fn` on the tab's state as one serialised step, after settling its deadlines. */
  private withTab(tabId: number, fn: (tab: TabState) => Promise<void>): Promise<void> {
    return this.serial(tabId, async () => {
      const tab = await this.load(tabId);
      const before = JSON.stringify(tab);
      const wasPending = hasDeadline(tab);
      await this.settleDeadlines(tabId, tab);
      await fn(tab);
      if (JSON.stringify(tab) === before) return;
      const pending = hasDeadline(tab);
      // The index first: a worker stopped between the writes leaves at most a stale listing.
      if (pending !== wasPending) await this.setPending(tabId, pending);
      await this.p.session.set(tabKey(tabId), tab);
    });
  }

  private async load(tabId: number): Promise<TabState> {
    return (await this.p.session.get<TabState>(tabKey(tabId))) ?? { frames: {} };
  }

  /** Runs `fn` after every earlier step for this tab has settled; a rejection blocks none. */
  private serial<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(tabId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(tabId, tail);
    void tail.then(() => {
      if (this.chains.get(tabId) === tail) this.chains.delete(tabId);
    });
    return run;
  }

  private setPending(tabId: number, on: boolean): Promise<void> {
    const run = this.pendingChain.then(async () => {
      const tabs = (await this.p.session.get<number[]>(PENDING)) ?? [];
      if (tabs.includes(tabId) === on) return;
      await this.p.session.set(PENDING, on ? [...tabs, tabId] : tabs.filter((t) => t !== tabId));
    });
    this.pendingChain = run.catch(() => undefined);
    return run;
  }

  // --- helpers ---

  /**
   * Not awaited: autoconsent's listener answers `optOut` and `selfTest` only once it has acted.
   * A frame with no receiver (gone, or never given Bouncer's script) is not an error here.
   */
  private send(tabId: number, frameId: number, msg: FrameMessage): void {
    this.p.sendToFrame(tabId, frameId, msg).catch(() => {});
  }

  private entry(
    from: Sender,
    cmp: string,
    at: number,
    over: Pick<LogEntry, "outcome"> & Partial<LogEntry>,
  ): Omit<LogEntry, "id"> {
    const url = pageUrl(from);
    return {
      at,
      site: siteOf(url),
      url,
      path: "autoconsent",
      rule: cmp,
      clicked: [],
      toggles: [],
      t: {},
      modelCalls: [],
      notes: [],
      ...over,
    };
  }
}

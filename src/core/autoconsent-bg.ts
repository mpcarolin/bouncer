import type { Arbiter } from "./arbiter.ts";
import { badgeFor } from "./badge.ts";
import { AC_OPTOUT_TIMEOUT_MS, PRERENDER_HOLDS_PER_TAB } from "./config.ts";
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
 * - `finishing`: `optOutResult` succeeded; waiting, under the same deadline, for the document's
 *   `autoconsentDone`, which says the rule's opt-out is complete.
 * - `selfTesting`: opted out, `selfTest` sent, waiting for its result until a fresh deadline.
 * - `timedOut`: the deadline passed first. Logged `failed`, but a late success still counts.
 * - `ended`: the outcome is final.
 */
type Phase = "optingOut" | "finishing" | "selfTesting" | "timedOut" | "ended";

interface OptOut {
  /** The log entry; absent if it couldn't be written. */
  entryId?: string;
  phase: Phase;
  /** Epoch ms, from the injected clock. Set only while `optingOut`, `finishing` or `selfTesting`. */
  deadline?: number;
  /** `optOutResult` asked for a self-test: it is sent on `autoconsentDone`. */
  selfTest?: true;
  /** autoconsent's styles were put back while its opt-out still ran: it may hide again. */
  watching?: boolean;
}

interface FrameState {
  documentId: string;
  /** autoconsent opts out at most once per document. */
  optOut?: OptOut;
  /** The arbiter refused this document's opt-out (Bouncer owns the page); logged once. */
  refused?: true;
}

/**
 * One tab, under `ac:<tabId>` in session storage, so a restarted service worker carries on:
 * each frame's current document (recorded at its `init`) and that document's opt-out.
 */
interface TabState {
  frames: Record<number, FrameState>;
}

/** A prerendered document's `init`, not yet answered: `url` is the one autoconsent sent. */
interface Held {
  from: Sender;
  url: string;
}

/** One serialised step over a tab: its state, and what of it is in storage. */
interface Step {
  tabId: number;
  tab: TabState;
  /** The stored state, as JSON, to tell whether a write is needed. */
  stored: string;
  /** Whether the tab is listed under `PENDING`. */
  listed: boolean;
}

const tabKey = (tabId: number) => `ac:${tabId}`;
/** The tabs whose state holds a deadline, so a restarted worker can find them. */
const PENDING = "ac:pending";

/**
 * The `report` lifecycles that matter here: the end of detection (§2b) and the end of an opt-out
 * (the re-hide watch). The rest are progress, dropped before they cost a storage read.
 */
const NOTABLE_REPORTS = new Set<string>([
  "nothingDetected",
  "done",
  "optOutFailed",
  "optOutSucceeded",
]);

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
 * Every autoconsent instance sends `init` before anything else, and that records its frame's
 * document. A message from any other document (one since replaced, or a previous page's frame)
 * is ignored. Everything sent names the document it is for, so a message meant for a replaced
 * document (a timer firing after the page changed) never reaches its successor.
 *
 * A prerendered page is not the one the user is on, and its frames' ids aren't the ones they will
 * have: its top frame becomes frame 0 only once shown. So a prerendered document's `init` is held,
 * unanswered, and autoconsent there does nothing. Bouncer's `hello`, which its content script
 * sends once the page is shown, releases it (`shown`).
 */
export class AutoconsentHost {
  private readonly chains = new Map<number, Promise<unknown>>();
  private pendingChain: Promise<unknown> = Promise.resolve();
  /** In-memory wake-ups for stored deadlines, by `${tabId}:${frameId}`. */
  private readonly timers = new Map<string, number>();
  /**
   * Prerendered documents' inits by tab, oldest first. Kept in memory only: a worker stopped while
   * a page is prerendered forgets them, and autoconsent, never answered, stays idle on that one
   * page. That is safe, and Bouncer's own path, which waits for the page to be shown, still runs.
   */
  private readonly held = new Map<number, Held[]>();
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
    if (from.documentLifecycle === "prerender") {
      // Its init waits for the page to be shown, and nothing else comes from autoconsent before
      // that is answered: nothing from a prerendered document is acted on or replied to.
      if (msg.type === "init") this.hold(msg.url, from);
      return;
    }
    if (msg.type === "eval") {
      // Not queued behind the tab's other steps: autoconsent waits only a second for it.
      return this.evaluate(msg.id, msg.snippetId, from);
    }
    if (msg.type === "init") {
      // A new page in the tab that isn't a shown prerender (whose init came while it was one): any
      // prerenders held were discarded or replaced. Its init may come before Bouncer's hello.
      if (from.frameId === 0) this.held.delete(from.tabId);
      // The document change comes before any deadline is settled, so an old deadline that has
      // passed ends as `navigation`. The answer, which needs no state, goes out at once.
      await Promise.all([
        this.withTab(from.tabId, (s) => this.newDocument(from, s), true),
        this.answerInit(msg.url, from),
      ]);
      return;
    }
    if (msg.type === "report" && !NOTABLE_REPORTS.has(msg.state?.lifecycle ?? "")) return;
    return this.withTab(from.tabId, (s) => this.step(msg, from, s));
  }

  /**
   * Bouncer's `hello` from a tab's top frame: `from` is the page the tab shows. If it is a
   * prerendered page whose init is held, it is now the tab's page, as a new page's init would make
   * it, and its held init and those of its frames are answered, judged by its own site. Any other
   * page there means the held ones were discarded or replaced, and they are dropped.
   */
  shown(from: Sender): Promise<void> {
    if (from.tabId < 0 || from.frameId !== 0 || !this.held.has(from.tabId)) {
      return Promise.resolve();
    }
    let released: Held[] = [];
    return this.withTab(
      from.tabId,
      async (s) => {
        released = await this.release(from, s);
      },
      true,
    ).then(async () => {
      await Promise.all(released.map((h) => this.answerInit(h.url, h.from)));
    });
  }

  /** The tab closed: its pending opt-outs end, and its state goes. */
  forget(tabId: number): Promise<void> {
    this.held.delete(tabId);
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

  private async step(msg: AcMessage, from: Sender, s: Step): Promise<void> {
    const frame = s.tab.frames[from.frameId];
    if (!frame || frame.documentId !== from.documentId) return; // not the frame's recorded document
    switch (msg.type) {
      case "cmpDetected":
        if (from.frameId !== 0) return; // a child frame's CMP doesn't stop Bouncer's top-frame path
        await this.arb.cmpDetected(s.tabId, 0, frame.documentId);
        this.toFrame(s, 0, { type: "acDetected" });
        return;
      case "popupFound":
        return this.popupFound(msg.cmp, from, s, frame);
      case "optOutResult":
        return this.optOutResult(msg.result === true, msg.scheduleSelfTest === true, s, from);
      case "autoconsentDone":
        return this.autoconsentDone(s, from.frameId);
      case "selfTestResult":
        return this.selfTestResult(msg.result === true, s, from.frameId);
      case "report":
        return this.report(msg.state, s, from.frameId);
      default:
        // visualDelay, optInResult, autoconsentError: nothing to do.
        return;
    }
  }

  private async evaluate(id: string, snippetId: string | undefined, from: Sender): Promise<void> {
    let result: unknown = false;
    // Only autoconsent's own snippets run: the code in the message is never used.
    if (snippetId) {
      try {
        result = await this.p.runInMainWorld(from.tabId, from.documentId, snippetId);
      } catch {
        result = false;
      }
    }
    this.send(from.tabId, from.frameId, from.documentId, { type: "evalResp", id, result });
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
    this.send(from.tabId, from.frameId, from.documentId, {
      type: "initResp",
      rules,
      config: acConfig(enabled),
    });
  }

  /**
   * autoconsent's `init` opens each document's exchange. (Its constructor sends a `loading` report
   * just before, which is dropped as progress.)
   */
  private async newDocument(from: Sender, s: Step): Promise<void> {
    const { tabId, frameId, documentId } = from;
    const prev = s.tab.frames[frameId];
    if (prev?.documentId !== documentId) {
      if (frameId === 0) {
        // A new page: every frame of the old one has gone with it.
        await this.endFrames(tabId, s.tab, "navigation");
        s.tab.frames = {};
      } else if (prev) {
        await this.endFrame(tabId, frameId, prev, "navigation");
      }
      s.tab.frames[frameId] = { documentId };
    }
    // Records the page before autoconsent can claim it, whichever of Bouncer's `hello` and this
    // arrives first. Idempotent for the same document.
    if (frameId === 0) await this.arb.topDocument(tabId, documentId);
  }

  /** Holds a prerendered document's init, unanswered, until its page is shown. */
  private hold(url: string, from: Sender): void {
    const holds = [...(this.held.get(from.tabId) ?? []), { from, url }];
    this.held.set(from.tabId, holds.slice(-PRERENDER_HOLDS_PER_TAB));
  }

  /**
   * `top` is shown. If its init is held, records it as frame 0 and the tab's other held documents
   * as its frames, and returns them all, to be answered: their senders now say where they are.
   * (Chrome names no parent for a frame, so a held frame of another prerender, which Chrome
   * discards when this one is shown, is answered too, and that answer reaches nothing.)
   */
  private async release(top: Sender, s: Step): Promise<Held[]> {
    const holds = this.held.get(top.tabId) ?? [];
    const own = holds.find((h) => h.from.documentId === top.documentId);
    if (!own) {
      // Another page is shown: the held ones were discarded or replaced. The hello of the page
      // already on record, which only ever comes before its prerenders, leaves them.
      if (s.tab.frames[0]?.documentId !== top.documentId) this.held.delete(top.tabId);
      return [];
    }
    this.held.delete(top.tabId);
    const page = pageUrl(top);
    const released: Held[] = [
      { from: top, url: own.url },
      ...holds
        .filter((h) => h !== own && h.from.frameId > 0)
        .map((h) => ({
          url: h.url,
          from: { ...h.from, tabUrl: page, documentLifecycle: "active" as const },
        })),
    ];
    for (const h of released) await this.newDocument(h.from, s);
    return released;
  }

  private async popupFound(cmp: string, from: Sender, s: Step, frame: FrameState): Promise<void> {
    const { tabId, frameId } = from;
    // A second matching rule in the same document: autoconsent opts out once, for the first.
    if (frame.optOut || frame.refused) return;
    // Switched off since the page loaded: never opt out.
    if (!enabledFor(await this.settings(), pageUrl(from))) return;
    const now = this.clock.now();
    // The arbiter judges the page this host has on record, not whatever it recorded since.
    const top = s.tab.frames[0]?.documentId;
    const { sendOptOut, reason } = await this.arb.popupFound(tabId, frameId, top);
    if (reason === "stale") return; // the arbiter has moved on to another page
    if (!sendOptOut) {
      frame.refused = true;
      await this.logAdd(
        this.entry(from, cmp, now, {
          outcome: "deferred",
          notes: ["popupFound after bouncer claim"],
        }),
      );
      return;
    }
    // Stored and armed before autoconsent is told to act, so even a worker stopped from here on
    // ends this opt-out. If it can't be stored, autoconsent is not told.
    const deadline = now + AC_OPTOUT_TIMEOUT_MS;
    const optOut: OptOut = { phase: "optingOut", deadline };
    frame.optOut = optOut;
    await this.persist(s);
    this.arm(tabId, frameId, deadline);
    this.toFrame(s, frameId, { type: "optOut" });
    this.toFrame(s, 0, { type: "acPopupFound" });
    optOut.entryId = await this.logAdd(
      this.entry(from, cmp, now, { outcome: "working", t: { found: now } }),
    );
  }

  private async optOutResult(
    ok: boolean,
    scheduleSelfTest: boolean,
    s: Step,
    from: Sender,
  ): Promise<void> {
    const o = s.tab.frames[from.frameId]?.optOut;
    if (o?.phase !== "optingOut") return; // a late result: `autoconsentDone` says if it succeeded
    if (!ok) return this.fail(s, from.frameId, o, "opt_out_failed", false);
    // autoconsent's own order (its docs/api.md, and its test runner): the rule may be one stage
    // of several, so nothing is concluded, and no `selfTest` is sent, before `autoconsentDone`.
    o.phase = "finishing";
    if (scheduleSelfTest) o.selfTest = true;
  }

  /**
   * autoconsent sends this, after a successful `optOutResult`, only once the rule's last stage is
   * done. It never comes after a failed one, so a late one is a late success.
   */
  private async autoconsentDone(s: Step, frameId: number): Promise<void> {
    const o = s.tab.frames[frameId]?.optOut;
    const now = this.clock.now();
    if (o?.phase === "timedOut") {
      // It finished after all. What it hid stays hidden.
      o.watching = false;
      return this.succeed(s, frameId, o, "dismissed_late", { t: { gone: now } });
    }
    if (o?.phase !== "finishing") return;
    if (!o.selfTest) {
      return this.succeed(s, frameId, o, "dismissed_unverified", {
        verification: "no_self_test",
        t: { gone: now },
      });
    }
    o.phase = "selfTesting";
    o.deadline = now + AC_OPTOUT_TIMEOUT_MS;
    this.arm(s.tabId, frameId, o.deadline);
    this.toFrame(s, frameId, { type: "selfTest" });
    await this.logPatch(o, { t: { gone: now } });
  }

  private async selfTestResult(ok: boolean, s: Step, frameId: number): Promise<void> {
    const o = s.tab.frames[frameId]?.optOut;
    if (o?.phase !== "selfTesting") return;
    if (ok) return this.succeed(s, frameId, o, "dismissed", { verification: "self_test_passed" });
    return this.fail(s, frameId, o, "self_test_failed", false);
  }

  private async report(
    state: Extract<AcMessage, { type: "report" }>["state"] | undefined,
    s: Step,
    frameId: number,
  ): Promise<void> {
    const lifecycle = state?.lifecycle;
    const ended = lifecycle === "nothingDetected" || lifecycle === "done";
    if (frameId === 0 && ended && (state?.detectedCmps ?? []).length === 0) {
      // Bouncer's own path may stop waiting for autoconsent (§2b).
      this.toFrame(s, 0, { type: "acDetectionEnded" });
    }
    const o = s.tab.frames[frameId]?.optOut;
    if (o?.phase === "finishing" && lifecycle === "optOutSucceeded") {
      // Sent in place of `autoconsentDone`: the rule is one stage of several (intermediate). In
      // autoconsent 16.59 only TrustArc-top is ever one, when its banner has no reject button: it
      // hides the banner and the preference centre and opens the centre, for TrustArc-newcm to
      // finish. That rule runs only in this same document, whose one detection pass ended before
      // the centre existed (and the hiding keeps its popup from showing), so nothing finishes the
      // opt-out. Waiting out the deadline would only keep both hidden until TrustArc-top's own
      // cleanup shows them again ten seconds on.
      return this.fail(s, frameId, o, "opt_out_unfinished", false);
    }
    if (!o?.watching) return;
    if (lifecycle === "optOutFailed") {
      // The opt-out ended without success, after autoconsent's `hide` steps may have run again.
      o.watching = false;
      this.toFrame(s, frameId, { type: "restoreAcStyles" });
    } else if (lifecycle === "done" || lifecycle === "optOutSucceeded") {
      o.watching = false;
    }
  }

  // --- outcomes ---

  private async succeed(
    s: Step,
    frameId: number,
    o: OptOut,
    outcome: Outcome,
    patch: Partial<LogEntry>,
  ): Promise<void> {
    this.stop(s.tabId, frameId, o, "ended");
    this.toFrame(s, 0, { type: "acOutcome", outcome });
    this.mark(s.tabId, outcome);
    await this.logPatch(o, { outcome, ...patch });
  }

  /** Marks the tab's toolbar icon. The mark is cosmetic: failing to set it fails nothing else. */
  private mark(tabId: number, outcome: Outcome): void {
    const b = badgeFor({ path: "autoconsent", outcome });
    if (b) this.p.setBadge(tabId, b).catch((e) => report(`failed to mark tab ${tabId}`, e));
  }

  /**
   * Logs `failed` and, if the user wants it put back, removes autoconsent's styles in the frame.
   * `stillRunning`: autoconsent may yet finish (a timeout), so a late result still counts and its
   * `report`s are watched for a re-hide. The put-back goes out before the log is written, and
   * neither a failed settings read (the default puts it back) nor a failed write holds it up.
   */
  private async fail(
    s: Step,
    frameId: number,
    o: OptOut,
    reason: string,
    stillRunning: boolean,
  ): Promise<void> {
    this.stop(s.tabId, frameId, o, stillRunning ? "timedOut" : "ended");
    const restore = await this.settings().then(
      (x) => x.onFailed === "restore",
      () => true,
    );
    if (restore) {
      this.toFrame(s, frameId, { type: "restoreAcStyles" });
      o.watching = stillRunning;
    }
    this.toFrame(s, 0, { type: "acOutcome", outcome: "failed" });
    await this.logPatch(o, { outcome: "failed", reason });
  }

  /** The deadline passed (§1, "Bouncer's own opt-out timeout"). */
  private timeOut(s: Step, frameId: number, o: OptOut): Promise<void> {
    if (o.phase === "selfTesting") {
      // The opt-out succeeded; only its check never answered.
      return this.succeed(s, frameId, o, "dismissed_unverified", {
        verification: "self_test_unanswered",
      });
    }
    // No result, or (`finishing`) a success never followed by `autoconsentDone`: not a refusal,
    // and autoconsent may still be at work, so a late `autoconsentDone` still counts.
    return this.fail(s, frameId, o, "opt_out_timeout", true);
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
    if (phase === "optingOut" || phase === "finishing") {
      await this.logPatch(o, { outcome: "failed", reason });
    } else if (phase === "selfTesting") {
      await this.logPatch(o, {
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
      this.withTab(tabId, async (s) => {
        const o = s.tab.frames[frameId]?.optOut;
        if (o?.deadline !== undefined) await this.timeOut(s, frameId, o);
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
  private async settleDeadlines(s: Step): Promise<void> {
    for (const [frameId, frame] of frames(s.tab)) {
      const o = frame.optOut;
      if (o?.deadline === undefined) continue;
      if (o.deadline <= this.clock.now()) await this.timeOut(s, frameId, o);
      else if (!this.timers.has(`${s.tabId}:${frameId}`)) this.arm(s.tabId, frameId, o.deadline);
    }
  }

  private async recover(): Promise<void> {
    const tabs = (await this.p.session.get<number[]>(PENDING)) ?? [];
    await Promise.all(
      tabs.map((tabId) =>
        this.withTab(tabId, async (s) => {
          // Listed but holding none (a worker stopped between the two writes): unlist it.
          if (!hasDeadline(s.tab)) await this.setPending(tabId, false);
        }),
      ),
    );
  }

  // --- state ---

  /**
   * Runs `fn` on the tab's state as one serialised step, with its expired deadlines settled first
   * (or, with `settleAfter`, once `fn` is done), and stores the result.
   */
  private withTab(tabId: number, fn: (s: Step) => Promise<void>, settleAfter = false) {
    return this.serial(tabId, async () => {
      const tab = await this.load(tabId);
      const s: Step = { tabId, tab, stored: JSON.stringify(tab), listed: hasDeadline(tab) };
      if (!settleAfter) await this.settleDeadlines(s);
      await fn(s);
      if (settleAfter) await this.settleDeadlines(s);
      await this.persist(s);
    });
  }

  /** Stores the step's state if it changed, and lists or unlists the tab under `PENDING`. */
  private async persist(s: Step): Promise<void> {
    const json = JSON.stringify(s.tab);
    if (json === s.stored) return;
    const pending = hasDeadline(s.tab);
    // The listing first: a worker stopped between the writes leaves at most a stale listing.
    if (pending !== s.listed) {
      await this.setPending(s.tabId, pending);
      s.listed = pending;
    }
    await this.p.session.set(tabKey(s.tabId), s.tab);
    s.stored = json;
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

  /** To the frame's recorded document; nothing if the frame has none on record. */
  private toFrame(s: Step, frameId: number, msg: FrameMessage): void {
    const documentId = s.tab.frames[frameId]?.documentId;
    if (documentId !== undefined) this.send(s.tabId, frameId, documentId, msg);
  }

  /**
   * Not awaited: autoconsent's listener answers `optOut` and `selfTest` only once it has acted.
   * A frame with no receiver (gone, replaced, or never given Bouncer's script) is not an error.
   */
  private send(tabId: number, frameId: number, documentId: string, msg: FrameMessage): void {
    this.p.sendToFrame(tabId, frameId, msg, documentId).catch(() => {});
  }

  /** The decision log is a record, not a gate: a failed write never stops an opt-out or a put-back. */
  private async logAdd(e: Omit<LogEntry, "id">): Promise<string | undefined> {
    try {
      return await this.log.add(e);
    } catch (err) {
      report("failed to log an autoconsent decision", err);
      return undefined;
    }
  }

  private async logPatch(o: OptOut, patch: Partial<LogEntry>): Promise<void> {
    if (o.entryId === undefined) return;
    try {
      await this.log.patch(o.entryId, patch);
    } catch (err) {
      report("failed to log an autoconsent outcome", err);
    }
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

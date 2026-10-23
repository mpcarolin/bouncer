// Bouncer's own path, stage 1 (§2a–g), in the top frame: watch for candidates, gate each with the
// AI, label and choose deterministically, claim the page from the background's arbiter, then
// hide, click, verify, unlock scroll and log. One terminal decision per page.
import type { AiProvider, AiResult, AiStatus } from "../ai.ts";
import { type ChooseOpts, choose, type Corroboration, decide } from "../choose.ts";
import { CLAIM_WAIT_MS } from "../config.ts";
import { labelDeterministic, mergeAiLabels } from "../label.ts";
import type { LogEntry } from "../log.ts";
import type { ReplyOf, ToBackground, ToContent } from "../messages.ts";
import { captureFocus, NavigationWatch, safeClick } from "../page/click.ts";
import { clickability } from "../page/clickable.ts";
import { type Candidate, CandidateWatcher } from "../page/detect.ts";
import { isVisible } from "../page/dom.ts";
import { Hider } from "../page/hide.ts";
import { ScrollTracker } from "../page/scroll.ts";
import { type Serialised, serialise } from "../page/serialise.ts";
import { isGoneBySite, verifyDismissed } from "../page/verify.ts";
import type { ContentPlatform } from "../platform.ts";
import { type Settings, siteOf } from "../settings.ts";
import type {
  AbsentReason,
  Clock,
  Control,
  Decision,
  Label,
  Labelled,
  Outcome,
  SerialisedBanner,
} from "../types.ts";
import { fastPathTarget } from "./fast-path.ts";
import {
  modalNotConsentShowing,
  overlayStillShowing,
  reappeared,
  stillSame,
} from "./page-checks.ts";

export interface PageDeps {
  doc: Document;
  win: Window;
  platform: ContentPlatform;
  ai: AiProvider;
  settings: Settings;
  /** Drives the claim wait and detection's timers. Real time by default. */
  clock?: Clock;
  /**
   * The scroll snapshot, when the content script started it at document_start, before `hello`
   * was answered. Otherwise `start()` takes the first record.
   */
  scroll?: ScrollTracker;
  /** §2g's windows; VERIFY_GONE_MS and VERIFY_STAY_MS by default. For tests. */
  verify?: { goneMs?: number; stayMs?: number };
}

type Draft = Omit<LogEntry, "id">;

/** How one candidate's run ended. `not_consent` is the only ending that keeps the page open. */
interface Ending {
  outcome: Outcome;
  reason?: string;
}

/** A decision ready to act on, or an ending reached without one. */
type Verdict = { decision: Decision; aiOnly: boolean } | { end: Ending };

/** One candidate's run through the pipeline. */
interface Run {
  c: Candidate;
  entry: Draft;
  /** Something was hidden or clicked: any ending but a dismissal is now `failed`. */
  acted: boolean;
  restoreFocus?: (touched: Element[]) => void;
  /** The `log` sent when the claim was granted; the ending is patched onto it. */
  logged?: Promise<string | undefined>;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
};

const DISMISSED_AS: Record<"reject" | "close" | "agree", Outcome> = {
  reject: "dismissed",
  close: "dismissed_close",
  agree: "dismissed_agreed",
};

const DISMISSED = new Set<Outcome>([
  "dismissed",
  "dismissed_unverified",
  "dismissed_close",
  "dismissed_agreed",
  "dismissed_late",
]);

/** Reasons that come from the model, not from the controls: an absent control never explains them. */
const MODEL_REASONS = new Set(["model_timeout", "model_error"]);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function isResult(r: unknown): r is AiResult<unknown> {
  if (typeof r !== "object" || r === null) return false;
  const { kind, meta } = r as { kind?: unknown; meta?: unknown };
  return (
    (kind === "answer" || kind === "timeout" || kind === "error") &&
    typeof meta === "object" &&
    meta !== null
  );
}

/** `unsure` before anything was touched: a gate or labeller that timed out or failed. */
const modelEnding = (r: AiResult<unknown>): Ending => ({
  outcome: "unsure",
  reason: r.kind === "timeout" ? "model_timeout" : "model_error",
});

/**
 * Task 19's seam: the settings hop (§2f.3) and save-with-toggles (§2f.2). Stage 1 hands both
 * decisions here; until Task 19 replaces this, they end `unsure` with nothing touched.
 */
function settingsHop(d: Decision): Decision {
  if (d.kind !== "settings" && d.kind !== "save") return d;
  return { kind: "unsure", reason: "settings_not_implemented" };
}

/**
 * What the chooser would have clicked if controls that navigate or submit were clickable, when
 * that control is one of them: the reason the banner could not be refused (§0, "Log it as the
 * decision's reason").
 */
function absentTarget(
  b: SerialisedBanner,
  labels: Map<number, Labelled>,
  o: ChooseOpts,
): { id: number; why: AbsentReason } | undefined {
  const present = { ...b, controls: b.controls.map(({ absent: _, ...c }) => c) };
  const d = choose(present, labels, o);
  if (!("target" in d)) return undefined;
  const why = b.controls.find((c) => c.id === d.target)?.absent;
  return why && { id: d.target, why };
}

/**
 * Stage 1 of Bouncer's own path for one top-frame page. `start()` begins watching; candidates
 * are handled one at a time until a terminal outcome. Nothing escapes into the page: every
 * failure ends as `unsure` before an action, or `failed` after one.
 */
export class OwnPath {
  /**
   * The page's terminal decision, as logged. It never settles on a page with no candidate, or
   * one autoconsent claimed before Bouncer had a candidate in hand.
   */
  readonly done: Promise<LogEntry>;
  private resolveDone!: (e: LogEntry) => void;
  private readonly clock: Clock;
  private readonly scroll: ScrollTracker;
  private readonly hider = new Hider();
  private watcher: CandidateWatcher | null = null;
  /** Waiting candidates, by element: a later report of the same element replaces the earlier. */
  private readonly queue = new Map<Element, { c: Candidate; found: number }>();
  private readonly notConsent: Candidate[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private busy = false;
  /** A terminal outcome was reached, or Bouncer stood down: no new candidate is handled. */
  private finished = false;
  private stopped = false;
  private claimed = false;
  /** autoconsent's top-frame `cmpDetected` arrived before Bouncer claimed the page. */
  private acDetected = false;
  /** autoconsent's detection ended with nothing found: the claim wait can end early. */
  private acEnded = false;
  private acOutcomeSeen = false;

  constructor(private readonly d: PageDeps) {
    this.clock = d.clock ?? realClock;
    this.scroll = d.scroll ?? new ScrollTracker(d.doc);
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refreshScroll();
    this.d.platform.onMessage((m) => this.onNotice(m));
    // A notice held back since document_start may already have stood Bouncer down.
    if (this.finished) return;
    this.watcher = new CandidateWatcher(this.d.doc, (c) => this.enqueue(c), this.clock, {
      onPass: () => this.refreshScroll(),
    });
  }

  /** Stops watching and ignores later notices; a run in flight ends before its next action. */
  stop(): void {
    this.stopped = true;
    this.standDown();
  }

  // --- notices from the background ---

  private onNotice(m: ToContent): void {
    if (this.stopped) return;
    try {
      switch (m.type) {
        case "acDetected":
          this.scroll.freeze();
          if (this.claimed || this.acDetected) return;
          this.acDetected = true;
          this.wake();
          // With a candidate in hand the run ends `deferred` itself; otherwise there is nothing
          // of Bouncer's to log.
          if (!this.busy) this.standDown();
          return;
        case "acDetectionEnded":
          this.acEnded = true;
          this.wake();
          return;
        case "acPopupFound":
          if (!this.claimed) this.scroll.markAction();
          return;
        case "acOutcome":
          // Re-sent after a worker restart, or once per frame of a multi-frame CMP: the first acts.
          if (this.claimed || this.acOutcomeSeen) return;
          this.acOutcomeSeen = true;
          this.scroll.tryUnlock(m.outcome, this.overlayShowing([]));
          return;
        default:
          return;
      }
    } catch (e) {
      console.error("Bouncer: notice handler failed", e);
    }
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** No more candidates. `done` is left as it is. */
  private standDown(): void {
    this.finished = true;
    this.watcher?.stop();
    this.queue.clear();
    this.wake();
  }

  private refreshScroll(): void {
    try {
      this.scroll.refresh(modalNotConsentShowing(this.notConsent));
    } catch (e) {
      console.error("Bouncer: scroll refresh failed", e);
    }
  }

  private overlayShowing(actedOn: Element[]): boolean {
    try {
      return overlayStillShowing(this.d.doc, this.notConsent, actedOn);
    } catch {
      return true; // when in doubt, leave the lock alone
    }
  }

  // --- candidates, one at a time ---

  private enqueue(c: Candidate): void {
    if (this.finished) return;
    this.queue.set(c.el, { c, found: this.clock.now() });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.finished) {
        const next = this.queue.values().next();
        if (next.done) break;
        this.queue.delete(next.value.c.el);
        try {
          await this.handle(next.value.c, next.value.found);
        } catch (e) {
          // `handle` ends every run itself; this only keeps a bug from reaching the page.
          console.error("Bouncer: candidate run failed", e);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async handle(c: Candidate, found: number): Promise<void> {
    // Gone before its turn (or hidden by autoconsent's prehide): nothing to decide.
    if (!c.el.isConnected || !isVisible(c.el)) return;
    const url = this.d.win.location.href;
    const r: Run = {
      c,
      acted: false,
      entry: {
        at: found,
        site: siteOf(url),
        url,
        path: "ai",
        clicked: [],
        toggles: [],
        t: { found },
        modelCalls: [],
        outcome: "working",
        notes: [],
      },
    };
    let end: Ending;
    try {
      end = await this.run(r);
    } catch (e) {
      r.entry.notes.push(`exception:${message(e)}`);
      end = { outcome: r.acted ? "failed" : "unsure", reason: "exception" };
    }
    await this.finish(r, end);
  }

  private async run(r: Run): Promise<Ending> {
    const ser = serialise(r.c, clickability);
    // §2b: wait up to CLAIM_WAIT_MS from finding the candidate, unless autoconsent's detection
    // ends first. The model calls run during the wait.
    const waited = this.claimWait();
    const v = await this.verdict(r, ser.banner);
    r.entry.t.decided = this.clock.now();
    if ("end" in v && v.end.outcome === "not_consent") return v.end;
    // Every other ending waits too, so autoconsent detecting the page in time means `deferred`.
    await waited;
    if (this.stopped) return { outcome: "deferred", reason: "stopped" };
    if (this.acDetected) return { outcome: "deferred", reason: "autoconsent_detected" };
    if ("end" in v) return v.end;
    return this.act(r, ser, v.decision, v.aiOnly);
  }

  /** §2c–f: the fast path when the model is unavailable, else the gate, labelling and chooser. */
  private async verdict(r: Run, banner: SerialisedBanner): Promise<Verdict> {
    const det = labelDeterministic(banner);
    const status = await this.status();
    if (status.state !== "available") {
      r.entry.path = "heuristic";
      r.entry.gate = "skipped";
      r.entry.labels = Object.fromEntries(
        [...det].filter((kv): kv is [number, Labelled] => kv[1] !== null),
      );
      r.entry.notes.push(`model:${status.state}${status.reason ? `:${status.reason}` : ""}`);
      const target = fastPathTarget(banner, det);
      if (target === null) return { end: { outcome: "model_unavailable" } };
      return { decision: { kind: "reject", target }, aiOnly: false };
    }

    // The AI labels only buttons and links the rules left open, and never one that is absent.
    const unlabelled = banner.controls
      .filter((c) => det.get(c.id) === null && !c.absent)
      .map((c) => c.id);
    const [gate, labels] = await Promise.all([
      this.model(r, "isConsentDialog", () => this.d.ai.isConsentDialog(banner)),
      unlabelled.length > 0
        ? this.model(r, "labelControls", () => this.d.ai.labelControls(banner, unlabelled))
        : undefined,
    ]);
    if (gate.kind !== "answer") return { end: modelEnding(gate) };
    if (gate.value === false) {
      r.entry.gate = "other";
      return { end: { outcome: "not_consent" } };
    }
    if (gate.value !== true) {
      r.entry.notes.push("isConsentDialog:malformed_answer");
      return { end: { outcome: "unsure", reason: "model_error" } };
    }
    r.entry.gate = "consent";
    let given: Record<number, Label> = {};
    if (labels) {
      if (labels.kind !== "answer") return { end: modelEnding(labels) };
      if (typeof labels.value !== "object" || labels.value === null) {
        r.entry.notes.push("labelControls:malformed_answer");
        return { end: { outcome: "unsure", reason: "model_error" } };
      }
      given = labels.value;
    }

    const merged = mergeAiLabels(banner, det, given);
    r.entry.labels = Object.fromEntries(merged);
    const opts: ChooseOpts = {
      closeAction: this.d.settings.closeAction,
      agreeToDismiss: this.d.settings.agreeToDismiss,
      allowSettings: true,
    };
    const res = await decide(banner, merged, opts, (control, label) =>
      this.corroborate(r, banner, control, label),
    );
    for (const { id, answer } of res.corroborations)
      r.entry.notes.push(`corroborate:${id}:${answer}`);
    const decision = settingsHop(res.decision);
    if ("target" in decision) return { decision, aiOnly: res.aiOnlyClick };

    const reason = decision.kind === "unsure" ? decision.reason : undefined;
    const missed =
      reason && MODEL_REASONS.has(reason) ? undefined : absentTarget(banner, merged, opts);
    if (missed) {
      r.entry.notes.push(`absent:${missed.id}:${missed.why}`);
      if (reason) r.entry.notes.push(`decision:${reason}`);
    }
    const outcome: Outcome = decision.kind === "no_option" ? "no_option" : "unsure";
    return { end: { outcome, reason: missed?.why ?? reason } };
  }

  /** §2b, §2g: claim, hide, click, verify. */
  private async act(r: Run, ser: Serialised, d: Decision, aiOnly: boolean): Promise<Ending> {
    if (!("target" in d) || (d.kind !== "reject" && d.kind !== "close" && d.kind !== "agree")) {
      return { outcome: "unsure", reason: "unexpected_decision" };
    }
    const el = ser.elements.get(d.target);
    const control = ser.banner.controls.find((c) => c.id === d.target);
    if (!el || !control || !stillSame(r.c, ser, d.target)) {
      return { outcome: "unsure", reason: "stale_target" };
    }

    const claim = await this.send({ type: "claim" });
    if (!claim) return { outcome: "deferred", reason: "claim_unanswered" };
    if (!claim.granted) return { outcome: "deferred", reason: claim.reason ?? "claim_refused" };
    this.claimed = true;
    r.logged = this.log({ ...r.entry, outcome: "working" });
    if (this.stopped) return { outcome: "unsure", reason: "stopped" };
    // The site may have re-rendered the banner while the claim was out.
    if (!stillSame(r.c, ser, d.target)) return { outcome: "unsure", reason: "stale_target" };

    this.scroll.freeze();
    r.restoreFocus = captureFocus(this.d.doc);
    this.hider.hide(r.c.el, r.c.root);
    r.acted = true;
    this.scroll.markAction();
    const nav = new NavigationWatch(this.d.win);
    let click: ReturnType<typeof safeClick>;
    try {
      click = safeClick(el, nav);
    } finally {
      nav.dispose();
    }
    if (click.reason !== "stale_target") {
      r.entry.clicked.push({ id: d.target, text: control.text, aiOnly });
    }
    if (click.hashGuardUsed) r.entry.notes.push("hash_guard");
    if (!click.ok) return { outcome: "failed", reason: click.reason };

    const v = await this.verify(r);
    r.entry.verification = v.ok ? "verified" : v.reason;
    if (!v.ok) return { outcome: "failed", reason: v.reason };
    return { outcome: DISMISSED_AS[d.kind] };
  }

  /** §2g: the banner (which held the clicked control) gone within the window, and staying gone. */
  private async verify(r: Run): Promise<{ ok: boolean; reason?: string }> {
    const els = [r.c.el];
    const nav = new NavigationWatch(this.d.win);
    let goneAt: number | undefined;
    try {
      const v = await verifyDismissed(els, {
        nav,
        goneMs: this.d.verify?.goneMs,
        stayMs: this.d.verify?.stayMs,
        // Called on every check, so it also notes when the banner was first seen gone.
        reappeared: () => {
          try {
            if (goneAt === undefined && els.every(isGoneBySite)) goneAt = this.clock.now();
          } catch {
            // only a timing; verification decides
          }
          return reappeared(this.d.doc, r.c, els);
        },
      });
      if (v.ok) r.entry.t.gone = goneAt ?? this.clock.now();
      return v;
    } catch (e) {
      r.entry.notes.push(`verify:${message(e)}`);
      return { ok: false, reason: "verify_error" };
    } finally {
      nav.dispose();
    }
  }

  /** Puts the page back as the ending requires, logs it, and closes the page on a terminal one. */
  private async finish(r: Run, end: Ending): Promise<void> {
    const outcome: Outcome = r.acted && !DISMISSED.has(end.outcome) ? "failed" : end.outcome;
    try {
      if (r.acted) {
        if (DISMISSED.has(outcome)) {
          this.hider.unhideAll();
          r.entry.notes.push(
            `scroll:${this.scroll.tryUnlock(outcome, this.overlayShowing([r.c.el]))}`,
          );
        } else if (this.d.settings.onFailed === "restore") {
          this.hider.unhideAll();
          r.entry.notes.push("restored");
        } else {
          r.entry.notes.push("kept_hidden");
        }
        r.restoreFocus?.([r.c.el]);
      }
    } catch (e) {
      r.entry.notes.push(`finish:${message(e)}`);
    }

    r.entry.outcome = outcome;
    if (end.reason !== undefined) r.entry.reason = end.reason;
    if (outcome === "deferred") r.entry.path = "deferred";
    const terminal = outcome !== "not_consent";
    if (!terminal) {
      this.watcher?.reject(r.c);
      this.notConsent.push(r.c);
      // autoconsent took the page while this candidate was being judged.
      if (this.acDetected) this.standDown();
    } else {
      this.standDown();
    }

    const entry = { ...r.entry, notes: [...r.entry.notes] };
    let id = r.logged ? await r.logged : undefined;
    if (id !== undefined) await this.send({ type: "logPatch", id, patch: entry });
    else id = await this.log(entry);
    if (terminal) this.resolveDone({ ...entry, id: id ?? "" });
  }

  // --- the background ---

  private async send<M extends ToBackground>(m: M): Promise<ReplyOf<M> | undefined> {
    try {
      return await this.d.platform.send(m);
    } catch {
      return undefined;
    }
  }

  private async log(entry: Draft): Promise<string | undefined> {
    return (await this.send({ type: "log", entry }))?.id;
  }

  private claimWait(): Promise<void> {
    return new Promise((resolve) => {
      if (this.acEnded || this.acDetected || this.finished) {
        resolve();
        return;
      }
      let timer = 0;
      const done = () => {
        this.clock.clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
      timer = this.clock.setTimeout(done, CLAIM_WAIT_MS);
    });
  }

  private async status(): Promise<AiStatus> {
    try {
      const s = await this.d.ai.status();
      if (typeof s?.state === "string") return s;
    } catch {
      // as below
    }
    return { state: "unavailable", reason: "status_failed", onDevice: false };
  }

  /**
   * One model call, recorded in the log in the order the calls were made (the gate and the
   * labeller run in parallel). A throw or a malformed result is an `error`.
   */
  private async model<T>(
    r: Run,
    op: "isConsentDialog" | "labelControls" | "corroborate",
    call: () => Promise<AiResult<T>>,
  ): Promise<AiResult<T>> {
    const rec: LogEntry["modelCalls"][number] = { op, ms: 0, cold: false, result: "error" };
    r.entry.modelCalls.push(rec);
    let res: AiResult<T>;
    try {
      const got: unknown = await call();
      res = isResult(got)
        ? (got as AiResult<T>)
        : {
            kind: "error",
            error: "malformed_result",
            meta: { ms: 0, cold: false, onDevice: false },
          };
    } catch (e) {
      res = { kind: "error", error: message(e), meta: { ms: 0, cold: false, onDevice: false } };
    }
    rec.ms = typeof res.meta.ms === "number" ? res.meta.ms : 0;
    rec.cold = res.meta.cold === true;
    rec.result = res.kind;
    if (res.kind === "error") r.entry.notes.push(`${op}:${res.error}`);
    return res;
  }

  private async corroborate(
    r: Run,
    banner: SerialisedBanner,
    control: Control,
    label: "reject" | "save" | "settings",
  ): Promise<Corroboration> {
    const res = await this.model(r, "corroborate", () =>
      this.d.ai.corroborate(banner, control, label),
    );
    if (res.kind !== "answer") return res.kind;
    return typeof res.value === "boolean" ? res.value : "error";
  }
}

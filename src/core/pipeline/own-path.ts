// Bouncer's own path (§2a–g), in the top frame: watch for candidates, gate each with the AI,
// label and choose deterministically, claim the page from the background's arbiter, then hide,
// act (a click, a save with toggles, or the settings hop of settings-hop.ts), verify, unlock
// scroll and log. One terminal decision per page.
import type { AiProvider, AiResult, AiStatus } from "../ai.ts";
import { type ChooseOpts, choose, type Corroboration, decide, MODEL_REASONS } from "../choose.ts";
import { CLAIM_WAIT_MS } from "../config.ts";
import { labelDeterministic, mergeAiLabels } from "../label.ts";
import type { LogEntry } from "../log.ts";
import type { ReplyOf, ToBackground, ToContent } from "../messages.ts";
import { type ClickResult, captureFocus, NavigationWatch, safeClick } from "../page/click.ts";
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
import {
  type Actions,
  type HopDeps,
  saveWithToggles,
  settingsHop,
  withHiddenToggles,
} from "./settings-hop.ts";

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
  /** §2f.3's wait for the settings panel; PANEL_WAIT_MS by default. For tests. */
  panel?: { waitMs?: number; pollMs?: number };
}

type Draft = Omit<LogEntry, "id">;

/**
 * How one candidate's run ended. `not_consent` and `model_unavailable` end that candidate only
 * and keep the page open (§2g's terminal list has neither); every other ending is the page's.
 */
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
  /** The settings panel the hop found, once it has (§2f.3). */
  panel?: Element;
  restoreFocus?: (touched: Element[]) => void;
  /** The `log` sent when the claim was granted; the ending is patched onto it. */
  logged?: Promise<string | undefined>;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
};

const DISMISSED_AS: Record<Exclude<Decision["kind"], "no_option" | "unsure">, Outcome> = {
  reject: "dismissed",
  save: "dismissed",
  settings: "dismissed",
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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An ending that is the page's decision, after which no candidate is handled (§2g). */
const isTerminal = (o: Outcome) => o !== "not_consent" && o !== "model_unavailable";

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

/** The visible part of a `hiddenToggles` serialisation: what a plain one gives, same ids. */
function shownOnly(s: Serialised): Serialised {
  return { ...s, banner: { ...s.banner, controls: s.banner.controls.filter((c) => !c.hidden) } };
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
 * Bouncer's own path for one top-frame page. `start()` begins watching; candidates
 * are handled one at a time until a terminal outcome. Nothing escapes into the page: every
 * failure ends as `unsure` before an action, or `failed` after one.
 */
export class OwnPath {
  /**
   * The page's terminal decision, as logged. It never settles on a page without one: no
   * candidate, only `not_consent` or `model_unavailable` ones, or autoconsent claimed the page
   * before Bouncer had a candidate in hand.
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
  /** A dismissed `acOutcome` has been through `tryUnlock`: later ones are ignored. */
  private acUnlockTried = false;
  /** The page's one `model_unavailable` entry has been logged. */
  private unavailableLogged = false;

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
          this.queue.clear();
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
          // Re-sent after a worker restart, or once per frame of a multi-frame CMP: the first
          // dismissed one acts. A `failed` can still be followed by `dismissed_late`.
          if (this.claimed || this.acUnlockTried || !DISMISSED.has(m.outcome)) return;
          this.acUnlockTried = true;
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
    if (this.finished || this.acDetected) return;
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
    if (this.acDetected) return { outcome: "deferred", reason: "autoconsent_detected" };
    // The gate, the labeller and the chooser see only what is shown; a save covers the rest.
    const full = serialise(r.c, clickability, { hiddenToggles: true });
    const ser = shownOnly(full);
    // §2b: wait up to CLAIM_WAIT_MS from finding the candidate, unless autoconsent's detection
    // ends first. The model calls run during the wait.
    const waited = this.claimWait();
    const v = await this.verdict(r, ser.banner);
    r.entry.t.decided = this.clock.now();
    if ("end" in v && !isTerminal(v.end.outcome)) return v.end;
    // Every page ending waits too, so autoconsent detecting the page in time means `deferred`.
    await waited;
    if (this.stopped) return { outcome: "deferred", reason: "stopped" };
    if (this.acDetected) return { outcome: "deferred", reason: "autoconsent_detected" };
    if ("end" in v) return v.end;
    return this.act(r, ser, full, v.decision, v.aiOnly);
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
    // autoconsent took the page while the model was asked: no labelling, no corroboration.
    if (this.acDetected) return { end: { outcome: "deferred", reason: "autoconsent_detected" } };
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
      const got = this.labelsOf(r, labels);
      if (typeof got === "string") return { end: { outcome: "unsure", reason: got } };
      given = got;
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
    const decision = res.decision;
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

  /**
   * §2b, §2f, §2g: claim, hide, act, verify. `full` is the banner serialised with its hidden
   * toggles, for a save; `ser` is its visible part, what the decision was made on.
   */
  private async act(
    r: Run,
    ser: Serialised,
    full: Serialised,
    d: Decision,
    aiOnly: boolean,
  ): Promise<Ending> {
    if (!("target" in d)) return { outcome: "unsure", reason: "unexpected_decision" };
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
    // Before hiding, so a throw part-way through still puts back whatever was hidden.
    r.acted = true;
    this.hider.hide(r.c.el, r.c.root);
    this.scroll.markAction();
    const actions = this.actions(r);
    // The texts whose return as a new element means the site put the banner (or panel) back.
    const keys = new Set([r.c.key]);
    if (d.kind === "settings") {
      const hop = await settingsHop({
        banner: r.c.el,
        ser,
        target: d.target,
        aiOnly,
        deps: this.hopDeps(r, actions),
      });
      if (hop.panel) r.panel = hop.panel;
      if (!hop.ok) return { outcome: "failed", reason: hop.reason };
      keys.add(hop.panelKey);
    } else if (d.kind === "save") {
      const saved = saveWithToggles(withHiddenToggles(d, full), full, r.c.el, aiOnly, actions);
      if (!saved.ok) return { outcome: "failed", reason: saved.reason };
    } else {
      const click = actions.click(el, control, aiOnly);
      if (!click.ok) return { outcome: "failed", reason: click.reason };
    }

    const v = await this.verify(r, keys);
    r.entry.verification = v.ok ? "verified" : v.reason;
    if (!v.ok) return { outcome: "failed", reason: v.reason };
    return { outcome: DISMISSED_AS[d.kind] };
  }

  /** Every click goes through `safeClick` with its own `NavigationWatch`, and into the log. */
  private actions(r: Run): Actions {
    return {
      click: (el, control, aiOnly) => {
        const nav = new NavigationWatch(this.d.win);
        let click: ClickResult;
        try {
          click = safeClick(el, nav);
        } finally {
          nav.dispose();
        }
        if (click.reason !== "stale_target") {
          r.entry.clicked.push({ id: control.id, text: control.text, aiOnly });
        }
        if (click.hashGuardUsed) r.entry.notes.push("hash_guard");
        return click;
      },
      toggled: (t) => r.entry.toggles.push(...t),
    };
  }

  /** What the settings hop needs from the page: stage-2 model calls are logged like stage 1's. */
  private hopDeps(r: Run, actions: Actions): HopDeps {
    return {
      ...actions,
      doc: this.d.doc,
      hider: this.hider,
      rejected: new Set(this.notConsent.map((c) => c.el)),
      choose: {
        closeAction: this.d.settings.closeAction,
        agreeToDismiss: this.d.settings.agreeToDismiss,
      },
      label: async (b, ids) =>
        this.labelsOf(
          r,
          await this.model(r, "labelControls", () => this.d.ai.labelControls(b, ids)),
        ),
      corroborate: (b, control, label) => this.corroborate(r, b, control, label),
      note: (s) => r.entry.notes.push(s),
      stopped: () => this.stopped,
      panel: this.d.panel,
    };
  }

  /** The banner, and the panel after a hop: what the flow acted on. */
  private touched(r: Run): Element[] {
    return r.panel && r.panel !== r.c.el ? [r.c.el, r.panel] : [r.c.el];
  }

  /**
   * §2g: the banner and, after a hop, the panel (which held the last clicked control) gone
   * within the window, and staying gone. In OneTrust-style flows the banner goes as the panel
   * opens, so the banner alone would pass while the panel is still open.
   */
  private async verify(
    r: Run,
    keys: ReadonlySet<string>,
  ): Promise<{ ok: boolean; reason?: string }> {
    const els = this.touched(r);
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
          return reappeared(this.d.doc, keys, els);
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
            `scroll:${this.scroll.tryUnlock(outcome, this.overlayShowing(this.touched(r)))}`,
          );
        } else if (this.d.settings.onFailed === "restore") {
          // An open settings panel is the site's own: un-hidden, it is left for the user (§3).
          this.hider.unhideAll();
          r.entry.notes.push("restored");
        } else {
          r.entry.notes.push("kept_hidden");
        }
        r.restoreFocus?.(this.touched(r));
      }
    } catch (e) {
      r.entry.notes.push(`finish:${message(e)}`);
    }

    r.entry.outcome = outcome;
    if (end.reason !== undefined) r.entry.reason = end.reason;
    if (outcome === "deferred") r.entry.path = "deferred";
    const terminal = isTerminal(outcome);
    if (outcome === "not_consent") {
      this.watcher?.reject(r.c);
      this.notConsent.push(r.c);
    } else if (outcome === "model_unavailable") {
      // Not judged, so not a not_consent overlay: it must not pause the scroll record or block
      // an unlock. It is only remembered so that it isn't handled again on every mutation.
      this.watcher?.reject(r.c);
    } else {
      this.standDown();
    }
    // autoconsent took the page while this candidate was being handled.
    if (!terminal && this.acDetected) this.standDown();
    // One `model_unavailable` entry per page, however many candidates the fast path passed on.
    if (outcome === "model_unavailable") {
      if (this.unavailableLogged) return;
      this.unavailableLogged = true;
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

  /** The labeller's answer, or why there is none (a malformed one is an error). */
  private labelsOf(
    r: Run,
    res: AiResult<Record<number, Label>>,
  ): Record<number, Label> | "model_timeout" | "model_error" {
    if (res.kind !== "answer") return res.kind === "timeout" ? "model_timeout" : "model_error";
    if (typeof res.value !== "object" || res.value === null) {
      r.entry.notes.push("labelControls:malformed_answer");
      return "model_error";
    }
    return res.value;
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

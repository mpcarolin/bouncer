// The harness the own-path DOM tests drive `OwnPath` with: MockProvider behind the
// fakeContent/fakeBackground pair, fast timers, and records of every click and hide.
import { MockProvider } from "../../src/ai/mock/provider.ts";
import type { AiProvider, AiResult, AiStatus } from "../../src/core/ai.ts";
import { RemoteAiProvider } from "../../src/core/ai-remote.ts";
import { type BackgroundApp, startBackground } from "../../src/core/background-app.ts";
import type { LearnedRule } from "../../src/core/learned.ts";
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
} from "./fake-platform.ts";
import { unmountAll } from "./mount.ts";

declare global {
  interface Window {
    __clicked?: string;
    __chatClicked?: string;
  }
}

/** Real timers, ten times faster: the claim wait is 150 ms and detection watches for 2 s. */
export const fastClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms / 10),
  clearTimeout: (id) => window.clearTimeout(id),
};
export const VERIFY = { goneMs: 500, stayMs: 200 };
export const PANEL = { waitMs: 500, pollMs: 20 };
export const HIDDEN = "data-bouncer-hidden";

/** MockProvider that records every model call (not `status`) and can run a hook on each. */
export class Counting extends MockProvider {
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
export class Unavailable extends Counting {
  override async status(): Promise<AiStatus> {
    return { state: "unavailable", reason: "test", onDevice: true };
  }
}

/** Corroborates every AI-only label, and reports the gate's call as a cold start. */
export class Agreeable extends Counting {
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

export interface Harness {
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

export interface StartOpts {
  provider?: Counting;
  settings?: Partial<Settings>;
  /** Runs after `hello`, before the pipeline starts. */
  before?: (h: { bg: FakeBackground; app: BackgroundApp; content: FakeContent }) => unknown;
  /** Wraps the content platform the pipeline talks through. */
  platform?: (content: FakeContent) => ContentPlatform;
  /** The pipeline's AI, in place of `RemoteAiProvider` over the fake background. */
  ai?: AiProvider;
  /** Learned rules the background holds before `hello`, as if from an earlier visit. */
  rules?: LearnedRule[];
}

const teardown: (() => void)[] = [];

/** Stops every pipeline started since the last call and removes the harness's listeners. */
export function stopAll(): void {
  for (const t of teardown.splice(0)) t();
}

/** For `afterEach`: stops the pipelines and puts the test page back as it was. */
export function cleanup(): void {
  stopAll();
  unmountAll();
  for (const s of document.querySelectorAll("style[data-bouncer]")) s.remove();
  delete window.__clicked;
  delete window.__chatClicked;
  document.body.style.removeProperty("overflow");
}

export async function start(o: StartOpts = {}): Promise<Harness> {
  const bg = fakeBackground();
  const provider = o.provider ?? new Counting();
  const app = startBackground(bg, provider);
  for (const r of o.rules ?? []) await app.rules.put(r);
  // The test page's own URL, so the background names the same site the pipeline does.
  const content = fakeContent(bg, { url: location.href });
  // The content entry's hello: it records the page with the arbiter, so a claim can be granted,
  // and hands the pipeline the site's learned rule.
  const hello = await content.send({ type: "hello" });
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
    learnedRule: hello?.learnedRule,
    clock: fastClock,
    verify: VERIFY,
    panel: PANEL,
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}

export const byId = (id: string) => document.getElementById(id) as HTMLElement;

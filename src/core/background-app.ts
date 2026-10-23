import type { AiMeta, AiProvider, AiResult } from "./ai.ts";
import { serveAi } from "./ai-remote.ts";
import { Arbiter } from "./arbiter.ts";
import { ModelBudget } from "./budget.ts";
import { DecisionLog } from "./log.ts";
import { type AiRequest, isToBackground, type ToBackground } from "./messages.ts";
import type { BackgroundPlatform, Sender } from "./platform.ts";
import { enabledFor, loadSettings } from "./settings.ts";

/** Handles one autoconsent protocol message. Its real replies go out through `sendToFrame`. */
export type AutoconsentHandler = (msg: unknown, from: Sender) => Promise<void> | void;

export interface BackgroundOptions {
  /** Defaults to a no-op until Task 17 plugs in autoconsent's host. */
  autoconsent?: AutoconsentHandler;
}

export interface BackgroundApp {
  /** The one arbiter for this background's lifetime (its atomicity is per instance). */
  readonly arbiter: Arbiter;
  /** The one decision log for this background's lifetime (its write queue is per instance). */
  readonly log: DecisionLog;
}

/** The messages that need work. `saveRule` and `discardRule` are acknowledged without any. */
type Work = Exclude<ToBackground, { type: "saveRule" | "discardRule" }>;

const refuse = (error: string): Promise<AiResult<never>> =>
  Promise.resolve({
    kind: "error",
    error,
    meta: { ms: 0, cold: false, onDevice: true } satisfies AiMeta,
  });

function report(what: string, e: unknown): void {
  console.error(`bouncer: ${what}`, e);
}

/** The settings page's `site` query: the hostname of an http(s) page, else nothing. */
function siteQuery(url: string | undefined): Record<string, string> | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname
      ? { site: u.hostname }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Composes the background: routes Bouncer's messages to the arbiter, the AI provider (through a
 * per-page budget), the decision log and the settings, and registers the browser events. All
 * registration happens before this returns, with nothing awaited first, as a service worker needs.
 *
 * Per-tab state that must outlive a worker restart (the arbiter's claims) lives in `p.session`.
 * The AI budgets are kept in memory only: a restarted worker gives each page a fresh budget,
 * which is acceptable because the budget only guards against a runaway page.
 */
export function startBackground(
  p: BackgroundPlatform,
  provider: AiProvider,
  opts: BackgroundOptions = {},
): BackgroundApp {
  const arbiter = new Arbiter(p.session);
  const log = new DecisionLog(p.local);
  const autoconsent = opts.autoconsent ?? (() => {});

  /** The budgeted provider per top document, keyed `${tabId}:${documentId}`. */
  const budgets = new Map<string, AiProvider>();
  const budgetKey = (tabId: number, documentId: string) => `${tabId}:${documentId}`;

  function budgetFor(tabId: number, documentId: string): AiProvider {
    const key = budgetKey(tabId, documentId);
    let budgeted = budgets.get(key);
    if (!budgeted) {
      budgeted = new ModelBudget().wrap(provider);
      budgets.set(key, budgeted);
    }
    return budgeted;
  }

  /** Drops the tab's budgets, except the one for `keepDocumentId` when given. */
  function dropBudgets(tabId: number, keepDocumentId?: string): void {
    const keep = keepDocumentId === undefined ? undefined : budgetKey(tabId, keepDocumentId);
    for (const key of [...budgets.keys()]) {
      if (key.startsWith(`${tabId}:`) && key !== keep) budgets.delete(key);
    }
  }

  async function hello(from: Sender) {
    const hasTab = from.tabId >= 0;
    if (hasTab && from.frameId === 0) {
      await arbiter.topDocument(from.tabId, from.documentId);
      dropBudgets(from.tabId, from.documentId); // the earlier documents are gone
    }
    const settings = await loadSettings(p.local);
    return {
      // `enabledFor` includes the global switch. A sender with no tab is not a page to act on.
      enabled: hasTab && enabledFor(settings, from.url),
      settings,
      // Task 20 fills this in from the stored rule for the site.
      learnedRule: undefined,
    };
  }

  function claim(from: Sender) {
    // Without a tab there is no page on record, which is exactly what `stale` means.
    if (from.tabId < 0) return Promise.resolve({ granted: false, reason: "stale" as const });
    return arbiter.claimForBouncer(from.tabId, from.documentId);
  }

  function ai(msg: AiRequest, from: Sender) {
    // `status` costs nothing and holds no page content, so any sender may ask (the settings
    // page does). Model calls need a page: the budget is per top document.
    if (msg.op === "status") return serveAi(provider, msg.op, msg.args);
    if (from.tabId < 0) return refuse("no_tab");
    // Child frames don't run the AI path, and a child's documentId isn't the top document's.
    if (from.frameId !== 0) return refuse("not_top_frame");
    return serveAi(budgetFor(from.tabId, from.documentId), msg.op, msg.args);
  }

  /** Answers a Bouncer message that needs work. A failure is logged and the reply is nothing. */
  async function answer(msg: Work, from: Sender): Promise<unknown> {
    try {
      switch (msg.type) {
        case "hello":
          return await hello(from);
        case "claim":
          return await claim(from);
        case "ai":
          return await ai(msg, from);
        case "log":
          return { id: await log.add(msg.entry) };
        case "logPatch":
          return await log.patch(msg.id, msg.patch);
      }
    } catch (e) {
      report(`failed to handle ${msg.type}`, e);
      return undefined;
    }
  }

  p.onMessage((msg, from) => {
    if (!isToBackground(msg)) {
      // autoconsent's protocol: acknowledge at once; its replies arrive through `sendToFrame`.
      void (async () => autoconsent(msg, from))().catch((e) => report("autoconsent handler", e));
      return undefined;
    }
    // Task 20 implements learned rules; until then both are acknowledged and ignored.
    if (msg.type === "saveRule" || msg.type === "discardRule") return undefined;
    return answer(msg, from);
  });

  p.onTabRemoved((tabId) => {
    dropBudgets(tabId);
    // Only here, never on navigation: `topDocument` handles a new page within the tab.
    arbiter.forget(tabId).catch((e) => report(`failed to forget tab ${tabId}`, e));
  });

  p.onActionClicked((tab) => {
    p.openPage("settings", siteQuery(tab.url)).catch((e) => report("failed to open settings", e));
  });

  p.onInstalled((reason) => {
    if (reason !== "install") return;
    p.openPage("onboarding").catch((e) => report("failed to open onboarding", e));
  });

  return { arbiter, log };
}

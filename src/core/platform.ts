import type { Badge } from "./badge.ts";
import type { FrameMessage, ReplyOf, ToBackground, ToContent } from "./messages.ts";

export interface KV {
  get<T>(k: string): Promise<T | undefined>;
  set(k: string, v: unknown): Promise<void>;
  remove(k: string): Promise<void>;
}

/** Where a document is in its life, in Chrome's words (`extensionTypes.DocumentLifecycle`). */
export type DocumentLifecycle = "prerender" | "active" | "cached" | "pending_deletion";

/**
 * Who sent a message. A sender with no tab (a popup or an offscreen document; settings and
 * onboarding are tabs) has `tabId` -1 and `frameId` -1.
 */
export interface Sender {
  tabId: number;
  /**
   * 0 for the top frame of the page the tab shows. A prerendered page's top frame has another id
   * until it is shown, and 0 from then on.
   */
  frameId: number;
  /** Stable for the document's life, across a prerendered page being shown. */
  documentId: string;
  /** `prerender`: a page loading unseen, which the user may never be shown. */
  documentLifecycle: DocumentLifecycle;
  /** The sending frame's own URL. For a child frame this is the frame's, not the page's. */
  url: string;
  /** The URL of the tab the frame is in, i.e. the page the user is on. `url` if unknown. */
  tabUrl: string;
}

export type PageName = "settings" | "onboarding";

export interface BackgroundPlatform {
  /** Survives browser restarts. */
  local: KV;
  /** Survives a service-worker restart, not a browser restart. */
  session: KV;
  /** Returning undefined replies at once with nothing. */
  onMessage(h: (msg: unknown, from: Sender) => Promise<unknown> | undefined): void;
  /**
   * To Bouncer's or autoconsent's content script in that frame. With `documentId`, only while that
   * document is the frame's: a message meant for a replaced document never reaches its successor.
   * Rejects when there is no such receiver.
   */
  sendToFrame(
    tabId: number,
    frameId: number,
    msg: FrameMessage,
    documentId?: string,
  ): Promise<void>;
  onTabRemoved(cb: (tabId: number) => void): void;
  /** The toolbar icon was clicked. `url` is the active tab's, when the browser exposes it. */
  onActionClicked(cb: (tab: { url?: string }) => void): void;
  /** `reason` is the browser's word for why: `install`, `update`, … */
  onInstalled(cb: (reason: string) => void): void;
  /** The browser started with this profile. Listening for it starts the background then too. */
  onStartup(cb: () => void): void;
  /** Keys of `local` that changed, whoever changed them (the settings page, say). */
  onLocalChanged(cb: (keys: string[]) => void): void;
  /**
   * Keeps the background running, which an idle one otherwise isn't, until the returned function
   * is called. `onTick` is called on each of the periodic wake-ups that keep it running.
   */
  keepRunning(onTick: () => void): () => void;
  /** Opens an extension page in a new tab; `query` becomes its query string. */
  openPage(p: PageName, query?: Record<string, string>): Promise<void>;
  /** Marks the toolbar icon for that tab only; `null` takes the mark off. Rejects for a closed tab. */
  setBadge(tabId: number, badge: Badge | null): Promise<void>;
  /**
   * Runs autoconsent's eval snippet `snippetId` in that document's main world, wherever in the tab
   * it is, and resolves with its result: never in a document that replaced it. Rejects for an
   * unknown snippet, or a document that is gone or can't be run in.
   */
  runInMainWorld(tabId: number, documentId: string, snippetId: string): Promise<unknown>;
}

export interface ContentPlatform {
  /**
   * Resolves `undefined` when the background could not answer (its handler failed). Rejects when
   * there is no background to ask. Either way, the caller stands down.
   */
  send<M extends ToBackground>(m: M): Promise<ReplyOf<M> | undefined>;
  onMessage(h: (m: ToContent) => void): void;
}

export interface PagePlatform {
  local: KV;
  /** As `ContentPlatform.send`. */
  send<M extends ToBackground>(m: M): Promise<ReplyOf<M> | undefined>;
  openPage(p: PageName, query?: Record<string, string>): Promise<void>;
}

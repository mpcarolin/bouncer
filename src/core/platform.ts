import type { FrameMessage, ReplyOf, ToBackground, ToContent } from "./messages.ts";

export interface KV {
  get<T>(k: string): Promise<T | undefined>;
  set(k: string, v: unknown): Promise<void>;
  remove(k: string): Promise<void>;
}

/**
 * Who sent a message. A sender with no tab (a popup or an offscreen document; settings and
 * onboarding are tabs) has `tabId` -1 and `frameId` -1.
 */
export interface Sender {
  tabId: number;
  frameId: number;
  documentId: string;
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
  /** Opens an extension page in a new tab; `query` becomes its query string. */
  openPage(p: PageName, query?: Record<string, string>): Promise<void>;
  /**
   * Runs autoconsent's eval snippet `snippetId` in the frame's main world and resolves with its
   * result. Rejects for an unknown snippet or a frame it can't run in.
   */
  runInMainWorld(tabId: number, frameId: number, snippetId: string): Promise<unknown>;
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

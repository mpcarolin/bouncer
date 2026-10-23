import type { ReplyOf, ToBackground, ToContent } from "./messages.ts";

export interface KV {
  get<T>(k: string): Promise<T | undefined>;
  set(k: string, v: unknown): Promise<void>;
  remove(k: string): Promise<void>;
}

/** Who sent a message. An extension page (no tab) has `tabId` -1 and `frameId` -1. */
export interface Sender {
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
}

export type PageName = "settings" | "onboarding";

export interface BackgroundPlatform {
  /** Survives browser restarts. */
  local: KV;
  /** Survives a service-worker restart, not a browser restart. */
  session: KV;
  /** Returning undefined replies at once with nothing. */
  onMessage(h: (msg: unknown, from: Sender) => Promise<unknown> | undefined): void;
  sendToFrame(tabId: number, frameId: number, msg: ToContent): Promise<void>;
  onTabRemoved(cb: (tabId: number) => void): void;
  /** The toolbar icon was clicked. `url` is the active tab's, when the browser exposes it. */
  onActionClicked(cb: (tab: { url?: string }) => void): void;
  /** `reason` is the browser's word for why: `install`, `update`, … */
  onInstalled(cb: (reason: string) => void): void;
  /** Opens an extension page in a new tab; `query` becomes its query string. */
  openPage(p: PageName, query?: Record<string, string>): Promise<void>;
  /** autoconsent eval. */
  runInMainWorld(tabId: number, frameId: number, snippetId: string): Promise<unknown>;
}

export interface ContentPlatform {
  send<M extends ToBackground>(m: M): Promise<ReplyOf<M>>;
  onMessage(h: (m: ToContent) => void): void;
}

export interface PagePlatform {
  local: KV;
  send<M extends ToBackground>(m: M): Promise<ReplyOf<M>>;
  openPage(p: PageName, query?: Record<string, string>): Promise<void>;
}

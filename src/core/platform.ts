import type { ReplyOf, ToBackground, ToContent } from "./messages.ts";

export interface KV {
  get<T>(k: string): Promise<T | undefined>;
  set(k: string, v: unknown): Promise<void>;
  remove(k: string): Promise<void>;
}

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
  openPage(p: PageName): Promise<void>;
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
  openPage(p: PageName): Promise<void>;
}

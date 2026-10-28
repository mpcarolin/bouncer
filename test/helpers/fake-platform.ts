import type { Badge } from "../../src/core/badge.ts";
import {
  type FrameMessage,
  isToContent,
  type ReplyOf,
  type ToBackground,
  type ToContent,
} from "../../src/core/messages.ts";
import type {
  BackgroundPlatform,
  ContentPlatform,
  KV,
  PageName,
  PagePlatform,
  Sender,
} from "../../src/core/platform.ts";

/**
 * In-memory fakes of the platform interfaces, shared by later tasks' tests.
 *
 * - Values cross every boundary (KV, messages, replies) as `structuredClone` copies, so a test
 *   can't pass by aliasing an object the code under test still holds.
 * - `fakeBackground()` is the service worker. `restart()` simulates Chrome stopping it:
 *   registered handlers are dropped and the owner must re-register them, but `local` and
 *   `session` contents are kept.
 * - `fakeContent(bg, sender?)` is one frame's content script. Its `send` reaches the background's
 *   message handler with `content.sender` as the sender (a mutable field: change `url` to simulate
 *   navigation). `bg.sendToFrame` reaches the content whose `sender.tabId`/`frameId` (and
 *   `documentId`, when the call names one) match: every
 *   message lands in its `inbox` (autoconsent's too, since its content script shares the frame),
 *   and Bouncer's own also reach the `onMessage` handlers.
 * - `fakePage(bg)` is an extension page (settings, onboarding): it shares the background's
 *   `local`, as the extension's pages share `chrome.storage.local`, and its messages reach the
 *   background's handler from a sender with no tab.
 */

export class MemoryKV implements KV {
  private data = new Map<string, unknown>();

  /** `changed` hears of every write, after it, in a later microtask (as `storage.onChanged`). */
  constructor(private readonly changed?: (key: string) => void) {}

  async get<T>(k: string): Promise<T | undefined> {
    return this.data.has(k) ? (structuredClone(this.data.get(k)) as T) : undefined;
  }

  async set(k: string, v: unknown): Promise<void> {
    this.data.set(k, structuredClone(v));
    this.tell(k);
  }

  async remove(k: string): Promise<void> {
    this.data.delete(k);
    this.tell(k);
  }

  private tell(k: string): void {
    const changed = this.changed;
    if (changed) queueMicrotask(() => changed(k));
  }
}

type MessageHandler = (msg: unknown, from: Sender) => Promise<unknown> | undefined;

export interface FakeBackground extends BackgroundPlatform {
  /** Simulate a service-worker restart: drop handlers, keep `local` and `session`. */
  restart(): void;
  /** Fire the registered `onTabRemoved` callbacks. */
  removeTab(tabId: number): void;
  /** Fire the registered `onActionClicked` callbacks (the toolbar icon was clicked). */
  clickAction(tab: { url?: string }): void;
  /** Fire the registered `onInstalled` callbacks. */
  install(reason: string): void;
  /** Fire the registered `onStartup` callbacks (the browser started). */
  startup(): void;
  /** How many `keepRunning` holds are in force. A restart ends them, as it ends a worker's timers. */
  running: number;
  /** One of the background's periodic wake-ups: every hold in force calls its `onTick`. */
  tick(): void;
  /** Pages passed to `openPage`, in order. */
  opened: PageName[];
  /** The same calls with their query strings. */
  openedWith: { page: PageName; query?: Record<string, string> }[];
  /** Each tab's toolbar mark, as the last `setBadge` for it left it. */
  badges: Map<number, Badge | null>;
  /** Every `setBadge` call, in order. */
  badgeCalls: { tabId: number; badge: Badge | null }[];
  /** Every `sendToFrame` call, delivered or not, in order. */
  frameSends: { tabId: number; frameId: number; documentId?: string; msg: FrameMessage }[];
  /**
   * Main-world snippets asked for, in order; `mainWorldResult` is what they return. Like Chrome,
   * one for a document no content holds rejects.
   */
  mainWorldCalls: { tabId: number; documentId: string; snippetId: string }[];
  mainWorldResult: (snippetId: string) => unknown;
  /** @internal registry used by `fakeContent`. */
  contents: Set<FakeContent>;
  /** @internal deliver a content message to the background. */
  deliver(msg: unknown, from: Sender): Promise<unknown>;
}

export function fakeBackground(): FakeBackground {
  let messageHandler: MessageHandler | undefined;
  let tabRemovedHandlers: ((tabId: number) => void)[] = [];
  let actionHandlers: ((tab: { url?: string }) => void)[] = [];
  let installedHandlers: ((reason: string) => void)[] = [];
  let startupHandlers: (() => void)[] = [];
  let localChangedHandlers: ((keys: string[]) => void)[] = [];
  let holds = new Set<() => void>();
  const bg: FakeBackground = {
    local: new MemoryKV((key) => {
      for (const cb of localChangedHandlers) cb([key]);
    }),
    session: new MemoryKV(),
    get running() {
      return holds.size;
    },
    opened: [],
    openedWith: [],
    badges: new Map(),
    badgeCalls: [],
    frameSends: [],
    mainWorldCalls: [],
    mainWorldResult: () => undefined,
    contents: new Set(),
    onMessage(h) {
      messageHandler = h;
    },
    onTabRemoved(cb) {
      tabRemovedHandlers.push(cb);
    },
    onActionClicked(cb) {
      actionHandlers.push(cb);
    },
    onInstalled(cb) {
      installedHandlers.push(cb);
    },
    onStartup(cb) {
      startupHandlers.push(cb);
    },
    onLocalChanged(cb) {
      localChangedHandlers.push(cb);
    },
    keepRunning(onTick) {
      const hold = () => onTick();
      holds.add(hold);
      return () => {
        holds.delete(hold);
      };
    },
    async sendToFrame(tabId, frameId, msg, documentId) {
      bg.frameSends.push({ tabId, frameId, documentId, msg: structuredClone(msg) });
      const target = [...bg.contents].find(
        (c) => c.sender.tabId === tabId && c.sender.frameId === frameId,
      );
      if (!target) throw new Error(`no content script at tab ${tabId} frame ${frameId}`);
      // Like Chrome: a message for one document never reaches the one that replaced it.
      if (documentId !== undefined && target.sender.documentId !== documentId) {
        throw new Error(`document ${documentId} is not the one in tab ${tabId} frame ${frameId}`);
      }
      const copy = structuredClone(msg);
      target.inbox.push(copy);
      if (isToContent(copy)) for (const h of target.handlers) h(structuredClone(copy));
    },
    async openPage(p, query) {
      bg.opened.push(p);
      bg.openedWith.push({ page: p, query: query && { ...query } });
    },
    async setBadge(tabId, badge) {
      bg.badgeCalls.push({ tabId, badge: structuredClone(badge) });
      bg.badges.set(tabId, structuredClone(badge));
    },
    async runInMainWorld(tabId, documentId, snippetId) {
      bg.mainWorldCalls.push({ tabId, documentId, snippetId });
      const held = [...bg.contents].some(
        (c) => c.sender.tabId === tabId && c.sender.documentId === documentId,
      );
      if (!held) throw new Error(`No document with id ${documentId} in tab ${tabId}`);
      return structuredClone(bg.mainWorldResult(snippetId));
    },
    restart() {
      messageHandler = undefined;
      tabRemovedHandlers = [];
      actionHandlers = [];
      installedHandlers = [];
      startupHandlers = [];
      localChangedHandlers = [];
      holds = new Set();
    },
    removeTab(tabId) {
      for (const cb of tabRemovedHandlers) cb(tabId);
    },
    clickAction(tab) {
      for (const cb of actionHandlers) cb({ ...tab });
    },
    install(reason) {
      for (const cb of installedHandlers) cb(reason);
    },
    startup() {
      for (const cb of startupHandlers) cb();
    },
    tick() {
      for (const hold of [...holds]) hold();
    },
    async deliver(msg, from) {
      // Like Chrome, a message with no listener rejects.
      if (!messageHandler) throw new Error("Receiving end does not exist");
      const reply = messageHandler(structuredClone(msg), { ...from });
      return reply === undefined ? undefined : structuredClone(await reply);
    },
  };
  return bg;
}

export interface FakeContent extends ContentPlatform {
  /**
   * Mutable: tests may change `url` and `tabUrl` (navigation; for a top frame they are the same
   * page), `documentId`, or `frameId` and `documentLifecycle` (a prerendered page being shown).
   */
  sender: Sender;
  /** Everything `sendToFrame` delivered to this frame, Bouncer's messages and autoconsent's. */
  inbox: FrameMessage[];
  /** @internal */
  handlers: ((m: ToContent) => void)[];
}

/**
 * `sender.tabUrl` defaults to `sender.url`, which is right for a top frame. For a child frame,
 * pass both.
 */
export function fakeContent(bg: FakeBackground, sender: Partial<Sender> = {}): FakeContent {
  const url = sender.url ?? "https://example.com/";
  const content: FakeContent = {
    sender: {
      tabId: 1,
      frameId: 0,
      documentId: "doc-1",
      documentLifecycle: "active",
      tabUrl: url,
      ...sender,
      url,
    },
    inbox: [],
    handlers: [],
    send<M extends ToBackground>(m: M) {
      return bg.deliver(m, content.sender) as Promise<ReplyOf<M> | undefined>;
    },
    onMessage(h) {
      content.handlers.push(h);
    },
  };
  bg.contents.add(content);
  return content;
}

const PAGE_SENDER: Sender = {
  tabId: -1,
  frameId: -1,
  documentId: "",
  documentLifecycle: "active",
  url: "chrome-extension://fake-extension-id/settings.html",
  tabUrl: "chrome-extension://fake-extension-id/settings.html",
};

export function fakePage(bg: FakeBackground): PagePlatform {
  return {
    local: bg.local,
    send<M extends ToBackground>(m: M) {
      return bg.deliver(m, PAGE_SENDER) as Promise<ReplyOf<M> | undefined>;
    },
    async openPage() {},
  };
}

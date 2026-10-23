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
 *   navigation). `bg.sendToFrame` reaches the content whose `sender.tabId`/`frameId` match: every
 *   message lands in its `inbox` (autoconsent's too, since its content script shares the frame),
 *   and Bouncer's own also reach the `onMessage` handlers.
 */

export class MemoryKV implements KV {
  private data = new Map<string, unknown>();

  async get<T>(k: string): Promise<T | undefined> {
    return this.data.has(k) ? (structuredClone(this.data.get(k)) as T) : undefined;
  }

  async set(k: string, v: unknown): Promise<void> {
    this.data.set(k, structuredClone(v));
  }

  async remove(k: string): Promise<void> {
    this.data.delete(k);
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
  /** Pages passed to `openPage`, in order. */
  opened: PageName[];
  /** The same calls with their query strings. */
  openedWith: { page: PageName; query?: Record<string, string> }[];
  /** Main-world snippets run, in order; `mainWorldResult` is what they return. */
  mainWorldCalls: { tabId: number; frameId: number; snippetId: string }[];
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
  const bg: FakeBackground = {
    local: new MemoryKV(),
    session: new MemoryKV(),
    opened: [],
    openedWith: [],
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
    async sendToFrame(tabId, frameId, msg) {
      const target = [...bg.contents].find(
        (c) => c.sender.tabId === tabId && c.sender.frameId === frameId,
      );
      if (!target) throw new Error(`no content script at tab ${tabId} frame ${frameId}`);
      const copy = structuredClone(msg);
      target.inbox.push(copy);
      if (isToContent(copy)) for (const h of target.handlers) h(structuredClone(copy));
    },
    async openPage(p, query) {
      bg.opened.push(p);
      bg.openedWith.push({ page: p, query: query && { ...query } });
    },
    async runInMainWorld(tabId, frameId, snippetId) {
      bg.mainWorldCalls.push({ tabId, frameId, snippetId });
      return structuredClone(bg.mainWorldResult(snippetId));
    },
    restart() {
      messageHandler = undefined;
      tabRemovedHandlers = [];
      actionHandlers = [];
      installedHandlers = [];
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
   * page) or `documentId`.
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

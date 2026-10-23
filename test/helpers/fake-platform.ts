import type { ReplyOf, ToBackground, ToContent } from "../../src/core/messages.ts";
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
 *   navigation). `bg.sendToFrame` reaches the content whose `sender.tabId`/`frameId` match.
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
  /** Pages passed to `openPage`, in order. */
  opened: PageName[];
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
  const bg: FakeBackground = {
    local: new MemoryKV(),
    session: new MemoryKV(),
    opened: [],
    mainWorldCalls: [],
    mainWorldResult: () => undefined,
    contents: new Set(),
    onMessage(h) {
      messageHandler = h;
    },
    onTabRemoved(cb) {
      tabRemovedHandlers.push(cb);
    },
    async sendToFrame(tabId, frameId, msg) {
      const target = [...bg.contents].find(
        (c) => c.sender.tabId === tabId && c.sender.frameId === frameId,
      );
      if (!target) throw new Error(`no content script at tab ${tabId} frame ${frameId}`);
      const copy = structuredClone(msg);
      for (const h of target.handlers) h(copy);
    },
    async openPage(p) {
      bg.opened.push(p);
    },
    async runInMainWorld(tabId, frameId, snippetId) {
      bg.mainWorldCalls.push({ tabId, frameId, snippetId });
      return structuredClone(bg.mainWorldResult(snippetId));
    },
    restart() {
      messageHandler = undefined;
      tabRemovedHandlers = [];
    },
    removeTab(tabId) {
      for (const cb of tabRemovedHandlers) cb(tabId);
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
  /** Mutable: tests may change `url` (navigation) or `documentId`. */
  sender: Sender;
  /** @internal */
  handlers: ((m: ToContent) => void)[];
}

export function fakeContent(bg: FakeBackground, sender: Partial<Sender> = {}): FakeContent {
  const content: FakeContent = {
    sender: {
      tabId: 1,
      frameId: 0,
      documentId: "doc-1",
      url: "https://example.com/",
      ...sender,
    },
    handlers: [],
    send<M extends ToBackground>(m: M) {
      return bg.deliver(m, content.sender) as Promise<ReplyOf<M>>;
    },
    onMessage(h) {
      content.handlers.push(h);
    },
  };
  bg.contents.add(content);
  return content;
}

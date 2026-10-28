import { vi } from "vitest";

/**
 * A stand-in for the `chrome.*` APIs the Chrome platform adapters use, installed as the global
 * `chrome`. It models Chrome closely where the adapters depend on it:
 *
 * - `runtime.onMessage` follows Chrome's reply rules: a listener that calls `sendResponse` before
 *   returning, or returns anything but `true`, closes the channel; one that returns `true` keeps
 *   it open for a later `sendResponse`. `deliver()` shows which of those happened.
 * - Storage areas keep what `JSON.stringify` keeps, as Chrome does (an `undefined` value is dropped).
 * - `runtime.sendMessage` reaches the `onMessage` listeners with `fc.sender` as the sender, and
 *   rejects when there are none, as Chrome does.
 * - `connect()` opens a port to the `runtime.onConnect` listeners; with none, Chrome fails it.
 *
 * Every call the adapters make is recorded for the test to inspect. Undo with
 * `vi.unstubAllGlobals()`.
 */

export interface FakeSender {
  tab?: { id?: number; url?: string };
  frameId?: number;
  documentId?: string;
  documentLifecycle?: chrome.extensionTypes.DocumentLifecycle;
  url?: string;
}

export interface Delivery {
  /** What the listener returned; `true` keeps the channel open for an asynchronous reply. */
  returned: unknown;
  /** True when `sendResponse` was called before the listener returned. */
  repliedSync: boolean;
  /** Every `sendResponse` call's arguments, in order. */
  responses: unknown[][];
  /** Settles with the reply: what `sendResponse` got, or `undefined` if the channel closed unanswered. */
  reply: Promise<unknown>;
}

class FakeEvent<A extends unknown[], R = void> {
  listeners: ((...args: A) => R)[] = [];

  addListener = (fn: (...args: A) => R): void => {
    this.listeners.push(fn);
  };

  fire(...args: A): R[] {
    return this.listeners.map((l) => l(...args));
  }
}

class FakeArea {
  private data = new Map<string, string>();

  get = async (key: string): Promise<Record<string, unknown>> => {
    const raw = this.data.get(key);
    return raw === undefined ? {} : { [key]: JSON.parse(raw) };
  };

  set = async (items: Record<string, unknown>): Promise<void> => {
    for (const [k, v] of Object.entries(items)) {
      if (v !== undefined) this.data.set(k, JSON.stringify(v));
    }
  };

  remove = async (key: string): Promise<void> => {
    this.data.delete(key);
  };

  keys(): string[] {
    return [...this.data.keys()];
  }
}

export interface ExecuteScriptCall {
  target: { tabId: number; frameIds?: number[]; documentIds?: string[] };
  world?: string;
  func: unknown;
}

export interface FakeChrome {
  /** The sender `runtime.sendMessage` presents to `onMessage` listeners. */
  sender: FakeSender;
  local: FakeArea;
  session: FakeArea;
  /** `tabs.sendMessage` calls. */
  sent: { tabId: number; msg: unknown; options: unknown }[];
  /** What `tabs.sendMessage` resolves with, or `sendError` makes it reject with. */
  sendReply: unknown;
  sendError: Error | undefined;
  /** `tabs.create` calls. */
  created: { url?: string }[];
  /** `scripting.executeScript` calls. */
  scripts: ExecuteScriptCall[];
  /** The `result` of the one frame `executeScript` reports, unless `scriptResults` is set. */
  scriptResult: unknown;
  scriptResults: { frameId: number; result?: unknown }[] | undefined;
  scriptError: Error | undefined;
  /** `runtime.sendMessage` calls. */
  messages: unknown[];
  /** `action.set*` calls, as [method, details]. */
  actionCalls: [string, unknown][];
  /** Makes every `action.set*` call reject with it, as Chrome does for a closed tab. */
  actionError: Error | undefined;
  /** Listener counts, to check that registration happened. */
  listenerCounts(): Record<
    "message" | "connect" | "tabRemoved" | "action" | "installed" | "startup" | "storageChanged",
    number
  >;
  /** `runtime.getPlatformInfo` calls. */
  platformInfoCalls: number;
  /** Dispatch a message to the `onMessage` listeners as Chrome would. */
  deliver(msg: unknown, sender?: FakeSender): Delivery;
  removeTab(tabId: number): void;
  clickAction(tab: { id?: number; url?: string }): void;
  /**
   * A content script's `runtime.connect({ name })`. `accepted` is false when no `onConnect`
   * listener took it: Chrome then fails the connect and logs an unchecked `runtime.lastError` in
   * the frame. `disconnected` is true once a listener has disconnected the port.
   */
  connect(name: string): { accepted: boolean; disconnected: boolean };
  /** Fire `runtime.onInstalled`. */
  installed(reason: string): void;
  /** Fire `runtime.onStartup`. */
  startup(): void;
  /** Fire `storage.onChanged` for these keys of `area`. */
  storageChanged(keys: string[], area: string): void;
  /** The object installed as `globalThis.chrome`. */
  readonly chrome: typeof chrome;
}

export const EXTENSION_ORIGIN = "chrome-extension://fake-extension-id";

/** Creates the fake and installs it as `globalThis.chrome`. */
export function installFakeChrome(): FakeChrome {
  const onMessage = new FakeEvent<
    [msg: unknown, sender: FakeSender, sendResponse: (value?: unknown) => void],
    boolean | undefined
  >();
  const onTabRemoved = new FakeEvent<[tabId: number]>();
  const onClicked = new FakeEvent<[tab: { id?: number; url?: string }]>();
  const onInstalled = new FakeEvent<[details: { reason: string }]>();
  const onConnect = new FakeEvent<[port: chrome.runtime.Port]>();
  const onStartup = new FakeEvent<[]>();
  const onStorageChanged = new FakeEvent<
    [changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string]
  >();

  const fc: FakeChrome = {
    sender: {
      tab: { id: 1, url: "https://example.com/" },
      frameId: 0,
      documentId: "doc-1",
      url: "https://example.com/",
    },
    local: new FakeArea(),
    session: new FakeArea(),
    sent: [],
    sendReply: undefined,
    sendError: undefined,
    created: [],
    scripts: [],
    scriptResult: undefined,
    scriptResults: undefined,
    scriptError: undefined,
    messages: [],
    actionCalls: [],
    actionError: undefined,
    listenerCounts: () => ({
      message: onMessage.listeners.length,
      connect: onConnect.listeners.length,
      tabRemoved: onTabRemoved.listeners.length,
      action: onClicked.listeners.length,
      installed: onInstalled.listeners.length,
      startup: onStartup.listeners.length,
      storageChanged: onStorageChanged.listeners.length,
    }),
    platformInfoCalls: 0,
    deliver(msg, sender = fc.sender) {
      let respond: (value?: unknown) => void = () => {};
      const reply = new Promise<unknown>((resolve) => {
        respond = resolve;
      });
      const responses: unknown[][] = [];
      let listenerReturned = false;
      let repliedSync = false;
      const sendResponse = (...args: unknown[]) => {
        responses.push(args);
        if (!listenerReturned) repliedSync = true;
        respond(args[0]);
      };
      const returns = onMessage.fire(structuredClone(msg), structuredClone(sender), sendResponse);
      listenerReturned = true;
      const keepOpen = returns.includes(true);
      // A closed channel with no response settles the sender's promise with nothing.
      if (!keepOpen && !repliedSync) respond(undefined);
      return { returned: keepOpen ? true : returns[0], repliedSync, responses, reply };
    },
    removeTab: (tabId) => void onTabRemoved.fire(tabId),
    clickAction: (tab) => void onClicked.fire(tab),
    connect(name) {
      const opened = { accepted: onConnect.listeners.length > 0, disconnected: false };
      const port = {
        name,
        sender: structuredClone(fc.sender),
        disconnect: () => {
          opened.disconnected = true;
        },
        postMessage: () => {},
        onMessage: new FakeEvent(),
        onDisconnect: new FakeEvent(),
      } as unknown as chrome.runtime.Port;
      onConnect.fire(port);
      return opened;
    },
    installed: (reason) => void onInstalled.fire({ reason }),
    startup: () => void onStartup.fire(),
    storageChanged: (keys, area) =>
      void onStorageChanged.fire(Object.fromEntries(keys.map((k) => [k, { newValue: 1 }])), area),
    chrome: undefined as unknown as typeof chrome,
  };

  const api = {
    runtime: {
      onMessage,
      onInstalled,
      onConnect,
      onStartup,
      getPlatformInfo: async () => {
        fc.platformInfoCalls++;
        return { os: "mac", arch: "arm64", nacl_arch: "arm" };
      },
      getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
      sendMessage: async (msg: unknown) => {
        fc.messages.push(structuredClone(msg));
        if (onMessage.listeners.length === 0) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return fc.deliver(msg).reply;
      },
    },
    tabs: {
      onRemoved: onTabRemoved,
      create: async (props: { url?: string }) => {
        fc.created.push({ ...props });
        return { id: 99, ...props };
      },
      sendMessage: async (tabId: number, msg: unknown, options?: unknown) => {
        fc.sent.push({ tabId, msg: structuredClone(msg), options });
        if (fc.sendError) throw fc.sendError;
        return fc.sendReply;
      },
    },
    action: {
      onClicked,
      ...Object.fromEntries(
        ["setBadgeText", "setBadgeBackgroundColor", "setBadgeTextColor", "setTitle"].map((m) => [
          m,
          async (details: unknown) => {
            fc.actionCalls.push([m, structuredClone(details)]);
            if (fc.actionError) throw fc.actionError;
          },
        ]),
      ),
    },
    storage: { local: fc.local, session: fc.session, onChanged: onStorageChanged },
    scripting: {
      executeScript: async (injection: ExecuteScriptCall) => {
        fc.scripts.push(injection);
        if (fc.scriptError) throw fc.scriptError;
        return (
          fc.scriptResults ?? [
            { frameId: injection.target.frameIds?.[0] ?? 0, result: fc.scriptResult },
          ]
        );
      },
    },
  };

  (fc as { chrome: unknown }).chrome = api;
  vi.stubGlobal("chrome", api);
  return fc;
}

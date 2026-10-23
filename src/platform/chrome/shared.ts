import type { ReplyOf, ToBackground } from "../../core/messages.ts";
import type { KV, PageName } from "../../core/platform.ts";
import { pageFile } from "./pages.ts";

/** A `KV` over one `chrome.storage` area. Values are stored as JSON, as the area does. */
export function chromeKV(area: chrome.storage.StorageArea): KV {
  return {
    async get<T>(k: string): Promise<T | undefined> {
      const found = await area.get(k);
      return found[k] as T | undefined;
    },
    set: (k, v) => area.set({ [k]: v }),
    remove: (k) => area.remove(k),
  };
}

/** Opens the page (`pageFile`) from this extension in a new tab. `query` becomes its query string. */
export async function openExtensionPage(
  page: PageName,
  query?: Record<string, string>,
): Promise<void> {
  const search = new URLSearchParams(query).toString();
  const url = chrome.runtime.getURL(pageFile(page)) + (search ? `?${search}` : "");
  await chrome.tabs.create({ url });
}

/**
 * Sends one message to the background and resolves with its reply. Written as an `async`
 * function so that even a synchronous throw (an invalidated extension context) is a rejection.
 */
export async function sendToBackground<M extends ToBackground>(
  m: M,
): Promise<ReplyOf<M> | undefined> {
  return (await chrome.runtime.sendMessage(m)) as ReplyOf<M> | undefined;
}

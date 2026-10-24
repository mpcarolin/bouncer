import { evalSnippets, filterCompactRules, type IndexedCMPRuleset } from "@duckduckgo/autoconsent";
import type { AcLib } from "../../core/autoconsent-bg.ts";
import type { BackgroundPlatform, Sender } from "../../core/platform.ts";
import { chromeKV, openExtensionPage } from "./shared.ts";

/** autoconsent's compact rules, which the build copies, unmodified, beside its content bundle. */
const RULES_PATH = "vendor/autoconsent/compact-rules.json";

/**
 * autoconsent's library for the core. The rules are read from the extension's own package (not
 * the network) once per service-worker lifetime; a failed read is tried again by the next frame.
 */
export function chromeAcLib(): AcLib {
  let rules: Promise<IndexedCMPRuleset> | undefined;
  function load(): Promise<IndexedCMPRuleset> {
    if (!rules) {
      const read = fetch(chrome.runtime.getURL(RULES_PATH)).then(async (r) => {
        if (!r.ok) throw new Error(`could not read ${RULES_PATH}: ${r.status}`);
        return (await r.json()) as IndexedCMPRuleset;
      });
      rules = read;
      read.catch(() => {
        if (rules === read) rules = undefined;
      });
    }
    return rules;
  }
  return {
    async filterRules(url, mainFrame) {
      return filterCompactRules(await load(), { url, mainFrame });
    },
  };
}

/**
 * Chrome's sender, as Bouncer's. A sender with no tab (a popup or an offscreen document) gets
 * tabId -1, and one with no frame gets frameId -1, so it can never pass for a page's top frame
 * (frameId 0). `url` is the frame's own and `tabUrl` the tab's; each falls back to the other.
 * Chrome names the lifecycle of every document that sends; a sender with none is no prerender.
 */
function toSender(s: chrome.runtime.MessageSender): Sender {
  return {
    tabId: s.tab?.id ?? -1,
    frameId: s.frameId ?? -1,
    documentId: s.documentId ?? "",
    documentLifecycle: s.documentLifecycle ?? "active",
    url: s.url ?? s.tab?.url ?? "",
    tabUrl: s.tab?.url ?? s.url ?? "",
  };
}

/**
 * The background's `chrome.*` calls, used directly with no polyfill. Every listener is added
 * when the method is called, so the caller must call them synchronously during the service
 * worker's first turn or Chrome won't wake the worker for the event.
 */
export function chromeBackground(): BackgroundPlatform {
  return {
    local: chromeKV(chrome.storage.local),
    session: chromeKV(chrome.storage.session),

    onMessage(h) {
      // autoconsent's content script also opens a port to the background on start (DuckDuckGo's
      // own background follows its instances with it). Nothing comes over it that Bouncer needs,
      // but it must be accepted: with no listener, Chrome fails the connect and logs an unchecked
      // runtime.lastError in every frame of every page.
      chrome.runtime.onConnect.addListener(() => {});
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        let reply: Promise<unknown> | undefined;
        try {
          reply = h(msg, toSender(sender));
        } catch (e) {
          console.error("bouncer: message handler threw", e);
        }
        if (reply === undefined) {
          sendResponse();
          return false;
        }
        reply.then(sendResponse, (e) => {
          console.error("bouncer: message handler rejected", e);
          sendResponse();
        });
        return true;
      });
    },

    /**
     * Rejects when the frame has no receiver (navigated away, no content script there), or, with
     * a `documentId`, when that document is not the frame's any more.
     */
    async sendToFrame(tabId, frameId, msg, documentId) {
      await chrome.tabs.sendMessage(tabId, msg, documentId ? { frameId, documentId } : { frameId });
    },

    onTabRemoved(cb) {
      chrome.tabs.onRemoved.addListener((tabId) => cb(tabId));
    },

    onActionClicked(cb) {
      chrome.action.onClicked.addListener((tab) => cb({ url: tab.url }));
    },

    onInstalled(cb) {
      chrome.runtime.onInstalled.addListener((details) => cb(details.reason));
    },

    openPage: openExtensionPage,

    /**
     * autoconsent's `eval` rule steps run its own snippets, so the page's JS never chooses the
     * code. Aimed at the document, not the frame: a frame's next document never runs its last
     * one's eval.
     */
    async runInMainWorld(tabId, documentId, snippetId) {
      const snippet = (evalSnippets as Record<string, (() => unknown) | undefined>)[snippetId];
      if (!snippet) throw new Error(`unknown autoconsent eval snippet: ${snippetId}`);
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId, documentIds: [documentId] },
        world: "MAIN",
        func: snippet,
      });
      return frame?.result;
    },
  };
}

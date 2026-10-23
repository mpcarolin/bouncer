import type { PagePlatform } from "../../core/platform.ts";
import { chromeKV, openExtensionPage, sendToBackground } from "./shared.ts";

/** What an extension page (settings, onboarding) uses of `chrome.*`. */
export function chromePage(): PagePlatform {
  return {
    local: chromeKV(chrome.storage.local),
    send: sendToBackground,
    openPage: openExtensionPage,
  };
}

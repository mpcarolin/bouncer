import { isToContent } from "../../core/messages.ts";
import type { ContentPlatform } from "../../core/platform.ts";
import { sendToBackground } from "./shared.ts";

/**
 * The content script's `chrome.*` calls. Bouncer's and autoconsent's content scripts share one
 * isolated world, so this listener also hears autoconsent's replies (`initResp`, `evalResp`,
 * ...). Only Bouncer's own messages get through, and the listener never claims the reply channel,
 * so it can't hold up autoconsent's.
 */
export function chromeContent(): ContentPlatform {
  return {
    send: sendToBackground,
    onMessage(h) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (isToContent(msg)) h(msg);
        return false;
      });
    },
  };
}

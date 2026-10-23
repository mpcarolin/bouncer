import { RemoteAiProvider } from "../core/ai-remote.ts";
import type { ReplyOf, ToContent } from "../core/messages.ts";
import { removeAcStyles } from "../core/page/ac-styles.ts";
import { ScrollTracker } from "../core/page/scroll.ts";
import { OwnPath } from "../core/pipeline/own-path.ts";
import type { ContentPlatform } from "../core/platform.ts";
import { chromeContent } from "../platform/chrome/content.ts";

const platform = chromeContent();

// Every frame: autoconsent runs in iframes too, and the background asks the frame that opted out.
platform.onMessage((m) => {
  if (m.type === "restoreAcStyles") removeAcStyles(document);
});

/** Resolves once the page is shown: a prerendered page is not one the user is on yet. */
function shown(): Promise<void> {
  if (!(document as Document & { prerendering?: boolean }).prerendering) return Promise.resolve();
  return new Promise((resolve) =>
    document.addEventListener("prerenderingchange", () => resolve(), { once: true }),
  );
}

/** Bouncer's own path runs in the top frame only, and only when the page is enabled. */
async function topFrame(): Promise<void> {
  // The scroll snapshot starts at document_start (§2a), before the hello's round trip.
  const scroll = new ScrollTracker(document);
  scroll.refresh(false);
  // autoconsent's notices can arrive before the pipeline listens: hold them until it does.
  const early: ToContent[] = [];
  let deliver: ((m: ToContent) => void) | null = null;
  platform.onMessage((m) => (deliver ? deliver(m) : early.push(m)));

  await shown();
  let hello: ReplyOf<{ type: "hello" }> | undefined;
  try {
    hello = await platform.send({ type: "hello" });
  } catch {
    hello = undefined; // no background to ask: stand down
  }
  if (!hello?.enabled) {
    deliver = () => {};
    early.length = 0;
    return;
  }
  const page: ContentPlatform = {
    send: platform.send,
    onMessage(h) {
      deliver = h;
      for (const m of early.splice(0)) h(m);
    },
  };
  new OwnPath({
    doc: document,
    win: window,
    platform: page,
    ai: new RemoteAiProvider(platform),
    settings: hello.settings,
    learnedRule: hello.learnedRule,
    scroll,
  }).start();
}

if (window === top) {
  topFrame().catch((e) => console.error("Bouncer: content script failed", e));
}

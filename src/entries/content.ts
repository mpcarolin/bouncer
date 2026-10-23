import { removeAcStyles } from "../core/page/ac-styles.ts";
import { chromeContent } from "../platform/chrome/content.ts";

const platform = chromeContent();

// Every frame: autoconsent runs in iframes too, and the background asks the frame that opted out.
platform.onMessage((m) => {
  if (m.type === "restoreAcStyles") removeAcStyles(document);
});

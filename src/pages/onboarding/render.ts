import { createDownloader, type Downloader } from "../../ai/compose.ts";
import type { PagePlatform } from "../../core/platform.ts";
import { h } from "../dom.ts";
import { mountModel } from "../model.ts";

export interface OnboardingOptions {
  /** Downloads the model. Injected by tests; the Chrome build's by default. */
  download?: Downloader;
}

/**
 * The page opened on install: checks the on-device model and, if it can be downloaded, offers the
 * download. Bouncer does nothing without the model's help, so this is the one thing to do first.
 */
export async function renderOnboarding(
  root: HTMLElement,
  p: PagePlatform,
  opts: OnboardingOptions = {},
): Promise<void> {
  const model = h("div", { class: "model" });
  root.replaceChildren(
    h("h1", {}, "Bouncer"),
    h(
      "p",
      {},
      "Bouncer refuses cookie banners for you. It reads each banner with Chrome's on-device model, so nothing about the pages you visit leaves your computer.",
    ),
    h("h2", {}, "The on-device model"),
    model,
    h(
      "p",
      { class: "dim" },
      "Once the model is ready there is nothing else to do: Bouncer works quietly while you browse. Its settings and decision log are behind its icon in the toolbar.",
    ),
  );
  await mountModel(model, p, opts.download ?? createDownloader());
}

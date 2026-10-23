import { createDownloader, type Downloader } from "../../ai/compose.ts";
import { LearnedRules } from "../../core/learned.ts";
import { DecisionLog } from "../../core/log.ts";
import type { PagePlatform } from "../../core/platform.ts";
import { h } from "../dom.ts";
import { mountModel } from "../model.ts";
import { mountControls } from "./controls.ts";
import { mountLog } from "./log-table.ts";
import { mountRules } from "./rules.ts";

export interface SettingsOptions {
  /** The hostname the page was opened for (`?site=`): the active tab's. Nothing when none. */
  site?: string;
  /** Downloads the model. Injected by tests; the Chrome build's by default. */
  download?: Downloader;
}

function section(title: string, ...content: HTMLElement[]): HTMLElement {
  return h("section", {}, h("h2", {}, title), ...content);
}

/** The settings page: the switches, the learned rules, the model, and the decision log. */
export async function renderSettings(
  root: HTMLElement,
  p: PagePlatform,
  opts: SettingsOptions = {},
): Promise<void> {
  const controls = h("div");
  const rules = h("div");
  const model = h("div", { class: "model" });
  const log = h("div");
  root.replaceChildren(
    h("h1", {}, "Bouncer"),
    section("Settings", controls),
    section(
      "Learned rules",
      h(
        "p",
        { class: "dim" },
        "Rules Bouncer learned from banners it refused, kept on this device.",
      ),
      rules,
    ),
    section("On-device model", model),
    section("Decision log", log),
  );
  await Promise.all([
    mountControls(controls, p.local, opts.site),
    mountRules(rules, new LearnedRules(p.local)),
    mountModel(model, p, opts.download ?? createDownloader()),
    mountLog(log, new DecisionLog(p.local)),
  ]);
}

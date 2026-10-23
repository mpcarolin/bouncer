// The model's status and its download: one widget, shared by the settings and onboarding pages.
import type { Downloader } from "../ai/compose.ts";
import type { AiStatus } from "../core/ai.ts";
import type { PagePlatform } from "../core/platform.ts";
import { h } from "./dom.ts";

/** Chrome's documented requirements for its on-device model, as the spec's Constraints quote them. */
const CHROME_REQUIREMENTS = [
  "Chrome 138 or newer",
  "macOS 13 or newer",
  "22 GB free on the volume that holds your Chrome profile (Chrome deletes the model if free space falls below 10 GB)",
  "A GPU with more than 4 GB of VRAM, or 16 GB of RAM with 4 or more CPU cores",
];

/** The model's status from the background, or `undefined` when it could not answer. */
async function readStatus(p: PagePlatform): Promise<AiStatus | undefined> {
  try {
    return await p.send({ type: "ai", op: "status", args: [] });
  } catch {
    return undefined;
  }
}

/**
 * Fills `box` with the model's status and what the user can do about it: nothing when it is
 * ready, a download button when it can be downloaded, the progress while it is downloading, and
 * the reason when this device can't run it. The download starts only from the button, since
 * Chrome starts one only from a user's click on a page; a download already running is followed
 * without one.
 */
export async function mountModel(
  box: HTMLElement,
  p: PagePlatform,
  download: Downloader,
): Promise<void> {
  show(box, await readStatus(p), download, true);
}

/** `attach`: follow a running download without a click (not after one just ended still running). */
function show(
  box: HTMLElement,
  status: AiStatus | undefined,
  download: Downloader,
  attach: boolean,
): void {
  box.setAttribute("aria-live", "polite");
  if (!status) {
    box.replaceChildren(
      h("p", { class: "warn" }, "Bouncer couldn't read the model's status. Reload this page."),
    );
    return;
  }
  const meta = h(
    "p",
    { class: "dim" },
    `State: ${status.state}. Runs on this device: ${status.onDevice ? "yes" : "no"}.`,
    status.reason ? ` Reported: ${status.reason}.` : "",
  );
  switch (status.state) {
    case "available":
      box.replaceChildren(
        h("p", { class: "ok" }, "Ready. Chrome's on-device model is installed."),
        meta,
      );
      return;
    case "downloadable": {
      const button = h("button", { type: "button" }, "Download the model");
      button.addEventListener("click", () => follow(box, download));
      box.replaceChildren(
        h(
          "p",
          {},
          "Bouncer reads banners with Chrome's on-device model, and it isn't downloaded yet. Nothing leaves your computer.",
        ),
        button,
        meta,
      );
      return;
    }
    case "downloading": {
      if (attach) {
        follow(box, download);
        return;
      }
      const button = h("button", { type: "button" }, "Show the download's progress");
      button.addEventListener("click", () => follow(box, download));
      box.replaceChildren(
        h("p", {}, "Chrome is still downloading its on-device model."),
        button,
        meta,
      );
      return;
    }
    case "unavailable":
      box.replaceChildren(
        h("p", { class: "warn" }, "This device can't run Chrome's on-device model."),
        h(
          "p",
          {},
          "Chrome's documented requirements (checked 2026-10-22) are below. They are Chrome's, not measured by Bouncer.",
        ),
        h("ul", {}, ...CHROME_REQUIREMENTS.map((r) => h("li", {}, r))),
        meta,
      );
  }
}

/** Shows the progress of the download and, when it ends, the status it ends with. */
function follow(box: HTMLElement, download: Downloader): void {
  const bar = h("progress", { max: "1" });
  const percent = h("span", { class: "dim" });
  box.replaceChildren(
    h("p", {}, "Downloading Chrome's on-device model. Keep this tab open."),
    h("p", {}, bar, " ", percent),
  );
  const onProgress = (loaded: number) => {
    const fraction = Math.min(1, Math.max(0, Number.isFinite(loaded) ? loaded : 0));
    bar.value = fraction;
    percent.textContent = `${Math.round(fraction * 100)}%`;
  };
  // The downloader never rejects; this only keeps the page from sticking if one ever does.
  download(onProgress)
    .catch(() => undefined)
    .then((status) => show(box, status, download, false));
}

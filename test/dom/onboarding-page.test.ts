import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Downloader } from "../../src/ai/compose.ts";
import { MockProvider } from "../../src/ai/mock/provider.ts";
import { PromptApiProvider } from "../../src/ai/prompt-api/provider.ts";
import type { AiStatus } from "../../src/core/ai.ts";
import { startBackground } from "../../src/core/background-app.ts";
import { renderOnboarding } from "../../src/pages/onboarding/render.ts";
import { fakeBackground, type FakeBackground, fakePage } from "../helpers/fake-platform.ts";
import { fakeLanguageModel } from "../helpers/fake-language-model.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

class StatusProvider extends MockProvider {
  constructor(private readonly reported: AiStatus) {
    super();
  }
  override async status(): Promise<AiStatus> {
    return this.reported;
  }
}

let bg: FakeBackground;
beforeEach(() => {
  bg = fakeBackground();
});
afterEach(unmountAll);

const available: AiStatus = { state: "available", onDevice: true };

/** A download the test steers: it reports progress and finishes when told to. */
function steered() {
  const run = {
    started: 0,
    progress: (_loaded: number) => {},
    finish: (_status: AiStatus) => {},
  };
  const download: Downloader = (onProgress) => {
    run.started++;
    run.progress = onProgress;
    return new Promise((resolve) => {
      run.finish = resolve;
    });
  };
  return { download, run };
}

async function open(status: AiStatus, download: Downloader) {
  startBackground(bg, new StatusProvider(status));
  const root = mount("");
  await renderOnboarding(root, fakePage(bg), { download });
  return root;
}

const button = (root: ParentNode) => root.querySelector("button");
const bar = (root: ParentNode) => root.querySelector("progress");

describe("onboarding page", () => {
  it("says it is ready when the model is available, with nothing to click", async () => {
    const root = await open(available, steered().download);
    expect(root.textContent).toContain("Ready");
    expect(button(root)).toBeNull();
    expect(bar(root)).toBeNull();
  });

  it("offers a download button when the model is downloadable, and starts nothing by itself", async () => {
    const { download, run } = steered();
    const root = await open({ state: "downloadable", onDevice: true }, download);
    expect(button(root)?.textContent).toContain("Download");
    expect(bar(root)).toBeNull();
    expect(run.started).toBe(0);
  });

  it("downloads on the click, and follows the progress as the monitor fires", async () => {
    const { download, run } = steered();
    const root = await open({ state: "downloadable", onDevice: true }, download);

    button(root)?.click();
    await vi.waitFor(() => expect(run.started).toBe(1));
    expect(button(root)).toBeNull(); // one download at a time
    expect(bar(root)?.hasAttribute("value")).toBe(false); // nothing reported yet: indeterminate

    run.progress(0.25);
    expect(bar(root)?.value).toBe(0.25);
    expect(root.textContent).toContain("25%");

    run.progress(0.8);
    expect(bar(root)?.value).toBe(0.8);
    expect(root.textContent).toContain("80%");

    run.progress(7); // a fraction outside 0..1 is held to it
    expect(bar(root)?.value).toBe(1);

    run.finish(available);
    await vi.waitFor(() => expect(root.textContent).toContain("Ready"));
    expect(bar(root)).toBeNull();
    expect(run.started).toBe(1);
  });

  it("downloads through the Prompt API, showing the progress Chrome's monitor reports", async () => {
    const fake = fakeLanguageModel({
      availability: "downloadable",
      downloadProgress: [0.25, 0.75],
      createMs: 50,
    });
    const provider = new PromptApiProvider(fake.lm);
    startBackground(bg, provider);
    const root = mount("");
    await renderOnboarding(root, fakePage(bg), {
      download: (onProgress) => provider.download(onProgress),
    });
    expect(fake.state.createCalls).toHaveLength(0); // nothing before the click

    button(root)?.click();
    await vi.waitFor(() => expect(bar(root)?.value).toBe(0.75));
    expect(fake.state.createCalls).toHaveLength(1);
    await vi.waitFor(() => expect(root.textContent).toContain("Ready"));
    expect(fake.state.destroyed).toBe(1);
  });

  it("shows a download that is already running, and finishes with it", async () => {
    const { download, run } = steered();
    const root = await open({ state: "downloading", onDevice: true }, download);
    // It attaches to the running download rather than waiting for a click.
    expect(run.started).toBe(1);
    expect(button(root)).toBeNull();
    expect(bar(root)).not.toBeNull();
    run.progress(0.5);
    expect(bar(root)?.value).toBe(0.5);
    run.finish(available);
    await vi.waitFor(() => expect(root.textContent).toContain("Ready"));
  });

  it("offers the download again, with the reason, when it failed", async () => {
    const { download, run } = steered();
    const root = await open({ state: "downloadable", onDevice: true }, download);
    button(root)?.click();
    await vi.waitFor(() => expect(run.started).toBe(1));
    run.finish({ state: "downloadable", reason: "download_error:NotAllowedError", onDevice: true });
    await vi.waitFor(() => expect(button(root)?.textContent).toContain("Download"));
    expect(root.textContent).toContain("download_error:NotAllowedError");
  });

  it("says plainly that the device can't run the model, quoting Chrome's requirements as Chrome's", async () => {
    const { download, run } = steered();
    const root = await open(
      { state: "unavailable", reason: "model_unavailable", onDevice: true },
      download,
    );
    expect(root.textContent).toContain("This device can't run Chrome's on-device model");
    expect(button(root)).toBeNull();
    expect(bar(root)).toBeNull();
    expect(run.started).toBe(0);
    const text = root.textContent ?? "";
    expect(text).toContain("Chrome's documented requirements");
    expect(text).toContain("Chrome 138");
    expect(text).toContain("macOS 13");
    expect(text).toContain("22 GB");
    expect(text).toContain("10 GB");
    expect(text).toMatch(/4 GB of VRAM/);
    expect(text).toMatch(/16 GB of RAM with 4 or more CPU cores/);
    expect(text).toContain("not measured by Bouncer");
    expect(text).toContain("model_unavailable"); // what the browser reported
  });

  it("says the status could not be read when the background did not answer", async () => {
    const root = mount("");
    // No background is listening: the message rejects.
    await renderOnboarding(root, fakePage(bg), { download: steered().download });
    expect(root.textContent).toContain("couldn't read");
    expect(button(root)).toBeNull();

    const quiet = mount("");
    const page = { ...fakePage(bg), send: async () => undefined };
    await renderOnboarding(quiet, page, { download: steered().download });
    expect(quiet.textContent).toContain("couldn't read");
  });

  it("a download that ends still downloading is not followed again by itself, but can be by a click", async () => {
    const { download, run } = steered();
    const root = await open({ state: "downloading", onDevice: true }, download);
    expect(run.started).toBe(1);
    run.finish({ state: "downloading", reason: "download_error:NotAllowedError", onDevice: true });
    await vi.waitFor(() => expect(button(root)?.textContent).toContain("progress"));
    expect(run.started).toBe(1);
    button(root)?.click();
    expect(run.started).toBe(2);
    expect(bar(root)).not.toBeNull();
  });

  it("points to the settings in the toolbar", async () => {
    const root = await open(available, steered().download);
    expect(root.textContent).toContain("toolbar");
  });
});

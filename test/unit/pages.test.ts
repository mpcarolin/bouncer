import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageName } from "../../src/core/platform.ts";
import { chromeBackground } from "../../src/platform/chrome/background.ts";
import { PAGE_SOURCES, pageFile } from "../../src/platform/chrome/pages.ts";
import { EXTENSION_ORIGIN, installFakeChrome } from "../helpers/fake-chrome.ts";

afterEach(() => vi.unstubAllGlobals());

describe("extension pages", () => {
  const pages = Object.keys(PAGE_SOURCES) as PageName[];

  it("each has the source HTML the build takes as its input", () => {
    expect([...pages].sort()).toEqual(["onboarding", "settings"]);
    for (const page of pages) expect(existsSync(PAGE_SOURCES[page])).toBe(true);
  });

  it("each is opened at the file the build emits for it", async () => {
    const fc = installFakeChrome();
    for (const page of pages) await chromeBackground().openPage(page);
    expect(fc.created.map((c) => c.url)).toEqual(
      pages.map((page) => `${EXTENSION_ORIGIN}/${pageFile(page)}`),
    );
  });
});

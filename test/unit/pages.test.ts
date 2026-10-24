import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageName } from "../../src/core/platform.ts";
import { chromeBackground } from "../../src/platform/chrome/background.ts";
import {
  DEV_PAGE_SOURCES,
  PAGE_SOURCES,
  pageFile,
  pagesFor,
} from "../../src/platform/chrome/pages.ts";
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

describe("the benchmark page", () => {
  const names = (mode: string) => pagesFor(mode).map(([page]) => page);

  it("has the source HTML the development build takes as its input, emitted as bench.html", () => {
    expect(existsSync(DEV_PAGE_SOURCES.bench)).toBe(true);
    expect(pageFile("bench")).toBe("bench.html");
  });

  it("is emitted by the development build only", () => {
    expect(names("development")).toEqual(["settings", "onboarding", "bench"]);
    expect(names("production")).toEqual(["settings", "onboarding"]);
    expect(names("e2e")).toEqual(["settings", "onboarding"]);
  });
});

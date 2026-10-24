import type { PageName } from "../../core/platform.ts";

/** Each page's source HTML, relative to the repo root. The build emits it as `pageFile(page)`. */
export const PAGE_SOURCES: Record<PageName, string> = {
  settings: "src/pages/settings/index.html",
  onboarding: "src/pages/onboarding/index.html",
};

/**
 * A page only the development build (`pnpm build:dev`) carries. Nothing in the product opens it:
 * its owner types `bench.html` after the extension's address. It is not a `PageName`, so the core
 * can't ask to open it.
 */
export type DevPageName = "bench";

export const DEV_PAGE_SOURCES: Record<DevPageName, string> = {
  bench: "src/pages/bench/index.html",
};

/** Where a page sits in the built extension, relative to its root. What `openExtensionPage` opens. */
export const pageFile = (page: PageName | DevPageName): string => `${page}.html`;

/** Every page a build in Vite mode `mode` emits: the product's, plus the benchmark in development. */
export function pagesFor(mode: string): [PageName | DevPageName, string][] {
  return [
    ...(Object.entries(PAGE_SOURCES) as [PageName, string][]),
    ...(mode === "development"
      ? (Object.entries(DEV_PAGE_SOURCES) as [DevPageName, string][])
      : []),
  ];
}

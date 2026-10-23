import type { PageName } from "../../core/platform.ts";

/** Each page's source HTML, relative to the repo root. The build emits it as `pageFile(page)`. */
export const PAGE_SOURCES: Record<PageName, string> = {
  settings: "src/pages/settings/index.html",
  onboarding: "src/pages/onboarding/index.html",
};

/** Where a page sits in the built extension, relative to its root. What `openExtensionPage` opens. */
export const pageFile = (page: PageName): string => `${page}.html`;

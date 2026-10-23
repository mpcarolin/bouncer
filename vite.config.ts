import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import type { PageName } from "./src/core/platform.ts";
import { PAGE_SOURCES, pageFile } from "./src/platform/chrome/pages.ts";

const root = import.meta.dirname;
const pages = Object.entries(PAGE_SOURCES) as [PageName, string][];

/**
 * Vite emits a page's HTML at its source path. `openExtensionPage` opens `pageFile(page)`, so
 * this moves each one there. The scripts and styles the HTML names are absolute from the
 * extension's root, so they still resolve.
 */
function pagesAtRoot(): Plugin {
  return {
    name: "bouncer:pages-at-root",
    enforce: "post",
    generateBundle(_, bundle) {
      for (const [page, source] of pages) {
        const emitted = bundle[source];
        if (emitted?.type !== "asset") throw new Error(`the build did not emit ${source}`);
        this.emitFile({ type: "asset", fileName: pageFile(page), source: emitted.source });
        delete bundle[source];
      }
    },
  };
}

// The background service worker (ES module) and the extension pages (settings, onboarding, and
// later bench) are `input` entries; the content script is built separately as an IIFE.
export default defineConfig(({ mode }) => {
  const outDir = process.env.BOUNCER_OUT_DIR ?? "dist/chrome";
  return {
    publicDir: false,
    plugins: [pagesAtRoot()],
    define: {
      "import.meta.env.VITE_AI_PROVIDER": JSON.stringify(
        process.env.VITE_AI_PROVIDER ?? (mode === "e2e" ? "mock" : "chrome"),
      ),
    },
    build: {
      outDir,
      emptyOutDir: false,
      target: "es2022",
      minify: false,
      rollupOptions: {
        input: {
          background: resolve(root, "src/entries/background.ts"),
          ...Object.fromEntries(pages.map(([page, source]) => [page, resolve(root, source)])),
        },
        output: {
          format: "es",
          // The service worker is named in the manifest; every other chunk is hashed.
          entryFileNames: (chunk) =>
            chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
});

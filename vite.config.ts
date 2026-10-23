import { resolve } from "node:path";
import { defineConfig } from "vite";

// Background service worker (ES module). Extension pages (settings, onboarding, bench) are
// added as further `input` entries; the content script is built separately as an IIFE.
export default defineConfig(({ mode }) => {
  const outDir = process.env.BOUNCER_OUT_DIR ?? "dist/chrome";
  return {
    publicDir: false,
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
        input: { background: resolve(import.meta.dirname, "src/entries/background.ts") },
        output: {
          format: "es",
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
});

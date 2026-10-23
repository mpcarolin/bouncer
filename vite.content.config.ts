import { resolve } from "node:path";
import { defineConfig } from "vite";

// Content scripts can't be ES modules, so this builds one self-contained IIFE.
export default defineConfig(({ mode }) => ({
  publicDir: false,
  define: {
    "import.meta.env.VITE_AI_PROVIDER": JSON.stringify(
      process.env.VITE_AI_PROVIDER ?? (mode === "e2e" ? "mock" : "chrome"),
    ),
  },
  build: {
    outDir: process.env.BOUNCER_OUT_DIR ?? "dist/chrome",
    emptyOutDir: false,
    target: "es2022",
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/entries/content.ts"),
      formats: ["iife"],
      name: "bouncerContent",
      fileName: () => "content.js",
    },
  },
}));

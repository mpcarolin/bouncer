import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        // Pre-bundled so the first run doesn't discover it mid-test and reload the page.
        optimizeDeps: { include: ["@duckduckgo/autoconsent/heuristics"] },
        test: {
          name: "dom",
          include: ["test/dom/**/*.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});

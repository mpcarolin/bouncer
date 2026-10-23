import { defineConfig } from "@playwright/test";

// The e2e suite: `pnpm build:e2e && pnpm build && pnpm test:e2e`. Each test launches its own
// headless Chromium with the e2e build loaded (e2e/fixtures.ts), so tests run in parallel.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  timeout: 45_000,
  reporter: "list",
});

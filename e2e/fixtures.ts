// The e2e harness: the e2e build (`pnpm build:e2e`, the mock AI provider) loaded in headless
// Chromium, a fresh profile per test, so no test sees another's settings, learned rules or log;
// and the pages in e2e/pages served locally, each on a host of its own under `.localhost`
// (Chrome resolves those to loopback), because learned rules and the per-site switch are keyed
// by site. Nothing here reaches the network.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { test as base, chromium, expect, type Locator, type Worker } from "@playwright/test";
import type { LogEntry } from "../src/core/log.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/core/settings.ts";

export { expect };

const EXTENSION = resolve(import.meta.dirname, "..", "dist", "chrome-e2e");
const PAGES = resolve(import.meta.dirname, "pages");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** Long enough for the slowest decision: the claim wait, a settings hop, and verification. */
const DECISION_TIMEOUT_MS = 15_000;

/** The site (as the log and the settings name it) of a page served on `host`. */
export const siteOf = (host: string) => `${host}.localhost`;

/** The banner is on show and untouched by Bouncer's hiding (which Playwright doesn't see). */
export async function expectShown(banner: Locator): Promise<void> {
  await expect(banner).toBeVisible();
  await expect(banner).not.toHaveAttribute("data-bouncer-hidden");
  await expect(banner).toHaveCSS("clip-path", "none");
  await expect(banner).toHaveCSS("pointer-events", "auto");
}

export interface ExtensionFixtures {
  /** The extension's background service worker. */
  serviceWorker: Worker;
  extensionId: string;
  /** The decision log, read in the service worker. */
  readLog(): Promise<LogEntry[]>;
  /**
   * Polls the log until `site` has `nth` entries with an outcome (not `working`), and returns the
   * `nth` of them in the order they were logged (the first by default). Fails after
   * DECISION_TIMEOUT_MS.
   */
  decided(site: string, nth?: number): Promise<LogEntry>;
  /** The URL of e2e/pages/<page>.html, served on `<host>.localhost` (the page's name by default). */
  pageUrl(page: string, host?: string): string;
  /** Stores Bouncer's settings: the defaults with `s` over them. Pages loaded after see them. */
  setSettings(s: Partial<Settings>): Promise<void>;
  /** A value in the extension's local storage. */
  stored(key: string): Promise<unknown>;
  /**
   * Errors logged by the extension's pages, the test pages (content scripts included) or the
   * service worker. Collected for every test, which fails if there are any, unless it is tagged
   * `@live` (a live site's console is its own).
   */
  consoleErrors: string[];
  /**
   * http(s) requests to any host but the local pages', from the pages or the extension. Collected
   * for every test, which fails if there are any, unless it is tagged `@live`.
   */
  offsiteRequests: string[];
}

export const test = base.extend<ExtensionFixtures, { pagesPort: number }>({
  pagesPort: [
    async ({}, use) => {
      const server = createServer(async (req, res) => {
        const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
        if (path === "/favicon.ico") {
          res.writeHead(204).end();
          return;
        }
        const file = resolve(PAGES, `.${path}`);
        try {
          if (!file.startsWith(PAGES + sep)) throw new Error("outside the pages");
          const body = await readFile(file);
          res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" }).end(body);
        } catch {
          res.writeHead(404).end();
        }
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      await use((server.address() as AddressInfo).port);
      await new Promise((done) => server.close(done));
    },
    { scope: "worker" },
  ],

  context: async ({}, use) => {
    await stat(join(EXTENSION, "manifest.json")).catch(() => {
      throw new Error(`no e2e build at ${EXTENSION}: run pnpm build:e2e first`);
    });
    const profile = await mkdtemp(join(tmpdir(), "bouncer-e2e-"));
    const context = await chromium.launchPersistentContext(profile, {
      // The full Chromium, whose new headless mode runs extensions (the headless shell doesn't).
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  },

  serviceWorker: async ({ context }, use) => {
    const worker =
      context.serviceWorkers().find((w) => w.url().endsWith("/background.js")) ??
      (await context.waitForEvent("serviceworker", (w) => w.url().endsWith("/background.js")));
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  readLog: async ({ serviceWorker }, use) => {
    await use(() =>
      serviceWorker.evaluate(
        async () =>
          ((await chrome.storage.local.get("decisionLog")).decisionLog ?? []) as LogEntry[],
      ),
    );
  },

  decided: async ({ readLog }, use) => {
    await use(async (site, nth = 1) => {
      let entry: LogEntry | undefined;
      await expect
        .poll(
          async () => {
            const final = (await readLog()).filter(
              (e) => e.site === site && e.outcome !== "working",
            );
            entry = final[nth - 1];
            return final.length;
          },
          { message: `${nth} decision(s) logged for ${site}`, timeout: DECISION_TIMEOUT_MS },
        )
        .toBeGreaterThanOrEqual(nth);
      return entry as LogEntry;
    });
  },

  pageUrl: async ({ pagesPort }, use) => {
    await use((page, host = page) => `http://${siteOf(host)}:${pagesPort}/${page}.html`);
  },

  setSettings: async ({ serviceWorker }, use) => {
    await use(async (s) => {
      const settings: Settings = { ...DEFAULT_SETTINGS, ...s };
      await serviceWorker.evaluate((v) => chrome.storage.local.set({ settings: v }), settings);
    });
  },

  stored: async ({ serviceWorker }, use) => {
    await use((key) =>
      serviceWorker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key),
    );
  },

  consoleErrors: [
    async ({ context, serviceWorker }, use, testInfo) => {
      const errors: string[] = [];
      context.on("console", (m) => {
        if (m.type() === "error") errors.push(`${m.location().url}: ${m.text()}`);
      });
      serviceWorker.on("console", (m) => {
        if (m.type() === "error") errors.push(`service worker: ${m.text()}`);
      });
      await use(errors);
      if (!testInfo.tags.includes("@live")) expect(errors, "errors in the console").toEqual([]);
    },
    { auto: true },
  ],

  offsiteRequests: [
    async ({ context }, use, testInfo) => {
      const offsite: string[] = [];
      context.on("request", (r) => {
        const { protocol, hostname } = new URL(r.url());
        const web = protocol === "http:" || protocol === "https:";
        if (web && !hostname.endsWith(".localhost")) offsite.push(r.url());
      });
      await use(offsite);
      if (!testInfo.tags.includes("@live")) {
        expect(offsite, "requests that left the machine").toEqual([]);
      }
    },
    { auto: true },
  ],
});

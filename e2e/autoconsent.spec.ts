// autoconsent's path (§1) through Bouncer's background host, with autoconsent's real content
// bundle: detection, its `eval` steps run in the page's main world, the arbiter's opt-out, and
// the self-test. Bouncer's own path must stand down on the page autoconsent detected (§2b).
import type { LogEntry } from "../src/core/log.ts";
import { expect, siteOf, test } from "./fixtures.ts";

/**
 * What Bouncer's own path logged on the site, having checked that it stood down: it logged
 * nothing, or deferrals with nothing clicked. (It logs every claim before it hides or clicks.)
 */
async function ownPathDeferred(
  readLog: () => Promise<LogEntry[]>,
  site: string,
): Promise<LogEntry[]> {
  const own = (await readLog()).filter((e) => e.site === site && e.path !== "autoconsent");
  for (const e of own) {
    expect(e).toMatchObject({ path: "deferred", outcome: "deferred", clicked: [] });
  }
  return own;
}

/** The site's autoconsent entry, once it has an outcome. */
async function acOutcome(readLog: () => Promise<LogEntry[]>, site: string): Promise<LogEntry> {
  let entry: LogEntry | undefined;
  await expect
    .poll(
      async () => {
        entry = (await readLog()).find((e) => e.site === site && e.path === "autoconsent");
        return entry?.outcome ?? "none";
      },
      { message: `autoconsent's outcome on ${site}`, timeout: 20_000 },
    )
    .not.toMatch(/^(none|working)$/);
  return entry as LogEntry;
}

test("a Cookiebot-shaped CMP is refused by autoconsent, and Bouncer's own path clicks nothing", async ({
  page,
  pageUrl,
  readLog,
}) => {
  const site = siteOf("cookiebot");
  await page.goto(pageUrl("cookiebot"));
  const entry = await acOutcome(readLog, site);
  expect(entry).toMatchObject({ rule: "Cybotcookiebot", outcome: "dismissed" });
  expect(entry.verification).toBe("self_test_passed");
  // autoconsent clicked the mock's own "Deny": the CMP recorded a refusal and closed its dialog.
  await expect(page.locator("#status")).toHaveText("consent: declined");
  await expect(page.locator("#site-cmp-dialog")).toBeHidden();
  // Whether Bouncer's watcher or autoconsent's detection saw the dialog first, Bouncer never
  // claimed it: it logged a deferral, or nothing.
  await ownPathDeferred(readLog, site);
});

test("a CMP detected after Bouncer has its dialog in hand: Bouncer stands down in its claim wait", async ({
  page,
  pageUrl,
  readLog,
  serviceWorker,
}) => {
  const site = siteOf("cookiebot-late");
  // Counts the gate questions Bouncer's own path asks the background: one means it has found
  // the dialog and is in its claim wait (it asks as the wait starts).
  await serviceWorker.evaluate(() => {
    const g = globalThis as unknown as { gated: number };
    g.gated = 0;
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === "ai" && m.op === "isConsentDialog") g.gated++;
    });
  });
  await page.goto(`${pageUrl("cookiebot", "cookiebot-late")}?late`);
  await expect
    .poll(() => serviceWorker.evaluate(() => (globalThis as unknown as { gated: number }).gated), {
      intervals: [50],
    })
    .toBeGreaterThan(0);
  // Only now does the CMP's script run, so autoconsent detects it during Bouncer's claim wait.
  await page.evaluate(() => (window as unknown as { initCmp(): void }).initCmp());

  const entry = await acOutcome(readLog, site);
  expect(entry).toMatchObject({ rule: "Cybotcookiebot", outcome: "dismissed" });
  await expect(page.locator("#status")).toHaveText("consent: declined");
  const own = await ownPathDeferred(readLog, site);
  expect(own.map((e) => e.reason)).toEqual(["autoconsent_detected"]);
});

// Live, so skipped unless asked for (no browser starts): BOUNCER_LIVE=1 pnpm test:e2e --grep @live
test.describe("live sites", { tag: "@live" }, () => {
  test.skip(!process.env.BOUNCER_LIVE, "a live site: set BOUNCER_LIVE=1 to run it");

  test("stackoverflow.com is refused by autoconsent", async ({ page, readLog }) => {
    await page.goto("https://stackoverflow.com/");
    const entry = await acOutcome(readLog, "stackoverflow.com");
    expect(["dismissed", "dismissed_unverified"]).toContain(entry.outcome);
    await ownPathDeferred(readLog, "stackoverflow.com");
  });
});

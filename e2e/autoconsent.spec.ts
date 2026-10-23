// autoconsent's path (§1) through Bouncer's background host, with autoconsent's real content
// bundle: detection, its `eval` steps run in the page's main world, the arbiter's opt-out, and
// the self-test. Bouncer's own path must stand down on the page autoconsent detected (§2b).
import type { LogEntry } from "../src/core/log.ts";
import { expect, siteOf, test } from "./fixtures.ts";

/**
 * What Bouncer's own path logged on the site, having checked that it stood down: anything it
 * logged is a deferral, with nothing clicked. (It logs every claim before it hides or clicks.)
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

test("a Cookiebot-shaped CMP is refused by autoconsent, and Bouncer's own path stands down", async ({
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
  // Bouncer's own path found the dialog too, and stood down for autoconsent's detection.
  const own = await ownPathDeferred(readLog, site);
  expect(own.map((e) => e.reason)).toEqual(["autoconsent_detected"]);
});

// Live, so skipped unless asked for: BOUNCER_LIVE=1 pnpm test:e2e --grep @live
test("stackoverflow.com is refused by autoconsent", { tag: "@live" }, async ({ page, readLog }) => {
  test.skip(!process.env.BOUNCER_LIVE, "a live site: set BOUNCER_LIVE=1 to run it");
  await page.goto("https://stackoverflow.com/");
  const entry = await acOutcome(readLog, "stackoverflow.com");
  expect(["dismissed", "dismissed_unverified"]).toContain(entry.outcome);
  await ownPathDeferred(readLog, "stackoverflow.com");
});

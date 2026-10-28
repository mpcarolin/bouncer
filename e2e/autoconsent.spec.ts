// autoconsent's path (§1) through Bouncer's background host, with autoconsent's real content
// bundle: detection, its `eval` steps run in the page's main world, the arbiter's opt-out, and
// the self-test. Bouncer's own path must stand down on the page autoconsent detected (§2b).
import { RULE_BADGE } from "../src/core/badge.ts";
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
  badge,
}) => {
  const site = siteOf("cookiebot");
  await page.goto(pageUrl("cookiebot"));
  const entry = await acOutcome(readLog, site);
  expect(entry).toMatchObject({ rule: "Cybotcookiebot", outcome: "dismissed" });
  expect(entry.verification).toBe("self_test_passed");
  // The toolbar says a rule handled it.
  await expect
    .poll(() => badge(pageUrl("cookiebot")))
    .toEqual({ text: RULE_BADGE.text, title: RULE_BADGE.title });
  // autoconsent clicked the mock's own "Deny": the CMP recorded a refusal and closed its dialog.
  await expect(page.locator("#status")).toHaveText("consent: declined");
  await expect(page.locator("#site-cmp-dialog")).toBeHidden();
  // Whether Bouncer's watcher or autoconsent's detection saw the dialog first, Bouncer never
  // claimed it: it logged a deferral, or nothing.
  await ownPathDeferred(readLog, site);
});

test("a CMP detected after Bouncer has its dialog in hand, while its model answers: Bouncer stands down in its claim wait", async ({
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
  // Only now does the CMP's script run, so autoconsent's next look detects it while Bouncer's
  // model (slow on this page) is still answering.
  await page.evaluate(() => (window as unknown as { initCmp(): void }).initCmp());

  const entry = await acOutcome(readLog, site);
  expect(entry).toMatchObject({ rule: "Cybotcookiebot", outcome: "dismissed" });
  await expect(page.locator("#status")).toHaveText("consent: declined");
  const own = await ownPathDeferred(readLog, site);
  expect(own.map((e) => e.reason)).toEqual(["autoconsent_detected"]);
});

test("TrustArc-top with no reject button: its intermediate opt-out is failed at once, with no self-test, and put back", async ({
  page,
  pageUrl,
  readLog,
}) => {
  const site = siteOf("trustarc-intermediate");
  await page.goto(pageUrl("trustarc-intermediate"));
  const entry = await acOutcome(readLog, site);
  expect(entry).toMatchObject({
    rule: "TrustArc-top",
    outcome: "failed",
    reason: "opt_out_unfinished",
  });
  // autoconsent opened the preference centre; nothing refused in it.
  await expect(page.locator("#status")).toHaveText("centre: open");
  // Its styles were removed: the banner and the centre it opened are on show again.
  await expect(page.locator("#truste-consent-track")).toBeVisible();
  await expect(page.locator(".truste_popframe")).toBeVisible();
  await expect(page.locator("style#autoconsent-css-rules, style#autoconsent-prehide")).toHaveCount(
    0,
  );
  // No self-test ran: it would have read the preference cookie, and failed.
  expect(
    await page.evaluate(() => (window as { __selfTested?: boolean }).__selfTested),
  ).toBeUndefined();
  await ownPathDeferred(readLog, site);
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

  // TrustArc-top's intermediate opt-out (no reject button): nothing in autoconsent finishes it,
  // so it is reported unfinished as soon as autoconsent says so, never self-tested too early.
  test("redis.io: TrustArc-top's intermediate opt-out is failed as unfinished", async ({
    page,
    readLog,
  }) => {
    await page.goto("https://redis.io/");
    const entry = await acOutcome(readLog, "redis.io");
    expect(entry).toMatchObject({
      rule: "TrustArc-top",
      outcome: "failed",
      reason: "opt_out_unfinished",
    });
  });
});

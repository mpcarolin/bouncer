// The extension's own pages (Task 21) in the built extension: the settings page shows a real
// visit's log entry and the provider's model status, and onboarding shows the model ready.
import { expect, siteOf, test } from "./fixtures.ts";

test("the settings page shows the visit's decision and the model's status", async ({
  context,
  page,
  pageUrl,
  decided,
  extensionId,
}) => {
  const site = siteOf("pages-smoke");
  await page.goto(pageUrl("custom-reject", "pages-smoke"));
  await decided(site);

  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html?site=${site}`);
  const row = settings.locator("table.log tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row.locator("td").first()).toHaveText(site);
  await expect(row).toContainText("Reject all");
  await expect(row.locator("td").last()).toHaveText("dismissed");
  await expect(settings.locator(".model")).toContainText(
    "Ready. Chrome's on-device model is installed.",
  );
  await expect(settings.locator(".model")).toContainText("State: available.");
});

test("the onboarding page opens on install and shows the model ready", async ({
  context,
  extensionId,
}) => {
  const url = `chrome-extension://${extensionId}/onboarding.html`;
  await expect.poll(() => context.pages().map((p) => p.url())).toContain(url);
  const onboarding = context.pages().find((p) => p.url() === url);
  if (!onboarding) throw new Error("the onboarding tab went away");
  await expect(onboarding.locator("h1")).toHaveText("Bouncer");
  await expect(onboarding.locator(".model")).toContainText(
    "Ready. Chrome's on-device model is installed.",
  );
});

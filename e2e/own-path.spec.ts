// Bouncer's own path (§2) in Chromium with the extension loaded: the background, the content
// script, autoconsent's bundle and the mock AI provider together, on local pages. Each test has
// a fresh profile, and each page its own host, so no test sees another's log, rules or settings.
import { AI_BADGE } from "../src/core/badge.ts";
import { CLAIM_WAIT_MS } from "../src/core/config.ts";
import { expect, expectShown, siteOf, test } from "./fixtures.ts";

const texts = (clicked: { text: string }[]) => clicked.map((c) => c.text);

/**
 * An absence can't be polled for. With Bouncer on, a banner's claim is logged at most
 * CLAIM_WAIT_MS after the banner is found; waiting this long past the page load leaves room for
 * that and then some.
 */
const ABSENCE_WAIT_MS = CLAIM_WAIT_MS + 1500;

test("custom-reject: the reject button is clicked and the banner is dismissed", async ({
  page,
  pageUrl,
  decided,
}) => {
  await page.goto(pageUrl("custom-reject"));
  const entry = await decided(siteOf("custom-reject"));
  expect(entry).toMatchObject({
    path: "ai",
    gate: "consent",
    outcome: "dismissed",
    verification: "verified",
  });
  expect(texts(entry.clicked)).toEqual(["Reject all"]);
  // autoconsent, unmodified, looked at the page and recognised nothing: that ended the claim wait.
  expect(entry.notes).toContainEqual(expect.stringMatching(/^claim_wait:autoconsent_looked:\d+$/));
  await expect(page.locator("#status")).toHaveText("consent: rejected");
  await expect(page.locator("#my-cookie-notice")).toHaveCount(0);
  await expect(page.locator("[data-bouncer-hidden], style[data-bouncer]")).toHaveCount(0);
});

test("the toolbar badge: AI once the model's refusal is done, gone when the tab loads another page", async ({
  page,
  pageUrl,
  decided,
  badge,
}) => {
  const url = pageUrl("custom-reject", "badge-ai");
  await page.goto(url);
  expect(await decided(siteOf("badge-ai"))).toMatchObject({ path: "ai", outcome: "dismissed" });
  await expect.poll(() => badge(url)).toEqual({ text: AI_BADGE.text, title: AI_BADGE.title });

  // A page whose overlay the gate rejects: nothing dismissed, so no mark.
  const next = pageUrl("login-wall", "badge-next");
  await page.goto(next);
  expect(await decided(siteOf("badge-next"))).toMatchObject({ outcome: "not_consent" });
  expect(await badge(next)).toEqual({ text: "", title: "Bouncer" });
});

test("custom-settings: settings, optional toggles off, do-not-sell on, saved", async ({
  page,
  pageUrl,
  decided,
}) => {
  await page.goto(pageUrl("custom-settings"));
  const entry = await decided(siteOf("custom-settings"));
  expect(entry).toMatchObject({ path: "ai", outcome: "dismissed", verification: "verified" });
  expect(texts(entry.clicked)).toEqual(["Cookie settings", "Save choices"]);
  // The site's own record of what was saved.
  await expect(page.locator("#status")).toHaveText("consent: ana=false,mkt=false,dns=true");
});

test("agree-only: no way to refuse, nothing clicked, the banner left as it was", async ({
  page,
  pageUrl,
  decided,
}) => {
  await page.goto(pageUrl("agree-only"));
  const entry = await decided(siteOf("agree-only"));
  expect(entry).toMatchObject({ path: "ai", gate: "consent", outcome: "no_option", clicked: [] });
  await expect(page.locator("#status")).toHaveText("untouched");
  await expectShown(page.locator("#cookie-agree-bar"));
});

test("login-wall: the gate says it is not a consent dialog, nothing touched", async ({
  page,
  pageUrl,
  decided,
}) => {
  await page.goto(pageUrl("login-wall"));
  const entry = await decided(siteOf("login-wall"));
  expect(entry).toMatchObject({ path: "ai", gate: "other", outcome: "not_consent", clicked: [] });
  await expect(page.locator("#status")).toHaveText("untouched");
  await expectShown(page.locator("#login"));
});

test("broken-reject: a reject that does nothing is failed, and the banner put back", async ({
  page,
  pageUrl,
  decided,
}) => {
  await page.goto(pageUrl("broken-reject"));
  const entry = await decided(siteOf("broken-reject"));
  expect(entry).toMatchObject({ path: "ai", outcome: "failed", reason: "not_gone" });
  expect(texts(entry.clicked)).toEqual(["Reject all"]);
  expect(entry.notes).toContain("restored");
  await expect(page.locator("#status")).toHaveText("clicks: reject");
  await expectShown(page.locator("#cookie-broken"));
});

test("hash-link-reject: a reject link to #… is clicked without changing the hash or scroll", async ({
  page,
  pageUrl,
  decided,
}) => {
  await page.goto(pageUrl("hash-link-reject"));
  const before = page.url();
  const entry = await decided(siteOf("hash-link-reject"));
  expect(entry).toMatchObject({ path: "ai", outcome: "dismissed", verification: "verified" });
  expect(texts(entry.clicked)).toEqual(["Reject all"]);
  expect(entry.notes).toContain("hash_guard");
  await expect(page.locator("#status")).toHaveText("consent: rejected");
  expect(await page.evaluate(() => [location.hash, scrollY])).toEqual(["", 0]);
  expect(page.url()).toBe(before);
});

test("ons-banner: a reject that submits an accept-all form is clicked, then the confirmation's Hide; nothing is requested or navigated", async ({
  page,
  pageUrl,
  decided,
}) => {
  const submitted: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/accept-all") submitted.push(r.url());
  });
  let navigations = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  await page.goto(pageUrl("ons-banner"));
  const before = page.url();
  const entry = await decided(siteOf("ons-banner"));
  // The banner answers the refusal with a confirmation, whose new Hide closes it (§2g).
  expect(entry).toMatchObject({ outcome: "dismissed", verification: "verified" });
  expect(texts(entry.clicked)).toEqual(["Reject additional cookies", "Hide"]);
  expect(entry.notes).toContain("confirmation:closed");
  // The page's own submit handler took the click, so the guard had nothing to cancel.
  expect(entry.notes).not.toContain("submit_guard:cancelled");
  await expect(page.locator("#status")).toHaveText("consent: rejected");
  const policy = (await page.context().cookies()).find((c) => c.name === "ons_cookie_policy");
  expect(decodeURIComponent(policy?.value ?? "")).toContain("'usage':false");
  await expect(page.locator("#global-cookie-message")).toBeHidden();
  expect(submitted).toEqual([]);
  expect(page.url()).toBe(before);
  expect(navigations).toBe(1);
});

test("scroll-locked: the page scrolls again after the banner that locked it is refused", async ({
  page,
  pageUrl,
  decided,
}) => {
  await page.goto(pageUrl("scroll-locked"));
  const entry = await decided(siteOf("scroll-locked"));
  expect(entry).toMatchObject({ path: "ai", outcome: "dismissed", verification: "verified" });
  expect(entry.notes).toContain("scroll:unlocked");
  await expect(page.locator("#status")).toHaveText("consent: rejected");
  // The user's own scrolling, which an `overflow: hidden` lock blocks (a script's would not be).
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
});

test("shadow-banner: a banner in an open shadow root is refused", async ({
  page,
  pageUrl,
  decided,
}) => {
  await page.goto(pageUrl("shadow-banner"));
  const entry = await decided(siteOf("shadow-banner"));
  expect(entry).toMatchObject({ path: "ai", outcome: "dismissed", verification: "verified" });
  expect(texts(entry.clicked)).toEqual(["Reject all"]);
  await expect(page.locator("#status")).toHaveText("consent: rejected");
  await expect(page.locator("site-consent")).toHaveCount(0);
});

test("late-prehide: a banner autoconsent prehides while Bouncer waits is refused once it shows", async ({
  page,
  pageUrl,
  readLog,
  decided,
}) => {
  const site = siteOf("late-prehide");
  await page.goto(pageUrl("late-prehide"));
  // autoconsent's prehide comes down on the banner (it now matches a generic rule's selector) and
  // lifts once autoconsent has looked for a CMP: hiding that is autoconsent's, not the site's.
  const banner = page.locator("#late-cookie-notice");
  await expect(banner).toHaveCSS("opacity", "0");
  await expect(banner).toHaveCSS("opacity", "1");
  const entry = await decided(site);
  expect(entry).toMatchObject({ path: "ai", outcome: "dismissed", verification: "verified" });
  expect(texts(entry.clicked)).toEqual(["Reject all"]);
  expect((await readLog()).filter((e) => e.site === site)).toHaveLength(1);
  await expect(page.locator("#status")).toHaveText("consent: rejected");
});

test("typing while the banner shows: focus, text and scroll position are kept (Goal 4)", async ({
  page,
  pageUrl,
  readLog,
  decided,
}) => {
  const site = siteOf("typing");
  await page.goto(pageUrl("typing"));
  await page.evaluate(() => scrollTo(0, 600));
  const input = page.locator("#q");
  await input.click();
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.keyboard.type("cookie ");
  await expect(page.locator("#typing-cookie-notice")).toBeVisible();
  // Bouncer has claimed the page: it is hiding, clicking and verifying while this is typed.
  await expect.poll(async () => (await readLog()).some((e) => e.site === site)).toBe(true);
  await page.keyboard.type("banners");
  const entry = await decided(site);
  expect(entry).toMatchObject({ path: "ai", outcome: "dismissed", verification: "verified" });
  await page.keyboard.type("!");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("cookie banners!");
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
});

test("with the global switch off, a banner is left alone and nothing is logged", async ({
  page,
  pageUrl,
  setSettings,
  readLog,
  decided,
}) => {
  const site = siteOf("global-off");
  await setSettings({ enabled: false });
  await page.goto(pageUrl("custom-reject", "global-off"));
  await page.waitForTimeout(ABSENCE_WAIT_MS);
  expect((await readLog()).filter((e) => e.site === site)).toEqual([]);
  await expect(page.locator("#status")).toHaveText("consent: unset");
  await expectShown(page.locator("#my-cookie-notice"));

  // The same page with the switch back on is refused: the quiet above was the switch's doing.
  await setSettings({ enabled: true });
  await page.reload();
  const entry = await decided(site);
  expect(entry.outcome).toBe("dismissed");
});

test("on a site in disabledSites, a banner is left alone and nothing is logged", async ({
  context,
  page,
  pageUrl,
  setSettings,
  readLog,
  decided,
}) => {
  await setSettings({ disabledSites: [siteOf("site-off")] });
  // The same page on an enabled site, loaded alongside: once it is decided, the disabled one
  // would have been too.
  const control = await context.newPage();
  await Promise.all([
    page.goto(pageUrl("custom-reject", "site-off")),
    control.goto(pageUrl("custom-reject", "site-on")),
  ]);
  const entry = await decided(siteOf("site-on"));
  expect(entry.outcome).toBe("dismissed");
  expect((await readLog()).filter((e) => e.site === siteOf("site-off"))).toEqual([]);
  await expect(page.locator("#status")).toHaveText("consent: unset");
  await expectShown(page.locator("#my-cookie-notice"));
});

test("a verified refusal is learned, and the next visit replays the learned rule", async ({
  page,
  pageUrl,
  decided,
  stored,
}) => {
  const site = siteOf("learned");
  await page.goto(pageUrl("custom-reject", "learned"));
  const first = await decided(site);
  expect(first).toMatchObject({ path: "ai", outcome: "dismissed", verification: "verified" });
  expect(first.notes).toContain("learned:saved");
  // The background stored it for the page's site: the sender's tab URL and the page's own agree.
  expect(await stored(`learnedRule:${site}`)).toMatchObject({
    site,
    stage1: { action: "reject", target: { text: "Reject all", label: "reject" } },
  });
  expect(await stored("learnedRuleSites")).toEqual([site]);

  await page.reload();
  const second = await decided(site, 2);
  expect(second).toMatchObject({
    path: "learned",
    gate: "skipped",
    outcome: "dismissed",
    verification: "verified",
    modelCalls: [],
  });
  expect(texts(second.clicked)).toEqual(["Reject all"]);
  await expect(page.locator("#status")).toHaveText("consent: rejected");
});

test("a learned rule its banner no longer fits is discarded, and the pipeline decides", async ({
  page,
  pageUrl,
  decided,
  stored,
}) => {
  const site = siteOf("relearn");
  await page.goto(pageUrl("custom-reject", "relearn"));
  expect((await decided(site)).notes).toContain("learned:saved");
  // The same site's banner, its buttons now the other way round: the rule's reject target (its
  // second button) reads "Accept all", so stage 1's check fails before anything is touched.
  await page.goto(pageUrl("broken-reject", "relearn"));
  const second = await decided(site, 2);
  expect(second).toMatchObject({ path: "ai", gate: "consent", outcome: "failed" });
  expect(texts(second.clicked)).toEqual(["Reject all"]);
  expect(second.notes).toContain("learned:mismatch:text_changed");
  expect(second.notes).toContain("learned:discarded");
  expect(await stored(`learnedRule:${site}`)).toBeUndefined();
  expect(await stored("learnedRuleSites")).toEqual([]);
});

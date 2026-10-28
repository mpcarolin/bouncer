import { describe, expect, test } from "vitest";
import { labelDeterministic } from "../../src/core/label.ts";
import { fastPathTarget } from "../../src/core/pipeline/fast-path.ts";
import type { SerialisedBanner } from "../../src/core/types.ts";
import { btn, type Draft, lnk } from "../helpers/banner.ts";

const COOKIE_TEXT = "We use cookies to analyse traffic and personalise ads.";

const banner = (text: string, drafts: Draft[]): SerialisedBanner => ({
  text: `${text} ${drafts.map((d) => d.text).join(" ")}`,
  controls: drafts.map((d, id) => ({ id, ...d })),
});
const target = (b: SerialisedBanner) => fastPathTarget(b, labelDeterministic(b));

describe("fastPathTarget", () => {
  test('a plain "Reject all" button on cookie text is the target', () => {
    expect(target(banner(COOKIE_TEXT, [btn("Accept all"), btn("Reject all")]))).toBe(1);
  });

  test("a Bank of England-shaped banner: its necessary-only button is the target, with no model", () => {
    const text =
      "Cookies on the Bank of England website. We use necessary cookies to make our site work. We'd also like to set optional analytics cookies.";
    const b = banner(text, [
      btn("Accept recommended cookies"),
      btn("Proceed with necessary cookies only"),
      lnk("Change cookie settings"),
    ]);
    expect(target(b)).toBe(1);
  });

  test('"Doorgaan met aanvaarden" (regex reject, accept-verb veto) → null', () => {
    expect(target(banner(COOKIE_TEXT, [btn("Doorgaan met aanvaarden")]))).toBeNull();
  });

  test('"Do not sell or share my personal information" → null', () => {
    const b = banner(COOKIE_TEXT, [btn("Do not sell or share my personal information")]);
    expect(target(b)).toBeNull();
  });

  test("a login wall → null, though its text matches autoconsent's patterns", () => {
    const text =
      "Log in to continue. By continuing you agree to our Terms of Service and acknowledge our Privacy Policy.";
    const b = banner(text, [btn("Log in"), btn("Close"), lnk("Privacy Policy")]);
    expect(target(b)).toBeNull();
  });

  test("a reject that is a link, or absent → null", () => {
    expect(target(banner(COOKIE_TEXT, [btn("Accept all"), lnk("Reject all")]))).toBeNull();
    expect(target(banner(COOKIE_TEXT, [btn("Reject all", { absent: "navigates" })]))).toBeNull();
  });

  test("text autoconsent's patterns don't match, or an excluded popup → null", () => {
    // The banner text includes its buttons', and "reject all" is itself one of the patterns.
    expect(target(banner("Get our newsletter every week.", [btn("Decline")]))).toBeNull();
    expect(target(banner(COOKIE_TEXT, [btn("Decline")]))).toBe(0);
    const ageGate = "Age verification: you must be 18 to enter. We use cookies.";
    expect(target(banner(ageGate, [btn("Reject all")]))).toBeNull();
  });
});

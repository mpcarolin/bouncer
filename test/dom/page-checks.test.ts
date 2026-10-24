import { afterEach, describe, expect, test, vi } from "vitest";
import { DETECT_THROTTLE_MS } from "../../src/core/config.ts";
import { findCandidates } from "../../src/core/page/detect.ts";
import { BUTTON_SEL } from "../../src/core/page/dom.ts";
import { throttledReappeared } from "../../src/core/pipeline/page-checks.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

afterEach(() => {
  vi.restoreAllMocks();
  unmountAll();
});

const BAR = "position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:8px;";

/**
 * A banner, acted on and removed, and a copy of it the site can render again as a new element.
 * `scans()` counts the page's full candidate scans since.
 */
function dismissed() {
  const box = mount(`<div id="bar" style="${BAR}">We use cookies. <button>Reject</button></div>`);
  const banner = box.querySelector("#bar") as Element;
  const keys = new Set(findCandidates(document).map((c) => c.key));
  expect(keys.size).toBe(1);
  const copy = banner.cloneNode(true) as Element;
  banner.remove();
  const spy = vi.spyOn(document, "querySelectorAll");
  const scans = () => spy.mock.calls.filter(([sel]) => sel === BUTTON_SEL).length;
  return { banner, keys, scans, renderAgain: () => box.append(copy) };
}

describe("throttledReappeared", () => {
  test("rescans at most once per DETECT_THROTTLE_MS: verification's fast ticks reuse the last answer", () => {
    const { banner, keys, scans, renderAgain } = dismissed();
    let now = 0;
    const reappeared = throttledReappeared(document, keys, [banner], () => now);
    expect(reappeared(false)).toBe(false);
    expect(scans()).toBe(1);
    renderAgain();
    for (now = 50; now < DETECT_THROTTLE_MS; now += 50) expect(reappeared(false)).toBe(false);
    expect(scans()).toBe(1);
    now = DETECT_THROTTLE_MS;
    expect(reappeared(false)).toBe(true);
    expect(scans()).toBe(2);
  });

  test("a fresh check always rescans", () => {
    const { banner, keys, scans, renderAgain } = dismissed();
    const reappeared = throttledReappeared(document, keys, [banner], () => 0);
    expect(reappeared(false)).toBe(false);
    renderAgain();
    expect(reappeared(true)).toBe(true);
    expect(scans()).toBe(2);
  });
});

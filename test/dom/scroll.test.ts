import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ScrollTracker } from "../../src/core/page/scroll.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

let t: ScrollTracker;
beforeEach(() => {
  t = new ScrollTracker(document);
});
afterEach(() => {
  unmountAll();
  document.documentElement.style.removeProperty("overflow");
  document.body.style.removeProperty("overflow");
});

const makeTall = () => mount('<div style="height:5000px"></div>');
const lock = () => {
  document.body.style.overflow = "hidden";
};

describe("ScrollTracker", () => {
  test("banner locks scroll, dismissed: restored to the original inline value", () => {
    makeTall();
    t.refresh(false);
    t.freeze();
    lock(); // the banner's lock is in place by the time of the first click
    t.markAction();
    expect(t.tryUnlock("dismissed", false)).toBe("unlocked");
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
  });

  test("a login wall's lock is never the before state", () => {
    makeTall();
    t.refresh(false);
    lock(); // login wall appears modally and locks
    t.refresh(true); // paused while the modal shows
    t.refresh(false); // even when the modal is gone from view, the lock is not recorded
    t.freeze();
    t.markAction();
    expect(t.tryUnlock("dismissed", false)).toBe("unlocked");
    expect(document.body.style.overflow).toBe("");
  });

  test("failed is skipped", () => {
    makeTall();
    t.refresh(false);
    t.markAction();
    lock();
    expect(t.tryUnlock("failed", false)).toBe("skipped:not_dismissed");
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("dismissed_unverified is unlocked", () => {
    makeTall();
    t.refresh(false);
    lock();
    t.markAction();
    expect(t.tryUnlock("dismissed_unverified", false)).toBe("unlocked");
  });

  test("a page that was never scrollable is skipped", () => {
    t.refresh(false);
    t.markAction();
    lock();
    expect(t.tryUnlock("dismissed", false)).toBe("skipped:not_scrollable_before");
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("inline values changed after markAction are left alone", () => {
    makeTall();
    t.refresh(false);
    lock();
    t.markAction();
    document.documentElement.style.overflow = "hidden"; // newsletter modal
    expect(t.tryUnlock("dismissed", false)).toBe("skipped:inline_changed");
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  test("a full-viewport overlay still showing is skipped", () => {
    makeTall();
    t.refresh(false);
    t.markAction();
    lock();
    expect(t.tryUnlock("dismissed", true)).toBe("skipped:overlay_showing");
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("not locked, and no snapshot", () => {
    makeTall();
    t.refresh(false);
    t.markAction();
    expect(t.tryUnlock("dismissed", false)).toBe("skipped:not_locked");
    expect(new ScrollTracker(document).tryUnlock("dismissed", false)).toBe("skipped:no_snapshot");
  });

  test("frozen: later refreshes do not replace the record", () => {
    makeTall();
    document.body.style.overflow = "scroll";
    t.refresh(false);
    t.freeze();
    document.body.style.overflow = "";
    t.refresh(false);
    lock();
    t.markAction();
    expect(t.tryUnlock("dismissed", false)).toBe("unlocked");
    expect(document.body.style.overflow).toBe("scroll");
  });
});

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
  document.body.style.removeProperty("position");
  document.body.classList.remove("bouncer-test-locked");
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

  test("html-only inline lock is unlocked", () => {
    makeTall();
    t.refresh(false);
    document.documentElement.style.overflow = "hidden";
    t.markAction();
    expect(t.tryUnlock("dismissed", false)).toBe("unlocked");
    expect(document.documentElement.style.overflow).toBe("");
  });

  test("fixed-body lock is not released by inline overflow: skipped, inline unchanged", () => {
    makeTall();
    document.body.style.overflow = "scroll";
    t.refresh(false);
    document.body.style.position = "fixed";
    document.body.style.overflow = "auto";
    t.markAction();
    expect(t.tryUnlock("dismissed", false)).toBe("skipped:lock_not_inline");
    expect(document.body.style.overflow).toBe("auto");
    expect(document.body.style.position).toBe("fixed");
  });

  test("class-driven lock is skipped, inline unchanged", () => {
    makeTall();
    mount("<style>.bouncer-test-locked{overflow:hidden}</style>");
    t.refresh(false); // original inline value is ''
    document.body.classList.add("bouncer-test-locked");
    t.markAction();
    expect(t.tryUnlock("dismissed", false)).toBe("skipped:lock_not_inline");
    expect(document.body.style.overflow).toBe("");
  });

  test("a modal not_consent that is not yet locking pauses the record", () => {
    makeTall();
    document.body.style.overflow = "scroll";
    t.refresh(false);
    document.body.style.overflow = "auto"; // changed while the modal shows
    t.refresh(true); // paused: record stays the pre-modal one
    lock(); // the modal's lock appears
    t.refresh(false); // locked: still not recorded
    t.markAction();
    expect(t.tryUnlock("dismissed", false)).toBe("unlocked");
    expect(document.body.style.overflow).toBe("scroll");
  });
});

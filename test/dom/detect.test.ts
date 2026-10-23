import { afterEach, describe, expect, it } from "vitest";
import { DETECT_THROTTLE_MS, DETECT_WATCH_MS } from "../../src/core/config.ts";
import { CandidateWatcher, type Candidate, findCandidates } from "../../src/core/page/detect.ts";
import type { Clock } from "../../src/core/types.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

afterEach(unmountAll);

const BAR = "position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:8px;";

const cookieBar = (extra = "") =>
  `<div id="bar" style="${BAR}">We use cookies. <button>Settings</button><button>Reject</button>${extra}</div>`;

/** A clock the test drives by hand. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  return { clock, advance };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("findCandidates", () => {
  it("finds a fixed cookie bar with two buttons", () => {
    mount(cookieBar());
    const found = findCandidates(document);
    expect(found).toHaveLength(1);
    expect(found[0]?.el.id).toBe("bar");
    expect(found[0]?.root).toBe(document);
    expect(found[0]?.modal).toBe(false);
  });

  it("rejects a footer with 12 links and the word cookies", () => {
    const links = Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join("");
    mount(`<footer style="${BAR}">${links} Cookies <button>Top</button></footer>`);
    expect(findCandidates(document)).toEqual([]);
  });

  it("ignores the text of a country select when matching", () => {
    mount(`<div style="${BAR}"><select><option>Cookie Islands</option><option>Privacy</option></select>
      Pick your country <button>Go</button></div>`);
    expect(findCandidates(document)).toEqual([]);
  });

  it("finds a banner in an open shadow root, with that root as root", () => {
    const box = mount("<div id='host'></div>");
    const root = box.querySelector("#host")?.attachShadow({ mode: "open" }) as ShadowRoot;
    root.innerHTML = `<div id="inner" style="${BAR}">Cookie notice <button>OK</button></div>`;
    const found = findCandidates(document);
    expect(found).toHaveLength(1);
    expect(found[0]?.el.id).toBe("inner");
    expect(found[0]?.root).toBe(root);
  });

  it("reports a banner nested in a qualifying wrapper once, as the outermost", () => {
    mount(`<div id="outer" style="position:fixed;inset:0;z-index:5000">
      <div id="inner" style="position:fixed;bottom:0;left:0">We use cookies <button>OK</button></div></div>`);
    const found = findCandidates(document);
    expect(found.map((c) => c.el.id)).toEqual(["outer"]);
    expect(found[0]?.modal).toBe(true);
  });

  it("accepts a role=dialog that is not positioned, and flags aria-modal", () => {
    mount(
      `<div id="d" role="dialog" aria-modal="true">Privacy choices <button>Close</button></div>`,
    );
    const found = findCandidates(document);
    expect(found[0]?.el.id).toBe("d");
    expect(found[0]?.modal).toBe(true);
  });

  it("gives equal text equal keys and different text different keys", () => {
    mount(cookieBar());
    const a = findCandidates(document)[0] as Candidate;
    expect(findCandidates(document)[0]?.key).toBe(a.key);
    document.querySelector("#bar")?.append(" More text about cookies.");
    expect(findCandidates(document)[0]?.key).not.toBe(a.key);
  });
});

describe("CandidateWatcher", () => {
  it("reports an announcement bar and then a cookie banner added later, in order", async () => {
    mount(`<div id="ann" style="${BAR}">Privacy week sale <button>Shop</button></div>`);
    const seen: string[] = [];
    const w = new CandidateWatcher(document, (c) => seen.push(c.el.id));
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual(["ann"]);
    mount(`<div id="real" style="${BAR}bottom:60px">We use cookies <button>OK</button></div>`);
    await new Promise((r) => setTimeout(r, 2 * DETECT_THROTTLE_MS));
    w.stop();
    expect(seen).toEqual(["ann", "real"]);
  });

  it("does not report a rejected candidate again while its text is unchanged", async () => {
    mount(cookieBar());
    const seen: Candidate[] = [];
    const w = new CandidateWatcher(document, (c) => {
      seen.push(c);
      w.reject(c);
    });
    document.body.append(document.createElement("div"));
    await new Promise((r) => setTimeout(r, 2 * DETECT_THROTTLE_MS));
    expect(seen).toHaveLength(1);
    // Changed text is a new candidate.
    document.querySelector("#bar")?.append(" Now with more cookie detail.");
    await new Promise((r) => setTimeout(r, 2 * DETECT_THROTTLE_MS));
    w.stop();
    expect(seen).toHaveLength(2);
  });

  it("keeps watching after a candidate was rejected", async () => {
    mount(cookieBar());
    const seen: string[] = [];
    const w = new CandidateWatcher(document, (c) => {
      seen.push(c.el.id);
      w.reject(c);
    });
    mount(`<div id="two" style="${BAR}bottom:80px">Consent needed <button>OK</button></div>`);
    await new Promise((r) => setTimeout(r, 2 * DETECT_THROTTLE_MS));
    w.stop();
    expect(seen).toEqual(["bar", "two"]);
  });

  it("caps detection passes during a mutation storm", async () => {
    const { clock, advance } = fakeClock();
    let passes = 0;
    const box = mount("<ul id='feed'></ul>");
    const feed = box.querySelector("#feed") as Element;
    const w = new CandidateWatcher(document, () => {}, clock, { onPass: () => passes++ });
    for (let i = 0; i < 1000; i++) {
      feed.append(document.createElement("li"));
      await Promise.resolve(); // let the MutationObserver callback run
      advance(1);
    }
    advance(DETECT_THROTTLE_MS);
    w.stop();
    expect(passes).toBeGreaterThan(1);
    expect(passes).toBeLessThanOrEqual(Math.ceil(1000 / DETECT_THROTTLE_MS) + 1);
  });

  it("stops after DETECT_WATCH_MS", async () => {
    const { clock, advance } = fakeClock();
    const seen: string[] = [];
    new CandidateWatcher(document, (c) => seen.push(c.el.id), clock);
    advance(DETECT_WATCH_MS + 1);
    seen.length = 0;
    mount(cookieBar());
    await flush();
    advance(10 * DETECT_THROTTLE_MS);
    expect(seen).toEqual([]);
  });

  it("stop() ends watching early", async () => {
    const seen: string[] = [];
    const w = new CandidateWatcher(document, (c) => seen.push(c.el.id));
    w.stop();
    mount(cookieBar());
    await new Promise((r) => setTimeout(r, 2 * DETECT_THROTTLE_MS));
    expect(seen).toEqual([]);
  });
});

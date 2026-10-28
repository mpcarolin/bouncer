import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("rejects an opacity:0 wrapper around a normal child", () => {
    mount(
      `<div style="opacity:0"><div style="${BAR}">We use cookies <button>OK</button></div></div>`,
    );
    expect(findCandidates(document)).toEqual([]);
  });

  it("ignores cookie/privacy wording that sits in a display:none submenu", () => {
    mount(`<div style="${BAR}">Welcome <button>Menu</button>
      <ul style="display:none"><li>Privacy</li><li>Cookie policy</li></ul><div hidden>Consent</div></div>`);
    expect(findCandidates(document)).toEqual([]);
  });

  describe("in-flow banners (§2a's in-flow case)", () => {
    // Shaped on parliament.uk and ons.gov.uk: banners in the page's normal flow, before the header.
    const PARLIAMENT = `<div id="p-cookie-banner" class="p-cookie-banner__wrapper">
      <div class="p-cookie-banner p-cookie-manager"><p>We use necessary cookies to make our site
      work. We'd also like to set additional cookies to understand how you use the site. Read our
      <a href="/cookie-policy">cookie policy</a>.</p><button>Accept additional cookies</button>
      <button>Reject additional cookies</button><button>Cookie settings</button></div></div>`;
    const ONS = `<section><form id="global-cookie-message" class="cookies-banner"
      aria-label="cookie banner" action="/cookies/accept-all" method="get">
      <div class="cookies-banner__wrapper" role="region" aria-label="Cookies banner">
      <h2>Cookies on ONS.GOV.UK</h2><p>Essential cookies make this website work. We'd like to set
      <a href="/cookies">additional cookies</a> to understand how you use the site.</p>
      <button type="submit" data-action="accept">Accept additional cookies</button>
      <button type="submit" data-action="reject">Reject additional cookies</button>
      <a href="/cookies">Manage settings</a></div></form></section>`;
    const PAGE = `<header>Site header <button>Menu</button></header>
      <main><h1>Welcome</h1><div style="height:3000px"></div></main>`;

    it("finds a parliament-shaped banner at the top of a long page", () => {
      mount(PARLIAMENT + PAGE);
      const found = findCandidates(document);
      expect(found.map((c) => c.el.id)).toEqual(["p-cookie-banner"]);
      expect(found[0]?.modal).toBe(false);
    });

    it("finds an ONS-shaped banner, the form being the outermost that qualifies", () => {
      mount(ONS + PAGE);
      expect(findCandidates(document).map((c) => c.el.id)).toEqual(["global-cookie-message"]);
    });

    it("finds a self-named banner at the bottom of a long page", () => {
      mount(`<div style="height:3000px"></div>${PARLIAMENT}`);
      expect(findCandidates(document).map((c) => c.el.id)).toEqual(["p-cookie-banner"]);
    });

    it("ignores the same shape inside main, article or their roles", () => {
      for (const wrap of ["main", "article", 'div role="main"', 'div role="article"']) {
        const tag = wrap.split(" ")[0];
        mount(`<${wrap}>${PARLIAMENT}</${tag}>`);
        expect(findCandidates(document), wrap).toEqual([]);
        unmountAll();
      }
    });

    it("ignores an in-flow element with consent text that doesn't name itself", () => {
      mount(
        `<div id="notice">We use cookies. <button>Accept</button><button>Reject</button></div>`,
      );
      expect(findCandidates(document)).toEqual([]);
    });

    it("ignores an app root wrapping a small page that holds an unstyled cookie banner", () => {
      mount(`<div id="root"><header>Shop</header><div>We use cookies to improve your visit.
        <button>Accept</button><button>Reject</button></div><p>Today's offers</p></div>`);
      expect(findCandidates(document)).toEqual([]);
    });

    it("never takes the parts of an overlay for in-flow banners, even once the overlay is rejected", () => {
      // Shaped on lemonde.fr's wall: a fixed overlay whose own parts name themselves.
      mount(`<div class="gdpr-lmd-wall" style="position:fixed;inset:0;z-index:10000001;background:#fff">
        <div class="gdpr-lmd-wall__wrapper"><a href="#">Reject all cookies</a>
        <div class="gdpr-lmd-wall__content"><p>We and our partners use cookies.</p></div>
        <footer class="gdpr-lmd-wall__footer"><button>Accept</button>
        <a href="#">Cookie settings</a></footer></div></div>${PAGE}`);
      const wall = document.querySelector(".gdpr-lmd-wall") as Element;
      expect(findCandidates(document).map((c) => c.el)).toEqual([wall]);
      expect(findCandidates(document, (el) => el === wall).map((c) => c.el)).toEqual([wall]);
    });

    it("passes over a self-named page wrapper that holds the page's main content", () => {
      mount(`<div id="app" class="cookie-banner-visible">${PARLIAMENT}${PAGE}</div>`);
      expect(findCandidates(document).map((c) => c.el.id)).toEqual(["p-cookie-banner"]);
    });

    it("ignores an in-flow element that names itself but has privacy wording only", () => {
      mount(`<div class="cookie-notice">We respect your privacy. <button>OK</button></div>`);
      expect(findCandidates(document)).toEqual([]);
    });

    it("ignores an in-flow element that names itself, mid-way down a long page", () => {
      mount(`<div style="height:3000px"></div>${PARLIAMENT}<div style="height:3000px"></div>`);
      expect(findCandidates(document)).toEqual([]);
    });
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

  it("observes shadow roots, so a banner populated there later is reported", async () => {
    const box = mount("<div id='host'></div>");
    const root = box.querySelector("#host")?.attachShadow({ mode: "open" }) as ShadowRoot;
    const seen: Candidate[] = [];
    const w = new CandidateWatcher(document, (c) => seen.push(c));
    await new Promise((r) => setTimeout(r, 2 * DETECT_THROTTLE_MS));
    expect(seen).toEqual([]);
    root.innerHTML = `<div id="inner" style="${BAR}">Cookie notice <button>OK</button></div>`;
    await new Promise((r) => setTimeout(r, 2 * DETECT_THROTTLE_MS));
    w.stop();
    expect(seen.map((c) => c.el.id)).toEqual(["inner"]);
    expect(seen[0]?.root).toBe(root);
  });

  it("reports a banner inside a shell that was rejected", async () => {
    mount(
      `<div id="shell" style="position:fixed;inset:0;z-index:5000">Privacy preferences <button>Edit</button></div>`,
    );
    const seen: string[] = [];
    const w = new CandidateWatcher(document, (c) => {
      seen.push(c.el.id);
      if (c.el.id === "shell") w.reject(c);
    });
    await new Promise((r) => setTimeout(r, 2 * DETECT_THROTTLE_MS));
    document
      .querySelector("#shell")
      ?.insertAdjacentHTML(
        "beforeend",
        `<div id="banner" style="${BAR}">We use cookies <button>OK</button></div>`,
      );
    await new Promise((r) => setTimeout(r, 2 * DETECT_THROTTLE_MS));
    w.stop();
    expect(seen).toEqual(["shell", "banner"]);
  });

  it("survives a throwing handler and still reports the rest of the pass", async () => {
    mount(cookieBar());
    mount(`<div id="two" style="${BAR}bottom:80px">Consent <button>OK</button></div>`);
    const seen: string[] = [];
    const w = new CandidateWatcher(document, (c) => {
      seen.push(c.el.id);
      throw new Error("boom");
    });
    await new Promise((r) => setTimeout(r, 50));
    w.stop();
    expect(seen).toHaveLength(2);
  });

  it("stops after DETECT_WATCH_MS and disconnects its observers", async () => {
    const { clock, advance } = fakeClock();
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const seen: string[] = [];
    new CandidateWatcher(document, (c) => seen.push(c.el.id), clock);
    expect(disconnect).not.toHaveBeenCalled();
    advance(DETECT_WATCH_MS + 1);
    expect(disconnect).toHaveBeenCalled();
    disconnect.mockRestore();
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

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NavigationWatch, captureFocus, safeClick } from "../../src/core/page/click.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

let nav: NavigationWatch;
let startUrl: string;

beforeEach(() => {
  startUrl = location.href;
  nav = new NavigationWatch(window);
});
afterEach(() => {
  nav.dispose();
  unmountAll();
  history.replaceState(null, "", startUrl);
  window.scrollTo(0, 0);
});

const link = (html = '<a id=t href="#cc">x</a>') => mount(html).querySelector("#t") as HTMLElement;

describe("safeClick", () => {
  test("hash guard prevents a fragment jump; site listener on the target sees defaultPrevented false", () => {
    const t = link();
    let seen: boolean | undefined;
    t.addEventListener("click", (e) => {
      seen = e.defaultPrevented;
    });
    expect(safeClick(t, nav)).toEqual({ ok: true, hashGuardUsed: true });
    expect(seen).toBe(false);
    expect(location.hash).toBe("");
  });

  test("delegated document listener sees defaultPrevented true", () => {
    const t = link();
    let seen: boolean | undefined;
    const on = (e: Event) => {
      seen = e.defaultPrevented;
    };
    document.addEventListener("click", on);
    try {
      safeClick(t, nav);
    } finally {
      document.removeEventListener("click", on);
    }
    expect(seen).toBe(true);
  });

  test("stopImmediatePropagation on the target defeats the guard -> hash change detected -> not ok", () => {
    const t = link();
    t.addEventListener("click", (e) => e.stopImmediatePropagation());
    expect(safeClick(t, nav)).toEqual({ ok: false, reason: "hash_changed", hashGuardUsed: true });
    expect(location.hash).toBe("#cc");
  });

  test("scroll-lock library restoring scrollY in its handler with guard flag set -> ok", () => {
    mount('<div style="height:3000px"></div>');
    window.scrollTo(0, 100);
    const t = link();
    t.addEventListener("click", () => window.scrollTo(0, 40));
    expect(safeClick(t, nav).ok).toBe(true);
    expect(window.scrollY).toBe(40);
  });

  test("guard listener is removed when the click never reached it", () => {
    const t = link();
    const block = (e: Event) => e.stopImmediatePropagation();
    t.addEventListener("click", block);
    safeClick(t, nav);
    t.removeEventListener("click", block);
    history.replaceState(null, "", startUrl);
    let seen: boolean | undefined;
    t.addEventListener("click", (e) => {
      seen = e.defaultPrevented;
    });
    const later = (e: Event) => {
      seen = e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener("click", later, { once: true });
    t.click();
    expect(seen).toBe(false);
  });

  test("guard covers a control inside a # link", () => {
    const t = link('<a href="#cc"><div id=t role=button>x</div></a>');
    expect(safeClick(t, nav)).toEqual({ ok: true, hashGuardUsed: true });
    expect(location.hash).toBe("");
  });

  test("an SVG element without click() is clicked by dispatch and never throws", () => {
    const box = mount('<svg><a id=t href="#cc"><text>x</text></a></svg>');
    const t = box.querySelector("#t") as Element;
    expect(safeClick(t, nav)).toEqual({ ok: true, hashGuardUsed: true });
    expect(location.hash).toBe("");
  });

  test("detached element is never clicked", () => {
    const t = link('<button id=t type="button">x</button>');
    let clicks = 0;
    t.addEventListener("click", () => clicks++);
    t.remove();
    expect(safeClick(t, nav)).toEqual({ ok: false, reason: "stale_target", hashGuardUsed: false });
    expect(clicks).toBe(0);
  });

  test("a click that starts a script navigation is reported as navigation", () => {
    const t = link('<button id=t type="button">x</button>');
    t.addEventListener("click", () => {
      (
        window as unknown as { navigation: { navigate(u: string, o: object): void } }
      ).navigation.navigate("#away", { history: "replace" });
    });
    expect(nav.started()).toBe(false);
    expect(safeClick(t, nav)).toEqual({ ok: false, reason: "navigation", hashGuardUsed: false });
  });

  test("a plain button click is ok", () => {
    expect(safeClick(link('<button id=t type="button">x</button>'), nav)).toEqual({
      ok: true,
      hashGuardUsed: false,
    });
  });
});

describe("safeClick: the submit guard", () => {
  const navigation = (window as unknown as { navigation: EventTarget }).navigation;
  /** Navigations that got past the guard. Each is cancelled here, so the test page stays. */
  let leaked: string[];
  let stopLeaks: () => void;
  beforeEach(() => {
    leaked = [];
    // Registered after the watch's own listener (the outer beforeEach), so it sees its cancel.
    const onNavigate = (e: Event) => {
      if (e.defaultPrevented) return;
      leaked.push((e as Event & { destination: { url: string } }).destination.url);
      e.preventDefault();
    };
    navigation.addEventListener("navigate", onNavigate);
    stopLeaks = () => navigation.removeEventListener("navigate", onNavigate);
  });
  afterEach(() => stopLeaks());

  /** Past the task in which a submission's navigation would begin. */
  const settle = () => new Promise((r) => setTimeout(r, 50));
  /** ONS's shape: the form's own action is accept-all. */
  const reject = (html = "") => {
    const box = mount(`<form id=f action="/accept-all" method="get"><input name=x value=1>
      <button id=t>Reject additional cookies</button></form>${html}`);
    return { form: box.querySelector("#f") as HTMLFormElement, t: box.querySelector("#t")! };
  };

  test("the page's own submit handlers run first and see defaultPrevented false", async () => {
    const { form, t } = reject();
    const seen: boolean[] = [];
    const onDoc = (e: Event) => seen.push(e.defaultPrevented);
    document.addEventListener("submit", onDoc);
    form.addEventListener("submit", (e) => {
      seen.push(e.defaultPrevented);
      e.preventDefault(); // the page handles its own submission
    });
    try {
      expect(safeClick(t, nav)).toEqual({ ok: true, hashGuardUsed: false });
    } finally {
      document.removeEventListener("submit", onDoc);
    }
    expect(seen).toEqual([false, true]);
    await settle();
    expect(leaked).toEqual([]);
  });

  test("a submission no handler cancels is cancelled by the guard: no navigation", async () => {
    const { t } = reject();
    expect(safeClick(t, nav)).toEqual({ ok: true, hashGuardUsed: false, submitGuard: "cancelled" });
    await settle();
    expect(leaked).toEqual([]);
    expect(location.href).toBe(startUrl);
  });

  test("a handler that stops propagation without cancelling is caught by the backstop, after the watch is disposed", async () => {
    const { form, t } = reject();
    form.addEventListener("submit", (e) => e.stopImmediatePropagation());
    const r = safeClick(t, nav);
    nav.dispose(); // as the own path does, in the same turn as the click
    // The verification's watch, made after the click, must not count the cancelled navigation.
    const later = new NavigationWatch(window);
    expect(r).toEqual({ ok: true, hashGuardUsed: false, submitGuard: "cancelled" });
    await settle();
    expect(leaked).toEqual([]);
    expect(location.href).toBe(startUrl);
    expect(later.started()).toBe(false);
    later.dispose();
  });

  test("a form in an open shadow root is guarded too", async () => {
    const host = mount("<div id=h></div>").querySelector("#h") as HTMLElement;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<form action="/accept-all"><button id=t>Reject</button></form>`;
    expect(safeClick(root.querySelector("#t")!, nav)).toMatchObject({ submitGuard: "cancelled" });
    await settle();
    expect(leaked).toEqual([]);
  });

  test("a button outside any form, or of type button, gets no submit guard", () => {
    const box = mount("<button id=a>x</button><form><button id=b type=button>x</button></form>");
    expect(safeClick(box.querySelector("#a")!, nav)).toEqual({ ok: true, hashGuardUsed: false });
    expect(safeClick(box.querySelector("#b")!, nav)).toEqual({ ok: true, hashGuardUsed: false });
  });
});

describe("safeClick: focus for the click", () => {
  /** ons.gov.uk's banner: its submit handler reads which button has focus, not the submitter. */
  const onsForm = () => {
    const root = mount(`<button id=elsewhere>Elsewhere</button><input id=q>
      <form id=f action="/accept-all"><button type=submit data-action=accept id=acc>Accept</button>
      <button type=submit data-action=reject id=rej>Reject</button></form>`);
    const read: (string | null)[] = [];
    root.querySelector("#f")?.addEventListener("submit", (e) => {
      e.preventDefault();
      read.push(document.activeElement?.getAttribute("data-action") ?? null);
    });
    const el = (id: string) => root.querySelector(`#${id}`) as HTMLElement;
    return { read, el };
  };

  test("the page sees the clicked control focused during the click; focus goes back after", () => {
    const { read, el } = onsForm();
    el("elsewhere").focus();
    expect(safeClick(el("rej"), nav)).toEqual({ ok: true, hashGuardUsed: false });
    expect(read).toEqual(["reject"]);
    expect(document.activeElement).toBe(el("elsewhere"));
  });

  test("with Accept focused, a click on Reject is read as Reject", () => {
    const { read, el } = onsForm();
    el("acc").focus();
    safeClick(el("rej"), nav);
    expect(read).toEqual(["reject"]);
    expect(document.activeElement).toBe(el("acc"));
  });

  test("nothing focused before: nothing focused after", () => {
    const { read, el } = onsForm();
    (document.activeElement as HTMLElement | null)?.blur();
    safeClick(el("rej"), nav);
    expect(read).toEqual(["reject"]);
    expect(document.activeElement).toBe(document.body);
  });

  test("a field being typed in keeps its focus: never blurred", () => {
    const { read, el } = onsForm();
    const q = el("q");
    q.focus();
    let blurs = 0;
    q.addEventListener("blur", () => blurs++);
    safeClick(el("rej"), nav);
    expect(blurs).toBe(0);
    expect(document.activeElement).toBe(q);
    // The page can't tell which button it was, so it does nothing: nothing wrong is recorded.
    expect(read).toEqual([null]);
  });
});

describe("NavigationWatch", () => {
  test("beforeunload marks started; dispose stops listening", () => {
    const w = new NavigationWatch(window);
    window.dispatchEvent(new Event("beforeunload"));
    expect(w.started()).toBe(true);
    const w2 = new NavigationWatch(window);
    w2.dispose();
    window.dispatchEvent(new Event("beforeunload"));
    expect(w2.started()).toBe(false);
    w.dispose();
  });
});

describe("captureFocus", () => {
  test("focus moved into banner is restored without scrolling", () => {
    const box = mount(
      '<input id=a><div style="height:3000px"></div><div id=banner><button id=b>x</button></div>',
    );
    const a = box.querySelector("#a") as HTMLElement;
    a.focus();
    const restore = captureFocus(document);
    const b = box.querySelector("#b") as HTMLElement;
    b.focus({ preventScroll: true });
    window.scrollTo(0, 500);
    restore([box.querySelector("#banner") as Element]);
    expect(document.activeElement).toBe(a);
    expect(window.scrollY).toBe(500);
  });

  test("focus elsewhere is left alone", () => {
    const box = mount("<input id=a><input id=c><div id=banner></div>");
    (box.querySelector("#a") as HTMLElement).focus();
    const restore = captureFocus(document);
    const c = box.querySelector("#c") as HTMLElement;
    c.focus();
    restore([box.querySelector("#banner") as Element]);
    expect(document.activeElement).toBe(c);
  });

  test("focus inside a shadow root of a touched host is restored", () => {
    const box = mount("<input id=a><div id=host></div>");
    const a = box.querySelector("#a") as HTMLElement;
    const host = box.querySelector("#host") as HTMLElement;
    host.attachShadow({ mode: "open" }).innerHTML = "<button>x</button>";
    a.focus();
    const restore = captureFocus(document);
    (host.shadowRoot?.querySelector("button") as HTMLElement).focus();
    restore([host]);
    expect(document.activeElement).toBe(a);
  });
});

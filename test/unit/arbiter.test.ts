import { describe, expect, it } from "vitest";
import { Arbiter } from "../../src/core/arbiter.ts";
import type { KV } from "../../src/core/platform.ts";
import { fakeBackground } from "../helpers/fake-platform.ts";

async function setup() {
  const { session } = fakeBackground();
  const arb = new Arbiter(session);
  await arb.topDocument(1, "doc-1");
  return { session, arb };
}

describe("Arbiter", () => {
  it("a top-frame cmpDetected refuses Bouncer's claim", async () => {
    const { arb } = await setup();
    await arb.cmpDetected(1, 0);
    expect(await arb.claimForBouncer(1, "doc-1")).toEqual({
      granted: false,
      reason: "autoconsent",
    });
    expect(await arb.owner(1)).toBe("autoconsent");
  });

  it("a child-frame cmpDetected lets Bouncer claim", async () => {
    const { arb } = await setup();
    await arb.cmpDetected(1, 5);
    expect(await arb.claimForBouncer(1, "doc-1")).toEqual({ granted: true });
    expect(await arb.owner(1)).toBe("bouncer");
  });

  it("popupFound after Bouncer's grant sends no opt-out", async () => {
    const { arb } = await setup();
    await arb.claimForBouncer(1, "doc-1");
    expect(await arb.popupFound(1, 0)).toEqual({ sendOptOut: false });
  });

  it("popupFound first refuses Bouncer's claim, and repeats stay true", async () => {
    const { arb } = await setup();
    expect(await arb.popupFound(1, 3)).toEqual({ sendOptOut: true });
    expect(await arb.popupFound(1, 0)).toEqual({ sendOptOut: true });
    expect((await arb.claimForBouncer(1, "doc-1")).granted).toBe(false);
  });

  it("cmpDetected and popupFound naming another page than the recorded one change nothing", async () => {
    const { arb } = await setup();
    await arb.cmpDetected(1, 0, "doc-0");
    expect(await arb.popupFound(1, 3, "doc-0")).toEqual({ sendOptOut: false, reason: "stale" });
    expect(await arb.owner(1)).toBe("none");
    expect(await arb.claimForBouncer(1, "doc-1")).toEqual({ granted: true });
    // The page on record is matched as before.
    const { arb: other } = await setup();
    await other.cmpDetected(1, 0, "doc-1");
    expect(await other.popupFound(1, 3, "doc-1")).toEqual({ sendOptOut: true });
    expect(await other.owner(1)).toBe("autoconsent");
  });

  it("a second claim by Bouncer is refused as already", async () => {
    const { arb } = await setup();
    await arb.claimForBouncer(1, "doc-1");
    expect(await arb.claimForBouncer(1, "doc-1")).toEqual({ granted: false, reason: "already" });
  });

  it("two concurrent claims produce exactly one grant", async () => {
    const { arb } = await setup();
    const rs = await Promise.all([
      arb.claimForBouncer(1, "doc-1"),
      arb.claimForBouncer(1, "doc-1"),
    ]);
    expect(rs.filter((r) => r.granted)).toHaveLength(1);
  });

  it("a new topDocument resets state and old claims are stale", async () => {
    const { arb } = await setup();
    await arb.claimForBouncer(1, "doc-1");
    await arb.topDocument(1, "doc-2");
    expect(await arb.owner(1)).toBe("none");
    expect(await arb.claimForBouncer(1, "doc-1")).toEqual({ granted: false, reason: "stale" });
    expect(await arb.claimForBouncer(1, "doc-2")).toEqual({ granted: true });
  });

  it("with no recorded top document, a claim is stale", async () => {
    const { session } = fakeBackground();
    const arb = new Arbiter(session);
    expect(await arb.claimForBouncer(2, "doc-9")).toEqual({ granted: false, reason: "stale" });
    expect(await arb.owner(2)).toBe("none");
  });

  it("autoconsent speaking first is kept when the top document arrives", async () => {
    const { session } = fakeBackground();
    const arb = new Arbiter(session);
    await arb.popupFound(2, 0);
    expect((await arb.claimForBouncer(2, "doc-9")).reason).toBe("stale");
    await arb.topDocument(2, "doc-9");
    expect(await arb.claimForBouncer(2, "doc-9")).toEqual({
      granted: false,
      reason: "autoconsent",
    });
  });

  it("topDocument says whether the tab has a new page: not for the same document, nor one autoconsent spoke for first", async () => {
    const { session } = fakeBackground();
    const arb = new Arbiter(session);
    expect(await arb.topDocument(1, "doc-1")).toBe(true);
    expect(await arb.topDocument(1, "doc-1")).toBe(false);
    expect(await arb.topDocument(1, "doc-2")).toBe(true);
    await arb.cmpDetected(2, 0); // before any document is on record for tab 2
    expect(await arb.topDocument(2, "doc-9")).toBe(false);
  });

  it("a duplicate topDocument for the same document keeps the claim", async () => {
    const { arb } = await setup();
    await arb.claimForBouncer(1, "doc-1");
    await arb.topDocument(1, "doc-1");
    expect(await arb.claimForBouncer(1, "doc-1")).toEqual({ granted: false, reason: "already" });
    expect(await arb.popupFound(1, 0)).toEqual({ sendOptOut: false });
  });

  it("a persisted top-frame cmpDetected keeps the claim refused after a restart", async () => {
    const { session, arb } = await setup();
    await arb.cmpDetected(1, 0);
    const reborn = new Arbiter(session);
    expect(await reborn.claimForBouncer(1, "doc-1")).toEqual({
      granted: false,
      reason: "autoconsent",
    });
  });

  it("a concurrent claim and popupFound have exactly one winner", async () => {
    const { arb } = await setup();
    const [claim, popup] = await Promise.all([
      arb.claimForBouncer(1, "doc-1"),
      arb.popupFound(1, 0),
    ]);
    expect(Number(claim.granted) + Number(popup.sendOptOut)).toBe(1);
  });

  it("survives a restart: a new Arbiter over the same KV sees the claim", async () => {
    const { session, arb } = await setup();
    await arb.claimForBouncer(1, "doc-1");
    const reborn = new Arbiter(session);
    expect(await reborn.popupFound(1, 0)).toEqual({ sendOptOut: false });
    expect(await reborn.owner(1)).toBe("bouncer");
  });

  it("tabs are independent and forget clears one", async () => {
    const { arb } = await setup();
    await arb.claimForBouncer(1, "doc-1");
    expect(await arb.owner(2)).toBe("none");
    await arb.forget(1);
    expect(await arb.owner(1)).toBe("none");
  });

  it("a rejected KV call rejects its caller but does not wedge the chain", async () => {
    const { session } = fakeBackground();
    let fail = true;
    const flaky: KV = {
      get: (k) => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("boom"));
        }
        return session.get(k);
      },
      set: (k, v) => session.set(k, v),
      remove: (k) => session.remove(k),
    };
    const arb = new Arbiter(flaky);
    await expect(arb.claimForBouncer(1, "doc-1")).rejects.toThrow("boom");
    await arb.topDocument(1, "doc-1");
    expect(await arb.claimForBouncer(1, "doc-1")).toEqual({ granted: true });
  });
});

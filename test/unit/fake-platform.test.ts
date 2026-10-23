import { describe, expect, expectTypeOf, it } from "vitest";
import type { AiResult, AiStatus } from "../../src/core/ai.ts";
import type { ReplyOf, ToBackground } from "../../src/core/messages.ts";
import type { Sender } from "../../src/core/platform.ts";
import { fakeBackground, fakeContent } from "../helpers/fake-platform.ts";

describe("ReplyOf", () => {
  it("maps each message type to its reply", () => {
    expectTypeOf<ReplyOf<{ type: "claim" }>>().toEqualTypeOf<{
      granted: boolean;
      reason?: "autoconsent" | "already";
    }>();
    expectTypeOf<ReplyOf<{ type: "log"; entry: never }>>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<ReplyOf<{ type: "ai"; op: "status"; args: [] }>>().toEqualTypeOf<AiStatus>();
    expectTypeOf<ReplyOf<{ type: "ai"; op: "corroborate"; args: never }>>().toEqualTypeOf<
      AiResult<boolean>
    >();
    expectTypeOf<ReplyOf<{ type: "discardRule"; site: string }>>().toEqualTypeOf<void>();
    expectTypeOf<ReplyOf<ToBackground>>().not.toBeNever();
  });
});

describe("fake platform", () => {
  it("routes content messages to the background with the configured sender", async () => {
    const bg = fakeBackground();
    const seen: { msg: unknown; from: Sender }[] = [];
    bg.onMessage((msg, from) => {
      seen.push({ msg, from });
      return Promise.resolve({ granted: true });
    });
    const c = fakeContent(bg, { tabId: 7, frameId: 2, url: "https://x.test/" });
    const reply = await c.send({ type: "claim" });
    expect(reply).toEqual({ granted: true });
    expect(seen[0]?.from).toMatchObject({ tabId: 7, frameId: 2, url: "https://x.test/" });
  });

  it("replies undefined when the handler returns undefined", async () => {
    const bg = fakeBackground();
    bg.onMessage(() => undefined);
    expect(await fakeContent(bg).send({ type: "claim" })).toBeUndefined();
  });

  it("copies messages, so the sender cannot alias what the handler sees", async () => {
    const bg = fakeBackground();
    let got: unknown;
    bg.onMessage((m) => {
      got = m;
      return undefined;
    });
    const msg = { type: "discardRule" as const, site: "a" };
    await fakeContent(bg).send(msg);
    expect(got).toEqual(msg);
    expect(got).not.toBe(msg);
  });

  it("sendToFrame reaches only the matching content", async () => {
    const bg = fakeBackground();
    const a = fakeContent(bg, { tabId: 1, frameId: 0 });
    const b = fakeContent(bg, { tabId: 1, frameId: 3 });
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    a.onMessage((m) => gotA.push(m));
    b.onMessage((m) => gotB.push(m));
    await bg.sendToFrame(1, 3, { type: "acDetected" });
    expect(gotA).toEqual([]);
    expect(gotB).toEqual([{ type: "acDetected" }]);
    await expect(bg.sendToFrame(9, 9, { type: "restoreAcStyles" })).rejects.toThrow();
  });

  it("restart drops handlers but keeps local and session", async () => {
    const bg = fakeBackground();
    await bg.local.set("k", { a: 1 });
    await bg.session.set("s", [1]);
    bg.onMessage(() => Promise.resolve(1));
    const removed: number[] = [];
    bg.onTabRemoved((t) => removed.push(t));
    bg.restart();
    expect(await bg.local.get("k")).toEqual({ a: 1 });
    expect(await bg.session.get("s")).toEqual([1]);
    await expect(fakeContent(bg).send({ type: "claim" })).rejects.toThrow();
    bg.removeTab(1);
    expect(removed).toEqual([]);
  });

  it("KV stores copies, not references", async () => {
    const { local } = fakeBackground();
    const v = { n: 1 };
    await local.set("k", v);
    v.n = 2;
    const got = await local.get<{ n: number }>("k");
    expect(got).toEqual({ n: 1 });
    if (got) got.n = 3;
    expect(await local.get("k")).toEqual({ n: 1 });
    await local.remove("k");
    expect(await local.get("k")).toBeUndefined();
  });
});

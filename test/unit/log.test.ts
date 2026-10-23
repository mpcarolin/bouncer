import { describe, expect, it } from "vitest";
import { LOG_RETENTION_MS } from "../../src/core/config.ts";
import { DecisionLog, type LogEntry } from "../../src/core/log.ts";
import { fakeBackground } from "../helpers/fake-platform.ts";

const H = 3_600_000;

function entry(at: number, over: Partial<LogEntry> = {}): Omit<LogEntry, "id"> {
  return {
    at,
    site: "example.com",
    url: "https://example.com/",
    path: "heuristic",
    clicked: [],
    toggles: [],
    t: {},
    modelCalls: [],
    outcome: "dismissed",
    notes: [],
    ...over,
  };
}

function setup(start = 0) {
  const { local } = fakeBackground();
  const clock = { t: start };
  return { local, clock, log: new DecisionLog(local, () => clock.t) };
}

describe("DecisionLog", () => {
  it("prunes entries older than 24h and keeps newer ones", async () => {
    const { log, clock } = setup();
    await log.add(entry(0));
    clock.t = H;
    const kept = await log.add(entry(H));
    clock.t = LOG_RETENTION_MS;
    expect(await log.list()).toHaveLength(2); // exactly 24h old: kept
    clock.t = LOG_RETENTION_MS + 1;
    expect((await log.list()).map((e) => e.id)).toEqual([kept]);
  });

  it("prunes on write too, and persists the pruned list", async () => {
    const { log, clock, local } = setup();
    await log.add(entry(0));
    clock.t = LOG_RETENTION_MS + 1;
    await log.add(entry(clock.t));
    const raw = (await local.get<LogEntry[]>("decisionLog")) ?? [];
    expect(raw).toHaveLength(1);
  });

  it("keeps every entry of concurrent adds, with unique ids", async () => {
    const { log } = setup();
    const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => log.add(entry(i))));
    expect(new Set(ids).size).toBe(20);
    expect(await log.list()).toHaveLength(20);
  });

  it("patch merges t shallowly and other fields by replacement", async () => {
    const { log } = setup();
    const id = await log.add(entry(0, { t: { found: 5 }, notes: ["a"] }));
    await log.patch(id, { t: { decided: 9 }, outcome: "failed", notes: ["b"] });
    const [e] = await log.list();
    expect(e?.t).toEqual({ found: 5, decided: 9 });
    expect(e?.outcome).toBe("failed");
    expect(e?.notes).toEqual(["b"]);
    expect(e?.id).toBe(id);
  });

  it("patch on an unknown id is a no-op", async () => {
    const { log } = setup();
    await log.add(entry(0));
    await log.patch("nope", { outcome: "failed" });
    expect((await log.list())[0]?.outcome).toBe("dismissed");
  });

  it("concurrent patches and adds do not lose updates", async () => {
    const { log } = setup();
    const id = await log.add(entry(0));
    await Promise.all([
      log.patch(id, { t: { found: 1 } }),
      log.patch(id, { t: { decided: 2 } }),
      log.add(entry(1)),
    ]);
    const list = await log.list();
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.id === id)?.t).toEqual({ found: 1, decided: 2 });
  });

  it("exportJson round-trips", async () => {
    const { log } = setup();
    await log.add(entry(0, { rule: "r", labels: { 1: { label: "reject", source: "rule" } } }));
    expect(JSON.parse(await log.exportJson())).toEqual(await log.list());
  });
});

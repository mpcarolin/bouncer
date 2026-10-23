import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/ai/mock/provider.ts";
import type { SerialisedBanner } from "../../src/core/types.ts";
import { loadFixtures } from "../fixtures/load.ts";

const banner = (text: string, controlTexts: string[] = []): SerialisedBanner => ({
  text,
  controls: controlTexts.map((t, i) => ({ id: i, role: "button", text: t })),
});

describe("MockProvider", () => {
  const mock = new MockProvider();
  const fixtures = loadFixtures();

  it("reports available and on-device", async () => {
    expect(await mock.status()).toEqual({ state: "available", onDevice: true });
  });

  it("gate says no on neg-pinterest-login and yes on stackoverflow", async () => {
    const get = (id: string) => fixtures.find((f) => f.id === id)!.banner;
    const no = await mock.isConsentDialog(get("neg-pinterest-login"));
    const yes = await mock.isConsentDialog(get("stackoverflow"));
    expect(no).toMatchObject({ kind: "answer", value: false });
    expect(yes).toMatchObject({ kind: "answer", value: true });
  });

  it("labels from the lookup table, else other", async () => {
    const b = banner("We use cookies", [
      "Continue to site",
      "Proceed",
      "Fine by me",
      "Our partners",
      "Whatever",
    ]);
    const r = await mock.labelControls(b, [0, 1, 2, 3, 4]);
    expect(r).toMatchObject({
      kind: "answer",
      value: { 0: "reject", 1: "reject", 2: "save", 3: "settings", 4: "other" },
    });
  });

  it("corroborates only the known texts", async () => {
    const b = banner("cookies", ["Not now", "Leave it", "Nope"]);
    const [a, c, d] = b.controls;
    expect(await mock.corroborate(b, a!, "reject")).toMatchObject({ value: true });
    expect(await mock.corroborate(b, c!, "reject")).toMatchObject({ value: true });
    expect(await mock.corroborate(b, d!, "reject")).toMatchObject({ value: false });
  });

  it("[mock:timeout] makes every op time out", async () => {
    const b = banner("cookies [mock:timeout]", ["Not now"]);
    for (const r of [
      await mock.isConsentDialog(b),
      await mock.labelControls(b, [0]),
      await mock.corroborate(b, b.controls[0]!, "reject"),
    ]) {
      expect(r.kind).toBe("timeout");
    }
  });

  it("[mock:error] makes every op error", async () => {
    const b = banner("cookies [mock:error]", ["Not now"]);
    for (const r of [
      await mock.isConsentDialog(b),
      await mock.labelControls(b, [0]),
      await mock.corroborate(b, b.controls[0]!, "reject"),
    ]) {
      expect(r.kind).toBe("error");
    }
  });
});

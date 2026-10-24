import { afterEach, describe, expect, it, vi } from "vitest";
import { MockProvider } from "../../src/ai/mock/provider.ts";
import type { AiResult } from "../../src/core/ai.ts";
import type { BannerFixture } from "../../src/core/fixture.ts";
import type { Label, SerialisedBanner } from "../../src/core/types.ts";
import { renderBench } from "../../src/pages/bench/render.ts";
import { b, btn, type Draft } from "../helpers/banner.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

function fixture(
  id: string,
  kind: "positive" | "negative",
  text: string,
  drafts: Draft[],
  labels: Label[] = [],
): BannerFixture {
  return {
    id,
    kind,
    stage: 1,
    note: "built by the test",
    gate: kind === "positive" ? "consent" : "other",
    banner: { ...b(drafts), text },
    ...(kind === "positive"
      ? { expectedLabels: Object.fromEntries(labels.map((l, i) => [i, l])) }
      : {}),
  };
}

// The mock reads "cookie" as consent, "sign up" as not; it labels "Continue to site" reject (wrong:
// it accepts) and "Whatever" other (right).
const FIXTURES = [
  fixture(
    "p1",
    "positive",
    "We use cookies",
    [btn("Reject all"), btn("Continue to site"), btn("Whatever")],
    ["reject", "accept", "other"],
  ),
  fixture("adv-x", "positive", "We use cookies", [btn("Continue to site")], ["accept"]),
  fixture("n1", "negative", "Sign up for our newsletter", [btn("Sign up")]),
];

/** The mock, except that corroboration says yes to everything: a model that would be fooled. */
class FooledProvider extends MockProvider {
  override async corroborate(): Promise<AiResult<boolean>> {
    return { kind: "answer", value: true, meta: { ms: 0, cold: false, onDevice: true } };
  }
}

async function open(provider: MockProvider = new MockProvider(), reps = 1) {
  const root = mount("");
  await renderBench(root, { provider, fixtures: FIXTURES, reps });
  return root;
}

const runButton = (root: ParentNode) => root.querySelector("button");
const buttonNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("button")].find((x) => x.textContent === name);

/** The summary's value for the row called `name`. */
const summaryOf = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("th")].find((th) => th.textContent === name)?.nextElementSibling
    ?.textContent;

async function run(root: ParentNode) {
  runButton(root)?.click();
  await vi.waitFor(() => expect(buttonNamed(root, "Download JSON")).toBeDefined());
}

describe("benchmark page", () => {
  it("shows the model's state and waits for a click before it asks the model anything", async () => {
    const provider = new MockProvider();
    const gate = vi.spyOn(provider, "isConsentDialog");
    const root = await open(provider);
    expect(root.textContent).toContain("3 banner fixtures");
    expect(root.textContent).toContain("Model: available. Runs on this device: yes.");
    expect(runButton(root)?.textContent).toBe("Run the benchmark");
    expect(root.querySelector("table")).toBeNull();
    expect(gate).not.toHaveBeenCalled();
  });

  it("reports the scores once the run ends", async () => {
    const root = await open();
    await run(root);
    expect(summaryOf(root, "Gate accuracy")).toBe("3 of 3 (100%)");
    expect(summaryOf(root, "Gate false positives")).toBe("0");
    expect(summaryOf(root, "Labeller accuracy")).toBe("1 of 3 (33%)");
    expect(summaryOf(root, "Adversarial controls corroboration would click")).toBe("none");
    expect(summaryOf(root, "Warm calls")).toMatch(/^\d+, median 0 ms$/);
    const rows = [...(root.querySelectorAll("tbody")[1]?.querySelectorAll("tr") ?? [])];
    expect(rows.map((r) => r.querySelector("td")?.textContent)).toEqual(["p1", "adv-x", "n1"]);
    expect(runButton(root)?.disabled).toBe(false);
    expect(runButton(root)?.textContent).toBe("Run again");
  });

  it("lists the adversarial controls corroboration would click, and marks them", async () => {
    const root = await open(new FooledProvider());
    await run(root);
    expect([...root.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "adv-x:0 reject",
    ]);
    const advRow = [...root.querySelectorAll("tr")].find((r) => r.textContent?.startsWith("adv-x"));
    expect(advRow?.textContent).toContain("would click 1");
    expect(advRow?.querySelector(".warn")).not.toBeNull();
  });

  it("shows its progress while it runs, and disables the button", async () => {
    const provider = new MockProvider();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realGate = provider.isConsentDialog.bind(provider);
    vi.spyOn(provider, "isConsentDialog").mockImplementation(async (banner: SerialisedBanner) => {
      await held;
      return realGate(banner);
    });
    const root = await open(provider);
    runButton(root)?.click();
    await vi.waitFor(() => expect(runButton(root)?.disabled).toBe(true));
    expect(root.querySelector("progress")?.hidden).toBe(false);
    release();
    await vi.waitFor(() => expect(buttonNamed(root, "Download JSON")).toBeDefined());
    expect(root.querySelector("progress")?.hidden).toBe(true);
  });

  it("says so when the run stops, instead of leaving the page blank", async () => {
    const provider = new MockProvider();
    vi.spyOn(provider, "isConsentDialog").mockRejectedValue(new Error("model went away"));
    const root = await open(provider);
    runButton(root)?.click();
    await vi.waitFor(() =>
      expect(root.textContent).toContain("The benchmark stopped: model went away"),
    );
    expect(runButton(root)?.disabled).toBe(false);
  });

  it("downloads the report as valid JSON", async () => {
    const root = await open(new FooledProvider(), 2);
    await run(root);
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    buttonNamed(root, "Download JSON")?.click();
    await vi.waitFor(() => expect(clicked).toHaveLength(1));
    const [link] = clicked;
    if (!link) throw new Error("no download link");
    expect(link.download).toMatch(/\.json$/);
    const report = JSON.parse(await (await fetch(link.href)).text());
    expect(report.reps).toBe(2);
    expect(report.gate.total).toBe(6);
    expect(report.corroboration.adversarialConfirmed).toEqual(["adv-x:0 reject"]);
    expect(report.perFixture.map((f: { id: string }) => f.id)).toEqual(["p1", "adv-x", "n1"]);
  });

  it("writes fixture text as text, never as markup", async () => {
    const hostile = fixture("<img src=x onerror=alert(1)>", "negative", "Sign up", [
      btn("Sign up"),
    ]);
    const root = mount("");
    await renderBench(root, { provider: new MockProvider(), fixtures: [hostile], reps: 1 });
    await run(root);
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

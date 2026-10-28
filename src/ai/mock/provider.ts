import type { AiMeta, AiProvider, AiResult, AiStatus } from "../../core/ai.ts";
import type { Control, Label, SerialisedBanner } from "../../core/types.ts";

/** Marker so the build can prove the mock is (or isn't) in a bundle. */
export const MOCK_MARKER = "__BOUNCER_MOCK__";

/** The mock's "download": it has nothing to fetch, so it is done at once. */
export async function mockDownload(onProgress: (loaded: number) => void): Promise<AiStatus> {
  onProgress(1);
  return { state: "available", onDevice: true };
}

const META: AiMeta = { ms: 0, cold: false, onDevice: true };

/**
 * How long `[mock:slow]` makes every answer take: longer than autoconsent's next look takes to
 * come, as a real model's answer can (§2b).
 */
export const MOCK_SLOW_MS = 1500;

const LABELS: Record<string, Label> = {
  "Continue to site": "reject",
  Proceed: "reject",
  "Fine by me": "save",
  "Our partners": "settings",
};

const CORROBORATED = new Set(["Not now", "Leave it"]);

/** Deterministic provider for tests and the e2e build. */
export class MockProvider implements AiProvider {
  readonly marker = MOCK_MARKER;

  private async pace(b: SerialisedBanner): Promise<void> {
    if (b.text.includes("[mock:slow]")) await new Promise((r) => setTimeout(r, MOCK_SLOW_MS));
  }

  private forced(b: SerialisedBanner): AiResult<never> | undefined {
    if (b.text.includes("[mock:timeout]")) return { kind: "timeout", meta: { ...META } };
    if (b.text.includes("[mock:error]")) {
      return { kind: "error", error: "mock_error", meta: { ...META } };
    }
    return undefined;
  }

  async status(): Promise<AiStatus> {
    return { state: "available", onDevice: true };
  }

  async isConsentDialog(b: SerialisedBanner): Promise<AiResult<boolean>> {
    await this.pace(b);
    const value =
      /cookie|consent|tracking/i.test(b.text) &&
      !/log in|sign up|newsletter|chat|subscribe/i.test(b.text);
    return this.forced(b) ?? { kind: "answer", value, meta: { ...META } };
  }

  async labelControls(
    b: SerialisedBanner,
    controlIds: number[],
  ): Promise<AiResult<Record<number, Label>>> {
    await this.pace(b);
    const value: Record<number, Label> = {};
    for (const id of controlIds) {
      const text = b.controls.find((c) => c.id === id)?.text ?? "";
      value[id] = LABELS[text] ?? "other";
    }
    return this.forced(b) ?? { kind: "answer", value, meta: { ...META } };
  }

  async corroborate(
    b: SerialisedBanner,
    control: Control,
    _label: "reject" | "save" | "settings",
  ): Promise<AiResult<boolean>> {
    await this.pace(b);
    return (
      this.forced(b) ?? {
        kind: "answer",
        value: CORROBORATED.has(control.text),
        meta: { ...META },
      }
    );
  }
}

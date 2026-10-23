import type { AiProvider } from "./ai.ts";
import { MAX_MODEL_CALLS_PER_PAGE } from "./config.ts";

/** Caps model calls per page. One instance per page; `status()` is free. */
export class ModelBudget {
  private used = 0;

  constructor(private readonly max = MAX_MODEL_CALLS_PER_PAGE) {}

  wrap(p: AiProvider): AiProvider {
    const exhausted = () => ({
      kind: "error" as const,
      error: "budget_exhausted",
      meta: { ms: 0, cold: false, onDevice: true },
    });
    const spend = () => this.used++ < this.max;
    return {
      status: () => p.status(),
      isConsentDialog: (b) => (spend() ? p.isConsentDialog(b) : Promise.resolve(exhausted())),
      labelControls: (b, ids) => (spend() ? p.labelControls(b, ids) : Promise.resolve(exhausted())),
      corroborate: (b, c, l) => (spend() ? p.corroborate(b, c, l) : Promise.resolve(exhausted())),
    };
  }
}

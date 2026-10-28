import type { AiProvider } from "./ai.ts";
import type { BackgroundPlatform } from "./platform.ts";
import { loadSettings } from "./settings.ts";

function report(what: string, e: unknown): void {
  console.error(`bouncer: ${what}`, e);
}

/**
 * Settings' `keepModelWarm`. The model session lives in the background, and Chrome stops an idle
 * background after 30 s, which unloads the model: the next AI decision then waits ~10 s for it to
 * load again. While the setting is on, the background is kept running and the model loaded, warmed
 * again on every tick in case Chrome dropped it. Off, or with Bouncer switched off (which uses no
 * model), the background stops when idle, as before.
 */
export class KeepWarm {
  private release: (() => void) | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly p: BackgroundPlatform,
    private readonly provider: AiProvider,
  ) {}

  /** Starts or stops to match the stored setting. Calls are queued, so the latest read wins. */
  sync(): Promise<void> {
    const run = this.queue.then(async () => {
      const s = await loadSettings(this.p.local);
      const on = s.enabled && s.keepModelWarm;
      if (on && !this.release) {
        this.release = this.p.keepRunning(() => this.warm());
        this.warm();
      } else if (!on && this.release) {
        this.release();
        this.release = undefined;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private warm(): void {
    this.provider.warmUp?.().catch((e) => report("failed to warm the model", e));
  }
}

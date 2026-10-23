import type { AiMeta, AiProvider, AiResult, AiStatus } from "./ai.ts";
import { CREATE_TIMEOUT_MS, PROMPT_TIMEOUT_MS } from "./config.ts";
import type { AiOps, AiRequest } from "./messages.ts";
import type { ContentPlatform } from "./platform.ts";

const SEND_TIMEOUT_MS = CREATE_TIMEOUT_MS + PROMPT_TIMEOUT_MS;

/**
 * Content-side AiProvider that forwards each op to the background's provider. It never throws
 * into the page: a rejected send (worker died, no handler) or one that never settles ends as a
 * time-out. The transport can't know whether the model is on-device, so a time-out's meta says
 * `onDevice: false` (the conservative claim).
 */
export class RemoteAiProvider implements AiProvider {
  constructor(private readonly p: ContentPlatform) {}

  private async call<K extends keyof AiOps>(op: K, args: AiOps[K]) {
    const msg = { type: "ai", op, args } as AiRequest;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SEND_TIMEOUT_MS);
    });
    try {
      const reply = await Promise.race([this.p.send(msg), deadline]);
      return reply === "timeout" ? undefined : reply;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async model<T, K extends Exclude<keyof AiOps, "status">>(
    op: K,
    args: AiOps[K],
  ): Promise<AiResult<T>> {
    const start = Date.now();
    const reply = await this.call(op, args);
    return (
      (reply as AiResult<T> | undefined) ?? {
        kind: "timeout",
        meta: { ms: Date.now() - start, cold: false, onDevice: false } satisfies AiMeta,
      }
    );
  }

  async status(): Promise<AiStatus> {
    const reply = await this.call("status", []);
    return (
      (reply as AiStatus | undefined) ?? {
        state: "unavailable",
        reason: "transport",
        onDevice: false,
      }
    );
  }

  isConsentDialog(b: Parameters<AiProvider["isConsentDialog"]>[0]) {
    return this.model<boolean, "isConsentDialog">("isConsentDialog", [b]);
  }

  labelControls(b: Parameters<AiProvider["labelControls"]>[0], controlIds: number[]) {
    return this.model<Record<number, never>, "labelControls">("labelControls", [b, controlIds]);
  }

  corroborate(
    b: Parameters<AiProvider["corroborate"]>[0],
    control: Parameters<AiProvider["corroborate"]>[1],
    label: "reject" | "save" | "settings",
  ) {
    return this.model<boolean, "corroborate">("corroborate", [b, control, label]);
  }
}

/** Background side: run one forwarded op on the real provider. Never throws. */
export async function serveAi(
  provider: AiProvider,
  op: string,
  args: unknown[],
): Promise<AiResult<unknown> | AiStatus> {
  const meta: AiMeta = { ms: 0, cold: false, onDevice: true };
  try {
    switch (op) {
      case "status":
        return await provider.status();
      case "isConsentDialog":
        return await provider.isConsentDialog(...(args as AiOps["isConsentDialog"]));
      case "labelControls":
        return await provider.labelControls(...(args as AiOps["labelControls"]));
      case "corroborate":
        return await provider.corroborate(...(args as AiOps["corroborate"]));
      default:
        return { kind: "error", error: "unknown_op", meta };
    }
  } catch (e) {
    return { kind: "error", error: e instanceof Error ? e.message : String(e), meta };
  }
}

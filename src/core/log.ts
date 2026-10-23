import { LOG_RETENTION_MS } from "./config.ts";
import type { KV } from "./platform.ts";
import type { Labelled, Outcome } from "./types.ts";

export interface LogEntry {
  id: string;
  at: number;
  site: string;
  url: string;
  path: "autoconsent" | "heuristic" | "ai" | "learned" | "deferred";
  rule?: string;
  gate?: "consent" | "other" | "skipped";
  labels?: Record<number, Labelled>;
  clicked: { id: number; text: string; aiOnly: boolean }[];
  toggles: { text: string; to: boolean }[];
  t: { found?: number; decided?: number; gone?: number };
  modelCalls: {
    op: string;
    ms: number;
    cold: boolean;
    result: "answer" | "timeout" | "error";
  }[];
  verification?: string;
  /** `working` while an autoconsent opt-out is in flight; it is patched to the outcome. */
  outcome: Outcome | "working";
  reason?: string;
  notes: string[];
}

const KEY = "decisionLog";

/**
 * Local 24-hour decision log. Entries older than LOG_RETENTION_MS are pruned on every read and
 * write. Read-modify-write cycles are serialised, so concurrent calls never lose entries.
 */
export class DecisionLog {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Loads, prunes, and persists the pruned list if anything was dropped. */
  private async load(): Promise<LogEntry[]> {
    const all = (await this.kv.get<LogEntry[]>(KEY)) ?? [];
    const cutoff = this.now() - LOG_RETENTION_MS;
    const kept = all.filter((e) => e.at >= cutoff);
    if (kept.length !== all.length) await this.kv.set(KEY, kept);
    return kept;
  }

  add(e: Omit<LogEntry, "id">): Promise<string> {
    return this.serial(async () => {
      const entries = await this.load();
      const id = crypto.randomUUID();
      entries.push({ ...e, id });
      await this.kv.set(KEY, entries);
      return id;
    });
  }

  /** Shallow merge, except `t`, which is merged one level down. Unknown ids are ignored. */
  patch(id: string, p: Partial<LogEntry>): Promise<void> {
    return this.serial(async () => {
      const entries = await this.load();
      const i = entries.findIndex((e) => e.id === id);
      const cur = entries[i];
      if (!cur) return;
      entries[i] = { ...cur, ...p, id, t: { ...cur.t, ...p.t } };
      await this.kv.set(KEY, entries);
    });
  }

  list(): Promise<LogEntry[]> {
    return this.serial(() => this.load());
  }

  async exportJson(): Promise<string> {
    return JSON.stringify(await this.list(), null, 2);
  }
}

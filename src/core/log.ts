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

  /**
   * The stored entries and those within retention, without writing anything. A stored value that
   * isn't a list reads as empty, so it can't stop every later read and write; the next write
   * replaces it.
   */
  private async read(): Promise<{ all: LogEntry[]; kept: LogEntry[] }> {
    const stored = await this.kv.get<unknown>(KEY);
    const all = Array.isArray(stored) ? (stored as LogEntry[]) : [];
    const cutoff = this.now() - LOG_RETENTION_MS;
    return { all, kept: all.filter((e) => e.at >= cutoff) };
  }

  /** Loads, prunes, and persists the pruned list if anything was dropped. */
  private async load(): Promise<LogEntry[]> {
    const { all, kept } = await this.read();
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

  /**
   * Shallow merge, except `t`, which is merged one level down. Resolves with the entry as patched;
   * an unknown id is ignored and resolves with nothing.
   */
  patch(id: string, p: Partial<LogEntry>): Promise<LogEntry | undefined> {
    return this.serial(async () => {
      const entries = await this.load();
      const i = entries.findIndex((e) => e.id === id);
      const cur = entries[i];
      if (!cur) return undefined;
      const next = { ...cur, ...p, id, t: { ...cur.t, ...p.t } };
      entries[i] = next;
      await this.kv.set(KEY, entries);
      return next;
    });
  }

  list(): Promise<LogEntry[]> {
    return this.serial(() => this.load());
  }

  /**
   * As `list`, but writes nothing: for a reader that is not the background (the settings page).
   * Its own write queue doesn't cover the background's, so a pruning write-back from there could
   * overwrite an entry the background has just added. Expired entries are left for the
   * background's next write to prune.
   */
  async peek(): Promise<LogEntry[]> {
    return (await this.read()).kept;
  }

  /** The log as JSON, read as `peek` reads it. */
  async exportJson(): Promise<string> {
    return JSON.stringify(await this.peek(), null, 2);
  }
}

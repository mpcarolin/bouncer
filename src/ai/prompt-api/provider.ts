import type { AiMeta, AiProvider, AiResult, AiStatus } from "../../core/ai.ts";
import {
  AVAILABILITY_TIMEOUT_MS,
  CREATE_TIMEOUT_MS,
  PROMPT_TIMEOUT_MS,
} from "../../core/config.ts";
import type { Control, Label, SerialisedBanner } from "../../core/types.ts";
import type {
  LanguageModelLanguages,
  LanguageModelSession,
  LanguageModelStatic,
} from "./language-model.d.ts";
import {
  AI_LABELS,
  CORROBORATE_SYSTEM,
  type CorroLabel,
  GATE_SCHEMA,
  GATE_SYSTEM,
  LABELS_SYSTEM,
  corroborateInput,
  gateInput,
  labelInput,
  labelsSchema,
} from "./prompts.ts";
import { TIMEOUT, timebox } from "./timebox.ts";

const LANG: LanguageModelLanguages = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

type Kind = "gate" | "labels" | "corroborate";

const SYSTEM: Record<Kind, string> = {
  gate: GATE_SYSTEM,
  labels: LABELS_SYSTEM,
  corroborate: CORROBORATE_SYSTEM,
};
const KINDS = Object.keys(SYSTEM) as Kind[];

interface Base {
  promise: Promise<LanguageModelSession>;
  session?: LanguageModelSession;
}

interface Clock {
  now(): number;
}

const errName = (e: unknown): string =>
  e instanceof Error ? e.name || e.message : String((e as { name?: unknown })?.name ?? e);

const destroyQuietly = (s: LanguageModelSession) => {
  try {
    s.destroy();
  } catch {
    // nothing left to release
  }
};

/** Chrome's on-device Prompt API (Gemini Nano). Never throws; every call is time-boxed. */
export class PromptApiProvider implements AiProvider {
  private readonly bases = new Map<Kind, Base>();
  private available = false;

  constructor(
    private readonly lm: LanguageModelStatic | undefined = globalThis.LanguageModel,
    private readonly clock: Clock = performance,
  ) {}

  async status(): Promise<AiStatus> {
    const unavailable = (reason: string): AiStatus => ({
      state: "unavailable",
      reason,
      onDevice: true,
    });
    if (!this.lm) return unavailable("no_language_model");
    try {
      const a = await timebox(this.lm.availability(LANG), AVAILABILITY_TIMEOUT_MS);
      if (a === TIMEOUT) return unavailable("availability_timeout");
      if (a === "unavailable") return unavailable("model_unavailable");
      return { state: a, onDevice: true };
    } catch (e) {
      return unavailable(`availability_error:${errName(e)}`);
    }
  }

  /**
   * Downloads the model, reporting `loaded` (0 to 1) as it arrives. It must run from a user click
   * on an extension page: `create()` starts a download only then, and a service worker can't.
   * Not time-boxed, since a download takes minutes. Never throws: when it fails, the current
   * status is returned with the error as its reason.
   */
  async download(onProgress: (loaded: number) => void): Promise<AiStatus> {
    if (!this.lm) return this.status();
    try {
      const session = await this.lm.create({
        ...LANG,
        monitor: (m) => {
          m.addEventListener("downloadprogress", (e) => {
            onProgress((e as Event & { loaded: number }).loaded);
          });
        },
      });
      destroyQuietly(session);
    } catch (e) {
      const status = await this.status();
      return status.state === "available"
        ? status
        : { ...status, reason: `download_error:${errName(e)}` };
    }
    return this.status();
  }

  /**
   * Loads the model and primes a base session for every kind of question, so the next decisions
   * are warm (Settings' `keepModelWarm`). Bases already there, or being created, are kept. Never
   * throws. It stops waiting at the create limit, but a base that lands later is kept; one that
   * fails is left for the next decision to create, as a cold one.
   */
  async warmUp(): Promise<void> {
    if (!(await this.isAvailable())) return;
    const lm = this.lm as LanguageModelStatic;
    const bases = KINDS.map((kind) => (this.bases.get(kind) ?? this.create(lm, kind)).promise);
    await Promise.allSettled(bases.map((b) => timebox(b, CREATE_TIMEOUT_MS)));
  }

  async isConsentDialog(b: SerialisedBanner): Promise<AiResult<boolean>> {
    return this.ask("gate", gateInput(b), [GATE_SCHEMA], yesNo);
  }

  async labelControls(
    b: SerialisedBanner,
    controlIds: number[],
  ): Promise<AiResult<Record<number, Label>>> {
    const controls = controlIds
      .map((id) => b.controls.find((c) => c.id === id))
      .filter((c): c is Control => c !== undefined);
    if (controls.length === 0) {
      return { kind: "answer", value: {}, meta: { ms: 0, cold: false, onDevice: true } };
    }
    const n = controls.length;
    return this.ask(
      "labels",
      labelInput(b, controls),
      [labelsSchema(n, true), labelsSchema(n, false)],
      (raw) => {
        const v = parseJson(raw) as { labels?: unknown } | undefined;
        const labels = v?.labels;
        if (!Array.isArray(labels) || labels.length !== n) return undefined;
        const out: Record<number, Label> = {};
        for (const [k, c] of controls.entries()) {
          const l = labels[k];
          if (!(AI_LABELS as readonly unknown[]).includes(l)) return undefined;
          out[c.id] = l as Label;
        }
        return out;
      },
    );
  }

  async corroborate(
    b: SerialisedBanner,
    control: Control,
    label: CorroLabel,
  ): Promise<AiResult<boolean>> {
    return this.ask("corroborate", corroborateInput(b, control, label), [GATE_SCHEMA], yesNo);
  }

  /**
   * One call: check status, get (or create) the primed base, clone it, prompt the clone, destroy it.
   * `schemas` are tried in order; the next is used only after a NotSupportedError.
   */
  private async ask<T>(
    kind: Kind,
    input: string,
    schemas: unknown[],
    parse: (raw: string) => T | undefined,
  ): Promise<AiResult<T>> {
    const t0 = this.clock.now();
    let cold = false;
    const meta = (): AiMeta => ({ ms: this.clock.now() - t0, cold, onDevice: true });
    const error = (e: string): AiResult<T> => ({ kind: "error", error: e, meta: meta() });
    const timeout = (): AiResult<T> => ({ kind: "timeout", meta: meta() });

    let clone: LanguageModelSession | undefined;
    try {
      if (!(await this.isAvailable())) return error("unavailable");
      const lm = this.lm as LanguageModelStatic;

      const entry = this.bases.get(kind) ?? this.create(lm, kind);
      // Cold for every call that waits on the base's creation, not only the one that began it.
      cold = !entry.session;
      let base = entry.session;
      if (!base) {
        const r = await timebox(entry.promise, CREATE_TIMEOUT_MS);
        if (r === TIMEOUT) {
          // Never keep a half-created base; if it lands later it destroys itself.
          if (this.bases.get(kind) === entry) this.bases.delete(kind);
          return timeout();
        }
        base = r;
      }

      const pending = base.clone();
      const c = await timebox(pending, PROMPT_TIMEOUT_MS).catch((e: unknown) => {
        // A base that can't be cloned is no use to any later call either: a worker kept running
        // (`keepModelWarm`) would otherwise keep it, and fail every decision, until Chrome stops.
        this.drop(kind, entry);
        throw e;
      });
      if (c === TIMEOUT) {
        pending.then(destroyQuietly, () => {});
        return timeout();
      }
      clone = c;

      for (const [i, schema] of schemas.entries()) {
        try {
          const raw = await timebox(
            clone.prompt(input, { responseConstraint: schema }),
            PROMPT_TIMEOUT_MS,
          );
          if (raw === TIMEOUT) return timeout();
          const value = parse(raw);
          if (value === undefined) return error("bad_answer");
          return { kind: "answer", value, meta: meta() };
        } catch (e) {
          if (errName(e) === "NotSupportedError" && i < schemas.length - 1) continue;
          throw e;
        }
      }
      return error("no_schema");
    } catch (e) {
      return error(errName(e));
    } finally {
      if (clone) destroyQuietly(clone);
    }
  }

  /** Once `available`, it stays so: a model that later goes is an error on the call that finds it. */
  private async isAvailable(): Promise<boolean> {
    if (!this.available) this.available = (await this.status()).state === "available";
    return this.available;
  }

  /** Forgets and destroys the base, unless another has taken its place. */
  private drop(kind: Kind, entry: Base): void {
    if (this.bases.get(kind) !== entry) return;
    this.bases.delete(kind);
    if (entry.session) destroyQuietly(entry.session);
  }

  private create(lm: LanguageModelStatic, kind: Kind): Base {
    const entry: Base = {} as Base;
    entry.promise = lm
      .create({ ...LANG, initialPrompts: [{ role: "system", content: SYSTEM[kind] }] })
      .then((s) => {
        if (this.bases.get(kind) === entry) entry.session = s;
        else destroyQuietly(s); // the caller gave up on it
        return s;
      })
      .catch((e) => {
        if (this.bases.get(kind) === entry) this.bases.delete(kind);
        throw e;
      });
    this.bases.set(kind, entry);
    return entry;
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The constrained answer is `"yes"` or `"no"`; anything else is not an answer. */
function yesNo(raw: string): boolean | undefined {
  const v = parseJson(raw) ?? raw.trim();
  return v === "yes" ? true : v === "no" ? false : undefined;
}

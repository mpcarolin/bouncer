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
      if (!this.available) {
        const st = await this.status();
        if (st.state !== "available") return error("unavailable");
        this.available = true;
      }
      const lm = this.lm as LanguageModelStatic;

      let entry = this.bases.get(kind);
      if (!entry) {
        cold = true;
        entry = this.create(lm, kind);
      }
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
      const c = await timebox(pending, PROMPT_TIMEOUT_MS);
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

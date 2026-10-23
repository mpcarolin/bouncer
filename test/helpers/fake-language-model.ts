import type {
  LanguageModelAvailability,
  LanguageModelCreateOptions,
  LanguageModelSession,
  LanguageModelStatic,
} from "../../src/ai/prompt-api/language-model.d.ts";

export interface FakeOptions {
  /** `"never"` makes availability() hang forever. */
  availability?: LanguageModelAvailability | "never";
  createMs?: number;
  /**
   * `downloadprogress` fractions that `create()` fires at the `monitor` it is given, as Chrome does
   * while it downloads the model. Once such a create resolves, `availability()` says `available`.
   */
  downloadProgress?: number[];
  /** Raw answers in call order; the last repeats. Or a function of the prompt. */
  answers?: string[] | ((input: string, constraint: unknown) => string);
  throwOn?: { create?: Error; clone?: Error; prompt?: Error };
  /** prompt() throws NotSupportedError when the constraint has minItems/maxItems. */
  rejectMinMax?: boolean;
}

export interface FakeCall {
  input: string;
  constraint: unknown;
}

export function fakeLanguageModel(o: FakeOptions = {}) {
  const state = {
    createCalls: [] as LanguageModelCreateOptions[],
    prompts: [] as FakeCall[],
    cloned: 0,
    destroyed: 0,
    sessions: 0,
  };
  let n = 0;

  const session = (): LanguageModelSession => {
    state.sessions++;
    return {
      async clone() {
        if (o.throwOn?.clone) throw o.throwOn.clone;
        state.cloned++;
        return session();
      },
      async prompt(input, options) {
        const constraint = options?.responseConstraint;
        state.prompts.push({ input, constraint });
        if (o.throwOn?.prompt) throw o.throwOn.prompt;
        const mm = constraint as { properties?: { labels?: { minItems?: number } } } | undefined;
        if (o.rejectMinMax && mm?.properties?.labels?.minItems !== undefined) {
          throw namedError("NotSupportedError");
        }
        const a = o.answers ?? ['"yes"'];
        return typeof a === "function"
          ? a(input, constraint)
          : (a[Math.min(n++, a.length - 1)] as string);
      },
      destroy() {
        state.destroyed++;
      },
    };
  };

  let availability = o.availability ?? "available";
  const lm: LanguageModelStatic = {
    availability: () =>
      availability === "never" ? new Promise<never>(() => {}) : Promise.resolve(availability),
    async create(options) {
      state.createCalls.push(options ?? {});
      if (o.throwOn?.create) throw o.throwOn.create;
      let downloaded = false;
      if (options?.monitor && o.downloadProgress) {
        const monitor = new EventTarget();
        options.monitor(monitor);
        for (const loaded of o.downloadProgress) {
          monitor.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded }));
        }
        downloaded = true;
      }
      if (o.createMs) await new Promise((r) => setTimeout(r, o.createMs));
      if (downloaded) availability = "available";
      return session();
    },
  };
  return { lm, state };
}

export function namedError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

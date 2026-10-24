/**
 * The fixture benchmark: scores an `AiProvider` on the banner fixtures, so any provider is judged
 * on the same ground truth. It calls the provider it is given directly, not through the
 * background, so the per-page model budget never cuts a run short.
 *
 * Every repetition is a trial. A timeout or an error is an incorrect answer, never a false
 * positive, and its wait counts as latency: it is a wait a user would have sat through.
 */
import type { AiProvider, AiResult } from "./ai.ts";
import { NEEDS_CORROBORATION } from "./choose.ts";
import type { BannerFixture } from "./fixture.ts";
import { labelDeterministic, mergeAiLabels } from "./label.ts";
import type { BlockReason, Label, Labelled } from "./types.ts";

/** How one provider call ended and how long it took. */
export interface CallStats {
  ms: number;
  cold: boolean;
  outcome: AiResult<unknown>["kind"];
  /** The provider's message, when `outcome` is `error`. */
  error?: string;
}

export interface GateTrial extends CallStats {
  /** What the gate said. Nothing when it did not answer. */
  said?: BannerFixture["gate"];
  correct: boolean;
}

export interface LabelTrial extends CallStats {
  /** Only the controls the rules left to the AI. `got` is missing when the model gave none. */
  controls: { id: number; expected?: Label; got?: Label; correct: boolean }[];
}

export interface CorroborationTrial extends CallStats {
  rep: number;
  id: number;
  label: "reject" | "save" | "settings";
  /** Missing when the call timed out or failed. */
  answer?: boolean;
}

/** A control the AI labelled reject, save or settings and a §0 guard blocked, so nobody was asked. */
export interface BlockedControl {
  rep: number;
  id: number;
  label: Label;
  reason: BlockReason;
}

export interface FixtureReport {
  id: string;
  kind: BannerFixture["kind"];
  /** What the gate should say. */
  expectedGate: BannerFixture["gate"];
  /** One entry per repetition in each list below, except where noted. */
  gate: GateTrial[];
  /** Positives with a control left to the AI only. */
  labeller: LabelTrial[];
  /** `adv-*` fixtures only: one per AI-labelled control that no guard blocked, per repetition. */
  corroboration: CorroborationTrial[];
  /** `adv-*` fixtures only. */
  blocked: BlockedControl[];
}

export interface BenchReport {
  reps: number;
  gate: {
    correct: number;
    total: number;
    /** Said consent on a banner that is not one. */
    falsePositives: number;
    medianMs: number;
    p90Ms: number;
  };
  /** Over the controls `labelDeterministic` leaves null, on positive fixtures (§2e step 5). */
  labeller: { correct: number; total: number };
  corroboration: {
    /** `"<fixtureId>:<controlId> <label>"`: adversarial controls corroboration would let be clicked. */
    adversarialConfirmed: string[];
  };
  /** Calls of every kind whose provider said the model was cold / warm. */
  cold: number;
  warm: number;
  /** Median ms over every call of that temperature. Null when there was none. */
  latency: { coldMedianMs: number | null; warmMedianMs: number | null };
  perFixture: FixtureReport[];
}

const callStats = (r: AiResult<unknown>): CallStats => ({
  ms: r.meta.ms,
  cold: r.meta.cold,
  outcome: r.kind,
  ...(r.kind === "error" ? { error: r.error } : {}),
});

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

/** The middle value; the mean of the middle two for an even count. 0 for none. */
function median(xs: number[]): number {
  const s = sorted(xs);
  if (s.length === 0) return 0;
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Nearest rank. 0 for none. */
function p90(xs: number[]): number {
  const s = sorted(xs);
  return s[Math.max(0, Math.ceil(s.length * 0.9) - 1)] ?? 0;
}

async function gateTrial(p: AiProvider, f: BannerFixture): Promise<GateTrial> {
  const r = await p.isConsentDialog(f.banner);
  const said = r.kind === "answer" ? (r.value ? "consent" : "other") : undefined;
  return { ...callStats(r), said, correct: said === f.gate };
}

async function labelTrial(
  p: AiProvider,
  f: BannerFixture,
  ids: number[],
): Promise<{ trial: LabelTrial; given: Record<number, Label> }> {
  const r = await p.labelControls(f.banner, ids);
  const given = r.kind === "answer" ? r.value : {};
  const controls = ids.map((id) => {
    const expected = f.expectedLabels?.[id];
    const got = given[id];
    return { id, expected, got, correct: got !== undefined && got === expected };
  });
  return { trial: { ...callStats(r), controls }, given };
}

/**
 * What the pipeline would do with the AI's labels on `f`: for each control the AI labelled
 * reject, save or settings, ask for corroboration unless a §0 guard blocks it.
 */
async function corroborationTrials(
  p: AiProvider,
  f: BannerFixture,
  det: Map<number, Labelled | null>,
  given: Record<number, Label>,
  rep: number,
): Promise<{ trials: CorroborationTrial[]; blocked: BlockedControl[] }> {
  const merged = mergeAiLabels(f.banner, det, given);
  const trials: CorroborationTrial[] = [];
  const blocked: BlockedControl[] = [];
  for (const control of f.banner.controls) {
    const m = merged.get(control.id);
    const said = given[control.id];
    if (m?.source !== "ai") continue;
    if (m.blocked) {
      if (said && NEEDS_CORROBORATION.has(said)) {
        blocked.push({ rep, id: control.id, label: said, reason: m.blocked });
      }
      continue;
    }
    if (!NEEDS_CORROBORATION.has(m.label)) continue;
    const label = m.label as CorroborationTrial["label"];
    const r = await p.corroborate(f.banner, control, label);
    trials.push({
      ...callStats(r),
      rep,
      id: control.id,
      label,
      answer: r.kind === "answer" ? r.value : undefined,
    });
  }
  return { trials, blocked };
}

/**
 * Runs `p` over `fixtures`, `reps` times through the whole set (so back-to-back repeats of one
 * banner don't flatter the latency). The gate sees every fixture. The labeller sees the controls
 * the rules leave null on positives. Corroboration runs on the `adv-*` fixtures.
 * `onProgress(done, total)` counts fixture trials.
 */
export async function runBenchmark(
  p: AiProvider,
  fixtures: BannerFixture[],
  reps = 3,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<BenchReport> {
  const plans = fixtures.map((f) => {
    const det = labelDeterministic(f.banner);
    // The AI labels only buttons and links the rules left open, and never one that is absent.
    const ids =
      f.kind === "positive"
        ? f.banner.controls.filter((c) => det.get(c.id) === null && !c.absent).map((c) => c.id)
        : [];
    const report: FixtureReport = {
      id: f.id,
      kind: f.kind,
      expectedGate: f.gate,
      gate: [],
      labeller: [],
      corroboration: [],
      blocked: [],
    };
    return { f, det, ids, report };
  });
  const total = fixtures.length * reps;
  let done = 0;
  for (let rep = 0; rep < reps; rep++) {
    for (const { f, det, ids, report } of plans) {
      report.gate.push(await gateTrial(p, f));
      if (ids.length > 0) {
        const { trial, given } = await labelTrial(p, f, ids);
        report.labeller.push(trial);
        if (f.id.startsWith("adv-")) {
          const c = await corroborationTrials(p, f, det, given, rep);
          report.corroboration.push(...c.trials);
          report.blocked.push(...c.blocked);
        }
      }
      onProgress(++done, total);
    }
  }
  return summarise(
    reps,
    plans.map((plan) => plan.report),
  );
}

function summarise(reps: number, perFixture: FixtureReport[]): BenchReport {
  const gate = perFixture.flatMap((f) => f.gate.map((t) => ({ t, expected: f.expectedGate })));
  const controls = perFixture.flatMap((f) => f.labeller.flatMap((t) => t.controls));
  const calls = perFixture.flatMap((f) => [...f.gate, ...f.labeller, ...f.corroboration]);
  const ms = (xs: CallStats[]) => (xs.length > 0 ? median(xs.map((c) => c.ms)) : null);
  const cold = calls.filter((c) => c.cold);
  const warm = calls.filter((c) => !c.cold);
  const confirmed = perFixture.flatMap((f) =>
    f.corroboration.filter((t) => t.answer === true).map((t) => `${f.id}:${t.id} ${t.label}`),
  );
  return {
    reps,
    gate: {
      correct: gate.filter(({ t }) => t.correct).length,
      total: gate.length,
      falsePositives: gate.filter(({ t, expected }) => t.said === "consent" && expected === "other")
        .length,
      medianMs: median(gate.map(({ t }) => t.ms)),
      p90Ms: p90(gate.map(({ t }) => t.ms)),
    },
    labeller: { correct: controls.filter((c) => c.correct).length, total: controls.length },
    corroboration: { adversarialConfirmed: [...new Set(confirmed)] },
    cold: cold.length,
    warm: warm.length,
    latency: { coldMedianMs: ms(cold), warmMedianMs: ms(warm) },
    perFixture,
  };
}

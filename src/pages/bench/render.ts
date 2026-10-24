import type { AiProvider } from "../../core/ai.ts";
import { type BenchReport, type FixtureReport, runBenchmark } from "../../core/bench.ts";
import type { BannerFixture } from "../../core/fixture.ts";
import { h, NONE, saveFile } from "../dom.ts";

export interface BenchOptions {
  provider: AiProvider;
  fixtures: BannerFixture[];
  /** Passes through the whole set. `runBenchmark`'s default when absent. */
  reps?: number;
}

const ms = (n: number | null) => (n === null ? NONE : `${Math.round(n)} ms`);
const share = (correct: number, total: number) =>
  total === 0 ? NONE : `${correct} of ${total} (${Math.round((100 * correct) / total)}%)`;

const row = (name: string, ...cells: (Node | string)[]) =>
  h("tr", {}, h("th", { scope: "row" }, name), h("td", {}, ...cells));

function summary(r: BenchReport): HTMLElement {
  const wouldClick = r.corroboration.adversarialConfirmed;
  return h(
    "table",
    { class: "log" },
    h(
      "tbody",
      {},
      row("Repetitions", String(r.reps)),
      row("Gate accuracy", share(r.gate.correct, r.gate.total)),
      row("Gate false positives", String(r.gate.falsePositives)),
      row("Gate latency", `median ${ms(r.gate.medianMs)}, 90th percentile ${ms(r.gate.p90Ms)}`),
      row("Labeller accuracy", share(r.labeller.correct, r.labeller.total)),
      row(
        "Adversarial controls corroboration would click",
        wouldClick.length === 0
          ? "none"
          : h("ul", { class: "warn" }, ...wouldClick.map((c) => h("li", {}, c))),
      ),
      row("Cold calls", `${r.cold}, median ${ms(r.latency.coldMedianMs)}`),
      row("Warm calls", `${r.warm}, median ${ms(r.latency.warmMedianMs)}`),
    ),
  );
}

/** One fixture's line: what the gate said each time, the labeller's score, and corroboration. */
function fixtureRow(f: FixtureReport): HTMLElement {
  const gateWrong = f.gate.some((t) => !t.correct);
  const labels = f.labeller.flatMap((t) => t.controls);
  const asked = f.corroboration.length;
  const clicked = f.corroboration.filter((t) => t.answer === true).length;
  const cell = (text: string, wrong = false) => h("td", wrong ? { class: "warn" } : {}, text);
  return h(
    "tr",
    {},
    h("td", {}, f.id),
    cell(f.expectedGate),
    cell(f.gate.map((t) => t.said ?? t.outcome).join(", "), gateWrong),
    cell(
      labels.length === 0 ? NONE : `${labels.filter((c) => c.correct).length}/${labels.length}`,
      labels.some((c) => !c.correct),
    ),
    cell(
      asked + f.blocked.length === 0
        ? NONE
        : `asked ${asked}, would click ${clicked}, blocked ${f.blocked.length}`,
      clicked > 0,
    ),
  );
}

function perFixture(r: BenchReport): HTMLElement {
  const columns = ["Fixture", "Gate should say", "Gate said", "Labeller", "Corroboration"];
  return h(
    "div",
    { class: "scroll" },
    h(
      "table",
      { class: "log" },
      h("thead", {}, h("tr", {}, ...columns.map((c) => h("th", {}, c)))),
      h("tbody", {}, ...r.perFixture.map(fixtureRow)),
    ),
  );
}

function showReport(box: HTMLElement, report: BenchReport): void {
  const download = h("button", { type: "button" }, "Download JSON");
  download.addEventListener("click", () =>
    saveFile("bouncer-bench.json", JSON.stringify(report, null, 2)),
  );
  box.replaceChildren(
    h("h2", {}, "Summary"),
    summary(report),
    h("p", {}, download),
    h("h2", {}, "By fixture"),
    perFixture(report),
  );
}

/**
 * The benchmark page: runs on a click (the model may want a user activation), shows how far it
 * has got, then the report and a JSON download of it. It calls the provider directly, so the
 * background's per-page model budget doesn't cut it short.
 */
export async function renderBench(root: HTMLElement, opts: BenchOptions): Promise<void> {
  const { provider, fixtures } = opts;
  const status = await provider.status();
  const run = h("button", { type: "button" }, "Run the benchmark");
  const bar = h("progress", { max: "1", hidden: "" });
  const count = h("span", { class: "dim" });
  const report = h("div");
  report.setAttribute("aria-live", "polite");

  run.addEventListener("click", async () => {
    run.disabled = true;
    report.replaceChildren();
    bar.hidden = false;
    try {
      const result = await runBenchmark(provider, fixtures, opts.reps, (done, total) => {
        bar.value = done / total;
        count.textContent = `${done} of ${total}`;
      });
      showReport(report, result);
    } catch (e) {
      report.replaceChildren(
        h("p", { class: "warn" }, `The benchmark stopped: ${e instanceof Error ? e.message : e}`),
      );
    } finally {
      bar.hidden = true;
      count.textContent = "";
      run.disabled = false;
      run.textContent = "Run again";
    }
  });

  root.replaceChildren(
    h("h1", {}, "Bouncer benchmark"),
    h(
      "p",
      {},
      `Scores the model on ${fixtures.length} banner fixtures: the gate, the labeller on the controls the rules leave to it, which adversarial controls corroboration would let be clicked, and latency, cold and warm. Nothing leaves this device.`,
    ),
    h(
      "p",
      { class: status.state === "available" ? "dim" : "warn" },
      `Model: ${status.state}. Runs on this device: ${status.onDevice ? "yes" : "no"}.`,
      status.reason ? ` Reported: ${status.reason}.` : "",
    ),
    h("p", {}, run, " ", bar, " ", count),
    report,
  );
}

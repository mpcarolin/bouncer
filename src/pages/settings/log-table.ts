import type { DecisionLog, LogEntry } from "../../core/log.ts";
import type { Outcome } from "../../core/types.ts";
import { h, NONE } from "../dom.ts";

/** The spec's names for the outcomes. `no_option` and `unsure` stay distinct here as in the code. */
const OUTCOMES: Record<Outcome | "working", string> = {
  dismissed: "dismissed",
  dismissed_unverified: "dismissed (unverified)",
  dismissed_close: "dismissed (close)",
  dismissed_agreed: "dismissed (agreed)",
  dismissed_late: "dismissed (late)",
  deferred: "deferred",
  not_consent: "not consent",
  no_option: "no option",
  unsure: "unsure",
  failed: "failed",
  model_unavailable: "model unavailable",
  working: "working",
};

const PATHS: Record<LogEntry["path"], string> = {
  autoconsent: "autoconsent",
  heuristic: "heuristic",
  ai: "AI",
  learned: "learned rule",
  deferred: "deferred",
};

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });

/** A cell of several short values, one per line. */
function lines(values: string[]): (Node | string)[] {
  return values.length === 0 ? [NONE] : values.map((v) => h("div", {}, v));
}

function labels(e: LogEntry): string[] {
  return Object.entries(e.labels ?? {}).map(([id, l]) => {
    const notes = [
      l.source,
      l.blocked && `blocked: ${l.blocked}`,
      l.corroborated && "corroborated",
    ];
    return `#${id} ${l.label} (${notes.filter(Boolean).join(", ")})`;
  });
}

/** The first moment is a time of day; the others are how long after it. */
function timings(t: LogEntry["t"]): string[] {
  const steps = (["found", "decided", "gone"] as const).flatMap((k) => {
    const at = t[k];
    return at === undefined ? [] : [[k, at] as const];
  });
  const first = steps[0]?.[1] ?? 0;
  return steps.map(([k, at], i) => (i === 0 ? `${k} ${clock(at)}` : `${k} +${at - first} ms`));
}

function row(e: LogEntry): HTMLTableRowElement {
  const outcome = h("td", {}, h("strong", {}, OUTCOMES[e.outcome]));
  if (e.reason) outcome.append(h("div", { class: "dim" }, e.reason));
  return h(
    "tr",
    {},
    h("td", {}, e.site),
    h("td", { title: new Date(e.at).toISOString() }, new Date(e.at).toLocaleString()),
    h("td", {}, e.path === "autoconsent" && e.rule ? `autoconsent: ${e.rule}` : PATHS[e.path]),
    h("td", {}, e.gate ?? NONE),
    h("td", {}, ...lines(labels(e))),
    h(
      "td",
      {},
      ...lines(e.clicked.map((c) => `${c.text} (#${c.id}${c.aiOnly ? ", AI-only" : ""})`)),
    ),
    h("td", {}, ...lines(e.toggles.map((t) => `${t.text}: ${t.to ? "on" : "off"}`))),
    h("td", {}, ...lines(timings(e.t))),
    h(
      "td",
      {},
      ...lines(
        e.modelCalls.map(
          (c) => `${c.op} ${Math.round(c.ms)} ms ${c.cold ? "cold" : "warm"} ${c.result}`,
        ),
      ),
    ),
    h("td", {}, e.verification ?? NONE),
    outcome,
  );
}

const COLUMNS = [
  "Site",
  "Time",
  "Path",
  "Gate",
  "Labels",
  "Clicked",
  "Toggles",
  "Timings",
  "Model calls",
  "Verification",
  "Outcome",
];

/** Offers `text` to the browser as a file download. */
function saveFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = h("a", { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Fills `box` with the decision log, newest first, and a button that exports it as JSON. The log
 * is read with `peek`: this page must not write to it (the background's writes aren't queued with
 * ours), so entries past retention stay stored until the background next prunes.
 */
export async function mountLog(box: HTMLElement, log: DecisionLog): Promise<void> {
  const entries = (await log.peek()).sort((a, b) => b.at - a.at);
  const exportButton = h("button", { type: "button" }, "Export JSON");
  exportButton.addEventListener("click", async () => {
    saveFile("bouncer-decision-log.json", await log.exportJson());
  });
  const table = h(
    "table",
    { class: "log" },
    h("thead", {}, h("tr", {}, ...COLUMNS.map((c) => h("th", {}, c)))),
    h("tbody", {}, ...entries.map(row)),
  );
  box.replaceChildren(
    h("p", {}, exportButton),
    entries.length === 0
      ? h("p", { class: "dim" }, "No decisions in the last 24 hours.")
      : h("div", { class: "scroll" }, table),
  );
}

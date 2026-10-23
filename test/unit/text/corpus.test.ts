import { readFileSync } from "node:fs";
import { classifyButtonTextRegex } from "@duckduckgo/autoconsent/heuristics";
import { expect, test } from "vitest";
import { isAcceptAll, isVetoed } from "../../../src/core/text/guards.ts";
import exceptionsJson from "./corpus-exceptions.json" with { type: "json" };

/** Accept-labelled texts the guards knowingly leave clickable as a refusal, each with a reason. */
const exceptions: { text: string; reason: string }[] = exceptionsJson;

interface Row {
  text: string;
  occurrences: number;
  label: string;
}

/** Parses autoconsent's labelled corpus: `button_text,occurences,label`, RFC 4180 quoting. */
function parseCsv(src: string): Row[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [header, ...body] = records;
  expect(header).toEqual(["button_text", "occurences", "label"]);
  return body.map((r) => {
    expect(r).toHaveLength(3);
    return { text: r[0] ?? "", occurrences: Number(r[1]), label: r[2] ?? "" };
  });
}

const CORPUS = new URL(
  "../../../node_modules/@duckduckgo/autoconsent/data/labelled-button-texts.csv",
  import.meta.url,
);
const rows = parseCsv(readFileSync(CORPUS, "utf8"));

/** True when Bouncer could click this text as a refusal or settings control. */
function clickableAsRefusal(text: string): boolean {
  const regex = classifyButtonTextRegex(text);
  return (
    (regex === "reject" || regex === "settings") && !isVetoed([text]) && !isAcceptAll([text], regex)
  );
}

test("corpus parses", () => {
  expect(rows.length).toBeGreaterThan(6000);
});

test("no text labelled accept is clickable as a refusal (bar reviewed exceptions)", () => {
  const known = new Set(exceptions.map((e) => e.text));
  const failing = rows.filter((r) => r.label === "accept" && clickableAsRefusal(r.text));
  expect(failing.map((r) => r.text).filter((t) => !known.has(t))).toEqual([]);
  // Every exception must still be needed, so the file never goes stale.
  expect([...known].filter((t) => !failing.some((r) => r.text === t))).toEqual([]);
});

test("every exception carries a reason", () => {
  for (const e of exceptions) expect(e.reason.length).toBeGreaterThan(0);
});

test("coverage cost on reject rows (reported, not asserted)", () => {
  const rejects = rows.filter((r) => r.label === "reject");
  const blocked = rejects.filter((r) => {
    const regex = classifyButtonTextRegex(r.text);
    return isVetoed([r.text]) || isAcceptAll([r.text], regex);
  });
  const occ = (rs: Row[]) => rs.reduce((n, r) => n + r.occurrences, 0);
  console.info(
    `coverage cost: ${blocked.length}/${rejects.length} reject rows ` +
      `(${occ(blocked)}/${occ(rejects)} occurrences) blocked by isVetoed or isAcceptAll`,
  );
});

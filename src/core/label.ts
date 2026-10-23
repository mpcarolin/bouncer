/**
 * §2e steps 1–4: the deterministic labeller, and the merge of the AI's step-5 labels under the
 * trust rules. The §0 block rules run on every button and link, whatever label came from where.
 */
import {
  type ButtonRegexClassification,
  classifyButtonTextRegex,
} from "@duckduckgo/autoconsent/heuristics";
import { fold, normalise, stemRe, wordRe } from "./text/normalise.ts";
import {
  isAcceptAll,
  isDoNotSell,
  isVetoed,
  textSources,
  hasEverythingWord,
} from "./text/guards.ts";
import { NECESSARY_ONLY, NEGATING_PREFIXES, SAVE_VERBS, type Term } from "./text/terms.ts";
import type { Control, Label, Labelled, SerialisedBanner } from "./types.ts";

const words = (ts: Term[]) => ts.flatMap((t) => ("word" in t ? [t.word] : []));
const stems = (ts: Term[]) => ts.flatMap((t) => ("stem" in t ? [t.stem] : []));

/**
 * Group 1 also holds "only", "selection" and "functional" wording, which marks a button as
 * necessary-*only* but says nothing about a toggle ("Functional" is optional). Toggles take just
 * the terms that mean "necessary".
 */
const NOT_NECESSITY = new Set([
  ...["only", "selection", "selected", "minimum", "nur", "uniquement", "seulement", "solo"],
  ...["solamente", "soltanto", "apenas", "somente", "doar", "alleen", "endast", "bara", "kun"],
  ...["vain", "tylko", "только", "minimal", "functional", "funktional", "funktionell"],
  ...["functione", "fonctionn", "funzional", "funcional"],
]);
const termText = (t: Term) => ("word" in t ? t.word : t.stem);

/** The spike's necessary pattern, plus group 1's terms for "necessary". Matched on folded text. */
const NECESSARY_TERMS: Term[] = [
  ...NECESSARY_ONLY.filter((t) => !NOT_NECESSITY.has(termText(t))),
  { stem: "strict" },
  { word: "always active" },
  { word: "always on" },
  { stem: "nodvendig" },
];
const necessaryWord = wordRe(words(NECESSARY_TERMS));
const necessaryStem = stemRe(stems(NECESSARY_TERMS));
/** "non-essential", "nicht notwendig": a negation before a necessary term means optional. */
const negatedNecessary = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${NEGATING_PREFIXES.map((p) => fold(normalise(p))).join("|")})[-\\s]+(?=${necessaryWord.source}|${necessaryStem.source})\\p{L}+`,
  "gu",
);
const OPTOUT_RE = /do not sell|don.?t sell|do not share|opt.?out|limit the use/;
const CLOSE_RE =
  /^(?:(?:×|x|✕|✖|✗|skip|lukk|luk|schliessen|fermer|cerrar|chiudi|sluiten|stang|sulje|zamknij|fechar)|(?:close|dismiss)(?: (?:this|the|cookie|cookies|preference|preferences|privacy|consent|settings|banner|dialog|popup|pop-up|modal|notice|message|window|panel|center|centre))*)$/;
const saveWord = wordRe(words(SAVE_VERBS));
const saveStem = stemRe(stems(SAVE_VERBS));

const folded = (s: string) => fold(normalise(s));

function toggleLabel(c: Control): Label {
  const texts = textSources(c).map((s) => folded(s).replace(negatedNecessary, "optional"));
  const any = (re: RegExp, second?: RegExp) => texts.some((t) => re.test(t) || second?.test(t));
  if (c.disabled || any(necessaryWord, necessaryStem)) return "toggle-necessary";
  if (any(OPTOUT_RE) || isDoNotSell(textSources(c))) return "toggle-optout";
  return "toggle-optional";
}

/** The first text source (text, aria-label, title) whose regex class is not `other`. */
function regexClass(c: Control): ButtonRegexClassification {
  for (const s of textSources(c)) {
    const cls = classifyButtonTextRegex(s);
    if (cls !== "other") return cls;
  }
  return "other";
}

const isClose = (c: Control) => textSources(c).some((s) => CLOSE_RE.test(folded(s)));
const isSaveCandidate = (c: Control) =>
  textSources(c).some((s) => saveWord.test(folded(s)) || saveStem.test(folded(s)));

/** Applies the §0 block rules to a button or link that has `label`. */
function withBlocks(c: Control, label: Label, source: Labelled["source"]): Labelled {
  const sources = textSources(c);
  const cls = regexClass(c);
  if (isAcceptAll(sources, cls)) return { label, source, blocked: "accept_all" };
  if ((cls === "reject" || cls === "settings") && isVetoed(sources)) {
    return { label, source, blocked: "accept_verb_veto" };
  }
  if (cls === "reject" && isDoNotSell(sources)) {
    return { label: "other", source, blocked: "do_not_sell" };
  }
  return { label, source };
}

const isClickable = (c: Control) => c.role === "button" || c.role === "link";

/** Steps 1–4. `null` marks a button or link left for the AI. */
export function labelDeterministic(b: SerialisedBanner): Map<number, Labelled | null> {
  const hasToggle = b.controls.some((c) => c.role === "toggle");
  const out = new Map<number, Labelled | null>();
  for (const c of b.controls) {
    if (c.role === "toggle") {
      out.set(c.id, { label: toggleLabel(c), source: "rule" });
    } else if (!isClickable(c)) {
      out.set(c.id, { label: "other", source: "rule" });
    } else if (isClose(c)) {
      out.set(c.id, withBlocks(c, "close", "rule"));
    } else if (hasToggle && isSaveCandidate(c) && !isEverythingSave(c)) {
      out.set(c.id, withBlocks(c, "save", "rule"));
    } else {
      const cls = regexClass(c);
      out.set(c.id, cls === "other" ? null : withBlocks(c, cls, "regex"));
    }
  }
  return out;
}

/** A save candidate that is accept-all, or names "everything", is never save (§2e step 3). */
function isEverythingSave(c: Control): boolean {
  const sources = textSources(c);
  return sources.some(hasEverythingWord) || isAcceptAll(sources, regexClass(c));
}

const AI_LABELS = new Set<Label>([
  "accept",
  "reject",
  "settings",
  "save",
  "acknowledge",
  "link",
  "other",
]);

/** AI labels for the null entries. Toggles stay as the rules labelled them; the block rules rerun everywhere. */
export function mergeAiLabels(
  b: SerialisedBanner,
  det: Map<number, Labelled | null>,
  ai: Record<number, Label>,
): Map<number, Labelled> {
  const out = new Map<number, Labelled>();
  for (const c of b.controls) {
    const known = det.get(c.id);
    if (c.role === "toggle") {
      out.set(c.id, known ?? { label: toggleLabel(c), source: "rule" });
    } else if (!isClickable(c)) {
      out.set(c.id, known ?? { label: "other", source: "rule" });
    } else if (known) {
      out.set(c.id, withBlocks(c, known.label, known.source));
    } else {
      const given = ai[c.id];
      // AI `close` is never acted on; a toggle label or a missing one is `other`.
      const label = given && AI_LABELS.has(given) ? given : "other";
      out.set(c.id, withBlocks(c, label, "ai"));
    }
  }
  return out;
}

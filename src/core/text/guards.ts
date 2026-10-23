/**
 * The §0 text guards. Every click Bouncer makes passes through them.
 *
 * Each check reads a control's text sources one at a time; a hit on any source counts.
 */
import {
  ACCEPT_PATTERNS,
  type ButtonRegexClassification,
  cleanButtonText,
} from "@duckduckgo/autoconsent/heuristics";
import type { Control } from "../types.ts";
import { fold, normalise, stemRe, wordRe } from "./normalise.ts";
import {
  ACCEPT_VERBS,
  ALLOW_LIST,
  DO_NOT_SELL,
  EVERYTHING_WORDS,
  EXTRA_ACCEPT_ALL_PHRASES,
  NECESSARY_ONLY,
  NEGATING_PREFIXES,
  REFUSAL,
  SAVE_VERBS,
  SETTINGS_WORDS,
  type Term,
} from "./terms.ts";

type Pattern = (typeof ACCEPT_PATTERNS)[number];

/** Compiles a term list into one predicate over folded, normalised text. */
function matcher(terms: Term[]): (n: string) => boolean {
  const words = wordRe(terms.flatMap((t) => ("word" in t ? [t.word] : [])));
  const stems = stemRe(terms.flatMap((t) => ("stem" in t ? [t.stem] : [])));
  return (n) => words.test(n) || stems.test(n);
}

const hasAcceptVerb = matcher(ACCEPT_VERBS);
const hasNecessaryOnly = matcher(NECESSARY_ONLY);
const necessaryOnlyStems = stemRe(NECESSARY_ONLY.flatMap((t) => ("stem" in t ? [t.stem] : [])));
const hasNecessaryOnlyStem = (word: string) => necessaryOnlyStems.test(word);
const hasSettingsWord = matcher(SETTINGS_WORDS);
const hasRefusal = matcher(REFUSAL);
const hasEverything = matcher(EVERYTHING_WORDS);
const hasSaveVerb = matcher(SAVE_VERBS);
const hasDoNotSell = matcher(DO_NOT_SELL);

/** The whole text without punctuation, for phrase lists. */
function bare(s: string): string {
  return fold(normalise(s))
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const extraAcceptAll = new Set(EXTRA_ACCEPT_ALL_PHRASES.map(bare));
const allowList = new Set(ALLOW_LIST.map(bare));

/**
 * autoconsent's preference-centre saves ("save … settings", "auswahl speichern", "guardar
 * preferencias"). It gives them accept semantics; Bouncer treats them as save (§2e step 3), so
 * they are not on the accept-all list. "Save all …" is still caught by the everything rule.
 */
function isPreferenceSave(p: Pattern): boolean {
  if (typeof p === "string") return p === "guardar preferencias";
  return (
    p.source.startsWith("^(save|store|submit") ||
    p.source.startsWith("^((meine\\s+)?auswahl|einstellungen")
  );
}

/** Fully anchored entries: exact strings and `^…$` regexes. The rest can hit inside longer text. */
function isAnchored(p: Pattern): boolean {
  return typeof p === "string" || (p.source.startsWith("^") && p.source.endsWith("$"));
}

const acceptPatterns = ACCEPT_PATTERNS.filter((p) => !isPreferenceSave(p));
const ANCHORED_ACCEPT = acceptPatterns.filter(isAnchored);
const UNANCHORED_ACCEPT = acceptPatterns.filter((p) => !isAnchored(p));
/** Exported so a test notices when an autoconsent upgrade changes which entries these are. */
export const EXCLUDED_ACCEPT = ACCEPT_PATTERNS.filter(isPreferenceSave);

/** Runs patterns on both the raw text and `cleanButtonText`, as §0 asks. */
function matchesAny(patterns: Pattern[], raw: string): boolean {
  const texts = [raw, normalise(raw), cleanButtonText(raw)];
  return patterns.some((p) =>
    typeof p === "string" ? texts.includes(p) : texts.some((t) => p.test(t)),
  );
}

const negatingPrefixes = new Set(NEGATING_PREFIXES.map((p) => fold(normalise(p))));

/**
 * The text that groups 1 and 3 are read from. A negation directly before a group 1 word becomes
 * "optional" ("non-essential", "nicht notwendige"), then hyphenated compounds are joined, so the
 * "nicht" of "nicht-EU" is not a negation. Both only ever remove lifting terms, never add one.
 */
function liftText(n: string): string {
  const parts = n.split(/([-\s]+)/);
  for (let i = 0; i + 2 < parts.length; i += 2) {
    if (negatingPrefixes.has(parts[i] ?? "") && hasNecessaryOnlyStem(parts[i + 2] ?? "")) {
      parts.splice(i, 3, "optional");
    }
  }
  return parts.join("").replace(/(?<=\p{L})-(?=\p{L})/gu, "");
}

/** Groups 1 and 3: the terms that lift the veto and override unanchored accept-list hits. */
function liftsVeto(n: string): boolean {
  const t = liftText(n);
  return hasNecessaryOnly(t) || hasRefusal(t);
}

function isAllowListedText(s: string): boolean {
  return allowList.has(bare(s));
}

/** Whether one source matches the accept-all list (allow-list not yet applied). */
function onAcceptList(raw: string, n: string, regexClass?: ButtonRegexClassification): boolean {
  if (matchesAny(ANCHORED_ACCEPT, raw) || extraAcceptAll.has(bare(raw))) return true;
  // A regex reject or settings label stands against everything but an anchored entry.
  if (regexClass === "reject" || regexClass === "settings") return false;
  if (liftsVeto(n)) return false;
  return matchesAny(UNANCHORED_ACCEPT, raw) || (hasAcceptVerb(n) && !hasSettingsWord(n));
}

function sourceIsAcceptAll(raw: string, regexClass?: ButtonRegexClassification): boolean {
  const n = fold(normalise(raw));
  const everything = hasEverything(n);
  const allowed = isAllowListedText(raw);
  if (onAcceptList(raw, n, regexClass) && (everything || !allowed)) return true;
  // §2e step 3's everything rule, moved into §0: "Confirm all", "Select all and save".
  return (
    everything && hasSaveVerb(n) && !hasRefusal(liftText(n)) && regexClass !== "reject" && !allowed
  );
}

/** The control's non-empty text sources, never joined: anchored patterns would miss a join. */
export function textSources(c: Pick<Control, "text" | "ariaLabel" | "title">): string[] {
  return [c.text, c.ariaLabel, c.title].filter((s): s is string => !!s && s.trim() !== "");
}

/**
 * §0 accept-all. `regexClass` is autoconsent's `classifyButtonTextRegex` label for the control,
 * if it has one.
 */
export function isAcceptAll(sources: string[], regexClass?: ButtonRegexClassification): boolean {
  return sources.some((s) => sourceIsAcceptAll(s, regexClass));
}

/** The selection-saving allow-list. */
export function isAllowListed(sources: string[]): boolean {
  return sources.some(isAllowListedText);
}

/**
 * The accept-verb veto, for a control the regex labelled reject or settings: true when a source
 * has an accept, agree or allow verb and no necessary-only or refusal term.
 */
export function isVetoed(sources: string[]): boolean {
  return sources.some((s) => {
    const n = fold(normalise(s));
    return hasAcceptVerb(n) && !liftsVeto(n);
  });
}

export function isDoNotSell(sources: string[]): boolean {
  return sources.some((s) => hasDoNotSell(fold(normalise(s))));
}

/** A whole word meaning "everything". */
export function hasEverythingWord(s: string): boolean {
  return hasEverything(fold(normalise(s)));
}

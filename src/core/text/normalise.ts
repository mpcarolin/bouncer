/** Lower-cases, maps curly apostrophes to ', collapses whitespace and trims. */
export function normalise(raw: string): string {
  return raw.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();
}

/** Strips diacritics (NFD, then drops combining marks). ø and ß have no decomposition and survive. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

const META = /[.*+?^${}()|[\]\\/]/g;

function alternation(terms: string[]): string {
  return terms.map((t) => fold(normalise(t)).replace(META, "\\$&")).join("|");
}

const NEVER = /(?!)/u;

/** Matches any term as a whole word. Non-global, so `.test()` is stateless. */
export function wordRe(terms: string[]): RegExp {
  if (terms.length === 0) return NEVER;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation(terms)})(?![\\p{L}\\p{N}])`, "u");
}

/** Matches any stem at the start of a word, followed by any letters. Non-global. */
export function stemRe(stems: string[]): RegExp {
  if (stems.length === 0) return NEVER;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation(stems)})\\p{L}*`, "u");
}

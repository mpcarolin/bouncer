// §2d.2: the no-model fast path. It runs only when the model is unavailable.
import { checkHeuristicPatterns, isExcludedPopup } from "@duckduckgo/autoconsent/heuristics";
import type { Labelled, SerialisedBanner } from "../types.ts";

/**
 * The control the fast path may click, or null. All of these must hold: autoconsent's text
 * patterns match the banner, `isExcludedPopup` is false, and a *button* (not a link) carries a
 * regex `reject` label that no §0 rule blocked and that would not navigate. The click-time guards
 * (`safeClick`) still apply on top.
 */
export function fastPathTarget(
  b: SerialisedBanner,
  det: ReadonlyMap<number, Labelled | null>,
): number | null {
  if (checkHeuristicPatterns(b.text).patterns.length === 0 || isExcludedPopup(b.text)) return null;
  const hit = b.controls.find((c) => {
    const l = det.get(c.id);
    return (
      c.role === "button" &&
      !c.absent &&
      l?.label === "reject" &&
      l.source === "regex" &&
      l.blocked === undefined
    );
  });
  return hit?.id ?? null;
}

import type { LogEntry } from "./log.ts";
import type { BackgroundPlatform } from "./platform.ts";
import { report } from "./report.ts";
import { DISMISSED } from "./types.ts";

/** The toolbar icon's mark for one tab's page: a few characters on a coloured badge, and a tooltip. */
export interface Badge {
  text: string;
  color: string;
  title: string;
}

/** A banner handled by a rule: autoconsent's, a learned one, or Bouncer's own without the model. */
export const RULE_BADGE: Badge = {
  text: "✓",
  color: "#1a7f37",
  title: "Bouncer handled this page's cookie banner with a rule",
};

/** A banner the on-device model judged. */
export const AI_BADGE: Badge = {
  text: "AI",
  color: "#8250df",
  title: "Bouncer handled this page's cookie banner with the on-device model",
};

/** The mark for a logged decision: none unless its banner was dismissed. */
export function badgeFor(e: Pick<LogEntry, "path" | "outcome">): Badge | null {
  if (e.outcome === "working" || !DISMISSED.has(e.outcome)) return null;
  return e.path === "ai" ? AI_BADGE : RULE_BADGE;
}

/** Marks the tab, or takes its mark off. The mark is cosmetic: failing to set it fails nothing else. */
export function markTab(p: BackgroundPlatform, tabId: number, b: Badge | null): void {
  p.setBadge(tabId, b).catch((e) => report(`failed to mark tab ${tabId}`, e));
}

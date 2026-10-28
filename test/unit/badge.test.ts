import { describe, expect, it } from "vitest";
import { AI_BADGE, badgeFor, RULE_BADGE } from "../../src/core/badge.ts";
import type { LogEntry } from "../../src/core/log.ts";
import { DISMISSED, type Outcome } from "../../src/core/types.ts";

const PATHS: LogEntry["path"][] = ["autoconsent", "heuristic", "ai", "learned", "deferred"];
const NOT_DISMISSED: (Outcome | "working")[] = [
  "working",
  "deferred",
  "not_consent",
  "no_option",
  "unsure",
  "failed",
  "model_unavailable",
];

describe("badgeFor", () => {
  it("marks a banner the model judged as AI, and one a rule handled as a rule, whatever the dismissal", () => {
    for (const outcome of DISMISSED) {
      expect(badgeFor({ path: "ai", outcome })).toBe(AI_BADGE);
      for (const path of ["autoconsent", "heuristic", "learned"] as const) {
        expect(badgeFor({ path, outcome })).toBe(RULE_BADGE);
      }
    }
  });

  it("marks nothing for a banner that wasn't dismissed", () => {
    for (const outcome of NOT_DISMISSED) {
      for (const path of PATHS) expect(badgeFor({ path, outcome })).toBeNull();
    }
  });

  it("tells the two apart by text and colour, and fits the toolbar", () => {
    expect(RULE_BADGE.text).not.toBe(AI_BADGE.text);
    expect(RULE_BADGE.color).not.toBe(AI_BADGE.color);
    for (const b of [RULE_BADGE, AI_BADGE]) {
      expect([...b.text].length).toBeLessThanOrEqual(4);
      expect(b.title).toMatch(/^Bouncer /);
    }
  });
});

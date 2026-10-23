import type { BannerFixture } from "../../src/core/fixture.ts";
import type { DecisionKind, Label } from "../../src/core/types.ts";

export type { BannerFixture, DecisionKind };

const LABELS: readonly Label[] = [
  "accept",
  "reject",
  "settings",
  "save",
  "close",
  "acknowledge",
  "link",
  "toggle-optional",
  "toggle-necessary",
  "toggle-optout",
  "other",
];
const DECISIONS: readonly string[] = [
  "reject",
  "save",
  "settings",
  "close",
  "agree",
  "no_option",
  "unsure",
];
const ROLES: readonly string[] = ["button", "link", "toggle", "other"];

/** Returns every way `f` breaks the fixture contract; empty means valid. */
export function validateFixture(f: BannerFixture): string[] {
  const errors: string[] = [];
  const bad = (msg: string) => errors.push(`${f.id}: ${msg}`);

  if (!f.id) bad("missing id");
  if (f.kind !== "positive" && f.kind !== "negative") bad(`kind ${String(f.kind)}`);
  if (f.stage !== 1 && f.stage !== 2) bad(`stage ${String(f.stage)}`);
  if (!f.note) bad("missing note");
  if (f.gate !== (f.kind === "positive" ? "consent" : "other")) bad(`gate ${f.gate} for ${f.kind}`);
  if (typeof f.banner?.text !== "string") bad("banner.text is not a string");

  const controls = f.banner?.controls ?? [];
  controls.forEach((c, i) => {
    if (c.id !== i) bad(`control ids must run 0..n-1 in order (got ${c.id} at ${i})`);
    if (!ROLES.includes(c.role)) bad(`control ${c.id}: role ${String(c.role)}`);
    if (typeof c.text !== "string") bad(`control ${c.id}: text is not a string`);
  });

  const labels = f.expectedLabels;
  if (f.kind === "positive") {
    if (!labels) bad("positive without expectedLabels");
    for (const c of controls) {
      const label = labels?.[c.id];
      if (label === undefined) {
        bad(`control ${c.id} has no expected label`);
        continue;
      }
      if (!LABELS.includes(label)) bad(`control ${c.id}: unknown label ${label}`);
      const toggleLabel = label.startsWith("toggle-");
      if (toggleLabel !== (c.role === "toggle")) {
        bad(`control ${c.id}: label ${label} on role ${c.role}`);
      }
      if (c.role === "toggle" && c.disabled && label !== "toggle-necessary") {
        bad(`control ${c.id}: a disabled toggle is toggle-necessary`);
      }
    }
    if (!f.expectedDecision || !DECISIONS.includes(f.expectedDecision)) {
      bad(`positive expectedDecision ${String(f.expectedDecision)}`);
    }
  } else if (f.expectedDecision !== "not_consent") {
    bad(`negative expectedDecision ${String(f.expectedDecision)}`);
  }

  if (labels) {
    const ids = new Set(controls.map((c) => c.id));
    for (const key of Object.keys(labels)) {
      if (!ids.has(Number(key))) bad(`expectedLabels names unknown control ${key}`);
    }
  }
  return errors;
}

import { GATE_TEXT_CHARS, LABEL_TEXT_CHARS } from "../../core/config.ts";
import type { Control, Label, SerialisedBanner } from "../../core/types.ts";

// ---------------------------------------------------------------- input formatting
// Ported from spike/bouncer-poc/variants.js (fmtInput) onto Bouncer's Control shape.
// The output format is identical so benchmarks compare.

function trunc(t: string, n: number): string {
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** A control's visible text, or its aria-label when the text is empty. */
export function controlLabel(c: Control): string {
  return c.text || c.ariaLabel || "";
}

function fmtControl(c: Control): string {
  let s = `[${c.id}] ${c.role} "${controlLabel(c)}"`;
  if (c.on !== undefined) s += c.on ? " on" : " off";
  if (c.disabled) s += " disabled";
  return s;
}

export function fmtInput(banner: SerialisedBanner, maxText: number, controls?: Control[]): string {
  const list = controls ?? banner.controls;
  const t = maxText > 0 ? `Text: ${trunc(banner.text, maxText)}\n` : "";
  return `${t}Controls:\n${list.map(fmtControl).join("\n")}`;
}

export const gateInput = (b: SerialisedBanner) => fmtInput(b, GATE_TEXT_CHARS);
export const labelInput = (b: SerialisedBanner, controls: Control[]) =>
  fmtInput(b, LABEL_TEXT_CHARS, controls);
export const corroborateInput = (b: SerialisedBanner, control: Control, label: CorroLabel) =>
  `${fmtInput(b, LABEL_TEXT_CHARS)}\n\n${corroborateQuestion(control, label)}`;

// ---------------------------------------------------------------- gate (§2d)

export const GATE_SCHEMA = { type: "string", enum: ["yes", "no"] } as const;

// The spike's GATE_DEF (variants.js:120-123), verbatim except for two edits the spec (§2d) requires:
//   (a) YES parenthetical: removed `, "Do not sell or share" choices`.
//   (b) NO list: added a counterexample for standalone US "Do not sell or share" notices.
// Original, for the owner's bench comparison:
//
//   Decide if a page element is a cookie/tracking CONSENT dialog.
//   YES: it asks the visitor to accept, reject or configure cookies, tracking, or use/sale/sharing of personal data (GDPR/CCPA banners, cookie preference centres, "Do not sell or share" choices). A dialog asking to agree to terms AND data collection also counts.
//   NO: login or sign-up walls, newsletter/email/SMS signups, discount or promo popups, chat widgets, paywalls and subscription offers, age gates, app-install or notification prompts, surveys, announcement bars, site headers and menus — even when they link to a Privacy Policy, Terms or Cookie Policy.
//   Answer yes or no.
export const GATE_SYSTEM = `Decide if a page element is a cookie/tracking CONSENT dialog.
YES: it asks the visitor to accept, reject or configure cookies, tracking, or use/sale/sharing of personal data (GDPR/CCPA banners, cookie preference centres). A dialog asking to agree to terms AND data collection also counts.
NO: login or sign-up walls, newsletter/email/SMS signups, discount or promo popups, chat widgets, paywalls and subscription offers, age gates, app-install or notification prompts, surveys, announcement bars, site headers and menus, standalone US "Do not sell or share my personal information" notices that offer no cookie choices — even when they link to a Privacy Policy, Terms or Cookie Policy.
Answer yes or no.`;

// ---------------------------------------------------------------- labels (§2e step 5)

export const AI_LABELS = [
  "accept",
  "reject",
  "settings",
  "save",
  "close",
  "acknowledge",
  "link",
  "other",
] as const satisfies readonly Label[];

export type AiLabel = (typeof AI_LABELS)[number];

// Adapted from the spike's D_LABELS_SYSTEM: no toggle labels (the AI never labels toggles),
// plus `acknowledge` (§2e). accept/acknowledge split the spike's "accept ... OK, Got it, Continue".
export const LABELS_SYSTEM = `Label every control of a cookie consent dialog. Input: dialog text, then the controls to label [n] role "label".
Labels:
accept = accepts/agrees/allows all
reject = refuses optional cookies: Reject all, Decline, Deny, Necessary/Required/Essential only
settings = opens cookie settings/preferences/choices
save = saves or confirms the current choices
close = closes the dialog (×, Close) without choosing
acknowledge = OK, Got it, Continue: acknowledges the notice without choosing
link = opens another page (policy, terms, vendor list)
other = anything else (category headings, tabs)
Reply JSON {"labels":[...]} with exactly one label per control, in the order given.`;

export function labelsSchema(n: number, minMax: boolean) {
  const arr: Record<string, unknown> = {
    type: "array",
    items: { type: "string", enum: AI_LABELS },
  };
  if (minMax) {
    arr.minItems = n;
    arr.maxItems = n;
  }
  return {
    type: "object",
    properties: { labels: arr },
    required: ["labels"],
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------- corroboration (§2e)

export type CorroLabel = "reject" | "save" | "settings";

export const CORROBORATE_SYSTEM =
  "You answer yes/no questions about a control of a cookie consent dialog. Answer yes or no.";

export function corroborateQuestion(control: Control, label: CorroLabel): string {
  const l = controlLabel(control);
  switch (label) {
    case "reject":
      return `Does clicking «${l}» refuse optional cookies?`;
    case "save":
      return `Does clicking «${l}» save the choices shown, without accepting everything?`;
    case "settings":
      return `Does clicking «${l}» open cookie choices without accepting?`;
  }
}

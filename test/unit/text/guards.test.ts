import { classifyButtonTextRegex } from "@duckduckgo/autoconsent/heuristics";
import { describe, expect, test } from "vitest";
import {
  EXCLUDED_ACCEPT,
  hasEverythingWord,
  isAcceptAll,
  isAllowListed,
  isDoNotSell,
  isVetoed,
  textSources,
} from "../../../src/core/text/guards.ts";

// §0 test cases, verbatim, plus the backlog's round-10 cases (the last five of NOT_ACCEPT_ALL).
const ACCEPT_ALL = [
  "Accept all and save",
  "Save & accept all",
  "Accept cookies and continue to site",
  "Accept and continue browsing",
  "Accept all now",
  "Confirm all",
  "Select all and save",
  "Alle auswählen und speichern",
  "Apply all",
  "Tillad alle",
  "Accepter alle",
  "Godkänn alla",
  "Hyväksy kaikki",
  "Acceptă toate",
  "Sounds good",
  "Yes, I'm happy",
];
const VETOED = [
  "Customise and accept all",
  "Allow all cookies and customise",
  "Accept and customize",
  "Agree and customise",
  "Doorgaan met aanvaarden",
  "Doorgaan en aanvaarden",
  "Customize and accept now",
  "Customise advertising and accept",
];
const NOT_VETOED = [
  "Nur notwendige Cookies akzeptieren",
  "Continuer sans accepter",
  "Alleen noodzakelijke cookies accepteren",
  "Accepteer alleen noodzakelijke",
  "Accetta solo necessari",
  "Aceptar solo necesarias",
  "Accepter uniquement les cookies nécessaires",
  "Nur essenzielle Cookies erlauben",
  "Accept required cookies",
  "Accept minimal",
];
const NOT_ACCEPT_ALL = [
  "Reject all",
  "Allow selection",
  "Save and accept",
  "Continue without accepting",
  "I do not accept",
  "I don't accept",
  "I don’t accept",
  "Do not accept cookies",
  "Continue without consent",
  "I do not agree",
  "Refuse consent",
  "Manage consent",
  "Consent settings",
  "Manage Consent Preferences",
  "Alle ablehnen und speichern",
  "Tout refuser et enregistrer",
  "Rechazar todo y guardar",
  "Reject all and save",
  "Save all my choices",
];
test.each(ACCEPT_ALL)("accept-all: %s", (t) =>
  expect(isAcceptAll([t], classifyButtonTextRegex(t))).toBe(true),
);
test.each(VETOED)("vetoed: %s", (t) => {
  expect(["reject", "settings"]).toContain(classifyButtonTextRegex(t));
  expect(isVetoed([t])).toBe(true);
});
test.each(NOT_VETOED)("veto lifted: %s", (t) => expect(isVetoed([t])).toBe(false));
test.each(NOT_ACCEPT_ALL)("not accept-all: %s", (t) =>
  expect(isAcceptAll([t], classifyButtonTextRegex(t))).toBe(false),
);
test("sources are read separately", () =>
  expect(isAcceptAll(["Accept all", "Accept all cookies"])).toBe(true));
test("icon × with accept aria-label", () =>
  expect(isAcceptAll(textSources({ text: "×", ariaLabel: "Accept and continue browsing" }))).toBe(
    true,
  ));
test("do not sell", () =>
  expect(isDoNotSell(["Do not sell or share my personal information"])).toBe(true));

describe("textSources", () => {
  test("keeps non-empty sources apart, in order", () => {
    expect(
      textSources({ text: "Accept all", ariaLabel: "Accept all cookies", title: " " }),
    ).toEqual(["Accept all", "Accept all cookies"]);
  });
});

describe("regex labels and the unanchored part of the accept-all list", () => {
  test("an unanchored ACCEPT_PATTERNS hit does not override a regex reject (backlog round 10)", () => {
    const t = "i accept only necessary cookies";
    expect(classifyButtonTextRegex(t)).toBe("reject");
    expect(isAcceptAll([t], "reject")).toBe(false);
    expect(isVetoed([t])).toBe(false);
  });
  test("the detector and unanchored entries still fire when the regex says nothing", () => {
    expect(isAcceptAll(["Allow cookies and continue to the site"], "other")).toBe(true);
  });
  test("the detector is off on a regex reject or settings control", () => {
    expect(isAcceptAll(["Customise advertising and accept"], "settings")).toBe(false);
  });
  test("an anchored ACCEPT_PATTERNS entry overrides a regex settings label", () => {
    // "Cookies auswählen" is regex settings but matches autoconsent's anchored German accept
    // pattern. Accepted as a coverage loss rather than allow-listed (see report).
    expect(classifyButtonTextRegex("Cookies auswählen")).toBe("settings");
    expect(isAcceptAll(["Cookies auswählen"], "settings")).toBe(true);
  });
});

describe("allow-list and the everything override", () => {
  test("allow-list phrases are listed", () => {
    for (const t of [
      "Save settings",
      "Accept selection",
      "Confirm my choices",
      "Save all my choices",
    ]) {
      expect(isAllowListed([t])).toBe(true);
    }
    expect(isAllowListed(["Accept all and save"])).toBe(false);
  });
  test("an accept-list hit with an everything word beats the allow-list", () => {
    expect(isAcceptAll(["Save and accept all"])).toBe(true);
  });
  test("save verb plus everything word is accept-all, wherever the control sits", () => {
    for (const t of ["Save all", "Alle bestätigen", "Activate all and save", "Tout enregistrer"]) {
      expect(isAcceptAll([t], classifyButtonTextRegex(t))).toBe(true);
    }
  });
  test("a regex reject keeps a save-plus-everything control a refusal", () => {
    expect(isAcceptAll(["Save all"], "reject")).toBe(false);
  });
  test("exactly autoconsent's three preference-save entries leave the accept-all list", () => {
    expect(EXCLUDED_ACCEPT).toHaveLength(3);
  });
  test("autoconsent's preference-save patterns are save, not accept-all", () => {
    for (const t of ["Save preferences", "Submit my cookie settings", "Auswahl speichern"]) {
      expect(isAcceptAll([t], classifyButtonTextRegex(t))).toBe(false);
    }
  });
});

describe("hasEverythingWord", () => {
  test("whole words only", () => {
    for (const t of [
      "Accept ALL",
      "Alle akzeptieren",
      "Tout accepter",
      "Aceptar todo",
      "Hyväksy kaikki",
    ]) {
      expect(hasEverythingWord(t)).toBe(true);
    }
    for (const t of ["Allow selection", "Totally fine", "Allemand"]) {
      expect(hasEverythingWord(t)).toBe(false);
    }
  });
});

describe("whole-word negations", () => {
  test('"no" does not hit "now", "sin" does not hit "browsing"', () => {
    expect(isVetoed(["Customize and accept now"])).toBe(true);
    expect(isVetoed(["Accept and customise browsing"])).toBe(true);
  });
  test("a negation lifts the veto in other languages", () => {
    for (const t of ["Nicht akzeptieren", "Niet accepteren", "Je n'accepte pas", "Non accetto"]) {
      expect(isVetoed([t])).toBe(false);
    }
  });
});

describe("corpus-driven cases", () => {
  test("a negated necessary word means optional, not necessary-only", () => {
    for (const t of [
      "Accept non-essential cookies",
      "Accept all non-essential cookies",
      "Agree to optional cookies",
    ]) {
      expect(isAcceptAll([t], classifyButtonTextRegex(t))).toBe(true);
    }
    expect(isVetoed(["Nicht notwendige Cookies akzeptieren"])).toBe(true);
  });
  test("refusals of optional cookies still lift the veto", () => {
    for (const t of [
      "Reject non-essential",
      "Nicht notwendige Cookies ablehnen",
      "Refuser les cookies non nécessaires",
    ]) {
      expect(isVetoed([t])).toBe(false);
    }
  });
  test("a hyphenated compound is not a negation", () => {
    const t = "Alle akzeptieren inkl. Datenübertragung in Nicht-EU-Staaten";
    expect(isAcceptAll([t], classifyButtonTextRegex(t))).toBe(true);
  });
  test("refusing nothing, functional-only and consent nouns", () => {
    expect(isVetoed(["Nichts akzeptieren"])).toBe(false);
    expect(isVetoed(["Funktionelle Cookies akzeptieren"])).toBe(false);
    expect(isVetoed(["Zustimmung verwalten"])).toBe(false);
  });
});

describe("do not sell", () => {
  test("phrasings", () => {
    for (const t of [
      "Do Not Sell My Personal Information",
      "Don’t sell or share my data",
      "Do not share my info",
    ]) {
      expect(isDoNotSell([t])).toBe(true);
    }
    expect(isDoNotSell(["Reject all"])).toBe(false);
  });
});

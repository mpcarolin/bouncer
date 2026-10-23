/**
 * Every term list from spec §0 (and the save verbs of §2e step 3), as data. Logic is in guards.ts.
 *
 * A `word` matches as a whole word, a `stem` at the start of a word (§0 "How terms match"). Both
 * are folded and normalised before matching, so "nécessaire" and "necessaire" are the same term;
 * ø, æ and ß have no decomposition and stay as written. Phrase lists (`*_PHRASES`, `ALLOW_LIST`)
 * match the whole control text, compared without punctuation.
 *
 * Which way a mistake fails matters. An extra accept verb only blocks more controls. An extra
 * term in groups 1–3 can lift a veto or switch the detector off, so those lists hold only terms
 * that never appear in accept-all wording ("nu" is Dutch for "now", "pas" is Dutch for "adjust").
 */

export type Term = { word: string } | { stem: string };

/** Accept-all phrases autoconsent's ACCEPT_PATTERNS miss, matched against the whole text. */
export const EXTRA_ACCEPT_ALL_PHRASES: string[] = [
  "tillad alle",
  "tillad alle cookies",
  "accepter alle",
  "accepter alle cookies",
  "godkänn alla",
  "godkänn alla cookies",
  "tillåt alla",
  "hyväksy kaikki",
  "hyväksy kaikki evästeet",
  "acceptă toate",
  "acceptă toate cookie-urile",
  "aceitar todos",
  "aceitar tudo",
  "accetta tutti",
  "accetta tutto",
  "all cookies",
  "alle cookies",
  "sounds good",
  "yes, i'm happy",
  "yes, i'm happy with that",
  "i'm happy",
  "i'm ok with this",
  "i'm okay with this",
  "i'm fine with this",
  "yes, that's fine",
  "fine by me",
  "geht klar",
  "ja",
  "oui",
  "sí",
];

/**
 * Negations that, directly before a group 1 stem, make it mean *optional*: "non-essential",
 * "nicht notwendige", "no esenciales". Such a pair is neither necessary-only nor a refusal, so
 * "Accept non-essential cookies" stays accept-all.
 */
export const NEGATING_PREFIXES: string[] = [
  "non",
  "not",
  "nicht",
  "no",
  "niet",
  "ikke",
  "inte",
  "nie",
  "não",
];

/** Accept, agree and allow verbs, any inflection, with translations. */
export const ACCEPT_VERBS: Term[] = [
  // en; the "accept" stem also covers accepter, accepteer(en), acceptar, acceptera, acceptă
  { stem: "accept" },
  { stem: "agree" },
  { stem: "allow" },
  { stem: "authoris" },
  { stem: "authoriz" },
  // de
  { stem: "akzeptier" },
  { stem: "erlaub" },
  { stem: "zulass" },
  { stem: "annehm" },
  { word: "nehme an" },
  { word: "zustimmen" }, // not a stem: "Zustimmung" is the noun, like "consent"
  { word: "stimme zu" },
  { stem: "einverstanden" },
  { word: "einwilligen" }, // not a stem: "Einwilligung" is the noun
  { word: "willige ein" },
  // nl
  { stem: "aanvaard" },
  { stem: "akkoord" },
  { word: "toestaan" },
  { word: "sta" }, // "sta … toe"
  // fr; "j'accepte" is covered by "accept", "jaccepte" is how cleaned text spells it
  { stem: "jaccept" },
  { stem: "autoris" },
  { stem: "accord" },
  // es, pt, it, ca
  { stem: "acept" },
  { stem: "aceit" },
  { stem: "accett" },
  { stem: "autoriz" },
  { stem: "permit" },
  { stem: "consentir" },
  // nordic
  { stem: "tillad" },
  { stem: "tillat" },
  { stem: "godkän" },
  { stem: "godkend" },
  { stem: "godta" },
  { stem: "hyväksy" },
  { stem: "salli" },
  // pl, cs
  { stem: "akcept" },
  { stem: "zaakcept" },
  { stem: "zgadz" },
  { stem: "zezwol" },
  { stem: "souhlas" },
  // ru, tr
  { stem: "принят" },
  { stem: "принима" },
  { stem: "соглас" },
  { stem: "разреш" },
  { word: "kabul" },
];

/** Detector exclusion group 1: necessary-only and selection wording. Lifts the veto. */
export const NECESSARY_ONLY: Term[] = [
  // en
  { stem: "necessar" },
  { stem: "essential" },
  { word: "only" },
  { word: "selection" },
  { word: "selected" },
  { word: "required" },
  { stem: "minimal" },
  { word: "minimum" },
  // functional-only wording, as autoconsent's own English accept pattern treats it
  { stem: "functional" },
  { stem: "funktional" },
  { stem: "funktionell" },
  { stem: "functione" },
  { stem: "fonctionn" },
  { stem: "funzional" },
  { stem: "funcional" },
  // de
  { word: "nur" },
  { stem: "notwendig" },
  { stem: "essenziell" },
  { stem: "erforderlich" },
  { stem: "nötig" },
  // fr
  { stem: "nécessaire" },
  { stem: "essentiel" },
  { word: "uniquement" },
  { word: "seulement" },
  // es, it, pt, ca, ro
  { stem: "necesari" },
  { stem: "necessari" },
  { stem: "necesar" },
  { stem: "esencial" },
  { stem: "essenzial" },
  { stem: "essencial" },
  { word: "solo" },
  { word: "solamente" },
  { word: "soltanto" },
  { word: "apenas" },
  { word: "somente" },
  { word: "doar" },
  // nl
  { word: "alleen" },
  { stem: "noodzakelijk" },
  { stem: "nodig" },
  // nordic
  { word: "endast" },
  { word: "bara" },
  { word: "kun" },
  { word: "vain" },
  { stem: "nødvendig" },
  { stem: "nödvändig" },
  { stem: "välttämät" },
  // pl, cs, ru
  { word: "tylko" },
  { stem: "niezbędn" },
  { stem: "nezbytn" },
  { word: "только" },
  { stem: "необходим" },
];

/** Detector exclusion group 2: settings wording. Switches the detector off; never lifts a veto. */
export const SETTINGS_WORDS: Term[] = [
  { stem: "manag" },
  { stem: "setting" },
  { stem: "preferen" },
  { stem: "customis" },
  { stem: "customiz" },
  { stem: "personalis" },
  { stem: "personaliz" },
  { stem: "personnalis" },
  { stem: "einstellung" },
  { stem: "anpass" },
  { stem: "verwalt" },
  { stem: "paramètre" },
  { stem: "gérer" },
  { stem: "configur" },
  { stem: "gestion" },
  { stem: "impostazion" },
  { stem: "gestisci" },
  { stem: "instelling" },
  { stem: "aanpass" },
  { stem: "beheer" },
  { stem: "voorkeur" },
  { stem: "inställning" },
  { stem: "indstilling" },
  { stem: "tilpas" },
  { stem: "asetuks" },
  { stem: "mukauta" },
  { stem: "setări" },
  { stem: "ustawien" },
  { stem: "dostosuj" },
];

/** Detector exclusion group 3: negation and refusal. Lifts the veto. */
export const REFUSAL: Term[] = [
  // en
  { word: "not" },
  { word: "don't" },
  { word: "dont" },
  { word: "do not" },
  { word: "without" },
  { word: "no" },
  { word: "none" },
  { word: "nothing" },
  { stem: "refus" },
  { word: "deny" },
  { stem: "denied" },
  { stem: "declin" },
  { stem: "reject" },
  { stem: "withdr" },
  { stem: "disagre" },
  // de
  { word: "nicht" },
  { word: "nichts" },
  { stem: "kein" },
  { word: "ohne" },
  { stem: "ablehn" },
  { stem: "verweiger" },
  { stem: "widerruf" },
  // fr: "n'" as a stem catches "n'accepte"; "pas" is left out (Dutch "pas aan" = adjust)
  { word: "ne" },
  { stem: "n'" },
  { word: "non" },
  { word: "sans" },
  { word: "rien" },
  { stem: "rejet" },
  // es, it, pt, ca, ro; "nu" is left out (Dutch "nu" = now)
  { word: "sin" },
  { word: "senza" },
  { word: "sem" },
  { word: "não" },
  { word: "nada" },
  { word: "niente" },
  { stem: "rechaz" },
  { stem: "rehus" },
  { stem: "deneg" },
  { stem: "rifiut" },
  { stem: "recus" },
  { stem: "rejeit" },
  { stem: "resping" },
  { stem: "refuz" },
  // nl
  { word: "niet" },
  { word: "geen" },
  { word: "zonder" },
  { word: "niets" },
  { stem: "weiger" },
  { stem: "afwijz" },
  // nordic
  { word: "inte" },
  { word: "ej" },
  { word: "utan" },
  { word: "ingen" },
  { word: "ikke" },
  { word: "uden" },
  { word: "uten" },
  { word: "ei" },
  { word: "ilman" },
  { stem: "avvis" },
  { stem: "avböj" },
  { stem: "afvis" },
  { stem: "afslå" },
  { stem: "avslå" },
  { stem: "hylkää" },
  // pl, cs, ru
  { word: "nie" },
  { word: "bez" },
  { stem: "odrzu" },
  { stem: "odmít" },
  { word: "не" },
  { word: "нет" },
  { word: "без" },
  { stem: "отказ" },
  { stem: "отклон" },
];

/** Whole words meaning "everything". */
export const EVERYTHING_WORDS: Term[] = [
  { word: "all" },
  { word: "everything" },
  { word: "alle" },
  { word: "alles" },
  { word: "allen" },
  { word: "allem" },
  { word: "tout" },
  { word: "tous" },
  { word: "toutes" },
  { word: "todo" },
  { word: "todos" },
  { word: "todas" },
  { word: "tutti" },
  { word: "tutte" },
  { word: "tutto" },
  { word: "tudo" },
  { word: "tot" },
  { word: "totes" },
  { word: "alla" },
  { word: "allt" },
  { word: "kaikki" },
  { word: "toate" },
  { word: "wszystkie" },
  { word: "wszystko" },
  { word: "всё" },
  { word: "все" },
];

/** Save, confirm, submit, apply, update, select and activate verbs (§2e step 3; Task 5). */
export const SAVE_VERBS: Term[] = [
  // en
  { stem: "save" },
  { stem: "confirm" },
  { stem: "submit" },
  { stem: "apply" },
  { stem: "update" },
  { stem: "select" },
  { stem: "activat" },
  // de
  { stem: "speicher" },
  { stem: "bestätig" },
  { stem: "übernehm" },
  { stem: "anwend" },
  { stem: "auswahl" }, // folding makes this cover auswählen too
  { stem: "aktivier" },
  { stem: "aktualisier" },
  // fr
  { stem: "enregistr" },
  { stem: "sauvegard" },
  { stem: "valid" },
  { stem: "appliqu" },
  { stem: "sélectionn" },
  { stem: "activer" },
  // es, it, pt, ro
  { stem: "guard" },
  { stem: "aplic" },
  { stem: "seleccion" },
  { stem: "activar" },
  { stem: "actualiz" },
  { stem: "salva" },
  { stem: "conferm" },
  { stem: "applic" },
  { stem: "selezion" },
  { stem: "attiva" },
  { stem: "aggiorn" },
  // nl
  { stem: "opsla" },
  { stem: "bewaar" },
  { stem: "bevestig" },
  { stem: "toepass" },
  // nordic
  { stem: "spara" },
  { stem: "bekräfta" },
  { stem: "tillämpa" },
  { word: "gem" },
  { stem: "bekræft" },
  { stem: "anvend" },
  { stem: "aktiver" },
  { stem: "tallenna" },
  { stem: "vahvista" },
  // pl
  { stem: "zapisz" },
  { stem: "zatwierd" },
  { stem: "potwierd" },
  { stem: "zastosuj" },
];

/**
 * Selection-saving allow-list, matched against the whole text. These save the choices shown;
 * §2f.2 may click one only as its save control.
 */
export const ALLOW_LIST: string[] = [
  "save settings",
  "save my settings",
  "save choices",
  "save my choices",
  "save all my choices",
  "save selection",
  "save my selection",
  "save preferences",
  "save my preferences",
  "save and accept",
  "accept selection",
  "accept selected",
  "accept my selection",
  "allow selection",
  "allow selected",
  "confirm choices",
  "confirm my choices",
  "confirm selection",
  "confirm my selection",
  "auswahl speichern",
  "meine auswahl speichern",
  "einstellungen speichern",
  "auswahl bestätigen",
  "meine auswahl bestätigen",
  "auswahl akzeptieren",
  "auswahl erlauben",
  "enregistrer mes choix",
  "valider mes choix",
  "accepter la sélection",
  "guardar preferencias",
  "guardar configuración",
  "guardar selección",
  "aceptar selección",
  "salva impostazioni",
  "salva le mie scelte",
  "voorkeuren opslaan",
  "instellingen opslaan",
  "selectie opslaan",
  "selectie accepteren",
  "selectie toestaan",
];

/** "Do not sell / share" wording (§0). Phase 1 never clicks these. */
export const DO_NOT_SELL: Term[] = [
  { word: "do not sell" },
  { word: "don't sell" },
  { word: "dont sell" },
  { word: "do not share" },
  { word: "don't share" },
  { word: "dont share" },
  { word: "opt out of sale" },
  { word: "opt out of the sale" },
  { word: "opt-out of sale" },
  { word: "opt-out of the sale" },
];

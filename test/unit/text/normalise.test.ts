import { describe, expect, test } from "vitest";
import { fold, normalise, stemRe, wordRe } from "../../../src/core/text/normalise.ts";

describe("normalise and fold", () => {
  test("normalise", () => expect(normalise("  I Don’t\n Accept ")).toBe("i don't accept"));
  test("fold keeps ø and ß", () => {
    expect(fold("sólo nécessaire")).toBe("solo necessaire");
    expect(fold("nødvendig straße")).toBe("nødvendig straße");
  });
});

describe("wordRe", () => {
  test("whole words are unicode-aware", () => {
    const re = wordRe(["no", "sin", "solo"]);
    expect(re.test(fold("aceptar sólo necesarias"))).toBe(true);
    for (const s of ["accept all now", "advertising", "browsing"]) {
      expect(re.test(s)).toBe(false);
    }
  });

  test("multi-word and apostrophe terms match as whole phrases", () => {
    const re = wordRe(["don't", "do not"]);
    expect(re.test(fold(normalise("I don’t accept")))).toBe(true);
    expect(re.test("i do not agree")).toBe(true);
    expect(re.test("i do nothing")).toBe(false);
    expect(re.test("we don't-but")).toBe(true);
  });

  test("regex metacharacters in terms are literal", () => {
    const re = wordRe(["a.b", "c+d"]);
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
    expect(re.test("ccd")).toBe(false);
    expect(re.test("c+d")).toBe(true);
  });

  test("is non-global, so repeated tests are stateless", () => {
    const re = wordRe(["no"]);
    expect(re.global).toBe(false);
    expect(re.test("no")).toBe(true);
    expect(re.test("no")).toBe(true);
  });

  test("empty term list matches nothing", () => {
    expect(wordRe([]).test("anything at all")).toBe(false);
  });
});

describe("stemRe", () => {
  test("stems match at word start only", () => {
    const re = stemRe(["akzeptier", "notwendig"]);
    expect(re.test("cookies akzeptieren")).toBe(true);
    expect(re.test("nicht-notwendige")).toBe(true);
    expect(re.test("unakzeptierbar")).toBe(false);
  });

  test("folds diacritics and escapes metacharacters", () => {
    expect(stemRe(["nécessair"]).test(fold("nécessaires"))).toBe(true);
    expect(stemRe(["a.b"]).test("axb")).toBe(false);
  });

  test("is non-global", () => {
    expect(stemRe(["notwendig"]).global).toBe(false);
  });
});

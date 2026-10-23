import { afterEach, expect, test } from "vitest";
import { removeAcStyles } from "../../src/core/page/ac-styles.ts";
import { mount, unmountAll } from "../helpers/mount.ts";

const added: Element[] = [];
afterEach(() => {
  for (const el of added.splice(0)) el.remove();
  unmountAll();
});

/** A `<style id=…>` in the head, as autoconsent's `getStyleElement` makes them. */
function style(id: string, css: string): HTMLStyleElement {
  const s = document.createElement("style");
  s.id = id;
  s.textContent = css;
  document.head.append(s);
  added.push(s);
  return s;
}

test("removeAcStyles removes both style elements", () => {
  const box = mount('<div id="cmp-banner">cookies</div><div id="cmp-wall">wall</div>');
  const banner = box.querySelector("#cmp-banner") as HTMLElement;
  const wall = box.querySelector("#cmp-wall") as HTMLElement;
  // autoconsent's pre-hide (opacity) and a `hide` rule step's rules (display).
  style("autoconsent-prehide", "#cmp-banner { opacity: 0 !important; }");
  style("autoconsent-css-rules", "#cmp-wall { display: none !important; }");
  const sites = style("site-styles", "#cmp-banner { color: rgb(1, 2, 3); }");
  expect(getComputedStyle(banner).opacity).toBe("0");
  expect(getComputedStyle(wall).display).toBe("none");

  removeAcStyles(document);

  expect(document.querySelector("#autoconsent-prehide, #autoconsent-css-rules")).toBeNull();
  expect(getComputedStyle(banner).opacity).toBe("1");
  expect(getComputedStyle(wall).display).toBe("block");
  // The page's own styles stay.
  expect(sites.isConnected).toBe(true);
  expect(getComputedStyle(banner).color).toBe("rgb(1, 2, 3)");
});

test("removeAcStyles does nothing when autoconsent has added neither, and can run again", () => {
  const sites = style("site-styles", "body { margin: 0; }");
  removeAcStyles(document);
  style("autoconsent-css-rules", "#x { display: none !important; }");
  removeAcStyles(document);
  removeAcStyles(document);
  expect(document.querySelector("#autoconsent-css-rules")).toBeNull();
  expect(sites.isConnected).toBe(true);
});

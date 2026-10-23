import type { AbsentReason, Control, Role, SerialisedBanner } from "../types.ts";
import type { Candidate } from "./detect.ts";
import { collapse, deepAll, isVisible, labelText, textOf } from "./dom.ts";

export { isVisible };

export const CONTROL_TEXT_CHARS = 120;
export const BANNER_TEXT_CHARS = 2000;

const TOGGLE_SEL = 'input[type="checkbox"], [role="switch"], [role="checkbox"]';
const CONTROL_SEL = [
  "button",
  "a[href]",
  '[role="button"]',
  '[role="link"]',
  'input[type="button"]',
  'input[type="submit"]',
  TOGGLE_SEL,
].join(", ");

/** Explicit ARIA roles that make an element some other kind of control. Others (alert …) are ignored. */
const OTHER_CONTROL_ROLES = new Set([
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
  "textbox",
  "searchbox",
  "treeitem",
]);

export interface Serialised {
  banner: SerialisedBanner;
  /** Maps `Control.id` back to the live element. */
  elements: Map<number, Element>;
}

export function roleOf(el: Element): Role {
  const aria = el.getAttribute("role");
  if (aria === "switch" || aria === "checkbox") return "toggle";
  if (aria && OTHER_CONTROL_ROLES.has(aria)) return "other";
  const tag = el.tagName;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    if (type === "checkbox") return "toggle";
    if (type === "button" || type === "submit") return "button";
    return "other";
  }
  if (tag === "BUTTON") return "button";
  if (tag === "A") return "link";
  if (aria === "button") return "button";
  if (aria === "link") return "link";
  return "other";
}

function isToggle(el: Element): boolean {
  return roleOf(el) === "toggle";
}

/** Custom switches hide the real input and style a label or parent, so look there too. */
export function isVisibleControl(el: Element): boolean {
  if (isVisible(el)) return true;
  if (!isToggle(el)) return false;
  const labels = (el as HTMLInputElement).labels;
  if (labels && [...labels].some(isVisible)) return true;
  return el.parentElement !== null && isVisible(el.parentElement);
}

/** The referenced elements may be hidden themselves; what they hide inside is left out. */
function ariaLabelledBy(el: Element): string {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return "";
  const root = el.getRootNode() as Document | ShadowRoot;
  const texts = ids.split(/\s+/).map((id) => {
    const ref = root.getElementById(id);
    return ref ? labelText(ref) : "";
  });
  return collapse(texts.join(" "));
}

/**
 * A control's text as the user sees it. A toggle the user cannot see has no rendered text, so
 * its labels are read whether or not they are rendered, without what the labels themselves hide.
 */
function visibleText(el: Element, shown: boolean): string {
  if (el instanceof HTMLInputElement && (el.type === "button" || el.type === "submit")) {
    return el.value;
  }
  if (isToggle(el)) {
    const read = shown ? textOf : labelText;
    const labels = (el as HTMLInputElement).labels;
    const fromLabels = labels ? [...labels].map(read).join(" ") : "";
    return collapse(fromLabels) || ariaLabelledBy(el) || read(el);
  }
  return textOf(el);
}

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function toggleOn(el: Element): boolean {
  if (el instanceof HTMLInputElement) return el.checked;
  return el.getAttribute("aria-checked") === "true";
}

function toggleDisabled(el: Element): boolean {
  return (
    (el instanceof HTMLInputElement && el.disabled) || el.getAttribute("aria-disabled") === "true"
  );
}

/**
 * Visible controls in document order, shadow roots included, with nested matches dropped
 * (outermost wins); then, if asked, the toggles that are not visible, in document order.
 */
function controlElements(root: Element, hiddenToggles: boolean): { el: Element; shown: boolean }[] {
  const all = deepAll(root, CONTROL_SEL).flatMap((el) => {
    const shown = isVisibleControl(el);
    return shown || (hiddenToggles && isToggle(el)) ? [{ el, shown }] : [];
  });
  // Only a non-toggle drops what it contains: hidden toggles leave the visible list as it was.
  const set = new Set(all.map((x) => x.el));
  const kept = all.filter(({ el }) => {
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
      if (set.has(p) && !isToggle(p)) return false;
    }
    return true;
  });
  return [...kept.filter((x) => x.shown), ...kept.filter((x) => !x.shown)];
}

export interface SerialiseOptions {
  /**
   * Also serialise the toggles the user cannot see (collapsed sections, hidden tabs), marked
   * `hidden`, after every visible control: the visible controls keep the ids a plain
   * serialisation gives them. For save decisions (§2f.2); off by default, so detection and the
   * gate see only what is shown.
   */
  hiddenToggles?: boolean;
}

/**
 * Describes a candidate for the labeller and the AI. `clickability` is the §0 test (Task 12):
 * a reason means the control would navigate or submit, so it is marked `absent`.
 * Toggles are not passed to it: §0's absence rules are about buttons and links, and a toggle
 * switches state in place. (An ancestor link would still navigate; the click guard in
 * §0 catches that at click time.)
 */
export function serialise(
  c: Pick<Candidate, "el">,
  clickability: (el: Element) => AbsentReason | null,
  opts: SerialiseOptions = {},
): Serialised {
  const elements = new Map<number, Element>();
  const controls: Control[] = [];
  for (const { el, shown } of controlElements(c.el, opts.hiddenToggles === true)) {
    const id = controls.length;
    const role = roleOf(el);
    const text = cap(collapse(visibleText(el, shown)), CONTROL_TEXT_CHARS);
    const control: Control = { id, role, text };
    if (!shown) control.hidden = true;
    const aria = el.getAttribute("aria-label")?.trim();
    if (aria) control.ariaLabel = aria;
    const title = el.getAttribute("title")?.trim();
    if (title) control.title = title;
    if (role === "toggle") {
      control.on = toggleOn(el);
      if (toggleDisabled(el)) control.disabled = true;
    } else {
      const absent = clickability(el);
      if (absent) control.absent = absent;
    }
    if (el.id) control.domId = el.id;
    controls.push(control);
    elements.set(id, el);
  }
  return { banner: { text: cap(textOf(c.el), BANNER_TEXT_CHARS), controls }, elements };
}

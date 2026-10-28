// §2g's GOV.UK-style confirmation: after the refusal the banner stays, now showing the choice it
// recorded ("You have rejected all additional cookies") and a control that closes it ("Hide").
import { labelDeterministic } from "../label.ts";
import type { ClickResult } from "../page/click.ts";
import { clickability } from "../page/clickable.ts";
import { serialise } from "../page/serialise.ts";
import { isGoneBySite, type VerifyResult } from "../page/verify.ts";
import type { Control } from "../types.ts";

/** The controls `banner` shows now: none of them can be the close control of a confirmation. */
export function shownControls(banner: Element): Set<Element> {
  return new Set(serialise({ el: banner }, clickability).elements.values());
}

/**
 * The close control the still-shown `banner` holds that isn't one of `before` (by identity, as
 * the settings hop tells a banner's gain): shown, labelled close by the rules (§2e step 2), and
 * neither blocked by §0 nor absent.
 */
export function confirmationClose(
  banner: Element,
  before: ReadonlySet<Element>,
): { el: Element; control: Control } | undefined {
  if (isGoneBySite(banner)) return undefined;
  const now = serialise({ el: banner }, clickability);
  const labels = labelDeterministic(now.banner);
  for (const control of now.banner.controls) {
    const el = now.elements.get(control.id);
    const l = labels.get(control.id);
    if (el && !before.has(el) && !control.absent && l?.label === "close" && !l.blocked) {
      return { el, control };
    }
  }
  return undefined;
}

export interface ConfirmationDeps {
  closeAction: "click" | "leave";
  /** Clicks through `safeClick` and logs the click. */
  click(el: Element, control: Control): ClickResult;
  note(s: string): void;
}

/**
 * `verifyDismissed`'s confirmation check after a refusal on `banner`, whose controls were `before`
 * when it was clicked. With Close set to click, the confirmation's close control is clicked, once,
 * and verification carries on. With "leave it", verification ends there: the banner confirmed the
 * refusal, but it isn't gone.
 */
export function confirmationCheck(
  banner: Element,
  before: ReadonlySet<Element>,
  deps: ConfirmationDeps,
): () => "clicked" | VerifyResult | null {
  let handled = false;
  return () => {
    if (handled) return null;
    const close = confirmationClose(banner, before);
    if (!close) return null;
    handled = true;
    if (deps.closeAction !== "click") {
      deps.note("confirmation:left");
      return { ok: false, reason: "confirmation" };
    }
    deps.note("confirmation:closed");
    const click = deps.click(close.el, close.control);
    return click.ok ? "clicked" : { ok: false, reason: click.reason ?? "navigation" };
  };
}

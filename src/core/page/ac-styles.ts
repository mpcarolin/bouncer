// autoconsent's own hiding, which it has no message to undo (§1, "Restoring after a failure"):
// its pre-hide, and the rules its `hide` steps add.
const AC_STYLES = "style#autoconsent-prehide, style#autoconsent-css-rules";

/** Puts back what autoconsent hid in `doc`, after its opt-out there has failed. */
export function removeAcStyles(doc: Document): void {
  for (const style of doc.querySelectorAll(AC_STYLES)) style.remove();
}

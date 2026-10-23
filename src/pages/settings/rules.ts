import type { LearnedRule, LearnedRules, LearnedStage } from "../../core/learned.ts";
import { h } from "../dom.ts";

/** What a stage does: its action and the control's text, and how many toggles it sets. */
function describeStage(stage: LearnedStage): string {
  const toggles = stage.toggles ? ` with ${stage.toggles.length} toggles` : "";
  return `${stage.action} "${stage.target.text}"${toggles}`;
}

const summary = (r: LearnedRule): string =>
  [r.stage1, r.stage2]
    .filter((s): s is LearnedStage => s !== undefined)
    .map(describeStage)
    .join(", then ");

/**
 * Fills `box` with the learned rules, each with a delete button. Deleting removes only that
 * site's rule: the index is the background's to write.
 */
export async function mountRules(box: HTMLElement, rules: LearnedRules): Promise<void> {
  const rows = await rules.list();
  if (rows.length === 0) {
    box.replaceChildren(h("p", { class: "dim" }, "No learned rules yet."));
    return;
  }
  const items = rows.map((r) => {
    const del = h(
      "button",
      { type: "button", "aria-label": `Delete the rule for ${r.site}` },
      "Delete",
    );
    del.addEventListener("click", async () => {
      del.disabled = true;
      await rules.removeRuleOnly(r.site);
      await mountRules(box, rules);
    });
    return h(
      "li",
      {},
      h("strong", {}, r.site),
      h(
        "span",
        { class: "dim" },
        ` learned ${new Date(r.createdAt).toLocaleDateString()}: ${summary(r)} `,
      ),
      del,
    );
  });
  box.replaceChildren(h("ul", { class: "rules" }, ...items));
}

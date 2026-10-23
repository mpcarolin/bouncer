/**
 * Builds an element. A string child becomes a text node, never markup: the decision log holds text
 * from web pages, and nothing on these pages may turn it into elements.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  el.append(...children);
  return el;
}

/** What a field shows when a decision has nothing to say for it. */
export const NONE = "–";

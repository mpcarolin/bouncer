const pages = import.meta.glob("../dom/pages/*.html", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const mounted: Element[] = [];

/** Appends HTML to the test page's body. Undone by `unmountAll()`. */
export function mount(html: string): HTMLElement {
  const box = document.createElement("div");
  box.innerHTML = html;
  document.body.append(box);
  mounted.push(box);
  return box;
}

/**
 * Mounts `test/dom/pages/<name>.html`: its `<style>` elements and body contents. Scripts do not
 * run (innerHTML), but inline `on*` handlers work. Returns the container.
 */
export function mountPage(name: string): HTMLElement {
  const html = pages[`../dom/pages/${name}.html`];
  if (html === undefined) throw new Error(`no test page "${name}"`);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const styles = [...parsed.querySelectorAll("style")].map((s) => s.outerHTML).join("");
  return mount(styles + parsed.body.innerHTML);
}

export function unmountAll(): void {
  for (const el of mounted.splice(0)) el.remove();
}

import type { KV } from "../../core/platform.ts";
import { loadSettings, type Settings, saveSettings, siteOf } from "../../core/settings.ts";
import { h } from "../dom.ts";

/**
 * Applies one change to the stored settings: load, change one field, save. Changes are queued, so
 * quick clicks can't overwrite each other, and each starts from what is stored now. The page is
 * the settings' only writer; the background only reads them.
 */
function changer(kv: KV, onError: (e: unknown) => void): (change: (s: Settings) => void) => void {
  let queue: Promise<void> = Promise.resolve();
  return (change) => {
    queue = queue
      .then(async () => {
        const s = await loadSettings(kv);
        change(s);
        await saveSettings(kv, s);
      })
      .catch(onError);
  };
}

function checkbox(
  text: string,
  checked: boolean,
  onToggle: (on: boolean) => void,
): HTMLLabelElement {
  const input = h("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onToggle(input.checked));
  return h("label", { class: "row" }, input, ` ${text}`);
}

function choice<T extends string>(
  legend: string,
  options: readonly (readonly [T, string])[],
  current: T,
  onPick: (value: T) => void,
  hint?: string,
): HTMLFieldSetElement {
  const name = `choice-${legend}`;
  const radios = options.map(([value, text]) => {
    const input = h("input", { type: "radio", name });
    input.checked = value === current;
    input.addEventListener("change", () => onPick(value));
    return h("label", { class: "row" }, input, ` ${text}`);
  });
  return h(
    "fieldset",
    {},
    h("legend", {}, legend),
    ...radios,
    ...(hint ? [h("p", { class: "dim" }, hint)] : []),
  );
}

/** Whether `site` is among the disabled sites, which may be stored with or without `www.`. */
const sameSite = (stored: string, site: string) => siteOf(`https://${stored}/`) === site;

/**
 * Fills `box` with the switches. `host` is the hostname the settings page was opened for (the
 * active tab's), or nothing when it was opened without one or the tab was not a website.
 */
export async function mountControls(
  box: HTMLElement,
  kv: KV,
  host: string | undefined,
): Promise<void> {
  const settings = await loadSettings(kv);
  const status = h("p", { class: "warn", role: "status" });
  const change = changer(kv, (e) => {
    status.textContent = `Couldn't save: ${e instanceof Error ? e.message : String(e)}`;
  });
  const site = host ? siteOf(`https://${host}/`) : "";

  box.replaceChildren(
    checkbox("Bouncer is on", settings.enabled, (on) =>
      change((s) => {
        s.enabled = on;
      }),
    ),
    ...(site
      ? [
          checkbox(
            `Disable on this site (${site})`,
            settings.disabledSites.some((d) => sameSite(d, site)),
            (off) =>
              change((s) => {
                s.disabledSites = s.disabledSites.filter((d) => !sameSite(d, site));
                if (off) s.disabledSites.push(site);
              }),
          ),
        ]
      : []),
    choice(
      "When a banner offers only Close",
      [
        ["click", "click Close"],
        ["leave", "leave it"],
      ],
      settings.closeAction,
      (value) =>
        change((s) => {
          s.closeAction = value;
        }),
    ),
    choice(
      "When a banner offers no way to refuse",
      [
        ["leave", "leave it"],
        ["agree", "agree to dismiss"],
      ],
      settings.agreeToDismiss ? "agree" : "leave",
      (value) =>
        change((s) => {
          s.agreeToDismiss = value === "agree";
        }),
      "Agreeing clicks the banner's OK or Agree button, which accepts its cookies.",
    ),
    choice(
      "When a dismissal fails",
      [
        ["restore", "put it back"],
        ["keep_hidden", "keep it hidden"],
      ],
      settings.onFailed,
      (value) =>
        change((s) => {
          s.onFailed = value;
        }),
      "This is for when Bouncer has hidden or clicked something and the banner is not verifiably gone.",
    ),
    checkbox("Keep the on-device model loaded", settings.keepModelWarm, (on) =>
      change((s) => {
        s.keepModelWarm = on;
      }),
    ),
    h(
      "p",
      { class: "dim" },
      "Banners the model handles are then refused without first waiting about 10 seconds for it to load. The model stays in memory for as long as Chrome is open.",
    ),
    status,
  );
}

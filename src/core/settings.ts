import type { KV } from "./platform.ts";

export interface Settings {
  enabled: boolean;
  disabledSites: string[];
  closeAction: "click" | "leave";
  agreeToDismiss: boolean;
  onFailed: "restore" | "keep_hidden";
  /** Keep the on-device model loaded while the browser runs, so no decision waits on loading it. */
  keepModelWarm: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  disabledSites: [],
  closeAction: "click",
  agreeToDismiss: false,
  onFailed: "restore",
  keepModelWarm: false,
};

/** Where the settings are kept in local storage. */
export const SETTINGS_KEY = "settings";

/**
 * Stored values are merged over the defaults, so older or partial records stay valid. A stored
 * `disabledSites` that isn't a list is dropped, and so is any entry in it that isn't a string:
 * every page's `hello` reads it, so a bad value must never make the read throw.
 */
export async function loadSettings(kv: KV): Promise<Settings> {
  const stored = await kv.get<Partial<Settings>>(SETTINGS_KEY);
  const sites: unknown = stored?.disabledSites;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    disabledSites: Array.isArray(sites)
      ? sites.filter((d): d is string => typeof d === "string")
      : [...DEFAULT_SETTINGS.disabledSites],
  };
}

export async function saveSettings(kv: KV, s: Settings): Promise<void> {
  await kv.set(SETTINGS_KEY, s);
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/** The site a URL is on, as the settings name sites: its hostname without `www.`. "" if none. */
export function siteOf(url: string): string {
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

/** Matches on the hostname without `www.`. An unparseable URL is treated as not enabled. */
export function enabledFor(s: Settings, url: string): boolean {
  if (!s.enabled) return false;
  let host: string;
  try {
    host = bareHost(new URL(url).hostname);
  } catch {
    return false;
  }
  return !s.disabledSites.some((d) => bareHost(d) === host);
}

import type { KV } from "./platform.ts";

export interface Settings {
  enabled: boolean;
  disabledSites: string[];
  closeAction: "click" | "leave";
  agreeToDismiss: boolean;
  onFailed: "restore" | "keep_hidden";
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  disabledSites: [],
  closeAction: "click",
  agreeToDismiss: false,
  onFailed: "restore",
};

const KEY = "settings";

/** Stored values are merged over the defaults, so older or partial records stay valid. */
export async function loadSettings(kv: KV): Promise<Settings> {
  const stored = await kv.get<Partial<Settings>>(KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    disabledSites: [...(stored?.disabledSites ?? DEFAULT_SETTINGS.disabledSites)],
  };
}

export async function saveSettings(kv: KV, s: Settings): Promise<void> {
  await kv.set(KEY, s);
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
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

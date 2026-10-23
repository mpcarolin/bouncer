export type BuildManifestOptions = { version: string };

export function buildManifest(
  _target: "chrome",
  opts: BuildManifestOptions,
): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: "Bouncer",
    version: opts.version,
    description: "Refuses cookie consent banners.",
    minimum_chrome_version: "138",
    permissions: ["storage", "scripting"],
    host_permissions: ["<all_urls>"],
    background: { service_worker: "background.js", type: "module" },
    action: { default_title: "Bouncer" },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["vendor/autoconsent/content.bundle.js"],
        all_frames: true,
        match_origin_as_fallback: true,
        run_at: "document_start",
      },
      {
        matches: ["<all_urls>"],
        js: ["content.js"],
        all_frames: true,
        match_origin_as_fallback: true,
        run_at: "document_start",
      },
    ],
  };
}

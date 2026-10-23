import { expect, test } from "vitest";
import { buildManifest } from "../../manifest/chrome.ts";

test("chrome manifest asks for the minimum", () => {
  const m = buildManifest("chrome", { version: "0.1.0" });
  expect(m.manifest_version).toBe(3);
  expect(m.minimum_chrome_version).toBe("138");
  expect(m.permissions).toEqual(["storage", "scripting"]);
  expect(m.host_permissions).toEqual(["<all_urls>"]);
  expect(m.background).toEqual({ service_worker: "background.js", type: "module" });
  expect(m.action?.default_popup).toBeUndefined(); // the icon opens the settings page
  expect(m.action?.default_title).toBe("Bouncer");
  const [ac, own] = m.content_scripts ?? [];
  expect(ac).toMatchObject({
    js: ["vendor/autoconsent/content.bundle.js"],
    all_frames: true,
    match_origin_as_fallback: true,
    run_at: "document_start",
  });
  expect(own).toMatchObject({ js: ["content.js"], all_frames: true, run_at: "document_start" });
});

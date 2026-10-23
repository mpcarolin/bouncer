// The Store build (`pnpm build` → dist/chrome) against what may ship: no mock provider, no
// benchmark page, and exactly the permissions Task 1 set. No browser is needed.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { MOCK_MARKER } from "../src/ai/mock/provider.ts";

const STORE = join(import.meta.dirname, "..", "dist", "chrome");
const E2E = join(import.meta.dirname, "..", "dist", "chrome-e2e");

/** Every file under `dir`, relative to it. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1));
}

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await files(dir)) {
    if ((await readFile(join(dir, f))).includes(needle)) out.push(f);
  }
  return out;
}

test("no file in the Store build contains the mock provider", async () => {
  expect(await files(STORE)).toContain("background.js");
  expect(await filesContaining(STORE, MOCK_MARKER)).toEqual([]);
});

test("the e2e build does contain it, so the check above can't pass for want of a marker", async () => {
  expect((await filesContaining(E2E, MOCK_MARKER)).length).toBeGreaterThan(0);
});

test("the Store build has no benchmark page", async () => {
  expect((await files(STORE)).filter((f) => f.endsWith("bench.html"))).toEqual([]);
});

test("the Store build's manifest asks for exactly storage, scripting and all URLs", async () => {
  const manifest = JSON.parse(await readFile(join(STORE, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.minimum_chrome_version).toBe("138");
  expect(manifest.permissions).toEqual(["storage", "scripting"]);
  expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  expect(manifest).not.toHaveProperty("optional_permissions");
  expect(manifest).not.toHaveProperty("optional_host_permissions");
});

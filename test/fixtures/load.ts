import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BannerFixture } from "../../src/core/fixture.ts";
import { validateFixture } from "./schema.ts";

const BANNERS_DIR = join(dirname(fileURLToPath(import.meta.url)), "banners");

/** Every fixture in `banners/`, sorted by file name. Throws if any breaks the schema. */
export function loadFixtures(): BannerFixture[] {
  const fixtures = readdirSync(BANNERS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(BANNERS_DIR, name), "utf8")) as BannerFixture);
  const errors = fixtures.flatMap(validateFixture);
  if (errors.length > 0) throw new Error(`invalid fixtures:\n${errors.join("\n")}`);
  return fixtures;
}

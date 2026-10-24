import { createProvider } from "../../ai/compose.ts";
import type { BannerFixture } from "../../core/fixture.ts";
import { renderBench } from "./render.ts";

// The fixtures are bundled into the page (it can't read files), in file-name order like the
// tests' `loadFixtures`.
const files = import.meta.glob<BannerFixture>("../../../test/fixtures/banners/*.json", {
  eager: true,
  import: "default",
});
const fixtures = Object.keys(files)
  .sort()
  .map((path) => files[path] as BannerFixture);

const root = document.getElementById("app");
if (!root) throw new Error("benchmark page has no #app");
await renderBench(root, { provider: createProvider(), fixtures });

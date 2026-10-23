import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findCoreViolations } from "../../scripts/check-core-imports.ts";

test("core imports no provider or platform code", async () => {
  expect(await findCoreViolations("src/core")).toEqual([]);
});

test("flags chrome, ai, platform and LanguageModel references, allows core-local imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "bouncer-core-"));
  try {
    const core = join(root, "src", "core");
    await mkdir(core, { recursive: true });
    await mkdir(join(root, "src", "ai"), { recursive: true });
    await mkdir(join(root, "src", "platform"), { recursive: true });
    await writeFile(join(core, "platform.ts"), "export const p = 1;\n");
    await writeFile(join(core, "ok.ts"), 'import { p } from "./platform";\nexport const q = p;\n');
    await writeFile(join(core, "a.ts"), 'import { x } from "../ai/provider";\nexport { x };\n');
    await writeFile(
      join(core, "b.ts"),
      'import { y } from "../platform/storage.ts";\nexport { y };\n',
    );
    await writeFile(join(core, "c.ts"), 'import chrome from "chrome";\nexport { chrome };\n');
    await writeFile(join(core, "d.ts"), "export const m = LanguageModel;\n");
    await writeFile(join(core, "e.ts"), "export const s = chrome.storage;\n");
    const v = await findCoreViolations(core);
    expect(v).toHaveLength(5);
    expect(v.some((s) => s.includes("a.ts") && s.includes("../ai/provider"))).toBe(true);
    expect(v.some((s) => s.includes("b.ts") && s.includes("../platform/storage.ts"))).toBe(true);
    expect(v.some((s) => s.includes("c.ts") && s.includes("chrome"))).toBe(true);
    expect(v.some((s) => s.includes("d.ts") && s.includes("LanguageModel"))).toBe(true);
    expect(v.some((s) => s.includes("e.ts") && s.includes("chrome."))).toBe(true);
    expect(v.some((s) => s.includes("ok.ts"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Ports spike/prompt-variants/fixtures/*.json into test/fixtures/banners/.
//
// Idempotent. The mechanical fields (id, kind, stage, gate, banner) are rewritten from the
// spike every run. Hand-filled data (expectedLabels, expectedDecision, and the note, which
// carries the reasoning) is read back from the existing output file and kept. Hand-written
// fixtures in the output directory are never touched: only ids listed in the spike's
// index.json are written.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BannerFixture } from "../src/core/fixture.ts";
import type { Control, Role } from "../src/core/types.ts";

interface SpikeControl {
  i: number;
  role: string;
  label: string;
  id?: string;
  on?: boolean;
  disabled?: boolean;
}

interface SpikeFixture {
  id: string;
  kind: "positive" | "negative";
  stage: 1 | 2;
  note: string;
  gate: { expected: "consent" | "other" };
  banner: { text: string; controls: SpikeControl[] };
}

/** `select` and `tab` have no Role of their own; `alert` is a button that carries role="alert". */
function toRole(role: string): Role {
  if (role === "button" || role === "link" || role === "toggle") return role;
  if (role === "alert") return "button";
  return "other";
}

function toControl(c: SpikeControl): Control {
  const out: Control = { id: c.i, role: toRole(c.role), text: c.label };
  if (c.on !== undefined) out.on = c.on;
  if (c.disabled !== undefined) out.disabled = c.disabled;
  if (c.id !== undefined) out.domId = c.id;
  return out;
}

async function readExisting(path: string): Promise<Partial<BannerFixture>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Partial<BannerFixture>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function portFixtures(opts: { srcDir: string; outDir: string }): Promise<string[]> {
  const index = JSON.parse(await readFile(join(opts.srcDir, "index.json"), "utf8")) as string[];
  await mkdir(opts.outDir, { recursive: true });
  const written: string[] = [];
  for (const id of index) {
    const spike = JSON.parse(
      await readFile(join(opts.srcDir, `${id}.json`), "utf8"),
    ) as SpikeFixture;
    const path = join(opts.outDir, `${id}.json`);
    const kept = await readExisting(path);
    const fixture: BannerFixture = {
      id: spike.id,
      kind: spike.kind,
      stage: spike.stage,
      note: kept.note ?? spike.note,
      gate: spike.gate.expected,
      banner: { text: spike.banner.text, controls: spike.banner.controls.map(toControl) },
    };
    if (kept.expectedLabels) fixture.expectedLabels = kept.expectedLabels;
    if (kept.expectedDecision) fixture.expectedDecision = kept.expectedDecision;
    await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`);
    written.push(path);
  }
  return written;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const written = await portFixtures({
    srcDir: "spike/prompt-variants/fixtures",
    outDir: "test/fixtures/banners",
  });
  console.log(`ported ${written.length} fixtures`);
}

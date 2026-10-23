import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { build } from "vite";
import { buildManifest } from "../manifest/chrome.ts";

const MODES = {
  production: { outDir: "dist/chrome", provider: "chrome" },
  development: { outDir: "dist/chrome-dev", provider: "chrome" },
  e2e: { outDir: "dist/chrome-e2e", provider: "mock" },
} as const;

type Mode = keyof typeof MODES;

const { values } = parseArgs({ options: { mode: { type: "string", default: "production" } } });
const mode = values.mode as Mode;
if (!(mode in MODES)) throw new Error(`unknown build mode: ${values.mode}`);
const { outDir, provider } = MODES[mode];

process.env.BOUNCER_OUT_DIR = outDir;
process.env.VITE_AI_PROVIDER = provider;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({ configFile: "vite.config.ts", mode, logLevel: "warn" });
await build({ configFile: "vite.content.config.ts", mode, logLevel: "warn" });

// autoconsent's files ship unmodified (MPL-2.0), with its LICENSE beside them.
const acRoot = "node_modules/@duckduckgo/autoconsent";
const vendorDir = join(outDir, "vendor", "autoconsent");
await mkdir(vendorDir, { recursive: true });
await cp(join(acRoot, "dist/addon-mv3/content.bundle.js"), join(vendorDir, "content.bundle.js"));
await cp(join(acRoot, "dist/addon-mv3/compact-rules.json"), join(vendorDir, "compact-rules.json"));
await cp(join(acRoot, "LICENSE"), join(vendorDir, "LICENSE"));

const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
await writeFile(
  join(outDir, "manifest.json"),
  `${JSON.stringify(buildManifest("chrome", { version }), null, 2)}\n`,
);
console.log(`built ${mode} -> ${outDir}`);

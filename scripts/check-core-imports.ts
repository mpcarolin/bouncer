// The core never touches chrome.*, LanguageModel, or anything under src/ai/ or src/platform/.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;
const FORBIDDEN_DIRS = [`${sep}src${sep}ai`, `${sep}src${sep}platform`];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function isForbiddenPath(path: string): boolean {
  return FORBIDDEN_DIRS.some((d) => path.endsWith(d) || path.includes(`${d}${sep}`));
}

function specifierViolation(file: string, specifier: string): boolean {
  if (specifier === "chrome" || specifier.startsWith("chrome/")) return true;
  if (specifier.startsWith(".")) return isForbiddenPath(resolve(dirname(file), specifier));
  return /(^|\/)src\/(ai|platform)(\/|$)/.test(specifier);
}

async function listSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return listSources(path);
      return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

/** Returns human-readable `file: reason` strings, one per violation. */
export async function findCoreViolations(dir: string): Promise<string[]> {
  const violations: string[] = [];
  for (const file of (await listSources(resolve(dir))).sort()) {
    const code = stripComments(await readFile(file, "utf8"));
    for (const match of code.matchAll(IMPORT_RE)) {
      const specifier = match[2] as string;
      if (specifierViolation(file, specifier)) violations.push(`${file}: ${specifier}`);
    }
    if (/\bLanguageModel\b/.test(code)) violations.push(`${file}: LanguageModel`);
    if (/(^|[^\w$.])chrome\s*\./.test(code)) violations.push(`${file}: chrome.`);
  }
  return violations;
}

if (import.meta.main) {
  const violations = await findCoreViolations("src/core");
  if (violations.length > 0) {
    console.error("core must not import providers, platform code or chrome:");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
}

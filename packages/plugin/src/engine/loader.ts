import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FilterDef } from "./schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILTERS_DIR = process.env.TOKMIZER_FILTERS_DIR || join(HERE, "..", "..", "filters");

export type LoadedFilter = FilterDef & { matchRegex: RegExp };

let cache: Map<string, LoadedFilter> | null = null;
let warnedAboutMissing = false;

function devMode(): boolean {
  return process.env.TOKMIZER_RELEASE_BUILD !== "1" && (process.env.TOKMIZER_DEV === "1" || process.env.TOKMIZER_DEV === "true");
}

export async function loadFilters(): Promise<Map<string, LoadedFilter>> {
  if (cache) return cache;
  if (!devMode()) {
    if (!warnedAboutMissing && process.env.TOKMIZER_DEBUG === "1") {
      process.stderr.write(
        "tokmizer: disk loader disabled (set TOKMIZER_DEV=1 to re-enable for local dev).\n"
      );
      warnedAboutMissing = true;
    }
    cache = new Map();
    return cache;
  }
  cache = await readFilterDir(FILTERS_DIR);
  return cache;
}

export async function readFilterDir(dir: string): Promise<Map<string, LoadedFilter>> {
  const map = new Map<string, LoadedFilter>();
  let parseToml: (s: string) => unknown;
  let files: string[];
  try {
    parseToml = (await import("smol-toml")).parse;
    files = (await readdir(dir)).filter((f) => f.endsWith(".toml"));
  } catch {
    return map;
  }
  for (const f of files) {
    const raw = await readFile(join(dir, f), "utf8");
    const parsed = parseToml(raw);
    const filtersSection = (parsed as { filters?: Record<string, unknown> }).filters;
    if (!filtersSection) continue;
    for (const [slug, body] of Object.entries(filtersSection)) {
      const def = FilterDef.parse({ slug, ...(body as object) });
      map.set(slug, { ...def, matchRegex: new RegExp(def.match_command) });
    }
  }
  return map;
}

export function __resetCache(): void {
  cache = null;
  warnedAboutMissing = false;
}

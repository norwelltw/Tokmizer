import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptBundle } from "./bundle-crypto";
import { readFilterDir } from "./engine/loader";
import { DEFAULT_RULES_SECRET } from "./default-rules";
import type { FilterDef } from "./engine/schema";

export const FILTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "filters");

export async function defaultRulesFilters(filtersDir: string = FILTERS_DIR): Promise<FilterDef[]> {
  const onDisk = await readFilterDir(filtersDir);
  const out: FilterDef[] = [];
  for (const loaded of onDisk.values()) {
    const { matchRegex: _regex, description: _description, ...def } = loaded;
    out.push(def);
  }
  return out;
}

export async function buildDefaultRules(filtersDir: string = FILTERS_DIR): Promise<string> {
  const filters = await defaultRulesFilters(filtersDir);
  if (filters.length === 0) throw new Error(`no default rules found in ${filtersDir}`);
  const bundleVersion = createHash("sha256").update(JSON.stringify(filters)).digest().readUInt32BE(0);
  const plaintext = JSON.stringify({ bundleVersion, signedAt: Date.now(), filters });
  return encryptBundle(plaintext, DEFAULT_RULES_SECRET);
}

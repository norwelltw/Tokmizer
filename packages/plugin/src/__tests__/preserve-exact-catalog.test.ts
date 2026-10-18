import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const EXACT_SLUGS = ["read-tool", "psql", "mysql", "sqlite3", "stripe"];
const CODE_FRAME_LINTERS = ["oxlint", "biome", "basedpyright", "ty"];

function loadCatalog(): Map<string, Record<string, unknown>> {
  const dir = fileURLToPath(new URL("../../filters", import.meta.url));
  const map = new Map<string, Record<string, unknown>>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".toml"))) {
    const parsed = parseToml(readFileSync(`${dir}/${f}`, "utf8")) as {
      filters?: Record<string, Record<string, unknown>>;
    };
    for (const [slug, body] of Object.entries(parsed.filters ?? {})) map.set(slug, body);
  }
  return map;
}

describe("preserve_exact catalog conformance", () => {
  it("marks every exactness-contract filter with preserve_exact", () => {
    const catalog = loadCatalog();
    for (const slug of EXACT_SLUGS) {
      expect(catalog.get(slug), slug).toBeDefined();
      expect(catalog.get(slug)!.preserve_exact, slug).toBe(true);
    }
  });

  it("keeps the nominal line cap at every verbosity for capped exactness filters", () => {
    const catalog = loadCatalog();
    for (const slug of EXACT_SLUGS) {
      const body = catalog.get(slug)!;
      if (body.max_lines === undefined) continue;
      expect(body.scale_with_level, slug).toBe(false);
    }
  });

  it("protects code-frame linter findings from verbosity transforms", () => {
    const catalog = loadCatalog();
    for (const slug of CODE_FRAME_LINTERS) {
      expect(catalog.get(slug), slug).toBeDefined();
      expect(catalog.get(slug)!.preserve_exact, slug).toBe(true);
    }
  });
});

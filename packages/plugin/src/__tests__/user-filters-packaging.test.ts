import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
const bundleConfig = readFileSync(join(pluginRoot, "scripts", "bundle.mjs"), "utf8");
const BARE_TOML_IMPORT = /(?:from\s*|import\(\s*)["']smol-toml["']/;

function bundleExternals(): string[] {
  const list = bundleConfig.match(/external:\s*\[([^\]]*)\]/)?.[1] ?? "";
  return [...list.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
}

function shippedScripts(): string[] {
  return ["bin", "hooks-host"].flatMap((sub) => {
    const dir = join(pluginRoot, "dist", sub);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => join(dir, f)) : [];
  });
}

describe("user filters packaging", () => {
  it("never leaves a module external to the bundle unless the published package depends on it", () => {
    const runtimeDeps = new Set(Object.keys(pkg.dependencies ?? {}));
    expect(bundleExternals().filter((name) => !runtimeDeps.has(name))).toEqual([]);
  });

  it.skipIf(shippedScripts().length === 0)("ships the TOML parser inside every published entrypoint", () => {
    const leaking = shippedScripts().filter((file) => BARE_TOML_IMPORT.test(readFileSync(file, "utf8")));
    expect(leaking).toEqual([]);
  });
});

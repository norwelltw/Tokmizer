import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: pkgDir,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024
});

const start = out.indexOf("[");
if (start < 0) {
  console.error("check-pack-clean: could not parse npm pack output");
  process.exit(1);
}
const data = JSON.parse(out.slice(start));
const files = data[0].files.map((f) => f.path);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const oversized = data[0].files.filter((f) => f.size > MAX_FILE_BYTES || f.path === "dist/bin/tkr" || f.path === "dist/bin/tkr.exe");
if (oversized.length > 0) {
  console.error("check-pack-clean: standalone executables ship in the platform packages, not in the main tarball:");
  for (const f of oversized) console.error(`  ${f.path} (${f.size} bytes)`);
  process.exit(1);
}

const forbidden = files.filter(
  (p) =>
    p.endsWith(".toml") ||
    p.endsWith(".map") ||
    p.startsWith("src/") ||
    p.startsWith("filters/") ||
    p.includes("__tests__") ||
    p.startsWith("commands/") ||
    p === "command-templates/power.md"
);

if (forbidden.length > 0) {
  console.error("check-pack-clean: tarball contains forbidden files:");
  for (const p of forbidden) console.error(`  ${p}`);
  process.exit(1);
}

const codexManifest = JSON.parse(readFileSync(join(pkgDir, ".codex-plugin", "plugin.json"), "utf8"));
const codexHooksPath = typeof codexManifest.hooks === "string" ? codexManifest.hooks.replace(/^\.\//, "") : null;
const codexHooks = codexHooksPath && files.includes(codexHooksPath) ? JSON.parse(readFileSync(join(pkgDir, codexHooksPath), "utf8")).hooks ?? {} : {};
const codexCommands = Object.values(codexHooks).flat().flatMap((group) => group.hooks ?? []).map((hook) => String(hook.command ?? ""));
if (!files.includes(".codex-plugin/plugin.json") || !codexCommands.length || codexCommands.some((c) => !c.includes("tkr-codex-hook"))) {
  console.error("check-pack-clean: the Codex manifest must ship in .codex-plugin/ and declare its own hooks file, holding only tkr-codex-hook commands (otherwise Codex loads the Claude hooks/hooks.json)");
  process.exit(1);
}

if (!files.some((p) => p.startsWith("dist/"))) {
  console.error("check-pack-clean: tarball missing dist/ output");
  process.exit(1);
}

console.log(`pack clean: ${files.length} files, no .toml/.map/src/filters/__tests__/power.md`);

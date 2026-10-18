import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLUGIN_VERSION } from "../dist/index.js";

const req = createRequire(import.meta.url);
const pkg = req("../package.json");

if (PLUGIN_VERSION !== pkg.version) {
  console.error(`version mismatch: dist reports ${PLUGIN_VERSION}, package.json is ${pkg.version}`);
  process.exit(1);
}

const claudeManifest = req("../.claude-plugin/plugin.json");
const codexManifest = req("../.codex-plugin/plugin.json");
for (const [name, manifest] of [[".claude-plugin", claudeManifest], [".codex-plugin", codexManifest]]) {
  if (manifest.version !== pkg.version) {
    console.error(`version mismatch: ${name} manifest is ${manifest.version}, package.json is ${pkg.version}`);
    process.exit(1);
  }
}

const siteMarketplace = req("../../../app/public/plugin/marketplace.json");
const siteVersions = [siteMarketplace.metadata?.version, siteMarketplace.plugins?.[0]?.version];
for (const v of siteVersions) {
  if (v !== pkg.version) {
    console.error(`version mismatch: app/public/plugin/marketplace.json is ${v}, package.json is ${pkg.version}`);
    process.exit(1);
  }
}
const formulaPath = fileURLToPath(new URL("../homebrew/tokmizer.rb", import.meta.url));
const formula = readFileSync(formulaPath, "utf8");
const formulaMatch = formula.match(/plugin-(\d+\.\d+\.\d+[^/]*)\.tgz/);
if (formulaMatch?.[1] !== pkg.version) {
  console.error(`version mismatch: homebrew/tokmizer.rb is ${formulaMatch?.[1]}, package.json is ${pkg.version}`);
  process.exit(1);
}

console.log(`version ok: ${PLUGIN_VERSION} (package.json, .claude-plugin, .codex-plugin, site marketplace, homebrew formula in sync)`);
console.log(`reminder: app/public/plugin/marketplace.json is NOT the authoritative catalog clients read; bump metadata.version + plugins[0].version in norwelltw/Tokmizer/.claude-plugin/marketplace.json and push to GitHub`);

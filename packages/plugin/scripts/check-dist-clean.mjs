import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateMarkers, scanFiles, selfTest, walkFiles } from "./secret-scan.mjs";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkgRoot, "dist");

if (existsSync(join(pkgRoot, "commands"))) {
  console.error("commands/ must not exist: it would register namespaced tokmizer: duplicates, ship command-templates/ instead");
  process.exit(1);
}

if (existsSync(join(pkgRoot, "command-templates", "power.md"))) {
  console.error("command-templates/power.md must not exist: the /power command is served remotely");
  process.exit(1);
}

if (!selfTest()) {
  console.error("check-dist-clean SELF-TEST FAILED: the secret scanner no longer catches a planted secret");
  process.exit(1);
}

if (!existsSync(root)) {
  console.error(`check-dist-clean: dist not found at ${root} (build first)`);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const shippedEntries = Array.isArray(pkg.files) ? pkg.files : [];
if (shippedEntries.length === 0) {
  console.error("check-dist-clean SELF-TEST FAILED: package.json has no files allowlist to derive the scan from");
  process.exit(1);
}

const files = [];
for (const rel of shippedEntries) {
  const p = join(pkgRoot, rel);
  if (!existsSync(p)) continue;
  files.push(...(statSync(p).isDirectory() ? walkFiles(p) : [p]));
}

const artifacts = join(pkgRoot, "native", "artifacts");
const singleOutputs = [join(artifacts, "single", "tkr-main.mjs")];
if (existsSync(artifacts)) {
  for (const key of readdirSync(artifacts)) singleOutputs.push(join(artifacts, key, "tkr"), join(artifacts, key, "tkr.exe"));
}
for (const file of singleOutputs) {
  if (existsSync(file) && !files.includes(file)) files.push(file);
}

const leaks = scanFiles(files, privateMarkers());
if (leaks.length) {
  console.error(`shipped files contain secrets or private references:\n${leaks.join("\n")}`);
  process.exit(1);
}
console.log(`dist clean: ${files.length} shipped files, no secrets or private references`);

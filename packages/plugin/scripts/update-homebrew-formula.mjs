import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const version = pkg.version;
const url = `https://registry.npmjs.org/@tokmizer/plugin/-/plugin-${version}.tgz`;

const res = await fetch(url);
if (!res.ok) {
  process.stderr.write(`tarball not on npm yet: ${url} (${res.status})\n`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const sha = createHash("sha256").update(buf).digest("hex");

const formulaPath = join(here, "..", "homebrew", "tokmizer.rb");
let formula = readFileSync(formulaPath, "utf8");
formula = formula.replace(/url ".*"/, `url "${url}"`);
formula = formula.replace(/sha256 ".*"/, `sha256 "${sha}"`);
writeFileSync(formulaPath, formula);

process.stdout.write(`homebrew/tokmizer.rb -> ${version} (${sha})\n`);
process.stdout.write("push it to norwelltw/homebrew-tokmizer (Formula/tokmizer.rb)\n");

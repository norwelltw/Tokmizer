import { createHash } from "node:crypto";
import { build } from "esbuild";
import { bundleDefines, singleBanner, sourceFingerprint } from "./bundle-config.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePlatforms, singleFile, singlePackage, syncSingleIntoDist, SINGLE_BUN_VERSION } from "./native-artifacts.mjs";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bun = process.env.TOKMIZER_BUN || "bun";
const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
const entry = join(directory, "native", "artifacts", "single", "tkr-main.mjs");
const hostKey = `${process.platform}-${process.arch}`;
const keys = (process.env.TOKMIZER_SINGLE_TARGETS || hostKey).split(",").map((key) => key.trim()).filter(Boolean);
const targets = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64-baseline",
  "win32-arm64": "bun-windows-arm64",
  "win32-x64": "bun-windows-x64-baseline"
};

const bunVersion = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim();
if (bunVersion !== SINGLE_BUN_VERSION) throw new Error(`Bun ${SINGLE_BUN_VERSION} is required, found ${bunVersion}`);
for (const key of keys) if (!nativePlatforms.includes(key)) throw new Error(`Unsupported single-binary target: ${key}`);

const source = sourceFingerprint(directory);
await build({
  entryPoints: [join(directory, "src", "bin", "tkr-main.ts")],
  outfile: entry,
  bundle: true,
  minify: true,
  define: { ...(await bundleDefines(directory)), "process.env.TOKMIZER_SINGLE_BINARY": '"1"', "import.meta.url": "__tkrSelfUrl" },
  platform: "node",
  format: "esm",
  target: "es2022",
  banner: { js: singleBanner },
  logLevel: "warning"
});

for (const key of keys) {
  const [platform, arch] = key.split("-");
  const output = join(directory, "native", "artifacts", key);
  const binary = join(output, singleFile(platform));
  mkdirSync(output, { recursive: true });
  rmSync(binary, { force: true });
  execFileSync(bun, ["build", "--compile", "--minify", "--bytecode", `--target=${targets[key]}`, entry, "--outfile", binary], { stdio: ["ignore", "ignore", "inherit"], cwd: directory });
  if (key === hostKey) {
    const probe = execFileSync(binary, ["--single-check"], { encoding: "utf8", timeout: 5000 }).trim();
    if (probe !== `tokmizer-single ${version}`) throw new Error(`Single binary probe failed: ${probe}`);
  }
  const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  writeFileSync(join(output, "single.json"), JSON.stringify({ version, platform, arch, bun: bunVersion, package: singlePackage(key), source, sha256 }, null, 2) + "\n");
  console.log(`single binary: ${key} ${version}${key === hostKey ? "" : " (cross-built, probed at install)"}`);
}
syncSingleIntoDist(directory);

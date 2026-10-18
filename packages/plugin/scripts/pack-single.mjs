import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeExtension, nativePlatforms, singleFile, singlePackage } from "./native-artifacts.mjs";

export const LICENSE_FILES = ["LICENSE", "LICENSE-ENGINE", "LICENSES.md", "NOTICE", "THIRD-PARTY-NOTICES.md"];
export const LICENSE_EXPRESSION = "Apache-2.0 AND BUSL-1.1";
const formulaKeys = { "darwin-arm64": ["on_macos", "on_arm"], "darwin-x64": ["on_macos", "on_intel"], "linux-arm64": ["on_linux", "on_arm"], "linux-x64": ["on_linux", "on_intel"] };

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verified(path, expected, label) {
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expected) throw new Error(`Corrupt artifact: ${label}`);
  return bytes;
}

function writeExecutable(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o755 });
  chmodSync(path, 0o755);
}

export function platformPackageJson(key, version) {
  const [platform, arch] = key.split("-");
  return {
    name: singlePackage(key),
    version,
    description: `Tokmizer standalone executable for ${key}`,
    license: LICENSE_EXPRESSION,
    repository: { type: "git", url: "https://github.com/norwelltw/Tokmizer" },
    homepage: "https://tokmizer.com",
    os: [platform],
    cpu: [arch],
    ...(platform === "linux" ? { libc: ["glibc"] } : {}),
    files: [singleFile(platform), ...LICENSE_FILES],
    preferUnplugged: true
  };
}

export function homebrewFormula(version, base, archives) {
  const blocks = [];
  for (const os of ["on_macos", "on_linux"]) {
    const inner = Object.entries(formulaKeys)
      .filter(([key, [group]]) => group === os && archives[key])
      .map(([key, [, cpu]]) => `    ${cpu} do\n      url "${base}/${archives[key].name}"\n      sha256 "${archives[key].sha256}"\n    end`);
    if (inner.length) blocks.push(`  ${os} do\n${inner.join("\n")}\n  end`);
  }
  return [
    "class Tokmizer < Formula",
    '  desc "Cuts the tokens your AI coding agent burns on command output"',
    '  homepage "https://tokmizer.com"',
    `  version "${version}"`,
    '  license all_of: ["Apache-2.0", "BUSL-1.1"]',
    "",
    blocks.join("\n"),
    "",
    "  def install",
    '    libexec.install Dir["*"]',
    '    bin.install_symlink libexec/"dist/bin/tkr", libexec/"dist/bin/tkr-exec"',
    "  end",
    "",
    "  test do",
    '    assert_match "tokmizer-single #{version}", shell_output("#{bin}/tkr --single-check")',
    '    assert_match "Usage: tkr", shell_output("#{bin}/tkr help")',
    "  end",
    "end",
    ""
  ].join("\n");
}

export function packSingle(directory, keys, base) {
  const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
  const release = join(directory, "native", "release");
  rmSync(release, { recursive: true, force: true });
  const licenses = LICENSE_FILES.map((name) => [name, readFileSync(join(directory, name))]);
  const archives = {};
  for (const key of keys) {
    const [platform, arch] = key.split("-");
    const artifacts = join(directory, "native", "artifacts", key);
    const single = JSON.parse(readFileSync(join(artifacts, "single.json"), "utf8"));
    const native = JSON.parse(readFileSync(join(artifacts, "manifest.json"), "utf8"));
    if (single.version !== version || single.platform !== platform || single.arch !== arch) throw new Error(`Invalid single binary artifact: ${key}`);
    if (native.version !== version || native.platform !== platform || native.arch !== arch) throw new Error(`Invalid native artifact: ${key}`);
    const binary = verified(join(artifacts, singleFile(platform)), single.sha256, `${key} ${singleFile(platform)}`);
    const launcher = verified(join(artifacts, `tkr-exec-native${nativeExtension(platform)}`), native.sha256, `${key} launcher`);

    const npm = join(release, "npm", key);
    writeExecutable(join(npm, singleFile(platform)), binary);
    for (const [name, bytes] of licenses) writeFileSync(join(npm, name), bytes);
    writeFileSync(join(npm, "package.json"), JSON.stringify(platformPackageJson(key, version), null, 2) + "\n");

    const name = `tokmizer-${version}-${key}`;
    const stage = join(release, "stage", name);
    writeExecutable(join(stage, "dist", "bin", singleFile(platform)), binary);
    writeExecutable(join(stage, "dist", "bin", `tkr-exec${nativeExtension(platform)}`), launcher);
    cpSync(join(directory, "agent-plugins"), join(stage, "agent-plugins"), { recursive: true });
    for (const [name, bytes] of licenses) writeFileSync(join(stage, name), bytes);
    writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "@tokmizer/standalone", version, private: true, license: LICENSE_EXPRESSION }, null, 2) + "\n");
    const archive = join(release, `${name}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", join(release, "stage"), name], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
    archives[key] = { name: `${name}.tar.gz`, sha256: sha256(readFileSync(archive)) };
  }
  rmSync(join(release, "stage"), { recursive: true, force: true });
  writeFileSync(join(release, "SHA256SUMS"), Object.values(archives).map(({ name, sha256: sum }) => `${sum}  ${name}\n`).join(""));
  if (Object.keys(formulaKeys).every((key) => archives[key])) writeFileSync(join(release, "tokmizer.rb"), homebrewFormula(version, base, archives));
  return archives;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
  const keys = process.env.TOKMIZER_SINGLE_TARGETS
    ? process.env.TOKMIZER_SINGLE_TARGETS.split(",").map((key) => key.trim()).filter(Boolean)
    : nativePlatforms.filter((key) => existsSync(join(directory, "native", "artifacts", key, "single.json")));
  for (const key of keys) if (!nativePlatforms.includes(key)) throw new Error(`Unsupported target: ${key}`);
  const base = process.env.TOKMIZER_RELEASE_BASE || `https://github.com/norwelltw/Tokmizer/releases/download/v${version}`;
  const archives = packSingle(directory, keys, base);
  for (const [key, { name, sha256: sum }] of Object.entries(archives)) console.log(`${key}: ${name} ${sum}`);
}

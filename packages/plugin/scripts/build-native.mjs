import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const triples = { "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc" };
const hostKey = `${process.platform}-${process.arch}`;
const key = process.env.TOKMIZER_NATIVE_PLATFORM || hostKey;
const [platform, arch] = key.split("-");
if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) throw new Error("Native artifacts are not supported on this platform");
const cross = key !== hostKey;
if (cross && !(process.platform === "win32" && triples[key])) throw new Error("Cross-built native artifacts are only supported between Windows targets");
const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
const cargo = readFileSync(join(directory, "native", "Cargo.toml"), "utf8");
if (!cargo.includes(`version = "${version}"`)) throw new Error("Native and plugin versions must match");
const target = resolve(process.env.CARGO_TARGET_DIR || join(directory, "native", "target"));
const triple = triples[key];
const remap = [`--remap-path-prefix=${homedir()}=~`, `--remap-path-prefix=${resolve(directory, "..", "..")}=.`].join(" ");
const rustflags = [process.env.RUSTFLAGS, remap].filter(Boolean).join(" ");
execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(directory, "native", "Cargo.toml"), "--target-dir", target, ...(triple ? ["--target", triple] : [])], { stdio: "inherit", cwd: join(directory, "native"), env: { ...process.env, RUSTFLAGS: rustflags } });
const extension = platform === "win32" ? ".exe" : "";
const binary = join(target, ...(triple ? [triple] : []), "release", `tkr-exec-native${extension}`);
if (!cross) {
  const probe = execFileSync(binary, ["--native-check"], { encoding: "utf8", timeout: 2000 });
  if (probe.trim() !== `tokmizer-native ${version} protocol=2`) throw new Error("Native artifact probe failed");
}
const output = join(directory, "native", "artifacts", key);
mkdirSync(output, { recursive: true });
copyFileSync(binary, join(output, `tkr-exec-native${extension}`));
writeFileSync(join(output, "manifest.json"), JSON.stringify({ version, platform, arch, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") }, null, 2) + "\n");
console.log(`native artifact: ${key} ${version}${cross ? " (cross-built, probed at install)" : ""}`);

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFingerprint } from "./bundle-config.mjs";

export const nativePlatforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];

export const SINGLE_BUN_VERSION = "1.4.2";

export function nativeExtension(platform) {
  return platform === "win32" ? ".exe" : "";
}

export function singleFile(platform) {
  return `tkr${nativeExtension(platform)}`;
}

export function singlePackage(key) {
  return `@tokmizer/plugin-${key}`;
}

export function verifyNativeArtifacts(directory) {
  const destination = join(directory, "dist", "native");
  const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8"));
  const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
  for (const key of nativePlatforms) {
    const entry = manifest[key];
    if (!entry || entry.version !== version || entry.file !== `tkr-exec-${key}${nativeExtension(key.split("-")[0])}` || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`Missing or invalid release artifact: ${key}`);
    const bytes = readFileSync(join(destination, entry.file));
    if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Corrupt release artifact: ${key}`);
  }
}

export function copyNativeArtifacts(directory) {
  const destination = join(directory, "dist", "native");
  const manifest = {};
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const arch of ["arm64", "x64"]) {
      const key = `${platform}-${arch}`;
      const source = join(directory, "native", "artifacts", key);
      if (!existsSync(join(source, "manifest.json"))) continue;
      const entry = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
      const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
      const extension = nativeExtension(platform);
      const bytes = readFileSync(join(source, `tkr-exec-native${extension}`));
      if (entry.version !== version || entry.platform !== platform || entry.arch !== arch ||
        entry.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error(`Invalid native artifact: ${key}`);
      mkdirSync(destination, { recursive: true });
      const file = `tkr-exec-${key}${extension}`;
      writeFileSync(join(destination, file), bytes, { mode: 0o755 });
      chmodSync(join(destination, file), 0o755);
      manifest[key] = { version, file, sha256: entry.sha256 };
    }
  }
  if (Object.keys(manifest).length) writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function copySingleArtifacts(directory) {
  const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
  const manifest = {};
  const fingerprint = sourceFingerprint(directory);
  for (const key of nativePlatforms) {
    const [platform, arch] = key.split("-");
    const source = join(directory, "native", "artifacts", key);
    if (!existsSync(join(source, "single.json"))) continue;
    if (JSON.parse(readFileSync(join(source, "single.json"), "utf8")).source !== fingerprint) {
      console.warn(`single binary ${key} is stale: run npm run build:single`);
      continue;
    }
    const entry = JSON.parse(readFileSync(join(source, "single.json"), "utf8"));
    const file = singleFile(platform);
    if (entry.version !== version || entry.platform !== platform || entry.arch !== arch || entry.package !== singlePackage(key) ||
      entry.sha256 !== sha256File(join(source, file))) throw new Error(`Invalid single binary artifact: ${key}`);
    manifest[key] = { version, package: entry.package, file, sha256: entry.sha256 };
  }
  const destination = join(directory, "dist", "native");
  if (!Object.keys(manifest).length) return;
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "single.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export function syncSingleIntoDist(directory) {
  if (existsSync(join(directory, "dist", "bin"))) copySingleArtifacts(directory);
}

export function verifySingleArtifacts(directory) {
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const manifestPath = join(directory, "dist", "native", "single.json");
  if (!existsSync(manifestPath)) throw new Error("dist/native/single.json is missing: run npm run build:single, then npm run build, before publishing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const key of nativePlatforms) {
    const [platform] = key.split("-");
    const entry = manifest[key];
    if (!entry || entry.version !== pkg.version || entry.package !== singlePackage(key) || entry.file !== singleFile(platform) ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`Missing or invalid single binary artifact: ${key}`);
    if (pkg.optionalDependencies?.[entry.package] !== pkg.version) throw new Error(`optionalDependencies must pin ${entry.package}@${pkg.version}`);
    if (sha256File(join(directory, "native", "artifacts", key, entry.file)) !== entry.sha256) throw new Error(`Corrupt single binary artifact: ${key}`);
  }
}

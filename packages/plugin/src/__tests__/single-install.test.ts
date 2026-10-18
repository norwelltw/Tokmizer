import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNative, installSingle, singleInstalled } from "../../scripts/install-native.mjs";
import { copySingleArtifacts, nativePlatforms, syncSingleIntoDist, verifySingleArtifacts } from "../../scripts/native-artifacts.mjs";
import { homebrewFormula, LICENSE_FILES, platformPackageJson } from "../../scripts/pack-single.mjs";
import { sourceFingerprint } from "../../scripts/bundle-config.mjs";

let directory: string;
const R = "${CLAUDE_PLUGIN_ROOT}";
const executable = "#!/bin/sh\nprintf 'tokmizer-single 0.9.52\\n'\n";
const node = {
  session: `node "${R}/hooks/on-session-start.mjs"`,
  reducerStart: `node "${R}/dist/hooks-host/reducer-session-start.js"`,
  recap: `node "${R}/dist/hooks-host/session-recap.js"`,
  prompt: `node "${R}/dist/hooks-host/reducer-prompt-submit.js"`,
  stop: `node "${R}/dist/hooks-host/reducer-stop.js"`,
  pre: `node "${R}/dist/hooks-host/pre-tool-use.js"`,
  post: `node "${R}/dist/hooks-host/post-tool-use.js"`
};

function hooksFile() {
  return join(directory, "hooks", "hooks.json");
}

function commands() {
  const hooks = JSON.parse(readFileSync(hooksFile(), "utf8")).hooks;
  return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, (groups as { hooks: { command: string; args?: string[] }[] }[]).flatMap((group) => group.hooks.map((hook) => (hook.args ? [hook.command, ...hook.args].join(" ") : hook.command)))]));
}

function platformPackage(key: string, body = executable, manifestBody = body) {
  const [platform] = key.split("-");
  const file = platform === "win32" ? "tkr.exe" : "tkr";
  const folder = join(directory, "node_modules", "@tokmizer", `plugin-${key}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: `@tokmizer/plugin-${key}`, version: "0.9.52" }));
  writeFileSync(join(folder, file), body, { mode: 0o755 });
  mkdirSync(join(directory, "dist", "native"), { recursive: true });
  const manifestPath = join(directory, "dist", "native", "single.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  manifest[key] = { version: "0.9.52", package: `@tokmizer/plugin-${key}`, file, sha256: createHash("sha256").update(manifestBody).digest("hex") };
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

function nativeLauncher() {
  const launcher = "#!/bin/sh\nprintf 'tokmizer-native 0.9.52 protocol=2\\n'\n";
  writeFileSync(join(directory, "dist", "native", "tkr-exec-darwin-arm64"), launcher, { mode: 0o755 });
  writeFileSync(join(directory, "dist", "native", "manifest.json"), JSON.stringify({ "darwin-arm64": { version: "0.9.52", file: "tkr-exec-darwin-arm64", sha256: createHash("sha256").update(launcher).digest("hex") } }));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tkr single space "));
  mkdirSync(join(directory, "dist", "bin"), { recursive: true });
  mkdirSync(join(directory, "hooks"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@tokmizer/plugin", version: "0.9.52" }));
  writeFileSync(join(directory, "dist", "bin", "tkr-exec.js"), "#!/usr/bin/env node\n");
  writeFileSync(hooksFile(), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: "", hooks: [{ command: node.session }, { command: node.reducerStart }, { command: node.recap }] }],
    UserPromptSubmit: [{ matcher: "", hooks: [{ command: node.prompt }] }],
    Stop: [{ matcher: "", hooks: [{ command: node.stop }, { command: "custom-stop" }] }],
    PreToolUse: [{ hooks: [{ command: node.pre }] }],
    PostToolUse: [{ hooks: [{ command: node.post }] }]
  } }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("standalone executable installation", () => {
  it("installs the verified platform executable and routes every Node hook through it", () => {
    platformPackage("darwin-arm64");
    expect(installSingle(directory, "darwin", "arm64")).toBe(true);
    expect(readFileSync(join(directory, "dist", "bin", "tkr"), "utf8")).toBe(executable);
    expect(singleInstalled(directory, "darwin")).toBe(true);
    expect(installNative(directory, "darwin", "arm64")).toBe(false);
    expect(commands()).toEqual({
      SessionStart: [`"${R}/dist/bin/tkr" hook session-start`, `"${R}/dist/bin/tkr" hook reducer-session-start`, `"${R}/dist/bin/tkr" hook session-recap`],
      UserPromptSubmit: [`"${R}/dist/bin/tkr" hook reducer-prompt-submit`],
      Stop: [`"${R}/dist/bin/tkr" hook reducer-stop`, "custom-stop"],
      PreToolUse: [`"${R}/dist/bin/tkr" hook pre-tool-use`],
      PostToolUse: [`"${R}/dist/bin/tkr" hook post-tool-use`]
    });
  });

  it("keeps the native launcher on the tool hooks and warms its processor", () => {
    platformPackage("darwin-arm64");
    nativeLauncher();
    expect(installSingle(directory, "darwin", "arm64")).toBe(true);
    expect(installNative(directory, "darwin", "arm64")).toBe(true);
    const hooks = commands();
    expect(hooks.PreToolUse).toEqual([`"${R}/dist/bin/tkr-exec" --pre-tool-use`]);
    expect(hooks.PostToolUse).toEqual([`"${R}/dist/bin/tkr-exec" --post-tool-use`]);
    expect(hooks.SessionStart).toEqual([`"${R}/dist/bin/tkr-exec" --session-start`, `"${R}/dist/bin/tkr" hook session-start`, `"${R}/dist/bin/tkr" hook reducer-session-start`, `"${R}/dist/bin/tkr" hook session-recap`]);
  });

  it("returns every hook to Node when the executable is disabled", () => {
    platformPackage("darwin-arm64");
    expect(installSingle(directory, "darwin", "arm64")).toBe(true);
    installNative(directory, "darwin", "arm64");
    vi.stubEnv("TOKMIZER_SINGLE_EXEC", "0");
    expect(installSingle(directory, "darwin", "arm64")).toBe(false);
    expect(existsSync(join(directory, "dist", "bin", "tkr"))).toBe(false);
    installNative(directory, "darwin", "arm64");
    expect(commands().Stop).toEqual([node.stop, "custom-stop"]);
    expect(commands().PreToolUse).toEqual([node.pre]);
  });

  it("keeps Node when the platform package is missing, corrupt or fails its probe", () => {
    expect(installSingle(directory, "darwin", "arm64")).toBe(false);
    platformPackage("darwin-arm64", executable, "something else");
    expect(installSingle(directory, "darwin", "arm64")).toBe(false);
    platformPackage("darwin-arm64", "#!/bin/sh\nexit 1\n");
    expect(installSingle(directory, "darwin", "arm64")).toBe(false);
    platformPackage("darwin-arm64", "#!/bin/sh\nprintf 'tokmizer-single 0.9.51\\n'\n");
    expect(installSingle(directory, "darwin", "arm64")).toBe(false);
    expect(existsSync(join(directory, "dist", "bin", "tkr"))).toBe(false);
    installNative(directory, "darwin", "arm64");
    expect(commands().PreToolUse).toEqual([node.pre]);
  });

  it("removes a previously installed executable that no longer verifies", () => {
    platformPackage("darwin-arm64");
    expect(installSingle(directory, "darwin", "arm64")).toBe(true);
    platformPackage("darwin-arm64", executable, "rotated");
    expect(installSingle(directory, "darwin", "arm64")).toBe(false);
    expect(existsSync(join(directory, "dist", "bin", "tkr"))).toBe(false);
  });

  it("rejects an entry naming another package or file", () => {
    platformPackage("darwin-arm64");
    const manifestPath = join(directory, "dist", "native", "single.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest["darwin-arm64"].package = "evil-package";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(installSingle(directory, "darwin", "arm64")).toBe(false);
  });

  it("uses exec-form hooks for the Windows executable", () => {
    platformPackage("win32-x64");
    expect(installSingle(directory, "win32", "x64")).toBe(true);
    expect(existsSync(join(directory, "dist", "bin", "tkr.exe"))).toBe(true);
    expect(installNative(directory, "win32", "x64")).toBe(false);
    const hooks = JSON.parse(readFileSync(hooksFile(), "utf8")).hooks;
    expect(hooks.Stop[0].hooks[0]).toEqual({ command: `${R}/dist/bin/tkr.exe`, args: ["hook", "reducer-stop"] });
    expect(hooks.PreToolUse[0].hooks[0]).toEqual({ command: `${R}/dist/bin/tkr.exe`, args: ["hook", "pre-tool-use"] });
    vi.stubEnv("TOKMIZER_SINGLE_EXEC", "0");
    installSingle(directory, "win32", "x64");
    installNative(directory, "win32", "x64");
    expect(JSON.parse(readFileSync(hooksFile(), "utf8")).hooks.Stop[0].hooks[0]).toEqual({ command: node.stop });
  });
});

describe("standalone release artifacts", () => {
  function artifact(key: string, overrides: Record<string, unknown> = {}) {
    const [platform, arch] = key.split("-");
    const folder = join(directory, "native", "artifacts", key);
    const file = platform === "win32" ? "tkr.exe" : "tkr";
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, file), `binary ${key}`);
    writeFileSync(join(folder, "single.json"), JSON.stringify({ version: "0.9.52", platform, arch, package: `@tokmizer/plugin-${key}`, source: sourceFingerprint(directory), sha256: createHash("sha256").update(`binary ${key}`).digest("hex"), ...overrides }));
  }

  it("publishes only fresh, verified executables in the manifest", () => {
    artifact("darwin-arm64");
    artifact("linux-x64", { source: "stale" });
    copySingleArtifacts(directory);
    const manifest = JSON.parse(readFileSync(join(directory, "dist", "native", "single.json"), "utf8"));
    expect(Object.keys(manifest)).toEqual(["darwin-arm64"]);
    expect(manifest["darwin-arm64"]).toMatchObject({ version: "0.9.52", package: "@tokmizer/plugin-darwin-arm64", file: "tkr" });
    artifact("darwin-x64", { sha256: "0".repeat(64) });
    expect(() => copySingleArtifacts(directory)).toThrow("Invalid single binary artifact: darwin-x64");
  });

  it("requires every platform and pinned optional packages before release", () => {
    for (const key of nativePlatforms) artifact(key);
    copySingleArtifacts(directory);
    expect(() => verifySingleArtifacts(directory)).toThrow("optionalDependencies must pin @tokmizer/plugin-darwin-arm64@0.9.52");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@tokmizer/plugin", version: "0.9.52", optionalDependencies: Object.fromEntries(nativePlatforms.map((key) => [`@tokmizer/plugin-${key}`, "0.9.52"])) }));
    expect(() => verifySingleArtifacts(directory)).not.toThrow();
    writeFileSync(join(directory, "native", "artifacts", "linux-arm64", "tkr"), "changed");
    expect(() => verifySingleArtifacts(directory)).toThrow("Corrupt single binary artifact: linux-arm64");
  });

  it("fails loudly before release when the single binary manifest was never copied into dist", () => {
    for (const key of nativePlatforms) artifact(key);
    expect(() => verifySingleArtifacts(directory)).toThrow("dist/native/single.json is missing: run npm run build:single, then npm run build");
  });

  it("refreshes dist when the single binary is built after the bundle", () => {
    artifact("darwin-arm64");
    expect(existsSync(join(directory, "dist", "native", "single.json"))).toBe(false);
    syncSingleIntoDist(directory);
    expect(Object.keys(JSON.parse(readFileSync(join(directory, "dist", "native", "single.json"), "utf8")))).toEqual(["darwin-arm64"]);
  });

  it("leaves a missing dist alone so the next bundle copies the single binary itself", () => {
    rmSync(join(directory, "dist"), { recursive: true, force: true });
    artifact("darwin-arm64");
    syncSingleIntoDist(directory);
    expect(existsSync(join(directory, "dist"))).toBe(false);
  });

  it("calls the dist refresh at the end of the single binary build", () => {
    const script = readFileSync(new URL("../../scripts/build-single.mjs", import.meta.url), "utf8").trimEnd();
    expect(script.endsWith("syncSingleIntoDist(directory);")).toBe(true);
  });

  it("describes platform packages that npm installs only on their own system", () => {
    expect(platformPackageJson("linux-x64", "1.2.3")).toMatchObject({ name: "@tokmizer/plugin-linux-x64", version: "1.2.3", os: ["linux"], cpu: ["x64"], libc: ["glibc"], license: "Apache-2.0 AND BUSL-1.1", files: ["tkr", ...LICENSE_FILES] });
    expect(platformPackageJson("win32-arm64", "1.2.3")).toMatchObject({ os: ["win32"], cpu: ["arm64"], files: ["tkr.exe", ...LICENSE_FILES] });
    expect(platformPackageJson("darwin-arm64", "1.2.3")).not.toHaveProperty("libc");
  });

  it("writes a Homebrew formula that installs the executable without Node", () => {
    const archives = Object.fromEntries(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map((key) => [key, { name: `tokmizer-1.2.3-${key}.tar.gz`, sha256: key.padEnd(64, "0") }]));
    const formula = homebrewFormula("1.2.3", "https://example.test/v1.2.3", archives);
    expect(formula).not.toContain("depends_on");
    expect(formula).toContain('  license all_of: ["Apache-2.0", "BUSL-1.1"]\n');
    expect(formula).toContain('  on_macos do\n    on_arm do\n      url "https://example.test/v1.2.3/tokmizer-1.2.3-darwin-arm64.tar.gz"');
    expect(formula).toContain('  on_linux do\n    on_arm do\n      url "https://example.test/v1.2.3/tokmizer-1.2.3-linux-arm64.tar.gz"');
    expect(formula).toContain(`sha256 "${"linux-x64".padEnd(64, "0")}"`);
    expect(formula).toContain('bin.install_symlink libexec/"dist/bin/tkr", libexec/"dist/bin/tkr-exec"');
  });
});

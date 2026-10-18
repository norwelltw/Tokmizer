import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNative } from "../../scripts/install-native.mjs";
import { copyNativeArtifacts, nativePlatforms, verifyNativeArtifacts } from "../../scripts/native-artifacts.mjs";

let directory: string;
const fallback = "#!/usr/bin/env node\nprocess.stdout.write('fallback');\n";
const candidate = "#!/bin/sh\nprintf 'tokmizer-native 0.9.52 protocol=2\\n'\n";
const nodeHook = 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks-host/pre-tool-use.js"';
const nativeHook = '"${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec" --pre-tool-use';
const nodePostHook = 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks-host/post-tool-use.js"';
const nativePostHook = '"${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec" --post-tool-use';
const sessionHook = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/on-session-start.mjs"';
const nativeSessionHook = '"${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec" --session-start';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tkr install space "));
  mkdirSync(join(directory, "dist", "bin"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.9.52" }));
  writeFileSync(join(directory, "dist", "bin", "tkr-exec.js"), fallback);
  mkdirSync(join(directory, "hooks"));
  writeFileSync(join(directory, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ command: sessionHook }] }], PreToolUse: [{ hooks: [{ command: nodeHook }, { command: "custom-hook" }] }], PostToolUse: [{ hooks: [{ command: nodePostHook }] }] } }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function artifact(overrides = {}) {
  const entry = { version: "0.9.52", platform: "darwin", arch: "arm64", sha256: createHash("sha256").update(candidate).digest("hex"), ...overrides };
  const folder = join(directory, "native", "artifacts", `${entry.platform}-${entry.arch}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `tkr-exec-native${entry.platform === "win32" ? ".exe" : ""}`), candidate, { mode: 0o755 });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(entry));
}

function toolHooks() {
  const hooks = JSON.parse(readFileSync(join(directory, "hooks", "hooks.json"), "utf8")).hooks;
  return [hooks.PreToolUse[0].hooks[0], hooks.PostToolUse[0].hooks[0]];
}

describe("native artifact installation", () => {
  it.skipIf(process.platform === "win32")("restores the JavaScript hook when native installation is disabled", () => {
    artifact();
    copyNativeArtifacts(directory);
    expect(installNative(directory, "darwin", "arm64")).toBe(true);
    vi.stubEnv("TOKMIZER_NATIVE_EXEC", "0");
    expect(installNative(directory, "darwin", "arm64")).toBe(false);
    expect(readFileSync(join(directory, "dist", "bin", "tkr-exec"), "utf8")).toBe(fallback);
    expect(JSON.parse(readFileSync(join(directory, "hooks", "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command).toBe(nodeHook);
  });

  it.skipIf(process.platform === "win32")("routes both tool hooks through the verified native launcher and back", () => {
    artifact();
    copyNativeArtifacts(directory);
    expect(installNative(directory, "darwin", "arm64")).toBe(true);
    let hooks = JSON.parse(readFileSync(join(directory, "hooks", "hooks.json"), "utf8")).hooks;
    expect(hooks.PreToolUse[0].hooks.map((hook: { command: string }) => hook.command)).toEqual([nativeHook, "custom-hook"]);
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(nativePostHook);
    vi.stubEnv("TOKMIZER_NATIVE_EXEC", "0");
    expect(installNative(directory, "darwin", "arm64")).toBe(false);
    hooks = JSON.parse(readFileSync(join(directory, "hooks", "hooks.json"), "utf8")).hooks;
    expect(hooks.PreToolUse[0].hooks[0].command).toBe(nodeHook);
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(nodePostHook);
  });

  it.skipIf(process.platform === "win32")("warms the native processor at session start only while the native launcher is installed", () => {
    artifact();
    copyNativeArtifacts(directory);
    const sessionCommands = () => JSON.parse(readFileSync(join(directory, "hooks", "hooks.json"), "utf8")).hooks.SessionStart[0].hooks.map((hook: { command: string }) => hook.command);
    expect(installNative(directory, "darwin", "arm64")).toBe(true);
    expect(sessionCommands()).toEqual([nativeSessionHook, sessionHook]);
    expect(installNative(directory, "darwin", "arm64")).toBe(true);
    expect(sessionCommands()).toEqual([nativeSessionHook, sessionHook]);
    vi.stubEnv("TOKMIZER_NATIVE_EXEC", "0");
    expect(installNative(directory, "darwin", "arm64")).toBe(false);
    expect(sessionCommands()).toEqual([sessionHook]);
  });

  it.skipIf(process.platform === "win32")("runs the installed launcher once so the first tool call does not pay its first-execution check", () => {
    const runs = join(directory, "probe-runs");
    const counting = `#!/bin/sh\nprintf 1 >> '${runs}'\nprintf 'tokmizer-native 0.9.52 protocol=2\\n'\n`;
    const entry = { version: "0.9.52", platform: "darwin", arch: "arm64", sha256: createHash("sha256").update(counting).digest("hex") };
    const folder = join(directory, "native", "artifacts", "darwin-arm64");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "tkr-exec-native"), counting, { mode: 0o755 });
    writeFileSync(join(folder, "manifest.json"), JSON.stringify(entry));
    copyNativeArtifacts(directory);
    expect(installNative(directory, "darwin", "arm64")).toBe(true);
    expect(readFileSync(runs, "utf8")).toBe("11");
  });

  it.skipIf(process.platform === "win32")("keeps the JavaScript launcher when the installed copy does not run", () => {
    const runs = join(directory, "probe-runs");
    const once = `#!/bin/sh\n[ -e '${runs}' ] && exit 1\nprintf 1 >> '${runs}'\nprintf 'tokmizer-native 0.9.52 protocol=2\\n'\n`;
    const entry = { version: "0.9.52", platform: "darwin", arch: "arm64", sha256: createHash("sha256").update(once).digest("hex") };
    const folder = join(directory, "native", "artifacts", "darwin-arm64");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "tkr-exec-native"), once, { mode: 0o755 });
    writeFileSync(join(folder, "manifest.json"), JSON.stringify(entry));
    copyNativeArtifacts(directory);
    expect(installNative(directory, "darwin", "arm64")).toBe(false);
    expect(readFileSync(join(directory, "dist", "bin", "tkr-exec"), "utf8")).toBe(fallback);
    expect(JSON.parse(readFileSync(join(directory, "hooks", "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command).toBe(nodeHook);
  });

  it("refuses a release containing only the build host artifact", () => {
    artifact();
    copyNativeArtifacts(directory);
    expect(() => verifyNativeArtifacts(directory)).toThrow("darwin-x64");
  });

  it("verifies all release artifacts and rejects post-build corruption", () => {
    for (const key of nativePlatforms) {
      const [platform, arch] = key.split("-");
      artifact({ platform, arch });
    }
    copyNativeArtifacts(directory);
    expect(() => verifyNativeArtifacts(directory)).not.toThrow();
    writeFileSync(join(directory, "dist", "native", "tkr-exec-linux-arm64"), "changed");
    expect(() => verifyNativeArtifacts(directory)).toThrow("Corrupt release artifact: linux-arm64");
  });

  it("keeps the Node entrypoint when no native artifact is available", () => {
    expect(installNative(directory, "darwin", "arm64")).toBe(false);
    expect(readFileSync(join(directory, "dist", "bin", "tkr-exec"), "utf8")).toBe(fallback);
  });

  it("keeps Windows on the Node entrypoint without a Windows artifact", () => {
    artifact();
    copyNativeArtifacts(directory);
    expect(installNative(directory, "win32", "x64")).toBe(false);
    expect(readFileSync(join(directory, "dist", "bin", "tkr-exec"), "utf8")).toBe(fallback);
    expect(existsSync(join(directory, "dist", "bin", "tkr-exec.exe"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("installs the Windows launcher beside the Node entrypoint with exec-form hooks", () => {
    artifact({ platform: "win32", arch: "x64" });
    copyNativeArtifacts(directory);
    expect(JSON.parse(readFileSync(join(directory, "dist", "native", "manifest.json"), "utf8"))["win32-x64"].file).toBe("tkr-exec-win32-x64.exe");
    expect(installNative(directory, "win32", "x64")).toBe(true);
    expect(readFileSync(join(directory, "dist", "bin", "tkr-exec.exe"), "utf8")).toBe(candidate);
    expect(readFileSync(join(directory, "dist", "bin", "tkr-exec"), "utf8")).toBe(fallback);
    expect(toolHooks()).toEqual([
      { command: "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec.exe", args: ["--pre-tool-use"] },
      { command: "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec.exe", args: ["--post-tool-use"] }
    ]);
    const sessionHooks = () => JSON.parse(readFileSync(join(directory, "hooks", "hooks.json"), "utf8")).hooks.SessionStart[0].hooks.map((hook: { command: string; args?: string[] }) => [hook.command, hook.args]);
    const windowsSession = ["${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec.exe", ["--session-start"]];
    expect(sessionHooks()).toEqual([windowsSession, [sessionHook, undefined]]);
    expect(installNative(directory, "win32", "x64")).toBe(true);
    expect(toolHooks()[0]).toEqual({ command: "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec.exe", args: ["--pre-tool-use"] });
    expect(sessionHooks()).toEqual([windowsSession, [sessionHook, undefined]]);
    vi.stubEnv("TOKMIZER_NATIVE_EXEC", "0");
    expect(installNative(directory, "win32", "x64")).toBe(false);
    expect(existsSync(join(directory, "dist", "bin", "tkr-exec.exe"))).toBe(false);
    expect(toolHooks()).toEqual([{ command: nodeHook }, { command: nodePostHook }]);
    expect(sessionHooks()).toEqual([[sessionHook, undefined]]);
  });

  it.skipIf(process.platform === "win32")("keeps Windows on Node when the packaged launcher fails its probe", () => {
    artifact({ platform: "win32", arch: "x64" });
    copyNativeArtifacts(directory);
    const file = join(directory, "dist", "native", "tkr-exec-win32-x64.exe");
    const broken = "#!/bin/sh\nexit 127\n";
    writeFileSync(file, broken);
    const manifest = JSON.parse(readFileSync(join(directory, "dist", "native", "manifest.json"), "utf8"));
    manifest["win32-x64"].sha256 = createHash("sha256").update(broken).digest("hex");
    writeFileSync(join(directory, "dist", "native", "manifest.json"), JSON.stringify(manifest));
    expect(installNative(directory, "win32", "x64")).toBe(false);
    expect(existsSync(join(directory, "dist", "bin", "tkr-exec.exe"))).toBe(false);
    expect(toolHooks()).toEqual([{ command: nodeHook }, { command: nodePostHook }]);
  });

  it("rejects a Windows manifest entry without the executable suffix", () => {
    artifact({ platform: "win32", arch: "x64" });
    copyNativeArtifacts(directory);
    const manifest = JSON.parse(readFileSync(join(directory, "dist", "native", "manifest.json"), "utf8"));
    manifest["win32-x64"].file = "tkr-exec-win32-x64";
    writeFileSync(join(directory, "dist", "native", "manifest.json"), JSON.stringify(manifest));
    expect(installNative(directory, "win32", "x64")).toBe(false);
    expect(existsSync(join(directory, "dist", "bin", "tkr-exec.exe"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("installs a verified executable and preserves explicit Node execution", () => {
    artifact();
    copyNativeArtifacts(directory);
    expect(installNative(directory, "darwin", "arm64")).toBe(true);
    expect(readFileSync(join(directory, "dist", "bin", "tkr-exec"), "utf8")).toBe(candidate);
    expect(readFileSync(join(directory, "dist", "bin", "tkr-exec.js"), "utf8")).toBe(fallback);
    const hooks = JSON.parse(readFileSync(join(directory, "hooks", "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks;
    expect(hooks.map((hook: { command: string }) => hook.command)).toEqual([nativeHook, "custom-hook"]);
    expect(installNative(directory, "win32", "x64")).toBe(false);
    expect(JSON.parse(readFileSync(join(directory, "hooks", "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command).toBe(nodeHook);
  });

  it("rejects a corrupted packaged binary and restores the fallback", () => {
    artifact();
    copyNativeArtifacts(directory);
    writeFileSync(join(directory, "dist", "native", "tkr-exec-darwin-arm64"), "corrupted");
    expect(installNative(directory, "darwin", "arm64")).toBe(false);
    expect(readFileSync(join(directory, "dist", "bin", "tkr-exec"), "utf8")).toBe(fallback);
  });

  it("refuses to bundle wrong-version or corrupt build artifacts", () => {
    artifact({ version: "old" });
    expect(() => copyNativeArtifacts(directory)).toThrow("Invalid native artifact");
    artifact({ sha256: "0".repeat(64) });
    expect(() => copyNativeArtifacts(directory)).toThrow("Invalid native artifact");
  });

  it.skipIf(process.platform === "win32")("does not install a binary that cannot run on this host", () => {
    artifact();
    copyNativeArtifacts(directory);
    const file = join(directory, "dist", "native", "tkr-exec-darwin-arm64");
    const broken = "#!/bin/sh\nexit 127\n";
    writeFileSync(file, broken);
    chmodSync(file, 0o755);
    const manifest = JSON.parse(readFileSync(join(directory, "dist", "native", "manifest.json"), "utf8"));
    manifest["darwin-arm64"].sha256 = createHash("sha256").update(broken).digest("hex");
    writeFileSync(join(directory, "dist", "native", "manifest.json"), JSON.stringify(manifest));
    expect(installNative(directory, "darwin", "arm64")).toBe(false);
    expect(readFileSync(join(directory, "dist", "bin", "tkr-exec"), "utf8")).toBe(fallback);
  });
});

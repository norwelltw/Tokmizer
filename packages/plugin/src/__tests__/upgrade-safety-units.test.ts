import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rewriteForAgent } from "../agent-rewrite";
import { tokmizerEnabled } from "../hooks-host/quick-settings";
import { missingTargets } from "../hook-health";

const pkg = resolve(__dirname, "..", "..");
const tkrJs = join(pkg, "dist", "bin", "tkr.js");
let root: string;
let home: string;
let tkrHome: string;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, TOKMIZER_HOME: tkrHome, TOKMIZER_NETWORK: "0", TOKMIZER_AUTO_UPDATE: "0", XDG_RUNTIME_DIR: "", CODEX_HOME: join(home, ".codex"), ...extra };
}

async function stopTestDaemon(): Promise<void> {
  vi.stubEnv("TOKMIZER_HOME", tkrHome);
  vi.stubEnv("XDG_RUNTIME_DIR", "");
  const { socketPath } = await vi.importActual<typeof import("../daemon/lifecycle")>("../daemon/lifecycle");
  const { shutdownDaemon } = await vi.importActual<typeof import("../daemon/client")>("../daemon/client");
  const { path } = socketPath();
  if (existsSync(path)) {
    await shutdownDaemon({ socketPath: path });
    await vi.waitFor(() => expect(existsSync(path)).toBe(false), { timeout: 3000, interval: 50 });
  }
  if (!path.startsWith(root)) rmSync(dirname(path), { recursive: true, force: true });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-upgrade-units-")));
  home = join(root, "home");
  tkrHome = join(home, ".tokmizer");
  mkdirSync(home);
});

afterEach(async () => {
  vi.doUnmock("../state");
  await stopTestDaemon();
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe("kill switch", () => {
  it("stops every hook rewrite and the post-tool compression while the flag is set", () => {
    vi.stubEnv("TOKMIZER_HOME", tkrHome);
    mkdirSync(tkrHome, { recursive: true });
    const record = vi.fn();
    expect(rewriteForAgent("git status", "opencode", "s", "tkr-exec", record)).toBe("tkr-exec git status");
    expect(tokmizerEnabled()).toBe(true);
    writeFileSync(join(tkrHome, "fail-open"), "1");
    expect(rewriteForAgent("git status", "opencode", "s", "tkr-exec", record)).toBeNull();
    expect(tokmizerEnabled()).toBe(false);
  });
});

describe("hook health", () => {
  it("reports only missing Tokmizer executables", () => {
    const present = join(root, "tkr-codex-hook");
    writeFileSync(present, "");
    const text = JSON.stringify({ hooks: [
      { command: `[ ! -x '${present}' ] || exec '${present}'` },
      { command: `node '${join(root, "gone", "tkr-cursor-hook.js")}'` },
      { command: `'${join(root, "gone", "my-own-guard")}'` }
    ] });
    expect(missingTargets(text)).toEqual([join(root, "gone", "tkr-cursor-hook.js")]);
  });
});

describe("shim runner", () => {
  it.skipIf(process.platform === "win32")("runs the command unchanged when its own setup throws", async () => {
    vi.doMock("../state", async (importActual) => ({ ...(await importActual<typeof import("../state")>()), loadState: () => Promise.reject(new Error("corrupt")) }));
    const { runShim } = await import("../shim/runner");
    const out = join(root, "out.txt");
    const result = await runShim({ cmdName: "/bin/sh", args: ["-c", `printf ran > '${out}'; exit 7`] });
    expect(result.exitCode).toBe(7);
    expect(readFileSync(out, "utf8")).toBe("ran");
  });
});

describe("Claude Code commands", () => {
  it("are not written when Claude Code is not installed", async () => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("TOKMIZER_CLAUDE_COMMANDS_DIR", "");
    vi.stubEnv("TOKMIZER_HOME", tkrHome);
    const { installCommand } = await import("../cache");
    const os = await import("node:os");
    const spy = vi.spyOn(os.default, "homedir").mockReturnValue(home);
    try {
      await installCommand("tkr-gain", "body");
      expect(existsSync(join(home, ".claude"))).toBe(false);
      mkdirSync(join(home, ".claude"));
      await installCommand("tkr-gain", "body");
      expect(readFileSync(join(home, ".claude", "commands", "tkr-gain.md"), "utf8")).toBe("body");
    } finally {
      spy.mockRestore();
    }
  });
});

describe.skipIf(process.platform === "win32")("tkr CLI", () => {
  it("wrap puts the shims first on PATH only for the agent it starts", () => {
    const r = spawnSync(process.execPath, [tkrJs, "wrap", "--host", "aider", "/bin/sh", "-c", "printf '%s|%s' \"$TOKMIZER_HOST\" \"${PATH%%:*}\""], { encoding: "utf8", env: env() });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`aider|${join(tkrHome, "shims")}`);
    expect(existsSync(join(tkrHome, "shims", "git"))).toBe(true);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    const exit = spawnSync(process.execPath, [tkrJs, "wrap", "--host", "aider", "/bin/sh", "-c", "exit 9"], { encoding: "utf8", env: env() });
    expect(exit.status).toBe(9);
    const unknown = spawnSync(process.execPath, [tkrJs, "wrap", "/bin/sh"], { encoding: "utf8", env: env() });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("--host");
  });

  it("wrap shows the network notice once so the agent's commands may finish the free sign-up", () => {
    const online = env({ TOKMIZER_NETWORK: "1", TOKMIZER_BASE_URL: "http://127.0.0.1:9" });
    const first = spawnSync(process.execPath, [tkrJs, "wrap", "--host", "aider", "/bin/sh", "-c", "exit 0"], { encoding: "utf8", env: online });
    expect(first.status).toBe(0);
    expect(first.stderr).toContain("Tokmizer contacts tokmizer.com");
    expect(existsSync(join(tkrHome, "network-notice-shown"))).toBe(true);
    const second = spawnSync(process.execPath, [tkrJs, "wrap", "--host", "aider", "/bin/sh", "-c", "exit 0"], { encoding: "utf8", env: online });
    expect(second.stderr).not.toContain("Tokmizer contacts tokmizer.com");
  });

  it("shim install no longer edits any shell profile", () => {
    const r = spawnSync(process.execPath, [tkrJs, "shim", "install"], { encoding: "utf8", env: env({ SHELL: "/bin/zsh" }) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tkr wrap");
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    expect(existsSync(join(tkrHome, "bin", "tkr-shim-launch"))).toBe(true);
  });

  it("doctor reports and --fix repairs a hook that points at a removed install", () => {
    const codex = join(home, ".codex");
    mkdirSync(codex, { recursive: true });
    const gone = join(root, "old", "dist", "bin", "tkr-codex-hook.js");
    writeFileSync(join(codex, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node '${gone}'` }] }] } }));
    const report = spawnSync(process.execPath, [tkrJs, "doctor"], { encoding: "utf8", env: env({ PATH: `/usr/bin:/bin` }) });
    expect(report.stdout).toContain(`Broken:   Codex points at a missing file (${gone})`);
    const fix = spawnSync(process.execPath, [tkrJs, "doctor", "--fix"], { encoding: "utf8", env: env({ PATH: `/usr/bin:/bin` }) });
    expect(fix.status).toBe(0);
    expect(fix.stdout).toContain("Repaired the Codex hook");
    const command = JSON.parse(readFileSync(join(codex, "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;
    expect(command).toBe(`[ ! -f '${join(tkrHome, "bin", "tkr-hook")}' ] || exec /bin/sh '${join(tkrHome, "bin", "tkr-hook")}' tkr-codex-hook`);
    expect(fix.stdout).toContain("In Codex, run /hooks once and approve it.");
    expect(spawnSync(process.execPath, [tkrJs, "doctor"], { encoding: "utf8", env: env({ PATH: `/usr/bin:/bin` }) }).stdout).not.toContain("Broken:");
  });

  it("setup-codex installs the hook without shims or profile changes", () => {
    const r = spawnSync(process.execPath, [tkrJs, "setup-codex"], { encoding: "utf8", env: env({ SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" }) });
    expect(r.status).toBe(0);
    expect(existsSync(join(tkrHome, "shims"))).toBe(false);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("Unix installer and Claude Code", () => {
  it("does not add Claude Code hooks because tkr itself created ~/.claude during the install", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "calls");
    const release = join(root, "release");
    mkdirSync(release);
    const tkr = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$1" = "--single-check" ] && printf 'tokmizer-single 9.9.9\\n'\n[ "$1" = shim ] && mkdir -p "$HOME/.claude/commands"\nexit 0\n`;
    const name = `tokmizer-9.9.9-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
    mkdirSync(join(root, "stage", name, "dist", "bin"), { recursive: true });
    for (const file of ["tkr", "tkr-exec"]) {
      writeFileSync(join(root, "stage", name, "dist", "bin", file), tkr);
      chmodSync(join(root, "stage", name, "dist", "bin", file), 0o755);
    }
    expect(spawnSync("tar", ["-czf", join(release, `${name}.tar.gz`), "-C", join(root, "stage"), name]).status).toBe(0);
    const sum = spawnSync("shasum", ["-a", "256", join(release, `${name}.tar.gz`)], { encoding: "utf8" }).stdout.split(" ")[0];
    writeFileSync(join(release, "SHA256SUMS"), `${sum}  ${name}.tar.gz\n`);
    const tools = join(root, "tools");
    mkdirSync(tools);
    for (const cmd of ["uname", "curl", "tar", "gzip", "mktemp", "rm", "grep", "head", "sha256sum", "shasum", "cut", "mkdir", "mv", "ln", "sh", "perl"]) {
      const found = ["/usr/bin", "/bin"].map((d) => join(d, cmd)).find((p) => existsSync(p));
      if (found && !existsSync(join(tools, cmd))) symlinkSync(found, join(tools, cmd));
    }
    const r = spawnSync("/bin/bash", [join(pkg, "scripts", "install-mac-linux.sh")], {
      encoding: "utf8",
      env: { ...env(), PATH: tools, TOKMIZER_STANDALONE: "1", TOKMIZER_DOWNLOAD_BASE: `file://${release}` }
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("shim install");
    expect(readFileSync(log, "utf8")).not.toContain("setup-claude");
    expect(r.stdout).toContain("Your shell profile was not changed.");
  });
});

describe.skipIf(process.platform === "win32")("config writes", () => {
  it("keep a symlinked config a symlink and keep its permissions", async () => {
    const { writeTextPreserving } = await import("../hook-config");
    const { lstatSync, statSync, symlinkSync } = await import("node:fs");
    const real = join(root, "dotfiles", "settings.json");
    mkdirSync(join(root, "dotfiles"));
    writeFileSync(real, "{}", { mode: 0o600 });
    const link = join(home, "settings.json");
    symlinkSync(real, link);
    expect(await writeTextPreserving(link, "{\"a\":1}")).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("{\"a\":1}");
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(await writeTextPreserving(join(home, "new", "fresh.json"), "{}")).toBe(true);
    expect(statSync(join(home, "new", "fresh.json")).mode & 0o777).toBe(0o600);
  });

  it("refresh every field of an existing hook entry on upgrade", async () => {
    const { upsertJsonHook } = await import("../json-hooks");
    const spec = { event: "PreToolUse", mark: "tkr-x-hook", nested: true, entry: (command: string) => ({ type: "command", command, timeout: 10 }) } as never;
    const parsed = { hooks: { PreToolUse: [{ type: "command", command: "old tkr-x-hook", timeout: 3, user: true }] } };
    expect(upsertJsonHook(parsed, spec, "new tkr-x-hook")).toBe("updated");
    expect(parsed.hooks.PreToolUse[0]).toEqual({ type: "command", command: "new tkr-x-hook", timeout: 10, user: true });
    expect(upsertJsonHook(parsed, spec, "new tkr-x-hook")).toBe("present");
  });
});

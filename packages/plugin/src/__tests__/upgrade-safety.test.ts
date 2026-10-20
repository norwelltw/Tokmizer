import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, utimesSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const pkg = resolve(__dirname, "..", "..");
const fixtures = join(__dirname, "fixtures", "upgrade");
const nodeDir = dirname(process.execPath);
const single = process.env.TOKMIZER_SINGLE_TEST_BIN;
const nativeExec = process.env.TOKMIZER_NATIVE_TEST_BIN;
const shells = ["sh", "bash", "zsh", "dash"].filter((s) => existsSync(`/bin/${s}`));
const python = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"].find(existsSync);
const HINT = "tokmizer: shim target missing, running command directly; run `tkr doctor --fix`";
const NEW = "0.9.59";
// Keeps the pty's slave end open until the shell has exited and the output is
// drained: closing it first lets macOS drop output still buffered in the pty.
const PTY = [
  "import os, pty, select, subprocess, sys",
  "m, s = pty.openpty()",
  "p = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=s, stderr=s)",
  "out = b''",
  "def drain(wait):",
  "    global out",
  "    while select.select([m], [], [], wait)[0]:",
  "        d = os.read(m, 4096)",
  "        if not d:",
  "            break",
  "        out += d",
  "while p.poll() is None:",
  "    drain(0.05)",
  "drain(0.2)",
  "os.close(s)",
  "sys.stdout.write(out.decode())"
].join("\n");

let root: string;
let home: string;
let tkrHome: string;
let cache: string;
let sample: string;
let stubLog: string;

function guardEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("TOKMIZER_TEST_") || k === "NODE_OPTIONS"));
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...guardEnv(),
    HOME: home,
    TOKMIZER_HOME: tkrHome,
    TOKMIZER_NETWORK: "0",
    TOKMIZER_AUTO_UPDATE: "0",
    TOKMIZER_POSTINSTALL_HEAL: "1",
    STUB_LOG: stubLog,
    PATH: `/usr/bin:/bin:${nodeDir}`,
    ...extra
  };
}

function shimPath(): string {
  return `${join(tkrHome, "shims")}:/usr/bin:/bin:${nodeDir}`;
}

type Mode = "agent" | "native" | "plain" | "wrapped";

const MODE_ENV: Record<Mode, NodeJS.ProcessEnv> = {
  agent: { CURSOR_VERSION: "1" },
  native: { CLAUDECODE: "1" },
  plain: {},
  wrapped: { TOKMIZER_HOST: "aider" }
};

function runIn(shell: string, mode: Mode, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(`/bin/${shell}`, ["-c", `cat '${sample}'`], { encoding: "utf8", timeout: 30000, env: baseEnv({ PATH: shimPath(), ...MODE_ENV[mode], ...extra }) });
}

function runTty(shell: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(python!, ["-c", PTY, `/bin/${shell}`, "-c", `cat '${sample}'; echo "rc=$?"`], { encoding: "utf8", timeout: 30000, env: baseEnv({ PATH: shimPath(), ...extra }) });
}

function expectWorks(r: ReturnType<typeof spawnSync>, hint = false): void {
  expect(r.status).toBe(0);
  expect(String(r.stdout)).toBe("payload\n");
  expect(String(r.stderr).includes(HINT)).toBe(hint);
}

function expectAllShellsWork(hint = false): void {
  for (const shell of shells) {
    for (const mode of ["agent", "native", "plain", "wrapped"] as Mode[]) expectWorks(runIn(shell, mode), hint);
    if (python) {
      const tty = runTty(shell);
      expect(tty.stdout.replace(/\r/g, "")).toContain("payload\nrc=0");
    }
  }
}

function oldStub(dir: string): string {
  const js = join(dir, "dist", "bin", "tkr-shim.js");
  mkdirSync(dirname(js), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@tokmizer/plugin", version: "0.9.58", type: "module" }));
  writeFileSync(js, [
    "import { spawnSync } from \"node:child_process\";",
    "import { appendFileSync } from \"node:fs\";",
    "const a = process.argv.slice(2);",
    "const i = a.indexOf(\"--as\");",
    "if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, \"old\\n\");",
    "const r = spawnSync(a[i + 1], a.slice(i + 2), { stdio: \"inherit\", env: { ...process.env, PATH: process.env.PATH.split(\":\").filter((p) => !p.endsWith(\"/.tokmizer/shims\")).join(\":\") } });",
    "process.exit(r.status ?? 1);",
    ""
  ].join("\n"));
  return js;
}

function newPackage(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const entry of ["dist", "hooks", ".claude-plugin", "package.json", "command-templates", "scripts"]) cpSync(join(pkg, entry), join(dir, entry), { recursive: true });
  return join(dir, "dist", "bin", "tkr-shim.js");
}

function oldShim(format: "0.9.32" | "0.9.52" | "0.9.58" | "0.9.58-single", target: string, cmd: string): string {
  if (format === "0.9.32") return `#!/usr/bin/env bash\nexec node ${JSON.stringify(target)} --as ${JSON.stringify(cmd)} "$@"\n`;
  const file = format === "0.9.52" ? "shim-0.9.52.sh" : "shim-0.9.58.sh";
  let text = readFileSync(join(fixtures, file), "utf8").split("__HOME__").join(home).replace("_tk_c='git'", `_tk_c='${cmd}'`).replace("--as 'git'", `--as '${cmd}'`);
  if (format === "0.9.58-single") return text.replace(`exec node '__JS__'`, `exec '${target}' shim-run`);
  return text.split("__JS__").join(target);
}

function writeOldInstall(format: Parameters<typeof oldShim>[0], target: string, rcFormat: "quoted" | "legacy" = "quoted"): void {
  const shims = join(tkrHome, "shims");
  mkdirSync(shims, { recursive: true });
  for (const cmd of ["git", "cat", "ls", "grep"]) {
    writeFileSync(join(shims, cmd), oldShim(format, target, cmd));
    chmodSync(join(shims, cmd), 0o755);
  }
  const rc = rcFormat === "quoted"
    ? readFileSync(join(fixtures, "zshrc-0.9.5x.txt"), "utf8").split("__HOME__").join(home)
    : `\n\n# tokmizer-shim PATH (managed by tokmizer)\nexport PATH="${join(tkrHome, "shims")}:$PATH"\n`;
  writeFileSync(join(home, ".zshrc"), `export KEEP=1\n${rc.replace(/^\n/, "")}`);
  writeFileSync(join(home, ".bashrc"), `alias ll='ls -l'\n${rc.replace(/^\n/, "")}`);
}

function launcher(): string {
  return readFileSync(join(tkrHome, "bin", "tkr-shim-launch"), "utf8");
}

function assertHealed(rcBackups = 2): void {
  const shim = readFileSync(join(tkrHome, "shims", "cat"), "utf8");
  expect(shim).toContain(join(tkrHome, "bin", "tkr-shim-launch"));
  expect(shim).not.toMatch(/exec node /);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("export KEEP=1\n");
  expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe("alias ll='ls -l'\n");
  expect(readdirSync(join(tkrHome, "backup", "rc")).length).toBe(rcBackups);
  expect(readdirSync(home).some((f) => f.includes("tkr-bak"))).toBe(false);
}

function sessionStart(pluginRoot: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(pluginRoot, "hooks", "on-session-start.mjs")], { encoding: "utf8", timeout: 30000, env: baseEnv({ CLAUDE_PLUGIN_ROOT: pluginRoot, TOKMIZER_CLAUDE_COMMANDS_DIR: join(root, "commands"), ...extra }) });
}

function tkr(entry: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(entry.endsWith(".js") ? process.execPath : entry, entry.endsWith(".js") ? [entry, ...args] : args, { encoding: "utf8", timeout: 30000, env: baseEnv(extra) });
}

beforeEach(() => {
  expect(existsSync(join(pkg, "dist", "bin", "tkr.js")) && existsSync(join(pkg, "dist", "bin", "tkr-shim.stable")), "build the plugin first: npm --workspace=@tokmizer/plugin run build").toBe(true);
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-upgrade-")));
  home = join(root, "home");
  tkrHome = join(home, ".tokmizer");
  cache = join(home, ".claude", "plugins", "cache", "tokmizer", "tokmizer");
  mkdirSync(cache, { recursive: true });
  sample = join(root, "sample.txt");
  writeFileSync(sample, "payload\n");
  stubLog = join(root, "stub.log");
});

async function stopTestDaemon(): Promise<void> {
  vi.stubEnv("TOKMIZER_HOME", tkrHome);
  for (const name of ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, "");
  try {
    const { socketPath } = await import("../daemon/lifecycle");
    const { shutdownDaemon } = await import("../daemon/client");
    const { path } = socketPath();
    if (existsSync(path)) {
      await shutdownDaemon({ socketPath: path });
      await vi.waitFor(() => expect(existsSync(path)).toBe(false), { timeout: 3000, interval: 50 });
    }
    if (!path.startsWith(root)) rmSync(dirname(path), { recursive: true, force: true });
  } finally {
    vi.unstubAllEnvs();
  }
}

afterEach(async () => {
  await stopTestDaemon();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("upgrade safety", () => {
  for (const format of ["0.9.32", "0.9.52", "0.9.58"] as const) {
    it(`Claude Code plugin: ${format} shims survive the cache swap and the old folder removal`, () => {
      const old = oldStub(join(cache, format === "0.9.32" ? "0.9.32" : format));
      writeOldInstall(format, old, format === "0.9.32" ? "legacy" : "quoted");
      expectWorks(runIn("sh", "agent"));
      newPackage(join(cache, NEW));
      rmSync(join(cache, format), { recursive: true, force: true });
      expect(runIn("sh", "agent").status).not.toBe(0);
      const started = sessionStart(join(cache, NEW));
      expect(started.status).toBe(0);
      expect(started.stdout).toContain(`removed its PATH line from ${join(home, ".zshrc")}, ${join(home, ".bashrc")}`);
      assertHealed();
      expect(launcher()).toContain(`_tk_k='${cache}'`);
      expectAllShellsWork();
      const again = sessionStart(join(cache, NEW));
      expect(again.status).toBe(0);
      expect(again.stdout).not.toContain("PATH line");
      assertHealed();
    });
  }

  it("Claude Code plugin: a later upgrade needs no heal at all", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    newPackage(join(cache, NEW));
    rmSync(join(cache, "0.9.58"), { recursive: true });
    expect(sessionStart(join(cache, NEW)).status).toBe(0);
    newPackage(join(cache, "0.9.60"));
    rmSync(join(cache, NEW), { recursive: true });
    expectAllShellsWork();
  });

  it("plugin removed but shims left: commands run unchanged with one hint", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    newPackage(join(cache, NEW));
    expect(sessionStart(join(cache, NEW)).status).toBe(0);
    rmSync(join(home, ".claude"), { recursive: true });
    for (const shell of shells) {
      const r = runIn(shell, "agent");
      expectWorks(r, true);
      expect(r.stderr.split(HINT).length - 1).toBe(1);
    }
    expect(readFileSync(join(tkrHome, "shim-fallbacks"), "utf8").length).toBeGreaterThan(0);
  });

  it("downgrade to a build without the stable launcher: commands run unchanged, old code is never started", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    newPackage(join(cache, NEW));
    expect(sessionStart(join(cache, NEW)).status).toBe(0);
    rmSync(stubLog, { force: true });
    rmSync(join(cache, NEW), { recursive: true, maxRetries: 10 });
    oldStub(join(cache, "0.9.58"));
    for (const shell of shells) expectWorks(runIn(shell, "agent"), true);
    expect(existsSync(stubLog)).toBe(false);
  });

  it("npm global: in-place upgrade heals through postinstall, a moved prefix is found on PATH", () => {
    const prefix = join(root, "npm");
    const dir = join(prefix, "lib", "node_modules", "@tokmizer", "plugin");
    writeOldInstall("0.9.58", oldStub(dir));
    rmSync(dir, { recursive: true });
    newPackage(dir);
    const post = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(`file://${join(dir, "scripts", "install-native.mjs")}`)}); process.stdout.write(String(m.healShims(${JSON.stringify(dir)})));`], { encoding: "utf8", env: baseEnv() });
    expect(post.stdout).toBe("true");
    assertHealed();
    expect(launcher()).toContain(`_tk_j='${join(dir, "dist", "bin", "tkr-shim.js")}'`);
    expectAllShellsWork();
    const moved = join(root, "npm2");
    const movedDir = join(moved, "lib", "node_modules", "@tokmizer", "plugin");
    newPackage(movedDir);
    mkdirSync(join(moved, "bin"));
    symlinkSync(join(movedDir, "dist", "bin", "tkr.js"), join(moved, "bin", "tkr"));
    rmSync(prefix, { recursive: true });
    for (const shell of shells) expectWorks(runIn(shell, "agent", { PATH: `${join(tkrHome, "shims")}:${join(moved, "bin")}:/usr/bin:/bin:${nodeDir}` }));
    expect(tkr(join(moved, "bin", "tkr"), ["status"], { PATH: `${join(moved, "bin")}:/usr/bin:/bin:${nodeDir}` }).status).toBe(0);
    expect(launcher()).toContain(`_tk_j='${join(movedDir, "dist", "bin", "tkr-shim.js")}'`);
  });

  it("Homebrew prefix: shims point at the opt link and survive brew cleanup", () => {
    const brew = join(root, "brew");
    const cellar = (v: string) => join(brew, "Cellar", "tokmizer", v);
    const pluginIn = (v: string) => join(cellar(v), "libexec", "lib", "node_modules", "@tokmizer", "plugin");
    const link = (v: string) => {
      rmSync(join(brew, "opt", "tokmizer"), { force: true });
      mkdirSync(join(brew, "opt"), { recursive: true });
      symlinkSync(cellar(v), join(brew, "opt", "tokmizer"));
      mkdirSync(join(brew, "bin"), { recursive: true });
      rmSync(join(brew, "bin", "tkr"), { force: true });
      symlinkSync(join(pluginIn(v), "dist", "bin", "tkr.js"), join(brew, "bin", "tkr"));
    };
    writeOldInstall("0.9.58", oldStub(pluginIn("0.9.58")));
    link("0.9.58");
    newPackage(pluginIn(NEW));
    link(NEW);
    rmSync(cellar("0.9.58"), { recursive: true });
    expect(tkr(join(brew, "bin", "tkr"), ["status"], { PATH: `${join(brew, "bin")}:/usr/bin:/bin:${nodeDir}` }).status).toBe(0);
    assertHealed();
    expect(launcher()).toContain(`_tk_j='${join(brew, "opt", "tokmizer", "libexec", "lib", "node_modules", "@tokmizer", "plugin", "dist", "bin", "tkr-shim.js")}'`);
    newPackage(pluginIn("0.9.60"));
    link("0.9.60");
    rmSync(cellar(NEW), { recursive: true });
    expectAllShellsWork();
  });

  it.skipIf(!single)("standalone install: single binary shims survive a version swap", () => {
    const share = join(home, ".local", "share", "tokmizer");
    const version = (v: string) => {
      const bin = join(share, `tokmizer-${v}`, "dist", "bin");
      mkdirSync(bin, { recursive: true });
      cpSync(single!, join(bin, "tkr"));
      chmodSync(join(bin, "tkr"), 0o755);
      rmSync(join(share, "current"), { force: true });
      symlinkSync(`tokmizer-${v}`, join(share, "current"));
    };
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    version("0.9.58");
    symlinkSync(join(share, "current", "dist", "bin", "tkr"), join(home, ".local", "bin", "tkr"));
    writeOldInstall("0.9.58-single", join(home, ".local", "bin", "tkr"));
    version(NEW);
    rmSync(join(share, "tokmizer-0.9.58"), { recursive: true });
    expect(tkr(join(home, ".local", "bin", "tkr"), ["shims-heal"], { PATH: `${join(home, ".local", "bin")}:/usr/bin:/bin` }).status).toBe(0);
    assertHealed();
    expect(launcher()).toContain(`_tk_s='${join(home, ".local", "bin", "tkr")}'`);
    expectAllShellsWork();
  });

  it("uninstall leaves every shell working and removes the PATH lines", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    newPackage(join(cache, NEW));
    expect(sessionStart(join(cache, NEW)).status).toBe(0);
    const r = tkr(join(cache, NEW, "dist", "bin", "tkr.js"), ["shim", "uninstall"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(tkrHome, "shims", "cat"))).toBe(false);
    expect(existsSync(join(tkrHome, "bin", "tkr-shim-launch"))).toBe(false);
    expectAllShellsWork();
  });

  it("kill switch: the fail-open flag sends every command straight to the real binary", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    newPackage(join(cache, NEW));
    expect(sessionStart(join(cache, NEW)).status).toBe(0);
    writeFileSync(join(tkrHome, "fail-open"), "1");
    rmSync(join(cache, NEW), { recursive: true });
    expectAllShellsWork();
    expect(existsSync(join(tkrHome, "shim-fallbacks"))).toBe(false);
  });

  it("login and interactive shells keep working when the user opted into the global PATH", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    newPackage(join(cache, NEW));
    rmSync(join(cache, "0.9.58"), { recursive: true });
    const entry = join(cache, NEW, "dist", "bin", "tkr.js");
    expect(tkr(entry, ["shim", "global-path", "on"], { SHELL: "/bin/zsh" }).status).toBe(0);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(join(tkrHome, "shims"));
    expect(sessionStart(join(cache, NEW)).status).toBe(0);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(join(tkrHome, "shims"));
    for (const [shell, args] of [["zsh", ["-l", "-c"]], ["zsh", ["-i", "-c"]], ["bash", ["-l", "-c"]], ["bash", ["-i", "-c"]]] as const) {
      if (!shells.includes(shell)) continue;
      const r = spawnSync(`/bin/${shell}`, [...args, `cat '${sample}'`], { encoding: "utf8", timeout: 30000, env: baseEnv({ CURSOR_VERSION: "1" }) });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("payload\n");
      expect(r.stderr).not.toContain(HINT);
    }
    expect(tkr(entry, ["shim", "global-path", "off"]).status).toBe(0);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).not.toContain(join(tkrHome, "shims"));
  });

  it("hooks pointing at a missing install exit 0 without output, and the kill switch stops rewrites", () => {
    const missing = join(root, "gone", "tkr-codex-hook");
    const missingJs = join(root, "gone", "tkr-codex-hook.js");
    for (const command of [`[ ! -x '${missing}' ] || exec '${missing}'`, `[ ! -f '${missingJs}' ] || exec node '${missingJs}'`, `[ ! -x '${missing}' ] || exec '${missing}' --pre-tool-use`]) {
      const r = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }), encoding: "utf8", env: baseEnv() });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, session_id: "s", hook_event_name: "PreToolUse" });
    const hook = join(pkg, "dist", "hooks-host", "pre-tool-use.js");
    const before = spawnSync(process.execPath, [hook], { input: payload, encoding: "utf8", env: baseEnv() });
    expect(before.status).toBe(0);
    mkdirSync(tkrHome, { recursive: true });
    writeFileSync(join(tkrHome, "fail-open"), "1");
    const after = spawnSync(process.execPath, [hook], { input: payload, encoding: "utf8", env: baseEnv() });
    expect(after.status).toBe(0);
    expect(after.stdout).not.toContain("updatedInput");
    if (before.stdout.includes("updatedInput")) expect(after.stdout).not.toBe(before.stdout);
  });

  it("a symlinked shell profile keeps its link when the old PATH line is removed", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    const dotfiles = join(root, "dotfiles");
    mkdirSync(dotfiles);
    cpSync(join(home, ".zshrc"), join(dotfiles, "zshrc"));
    rmSync(join(home, ".zshrc"));
    symlinkSync(join(dotfiles, "zshrc"), join(home, ".zshrc"));
    newPackage(join(cache, NEW));
    expect(sessionStart(join(cache, NEW)).status).toBe(0);
    expect(lstatSync(join(home, ".zshrc")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, ".zshrc"))).toBe(join(dotfiles, "zshrc"));
    expect(readFileSync(join(dotfiles, "zshrc"), "utf8")).toBe("export KEEP=1\n");
    expect(readdirSync(dotfiles)).toEqual(["zshrc"]);
    expect(readdirSync(join(tkrHome, "backup", "rc")).some((f) => f.startsWith(".zshrc-"))).toBe(true);
  });

  it("agent hooks keep one command string across upgrades, run without node on PATH, and exit 0 once the install is gone", () => {
    const first = join(root, "npm", "lib", "node_modules", "@tokmizer", "plugin");
    const withNativeExec = (dir: string): void => {
      if (nativeExec) copyFileSync(nativeExec, join(dir, "dist", "bin", "tkr-exec"));
    };
    const rewritten = (out: string): void => {
      if (nativeExec || out) expect(out).toMatch(/tkr-(exec|run)/);
    };
    newPackage(first);
    withNativeExec(first);
    const codexFile = join(home, ".codex", "hooks.json");
    const setup = tkr(join(first, "dist", "bin", "tkr.js"), ["setup-codex"], { CODEX_HOME: join(home, ".codex") });
    expect(setup.status, setup.stderr).toBe(0);
    const command = (): string => JSON.parse(readFileSync(codexFile, "utf8")).hooks.PreToolUse[0].hooks[0].command;
    const before = command();
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", turn_id: "t1", model: "gpt-5.5", tool_name: "Bash", tool_input: { command: "git status" }, session_id: "s", cwd: root });
    const fire = () => spawnSync("/bin/sh", ["-c", command()], { input: payload, encoding: "utf8", timeout: 30000, env: baseEnv({ PATH: "/usr/bin:/bin" }) });
    const ran = fire();
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stderr).not.toContain("No such file");
    rewritten(ran.stdout);
    const second = join(root, "npm2", "lib", "node_modules", "@tokmizer", "plugin");
    newPackage(second);
    withNativeExec(second);
    rmSync(join(root, "npm"), { recursive: true });
    expect(tkr(join(second, "dist", "bin", "tkr.js"), ["setup-codex"], { CODEX_HOME: join(home, ".codex") }).status).toBe(0);
    expect(command()).toBe(before);
    rewritten(fire().stdout);
    rmSync(join(root, "npm2"), { recursive: true });
    const gone = fire();
    expect(gone.status).toBe(0);
    expect(gone.stdout).toBe("");
    rmSync(join(tkrHome, "bin"), { recursive: true });
    const noLauncher = fire();
    expect(noLauncher.status).toBe(0);
    expect(noLauncher.stdout).toBe("");
  });

  it("tkr uninstall removes hooks, shims and PATH lines and leaves every shell working", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    newPackage(join(cache, NEW));
    const entry = join(cache, NEW, "dist", "bin", "tkr.js");
    expect(tkr(entry, ["shim", "global-path", "on"], { SHELL: "/bin/zsh" }).status).toBe(0);
    expect(tkr(entry, ["setup-codex"], { CODEX_HOME: join(home, ".codex") }).status).toBe(0);
    const r = tkr(entry, ["uninstall"], { CODEX_HOME: join(home, ".codex") });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).not.toContain("tkr");
    expect(readFileSync(join(home, ".zshrc"), "utf8")).not.toContain(".tokmizer");
    expect(existsSync(join(tkrHome, "shims", "cat"))).toBe(false);
    expect(existsSync(join(tkrHome, "bin", "tkr-hook"))).toBe(false);
    expectAllShellsWork();
  });

  it("session and prompt hooks read large payloads without breaking the pipe, and stop waiting on a stuck stdin", async () => {
    const big = JSON.stringify({ prompt: "x".repeat(512 * 1024) });
    for (const hook of [join(pkg, "hooks", "on-session-start.mjs"), join(pkg, "dist", "hooks-host", "reducer-prompt-submit.js"), join(pkg, "dist", "hooks-host", "reducer-session-start.js")]) {
      const r = spawnSync(process.execPath, [hook], { input: big, encoding: "utf8", timeout: 30000, env: baseEnv({ TOKMIZER_CLAUDE_COMMANDS_DIR: join(root, "commands"), CLAUDE_PLUGIN_ROOT: pkg, TOKMIZER_NATIVE_EXEC: "0" }) });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
    }
    const { spawn } = await import("node:child_process");
    const started = Date.now();
    const code = await new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [join(pkg, "dist", "hooks-host", "pre-tool-use.js")], { stdio: ["pipe", "ignore", "ignore"], env: baseEnv() });
      child.stdin.write("{");
      child.on("close", (c) => done(c));
    });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(15000);
  }, 30000);

  it("ignores malformed cache folders and relative PATH entries, and never runs an unmarked recorded build", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    newPackage(join(cache, NEW));
    expect(sessionStart(join(cache, NEW)).status).toBe(0);
    rmSync(join(cache, NEW), { recursive: true });
    for (const bad of ["1.0.08", "01.2.3", "1.2.99999999"]) newPackage(join(cache, bad));
    const rel = join(root, "proj");
    newPackage(join(rel, "lib", "node_modules", "@tokmizer", "plugin"));
    mkdirSync(join(rel, "bin"));
    rmSync(stubLog, { force: true });
    for (const shell of shells) {
      const r = spawnSync(`/bin/${shell}`, ["-c", `cat '${sample}'`], { cwd: join(rel, "bin"), encoding: "utf8", timeout: 30000, env: baseEnv({ PATH: `${join(tkrHome, "shims")}:.:/usr/bin:/bin:${nodeDir}`, CURSOR_VERSION: "1" }) });
      expectWorks(r, true);
    }
  });

  it("two installed versions do not rewrite each other's shims", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    newPackage(join(cache, NEW));
    expect(sessionStart(join(cache, NEW)).status).toBe(0);
    const prefix = join(root, "npm", "lib", "node_modules", "@tokmizer", "plugin");
    newPackage(prefix);
    const shimBefore = readFileSync(join(tkrHome, "shims", "cat"), "utf8").replace("_tk_c='cat'\n", "_tk_c='cat'\n_tk_x=\n");
    writeFileSync(join(tkrHome, "shims", "cat"), shimBefore);
    expect(tkr(join(prefix, "dist", "bin", "tkr.js"), ["status"]).status).toBe(0);
    expect(readFileSync(join(tkrHome, "shims", "cat"), "utf8")).toBe(shimBefore);
    expect(readdirSync(join(tkrHome, "backup")).filter((n) => n.startsWith("shims-")).length).toBeLessThanOrEqual(3);
  });

  it("an expired kill switch is cleared by the next Tokmizer process and commands keep working meanwhile", () => {
    writeOldInstall("0.9.58", oldStub(join(cache, "0.9.58")));
    newPackage(join(cache, NEW));
    expect(sessionStart(join(cache, NEW)).status).toBe(0);
    writeFileSync(join(tkrHome, "fail-open"), "1");
    const old = new Date(Date.now() - 25 * 3600_000);
    utimesSync(join(tkrHome, "fail-open"), old, old);
    expectWorks(runIn("sh", "agent"));
    expect(tkr(join(cache, NEW, "dist", "bin", "tkr.js"), ["doctor"]).status).toBe(0);
    expect(existsSync(join(tkrHome, "fail-open"))).toBe(false);
    expectWorks(runIn("sh", "agent"));
  });

  it("SessionStart repairs an agent hook that points at a removed install", () => {
    const codex = join(home, ".codex");
    mkdirSync(codex, { recursive: true });
    const gone = join(root, "old", "dist", "bin", "tkr-codex-hook.js");
    writeFileSync(join(codex, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node '${gone}'`, timeout: 10 }] }] } }));
    newPackage(join(cache, NEW));
    const started = sessionStart(join(cache, NEW), { CODEX_HOME: codex });
    expect(started.stdout).toContain("Repaired the Codex hook");
    expect(started.stdout).toContain("/hooks");
    const command = JSON.parse(readFileSync(join(codex, "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;
    expect(command).toContain("tkr-hook' tkr-codex-hook");
  });

  it("kill switch with every shim installed never recurses through the shimmed tools", () => {
    newPackage(join(cache, NEW));
    const entry = join(cache, NEW, "dist", "bin", "tkr.js");
    expect(tkr(entry, ["shim", "install"]).status).toBe(0);
    expect(existsSync(join(tkrHome, "shims", "find"))).toBe(true);
    writeFileSync(join(tkrHome, "fail-open"), "1");
    for (const shell of shells) {
      for (const mode of ["agent", "wrapped"] as Mode[]) {
        expectWorks(runIn(shell, mode));
        const f = spawnSync(`/bin/${shell}`, ["-c", `find '${sample}'`], { encoding: "utf8", timeout: 10000, env: baseEnv({ PATH: shimPath(), ...MODE_ENV[mode] }) });
        expect(f.status).toBe(0);
        expect(f.stdout).toBe(`${sample}\n`);
      }
    }
    expect(tkr(entry, ["setup-codex"], { CODEX_HOME: join(home, ".codex") }).status).toBe(0);
    const command = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;
    rmSync(join(cache, NEW), { recursive: true });
    const hook = spawnSync("/bin/sh", ["-c", command], { input: "x".repeat(200000), encoding: "utf8", timeout: 10000, env: baseEnv({ PATH: shimPath(), CURSOR_VERSION: "1" }) });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe("");
  });
});

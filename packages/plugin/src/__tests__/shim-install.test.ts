import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync, readdirSync, statSync, symlinkSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installShims,
  uninstallShims,
  shimsDir,
  listShimmableCommands,
  ensurePathInRc,
  ensureShimPath,
  shellRcLine,
  powershellProfileSnippet,
  unixWrapperScript,
  windowsWrapperScript,
  resolveShimJsPath,
  refreshStaleShims,
  stripGlobalPathBlock,
  removeGlobalPathLines,
  setGlobalPath,
  globalPathOptedIn,
  countGlobalPathLines
} from "../shim/install";
import { launcherFile, launcherScript, parseLauncher, readLauncher, writeLauncher } from "../shim/launcher";
import { healIfStale, healInstall } from "../shim/heal";

let dir: string;
let origHome: string | undefined;
let shimRunner: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-shim-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
  shimRunner = join(dir, "shim-runner.js");
  writeFileSync(shimRunner, "// stub", { mode: 0o755 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
});

describe("shim install", () => {
  it("configures both interactive and login bash profiles", async () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/bin/bash";
    const home = vi.spyOn(os, "homedir").mockReturnValue(dir);
    const platform = vi.spyOn(os, "platform").mockReturnValue("darwin");
    writeFileSync(join(dir, ".profile"), "export EXISTING=value\n");
    try {
      expect((await ensureShimPath()).status).toBe("added");
      expect(readFileSync(join(dir, ".bashrc"), "utf8")).toContain(shimsDir());
      expect(readFileSync(join(dir, ".profile"), "utf8")).toContain(shimsDir());
      expect(readFileSync(join(dir, ".profile"), "utf8")).toContain("EXISTING=value");
      expect((await ensureShimPath()).status).toBe("present");
    } finally {
      home.mockRestore();
      platform.mockRestore();
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
    }
  });
  it("sets up fish in its own profile on a fresh account", async () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/usr/bin/fish";
    const home = vi.spyOn(os, "homedir").mockReturnValue(dir);
    const platform = vi.spyOn(os, "platform").mockReturnValue("linux");
    try {
      const result = await ensureShimPath();
      expect(result.status).toBe("added");
      expect(result.target).toBe(join(dir, ".config", "fish", "config.fish"));
      expect(readFileSync(result.target, "utf8")).toContain("set -gx PATH");
      expect(readFileSync(result.target, "utf8")).not.toContain("export PATH");
    } finally {
      home.mockRestore();
      platform.mockRestore();
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
    }
  });

  it("quotes paths without expanding shell substitutions in profiles", () => {
    if (process.platform === "win32") return;
    process.env.TOKMIZER_HOME = join(dir, "path $USER 'quoted'");
    const result = spawnSync("/bin/sh", ["-c", `${shellRcLine()}\nprintf '%s' "$PATH"`], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.split(":")[0]).toBe(shimsDir());
  });
  it("listShimmableCommands returns set including git npm docker", () => {
    const cmds = listShimmableCommands();
    expect(cmds).toContain("git");
    expect(cmds).toContain("npm");
    expect(cmds).toContain("docker");
    expect(cmds).toContain("kubectl");
    expect(cmds.length).toBeGreaterThanOrEqual(20);
  });

  it("shimsDir under TOKMIZER_HOME", () => {
    expect(shimsDir()).toBe(join(dir, "shims"));
  });

  it("installShims creates entry per command", async () => {
    const created = await installShims(shimRunner);
    expect(created.length).toBeGreaterThanOrEqual(20);
    const isWin = process.platform === "win32";
    const probe = isWin ? join(shimsDir(), "git.cmd") : join(shimsDir(), "git");
    expect(existsSync(probe)).toBe(true);
  });

  it("uninstallShims removes them", async () => {
    await installShims(shimRunner);
    const removed = await uninstallShims();
    expect(removed).toBeGreaterThanOrEqual(20);
    const isWin = process.platform === "win32";
    const probe = isWin ? join(shimsDir(), "git.cmd") : join(shimsDir(), "git");
    expect(existsSync(probe)).toBe(false);
  });

  it("shellRcLine contains export PATH and shims dir", () => {
    const line = shellRcLine();
    expect(line).toContain("export PATH=");
    expect(line).toContain(shimsDir());
  });

  it("ensurePathInRc adds marker to rc file", async () => {
    const rc = join(dir, ".zshrc");
    writeFileSync(rc, "# existing config\nexport FOO=bar\n");
    const r = await ensurePathInRc(rc);
    expect(r).toBe("added");
    expect(readFileSync(rc, "utf8")).toContain("tokmizer-shim PATH");
  });

  it.skipIf(process.platform === "win32")("ensurePathInRc keeps a linked rc file a link and keeps its permissions", async () => {
    const real = join(dir, "dotfiles-zshrc");
    writeFileSync(real, "export FOO=bar\n");
    chmodSync(real, 0o640);
    const rc = join(dir, ".zshrc");
    symlinkSync(real, rc);
    expect(await ensurePathInRc(rc)).toBe("added");
    expect(lstatSync(rc).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("tokmizer-shim PATH");
    expect(readFileSync(real, "utf8").startsWith("export FOO=bar\n")).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o640);
  });

  it("ensurePathInRc idempotent on second call", async () => {
    const rc = join(dir, ".zshrc");
    writeFileSync(rc, "x\n");
    await ensurePathInRc(rc);
    const r = await ensurePathInRc(rc);
    expect(r).toBe("present");
  });

  it("creates a missing profile for a fresh installation", async () => {
    const rc = join(dir, "fresh", ".bashrc");
    expect(await ensurePathInRc(rc)).toBe("added");
    expect(readFileSync(rc, "utf8")).toContain(shimsDir());
    expect(await ensurePathInRc(rc)).toBe("present");
  });

  it("powershellProfileSnippet emits $env:Path", () => {
    const snip = powershellProfileSnippet();
    expect(snip).toContain("$env:Path");
    expect(snip).toContain(shimsDir());
  });

  it("unixWrapperScript hands over to the stable launcher and never names a versioned install", () => {
    const s = unixWrapperScript("git");
    expect(s.startsWith("#!/bin/sh\n")).toBe(true);
    expect(s).toContain(`exec /bin/sh '${launcherFile()}' "$_tk_c" "$@"`);
    expect(s).not.toContain("node ");
  });

  it("windowsWrapperScript passes --as flag and forwards args", () => {
    const s = windowsWrapperScript("C:\\Program Files\\tok\\shim.js", "git");
    expect(s).toContain("@echo off");
    expect(s).toContain('--as "git" %*');
    expect(s.indexOf('if "%TOKMIZER_SHIM_ACTIVE%"=="git" goto tkpass')).toBeLessThan(s.indexOf('--as "git"'));
  });

  it("installed wrapper contains --as <cmd> (not symlink, no fork-bomb risk)", async () => {
    await installShims(shimRunner);
    const isWin = process.platform === "win32";
    const probe = isWin ? join(shimsDir(), "git.cmd") : join(shimsDir(), "git");
    const content = readFileSync(probe, "utf8");
    expect(content).toContain("git");
    if (isWin) expect(content).toContain(shimRunner);
    else expect(readLauncher()?.target.js).toBe(shimRunner);
  });

  it("resolveShimJsPath honors TOKMIZER_SHIM_JS env override", () => {
    const orig = process.env.TOKMIZER_SHIM_JS;
    process.env.TOKMIZER_SHIM_JS = "/custom/shim.js";
    try {
      expect(resolveShimJsPath()).toBe("/custom/shim.js");
    } finally {
      if (orig === undefined) delete process.env.TOKMIZER_SHIM_JS;
      else process.env.TOKMIZER_SHIM_JS = orig;
    }
  });
});

const HOST_VARS = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE", "CLAUDE_CODE_VERSION", "ANTHROPIC_CLAUDE_CODE",
  "CODEX_VERSION", "CODEX_CLI", "OPENAI_CODEX", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CURSOR_VERSION", "CURSOR_TRACE_ID", "CLINE_VERSION",
  "CLINE_API_KEY", "AIDER_VERSION", "AIDER_MODEL", "GEMINI_CLI_VERSION", "GEMINI_API_KEY",
  "WINDSURF_VERSION", "WINDSURF_USER", "GITHUB_COPILOT_VERSION", "COPILOT_INTEGRATION_ID"
];

describe.skipIf(process.platform === "win32")("unix shim fast path", () => {
  let realDir: string;
  let fakeNodeDir: string;

  beforeEach(() => {
    realDir = join(dir, "real");
    fakeNodeDir = join(dir, "fakenode");
    mkdirSync(realDir);
    mkdirSync(fakeNodeDir);
    writeFileSync(join(realDir, "tkfake"), '#!/bin/sh\necho "REAL $* PATH=$PATH"\n');
    chmodSync(join(realDir, "tkfake"), 0o755);
    writeFileSync(join(fakeNodeDir, "node"), '#!/bin/sh\necho "NODE $*"\n');
    chmodSync(join(fakeNodeDir, "node"), 0o755);
    mkdirSync(shimsDir(), { recursive: true });
    writeFileSync(join(shimsDir(), "tkfake"), unixWrapperScript("tkfake"));
    chmodSync(join(shimsDir(), "tkfake"), 0o755);
    return writeLauncher({ single: "", js: shimRunner, cache: "", node: "" });
  });

  function runShim(extra: Record<string, string>): string {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_VARS.includes(k)) env[k] = v;
    env.PATH = [shimsDir(), fakeNodeDir, realDir, "/usr/bin", "/bin"].join(":");
    Object.assign(env, extra);
    const r = spawnSync(join(shimsDir(), "tkfake"), ["a b", "c"], { env, encoding: "utf8" });
    return r.stdout;
  }

  it("execs the real command directly inside Claude Code, without the shim dir on PATH", () => {
    const out = runShim({ CLAUDECODE: "1" });
    expect(out.startsWith("REAL a b c PATH=")).toBe(true);
    expect(out).not.toContain(shimsDir());
    expect(out).toContain(realDir);
  });

  it("execs the real command directly inside Codex, whose hook wraps only the final segment", () => {
    expect(runShim({ CODEX_VERSION: "0.161.0" }).startsWith("REAL ")).toBe(true);
  });

  it("recognises Codex from its thread id alone", () => {
    expect(runShim({ CODEX_THREAD_ID: "t1" }).startsWith("REAL ")).toBe(true);
  });

  it("execs the real command directly for a plain shell whose stdout is not a terminal", () => {
    expect(runShim({}).startsWith("REAL ")).toBe(true);
  });

  it("finds the real command when the shim dir is on PATH under another spelling", () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_VARS.includes(k)) env[k] = v;
    env.PATH = [`${shimsDir()}/`, `${shimsDir()}/.`, fakeNodeDir, realDir, "/usr/bin", "/bin"].join(":");
    env.CLAUDECODE = "1";
    const r = spawnSync(join(shimsDir(), "tkfake"), ["x"], { env, encoding: "utf8", timeout: 5000 });
    expect(r.error).toBeUndefined();
    expect(r.stdout.startsWith("REAL x PATH=")).toBe(true);
  });

  it("reports a missing real command with exit 127 instead of looping", () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_VARS.includes(k)) env[k] = v;
    env.PATH = [shimsDir(), "/usr/bin", "/bin"].join(":");
    env.CLAUDECODE = "1";
    const r = spawnSync(join(shimsDir(), "tkfake"), [], { env, encoding: "utf8", timeout: 5000 });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("tkfake");
  });

  it("hands over to node for a host without native hooks", () => {
    expect(runShim({ CURSOR_TRACE_ID: "x" }).trim()).toBe(`NODE ${shimRunner} --as tkfake a b c`);
  });

  it("hands over to node inside an agent started with tkr wrap", () => {
    expect(runShim({ TOKMIZER_HOST: "aider" }).trim()).toBe(`NODE ${shimRunner} --as tkfake a b c`);
  });

  it("runs the real command with one hint when the recorded install is gone", () => {
    rmSync(shimRunner);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_VARS.includes(k)) env[k] = v;
    env.PATH = [shimsDir(), fakeNodeDir, realDir, "/usr/bin", "/bin"].join(":");
    env.CURSOR_TRACE_ID = "x";
    const r = spawnSync(join(shimsDir(), "tkfake"), ["a"], { env, encoding: "utf8", timeout: 5000 });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("REAL a PATH=")).toBe(true);
    expect(r.stderr).toBe("tokmizer: shim target missing, running command directly; run `tkr doctor --fix`\n");
  });

  it("goes straight to the real command when the fail-open flag is set", () => {
    writeFileSync(join(dir, "fail-open"), "1");
    expect(runShim({ CURSOR_TRACE_ID: "x" }).startsWith("REAL ")).toBe(true);
  });

  it("prefers the native-hook host when several host variables are set", () => {
    expect(runShim({ CLAUDECODE: "1", CURSOR_TRACE_ID: "x" }).startsWith("REAL ")).toBe(true);
  });

  function runFrom(entry: string, pathDirs: string[], extra: Record<string, string>) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_VARS.includes(k)) env[k] = v;
    env.PATH = [...pathDirs, "/usr/bin", "/bin"].join(":");
    Object.assign(env, extra);
    return spawnSync(entry, ["x"], { env, encoding: "utf8", timeout: 5000 });
  }

  it("skips a link to the shim placed in another PATH folder instead of running itself forever", () => {
    const linkDir = join(dir, "links");
    mkdirSync(linkDir);
    symlinkSync(join(shimsDir(), "tkfake"), join(linkDir, "tkfake"));
    const r = runFrom(join(linkDir, "tkfake"), [shimsDir(), linkDir, realDir], { CLAUDECODE: "1" });
    expect(r.error).toBeUndefined();
    expect(r.stdout.startsWith("REAL x PATH=")).toBe(true);
  });

  it("skips a copy of the shim placed in another PATH folder", () => {
    const copyDir = join(dir, "copies");
    mkdirSync(copyDir);
    writeFileSync(join(copyDir, "tkfake"), unixWrapperScript("tkfake"));
    chmodSync(join(copyDir, "tkfake"), 0o755);
    const r = runFrom(join(copyDir, "tkfake"), [copyDir, realDir], { CLAUDECODE: "1" });
    expect(r.error).toBeUndefined();
    expect(r.stdout.startsWith("REAL x PATH=")).toBe(true);
  });

  it("runs the real command when the runner re-enters the same shim", () => {
    const r = runFrom(join(shimsDir(), "tkfake"), [shimsDir(), fakeNodeDir, realDir], { CURSOR_TRACE_ID: "x", TOKMIZER_SHIM_ACTIVE: "tkfake" });
    expect(r.stdout.startsWith("REAL x PATH=")).toBe(true);
  });

  it("still hands another command over to node while one shim is running", () => {
    const r = runFrom(join(shimsDir(), "tkfake"), [shimsDir(), fakeNodeDir, realDir], { CURSOR_TRACE_ID: "x", TOKMIZER_SHIM_ACTIVE: "git" });
    expect(r.stdout.trim()).toBe(`NODE ${shimRunner} --as tkfake x`);
  });

  it("quotes paths that contain spaces and single quotes and reads them back", () => {
    const s = launcherScript({ single: "", js: "/a b/it's/tkr-shim.js", cache: "", node: "" });
    expect(s).toContain("_tk_j='/a b/it'\\''s/tkr-shim.js'");
    expect(parseLauncher(s)?.target.js).toBe("/a b/it's/tkr-shim.js");
  });
});

describe.skipIf(process.platform === "win32")("refreshStaleShims", () => {
  it("rewrites existing outdated shims and leaves absent ones absent", async () => {
    mkdirSync(shimsDir(), { recursive: true });
    const old = '#!/usr/bin/env bash\nexec node "/old/tkr-shim.js" --as "git" "$@"\n';
    writeFileSync(join(shimsDir(), "git"), old, { mode: 0o755 });
    expect(await refreshStaleShims(shimRunner)).toEqual({ stale: 1, rewritten: 1 });
    expect(readFileSync(join(shimsDir(), "git"), "utf8")).toBe(unixWrapperScript("git"));
    expect(existsSync(join(shimsDir(), "npm"))).toBe(false);
    const backups = readdirSync(join(dir, "backup"));
    expect(readFileSync(join(dir, "backup", backups[0]!, "git"), "utf8")).toBe(old);
  });

  it("does nothing when shims are current", async () => {
    await installShims(shimRunner);
    expect(await refreshStaleShims(shimRunner)).toEqual({ stale: 0, rewritten: 0 });
  });

  it("does nothing when no shim is installed", async () => {
    expect(await refreshStaleShims(shimRunner)).toEqual({ stale: 0, rewritten: 0 });
  });
});

describe.skipIf(process.platform === "win32")("healIfStale", () => {
  it("refreshes every shim and writes the launcher when the invoked one is outdated", async () => {
    mkdirSync(shimsDir(), { recursive: true });
    writeFileSync(join(shimsDir(), "git"), "#!/usr/bin/env bash\nold\n");
    writeFileSync(join(shimsDir(), "ls"), "#!/usr/bin/env bash\nold\n");
    await healIfStale(shimRunner, "git");
    expect(readFileSync(join(shimsDir(), "ls"), "utf8")).toBe(unixWrapperScript("ls"));
    expect(readLauncher()?.target.js).toBe(shimRunner);
  });

  it("leaves a healthy install alone", async () => {
    await installShims(shimRunner);
    writeFileSync(join(shimsDir(), "ls"), "#!/usr/bin/env bash\nold\n");
    await healIfStale(join(dir, "other.js"), "git");
    expect(readFileSync(join(shimsDir(), "ls"), "utf8")).toBe("#!/usr/bin/env bash\nold\n");
    expect(readLauncher()?.target.js).toBe(shimRunner);
  });

  it("retargets the launcher once the recorded install disappears", async () => {
    await installShims(shimRunner);
    rmSync(shimRunner);
    const other = join(dir, "other.js");
    writeFileSync(other, "");
    await healIfStale(other, "git");
    expect(readLauncher()?.target.js).toBe(other);
  });

  it("never records an npx cache path", async () => {
    const npx = join(dir, "_npx", "abc", "node_modules", "@tokmizer", "plugin", "dist", "bin", "tkr-shim.js");
    mkdirSync(join(npx, ".."), { recursive: true });
    writeFileSync(npx, "");
    await installShims(npx);
    expect(readLauncher()?.target.js).toBe("");
  });

  it("records the plugin cache folder instead of a versioned path", async () => {
    const js = join(dir, "cache", "tokmizer", "tokmizer", "0.9.59", "dist", "bin", "tkr-shim.js");
    mkdirSync(join(js, ".."), { recursive: true });
    writeFileSync(js, "");
    writeFileSync(join(js, "..", "tkr-shim.stable"), "1\n");
    await installShims(js);
    expect(readLauncher()?.target).toEqual({ single: "", js: "", cache: join(dir, "cache", "tokmizer", "tokmizer"), node: process.execPath });
    expect((await healInstall({ shimJs: js, dryRun: true })).launcher).toBe("ok");
  });
});

describe("global PATH line migration", () => {
  const block = () => `# tokmizer-shim PATH (managed by tokmizer)\nexport PATH='${shimsDir()}':"$PATH"\n`;
  const legacy = () => `# tokmizer-shim PATH (managed by tokmizer)\nexport PATH="${shimsDir()}:$PATH"\n`;

  it("removes exactly the blocks Tokmizer wrote and nothing else", () => {
    const user = "export A=1\n# tokmizer-shim PATH (managed by tokmizer)\nexport PATH='/elsewhere':\"$PATH\"\n";
    expect(stripGlobalPathBlock(`${user}\n${block()}`)).toEqual({ content: user, removed: 1 });
    expect(stripGlobalPathBlock(`${user}\n${legacy()}`)).toEqual({ content: user, removed: 1 });
    expect(stripGlobalPathBlock(`\n${block()}`)).toEqual({ content: "", removed: 1 });
    expect(stripGlobalPathBlock(`\n\n${block()}`)).toEqual({ content: "\n", removed: 1 });
    const edited = block().replace(`"$PATH"`, `"$PATH:/extra"`);
    expect(stripGlobalPathBlock(edited)).toEqual({ content: edited, removed: 0 });
    expect(stripGlobalPathBlock("a\r\n" + block().replace(/\n/g, "\r\n"))).toEqual({ content: "a\r\n", removed: 1 });
  });

  it("backs up, removes, records, and restores on undo", async () => {
    const home = vi.spyOn(os, "homedir").mockReturnValue(dir);
    const platform = vi.spyOn(os, "platform").mockReturnValue("darwin");
    try {
      writeFileSync(join(dir, ".zshrc"), `export KEEP=1\n\n${block()}`, { mode: 0o640 });
      mkdirSync(join(dir, ".config", "fish"), { recursive: true });
      writeFileSync(join(dir, ".config", "fish", "config.fish"), `\n# tokmizer-shim PATH (managed by tokmizer)\nset -gx PATH '${shimsDir()}' $PATH\n`);
      expect(await countGlobalPathLines()).toBe(2);
      const changed = await removeGlobalPathLines();
      expect(changed.sort()).toEqual([join(dir, ".config", "fish", "config.fish"), join(dir, ".zshrc")].sort());
      expect(readFileSync(join(dir, ".zshrc"), "utf8")).toBe("export KEEP=1\n");
      expect(statSync(join(dir, ".zshrc")).mode & 0o777).toBe(0o640);
      const backup = readdirSync(join(dir, "backup", "rc")).find((f) => f.startsWith(".zshrc-"))!;
      expect(statSync(join(dir, "backup", "rc", backup)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, "backup", "rc", backup), "utf8")).toBe(`export KEEP=1\n\n${block()}`);
      expect(await removeGlobalPathLines()).toEqual([]);
      const undo = await setGlobalPath(true);
      expect(undo.files.sort()).toEqual(changed.sort());
      expect(globalPathOptedIn()).toBe(true);
      expect(readFileSync(join(dir, ".zshrc"), "utf8")).toBe(`export KEEP=1\n\n${block()}`);
      expect(readFileSync(join(dir, ".config", "fish", "config.fish"), "utf8")).toContain(`set -gx PATH '${shimsDir()}' $PATH`);
      expect(await removeGlobalPathLines()).toEqual([]);
      expect((await setGlobalPath(false)).files.length).toBe(2);
      expect(globalPathOptedIn()).toBe(false);
      expect(await countGlobalPathLines()).toBe(0);
    } finally {
      home.mockRestore();
      platform.mockRestore();
    }
  });
});

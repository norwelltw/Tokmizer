import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPreToolUseOutput, rewriteAllowed, rewriteShellCommand, type HookHost } from "../hooks-host/pre-tool-rewrite";
import { execSkips, execUsable } from "../hooks-host/exec-health";
import { claudeShellNames, parseShellSnapshot, resolvableHead } from "../hooks-host/shell-heads";
import { processToolOutput } from "../hooks-host/post-tool-process";
import { codexHookResponse } from "../adapters/codex";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distHook = join(pluginRoot, "dist", "hooks-host", "pre-tool-use.js");
const distPostHook = join(pluginRoot, "dist", "hooks-host", "post-tool-use.js");
const distCodexHook = join(pluginRoot, "dist", "bin", "tkr-codex-hook.js");
const nativeBinary = process.env.TOKMIZER_NATIVE_TEST_BIN;
const singleBinary = process.env.TOKMIZER_SINGLE_TEST_BIN;

let root: string;
let home: string;
let config: string;
let project: string;
let bin: string;
let pathEnv: string;

function write(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

function tool(name: string, body = "#!/bin/sh\necho stub\n", mode = 0o755): string {
  const path = join(bin, name);
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
}

function snapshot(text: string, name = "snapshot-bash-1-a.sh"): void {
  write(join(config, "shell-snapshots", name), text);
}

function rewritten(cmd: string, host: HookHost = "claude-code", cwd = project): string | null {
  return rewriteShellCommand(cmd, { host, sessionId: "s", cwd, claudeDirs: { configDir: config }, pathEnv, permissionMode: "bypassPermissions" }, "tkr-exec", () => {});
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-rewrite-core-")));
  home = join(root, "home");
  config = join(home, ".claude");
  project = join(root, "project");
  bin = join(root, "bin");
  for (const dir of [home, config, project, bin]) mkdirSync(dir, { recursive: true });
  pathEnv = `${bin}:relative-dir`;
  for (const name of ["git", "ls", "cat", "grep", "npm", "seq", "conda", "bat"]) tool(name);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("CLAUDE_PROJECT_DIR", "");
  vi.stubEnv("TOKMIZER_HOME", join(home, ".tokmizer"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("H1: Claude Code updatedInput keeps every original field", () => {
  it("returns the whole tool_input with only the command replaced", () => {
    const input = { command: "git status", description: "Show status", timeout: 333333, dangerouslyDisableSandbox: true, run_in_background: false };
    const out = JSON.parse(buildPreToolUseOutput({ tool_name: "Bash", permission_mode: "bypassPermissions", session_id: "s", cwd: project, tool_input: input }, "claude-code", "tkr-exec", () => {}, { configDir: config }, pathEnv)!);
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, command: "tkr-exec git status" } } });
  });

  it("leaves background commands untouched", () => {
    const payload = { tool_name: "Bash", session_id: "s", cwd: project, tool_input: { command: "git status", run_in_background: true, timeout: 5 } };
    expect(buildPreToolUseOutput(payload, "claude-code", "tkr-exec", () => {}, { configDir: config }, pathEnv)).toBeNull();
  });
});

describe("H2: Claude Code allow rules keep working", () => {
  it("does not rewrite a command the user allowed, so the allow rule still applies", () => {
    write(join(config, "settings.json"), { permissions: { allow: ["Bash(git status:*)", "Read"] } });
    expect(rewriteAllowed("git status", "claude-code", project)).toBe(false);
    expect(rewriteAllowed("git status --short", "claude-code", project)).toBe(false);
    expect(rewriteAllowed("cd sub && git status", "claude-code", project)).toBe(false);
    expect(rewriteAllowed("git log", "claude-code", project)).toBe(true);
  });

  it("reads allow rules from every settings scope", () => {
    write(join(project, ".claude", "settings.local.json"), { permissions: { allow: ["Bash(npm test)"] } });
    expect(rewriteAllowed("npm test", "claude-code", project)).toBe(false);
    expect(rewriteAllowed("npm run build", "claude-code", project)).toBe(true);
  });

  it("keeps rewriting under a rule that allows every shell command, rewritten ones included", () => {
    for (const rule of ["Bash", "Bash(*)", " Bash( * ) "]) {
      write(join(config, "settings.json"), { permissions: { allow: [rule, "Bash(git status:*)"] } });
      expect(rewriteAllowed("git status", "claude-code", project), rule).toBe(true);
    }
  });

  it("never emits a permission decision, so deny and ask rules keep the last word", () => {
    write(join(config, "settings.json"), { permissions: { allow: ["Bash"], ask: ["Bash(git push:*)"], deny: ["Bash(rm:*)"] } });
    const payload = (command: string) => ({ tool_name: "Bash", permission_mode: "bypassPermissions", session_id: "s", cwd: project, tool_input: { command } });
    expect(buildPreToolUseOutput(payload("git push"), "claude-code", "tkr-exec", () => {}, { configDir: config }, pathEnv)).toBeNull();
    expect(buildPreToolUseOutput(payload("rm -rf x"), "claude-code", "tkr-exec", () => {}, { configDir: config }, pathEnv)).toBeNull();
    const out = JSON.parse(buildPreToolUseOutput(payload("git log"), "claude-code", "tkr-exec", () => {}, { configDir: config }, pathEnv)!);
    expect(out.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(out.hookSpecificOutput.updatedInput.command).toBe("tkr-exec git log");
  });

  it("does not rewrite when an allow rule would approve the rewritten command itself", () => {
    write(join(config, "settings.json"), { permissions: { allow: ["Bash(node:*)"] } });
    const run = (cmd: string) => rewriteShellCommand(cmd, { host: "claude-code", sessionId: "s", cwd: project, claudeDirs: { configDir: config }, pathEnv, permissionMode: "bypassPermissions" }, "node '/x/tkr-exec.js'", () => {});
    expect(run("git push --force origin main")).toBeNull();
    write(join(config, "settings.json"), { permissions: { allow: ["Bash(/x/*)"] } });
    expect(run("git push --force origin main")).toBeNull();
    write(join(config, "settings.json"), { permissions: { deny: ["Bash(tkr-exec.js:*)"] } });
    expect(run("git log")).toBeNull();
    write(join(config, "settings.json"), { permissions: { allow: ["Bash"] } });
    expect(run("git log")).toBe("node '/x/tkr-exec.js' git log");
    write(join(config, "settings.json"), { permissions: { allow: ["Bash", "Bash(node:*)"] } });
    expect(run("git push --force origin main")).toBeNull();
  });

  it("does not rewrite through a launcher path that allow rules could not match reliably", () => {
    const run = (exec: string) => rewriteShellCommand("git log", { host: "claude-code", sessionId: "s", cwd: project, claudeDirs: { configDir: config }, pathEnv, permissionMode: "bypassPermissions" }, exec, () => {});
    for (const exec of ["'/Users/o'\\''brien/tkr-exec'", "'C:/Program Files (x86)/tkr-exec.exe'", "'/a$b/tkr-exec'", "'/a;b/tkr-exec'"]) {
      expect(run(exec), exec).toBeNull();
    }
    expect(run("'/Users/al bert/tkr-exec'")).toBe("'/Users/al bert/tkr-exec' git log");
  });

  it("ignores blanket allows from settings Claude Code does not load", () => {
    const other = join(root, "other-config");
    write(join(home, ".claude", "settings.json"), { permissions: { allow: ["Bash"] } });
    write(join(other, "settings.json"), { permissions: { allow: ["Bash(git status:*)"] } });
    expect(rewriteAllowed("git status", "claude-code", project, { configDir: other })).toBe(false);
    rmSync(join(home, ".claude", "settings.json"));
    write(join(root, ".claude", "settings.local.json"), { permissions: { allow: ["Bash(*)"] } });
    write(join(project, ".claude", "settings.json"), { permissions: { allow: ["Bash(git status:*)"] } });
    expect(rewriteAllowed("git status", "claude-code", project, { projectDir: project })).toBe(false);
    expect(rewriteAllowed("git status", "claude-code", project, { projectDir: root })).toBe(false);
    rmSync(join(project, ".claude", "settings.json"));
    expect(rewriteAllowed("git status", "claude-code", project, { projectDir: root })).toBe(true);
  });

  it("never rewrites commands touching paths Claude Code protects", () => {
    write(join(config, "settings.json"), { permissions: { allow: ["Bash"] } });
    tool("tee");
    for (const cmd of ["echo x | tee -a ~/.zshrc", "cat .git/config", "ls ~/.claude/", "cat .mcp.json", "grep x .bashrc"]) {
      expect(rewritten(cmd), cmd).toBeNull();
    }
    expect(rewritten("cat .zsh''rc")).toBeNull();
    expect(rewritten("cat .gitignore")).toBe("tkr-exec cat .gitignore");
    expect(rewritten("cat cpu.profile x.mcp.json")).toBe("tkr-exec cat cpu.profile x.mcp.json");
  });

  it("does not rewrite when an allow list cannot be read", () => {
    write(join(config, "settings.json"), { permissions: { allow: "Bash(git status:*)" } });
    expect(rewriteAllowed("git log", "claude-code", project)).toBe(false);
  });
});

describe("H3: only commands that resolve to an executable on PATH are rewritten", () => {
  it("leaves functions, aliases and builtins untouched", () => {
    for (const cmd of ["myfn arg", "ll", "cd sub", "source env.sh", ". env.sh", "export A=1", "type ls", "printf x", "pwd", "which git", "builtin cd x", "command -v git", "nb list"]) {
      expect(rewritten(cmd), cmd).toBeNull();
    }
  });

  it("rewrites executables found on PATH, and only those segments", () => {
    expect(rewritten("git status")).toBe("tkr-exec git status");
    expect(rewritten("myfn a && git log")).toBe("myfn a && tkr-exec git log");
    expect(rewritten("bash -c 'myfn; ls'")).toBe("tkr-exec bash -c 'myfn; tkr-exec ls'");
  });

  it("skips files that are not runnable programs", () => {
    tool("plain", "echo no shebang\n");
    tool("noexec", "#!/bin/sh\n", 0o644);
    mkdirSync(join(bin, "dir"));
    for (const cmd of ["plain x", "noexec x", "dir x"]) expect(rewritten(cmd), cmd).toBeNull();
  });

  it("ignores relative PATH entries and odd command words", () => {
    mkdirSync(join(project, "relative-dir"));
    copyFileSync(join(bin, "git"), join(project, "relative-dir", "rel"));
    chmodSync(join(project, "relative-dir", "rel"), 0o755);
    for (const cmd of ["rel x", "'git' status", "~/bin/git status", "g\\it status"]) expect(rewritten(cmd), cmd).toBeNull();
  });

  it("resolves path commands against the payload cwd", () => {
    copyFileSync(join(bin, "git"), join(project, "gradlew"));
    chmodSync(join(project, "gradlew"), 0o755);
    expect(rewritten("./gradlew test")).toBe("tkr-exec ./gradlew test");
    expect(rewritten("./missing test")).toBeNull();
  });

  it("does not rewrite anything when PATH is unknown", () => {
    pathEnv = "";
    expect(rewritten("git status")).toBeNull();
  });

  it("respects functions and renaming aliases from Claude Code shell snapshots", () => {
    snapshot([
      "# Snapshot file",
      "# Functions",
      "eval $'conda () \\n{ \\n    echo fn\\n}' > /dev/null 2>&1",
      "# Shell Options",
      "# Aliases",
      "alias -- ls='ls -G'",
      "alias -- cat=bat",
      "# Check for rg availability",
      "function grep {",
      "}",
      "export PATH=/usr/bin"
    ].join("\n"));
    snapshot("# Functions\ngit () {\n\tcommand git \"$@\"\n}\n# Shell Options\n", "snapshot-zsh-2-b.sh");
    expect(rewritten("conda list")).toBeNull();
    expect(rewritten("git status")).toBeNull();
    expect(rewritten("cat README.md")).toBeNull();
    expect(rewritten("ls -la")).toBe("tkr-exec ls -la");
    expect(rewritten("grep x f")).toBe("tkr-exec grep x f");
    expect(rewritten("conda list", "opencode")).toBe("tkr-exec conda list");
  });

  it("parses both bash and zsh snapshot formats", () => {
    const names = { functions: new Set<string>(), aliases: new Map<string, string>(), paths: [] as string[], uncertain: false };
    parseShellSnapshot("# Functions\neval $'my-fn () \\n{ :; }'\nzfn () {\n\t:\n}\n# Aliases\nalias -- run-help=man\nalias -- ll='ls -la'\n", names);
    expect([...names.functions]).toEqual(["my-fn", "zfn"]);
    expect(Object.fromEntries(names.aliases)).toEqual({ "run-help": "man", ll: "ls -la" });
  });

  it("keeps reading functions after a heredoc comment line inside a zsh function", () => {
    snapshot("# Functions\nmkreadme () {\n\tcat <<EOF\n# Project\nEOF\n}\nnpm () {\n\tcommand npm \"$@\"\n}\n# Shell Options\n# Aliases\n");
    expect(rewritten("npm test")).toBeNull();
  });

  it("only treats cosmetic same-name aliases as harmless", () => {
    snapshot("# Aliases\nalias -- ls='ls -G'\nalias -- cat='cat --color=auto'\nalias -- grep='grep --color=auto --exclude-dir={.git,.svn}'\n");
    expect(rewritten("ls")).toBe("tkr-exec ls");
    expect(rewritten("cat f")).toBe("tkr-exec cat f");
    expect(rewritten("grep -rn x .")).toBeNull();
  });

  it("also resolves commands on the PATH exported by the shell snapshot", () => {
    const extra = join(root, "brew-bin");
    mkdirSync(extra);
    writeFileSync(join(extra, "rg"), "#!/bin/sh\n");
    chmodSync(join(extra, "rg"), 0o755);
    expect(rewritten("rg x")).toBeNull();
    snapshot(`# Functions\n# Shell Options\n# Aliases\nexport PATH='${extra}:/usr/bin'\n`);
    expect(rewritten("rg x")).toBe("tkr-exec rg x");
    expect(rewritten("rg x", "opencode")).toBeNull();
  });

  it("does not rewrite when a snapshot cannot be read", () => {
    snapshot("# Functions\n");
    chmodSync(join(config, "shell-snapshots", "snapshot-bash-1-a.sh"), 0o000);
    const readable = spawnSync("cat", [join(config, "shell-snapshots", "snapshot-bash-1-a.sh")]).status === 0;
    expect(claudeShellNames(config).uncertain).toBe(!readable);
    if (!readable) expect(rewritten("git status")).toBeNull();
  });

  it("resolves Windows commands through PATHEXT", () => {
    vi.stubEnv("PATHEXT", ".EXE;.CMD");
    writeFileSync(join(bin, "tool.exe"), "MZ");
    expect(resolvableHead("tool", undefined, bin, "win32")).toBe(true);
    expect(resolvableHead("absent", undefined, bin, "win32")).toBe(false);
  });
});

describe("M4: the launcher must be runnable before any rewrite", () => {
  const probe = () => join(home, ".tokmizer", "exec-probe.json");

  it("refuses a missing, non-executable or foreign binary and counts each skip", () => {
    expect(execUsable(join(bin, "absent"), "darwin", pathEnv, probe())).toBe(false);
    const foreign = tool("tkr-exec", Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]).toString("latin1"));
    expect(execUsable(foreign, "darwin", pathEnv, probe())).toBe(false);
    expect(execUsable(foreign, "darwin", pathEnv, probe())).toBe(false);
    chmodSync(foreign, 0o644);
    expect(execUsable(foreign, "darwin", pathEnv, probe())).toBe(false);
    expect(execSkips(probe())).toBe(3);
  });

  it("retries a failed probe after a minute instead of disabling rewrites for good", () => {
    const launcher = tool("tkr-exec", "#!/usr/bin/env node\n");
    const now = Date.now();
    expect(execUsable(launcher, "darwin", bin, probe(), now)).toBe(false);
    const record = JSON.parse(readFileSync(probe(), "utf8"));
    tool("node", "#!/bin/sh\n");
    expect(execUsable(launcher, "darwin", bin, probe(), now + 1000)).toBe(false);
    expect(readFileSync(probe(), "utf8")).toBe(JSON.stringify(record));
    expect(execUsable(launcher, "darwin", bin, probe(), now + 61_000)).toBe(true);
    expect(execSkips(probe())).toBe(1);
  });

  it("accepts a script launcher only when its interpreter is reachable", () => {
    const launcher = tool("launcher", "#!/usr/bin/env node\n");
    expect(execUsable(launcher, "darwin", pathEnv, probe())).toBe(false);
    expect(execUsable(launcher, "darwin", `${bin}:${dirname(process.execPath)}`, probe())).toBe(true);
  });

  it.skipIf(!nativeBinary || process.platform === "win32")("caches the probe of a working native launcher", () => {
    const copy = join(bin, "tkr-exec-native");
    copyFileSync(nativeBinary!, copy);
    chmodSync(copy, 0o755);
    expect(execUsable(copy, process.platform, pathEnv, probe())).toBe(true);
    const record = JSON.parse(readFileSync(probe(), "utf8"));
    expect(record).toMatchObject({ ok: true, skipped: 0 });
    expect(record.key.startsWith(`${copy}|`)).toBe(true);
    expect(execUsable(copy, process.platform, pathEnv, probe())).toBe(true);
  });
});

describe("L1: malformed payloads are ignored silently", () => {
  it("returns nothing for null, arrays and non-string fields", async () => {
    for (const payload of [null, [], 42, "x", { tool_name: "Bash", tool_input: null }, { tool_name: "Bash", tool_input: "git status" }, { tool_name: "Bash", tool_input: { command: 5 } }]) {
      expect(buildPreToolUseOutput(payload as never, "claude-code", "tkr-exec", () => {}, { configDir: config }, pathEnv)).toBeNull();
      expect(buildPreToolUseOutput(payload as never, "codex", "tkr-exec", () => {}, { configDir: config }, pathEnv)).toBeNull();
    }
    for (const payload of [null, [], { tool_name: "Bash", tool_input: { command: 5 }, tool_response: "x" }, { tool_name: 3 }, { tool_name: "Read", tool_input: "x" }]) {
      expect(await processToolOutput(payload as never)).toBeNull();
    }
    expect(await codexHookResponse("null")).toBe(JSON.stringify({ action: "continue" }));
    expect(await codexHookResponse("[]")).toBe(JSON.stringify({ action: "continue" }));
    expect(await codexHookResponse(JSON.stringify({ event: "after_tool_call", tool: "shell", command: 5, args: "x", stdout: 3 }))).toBe(JSON.stringify({ action: "continue" }));
  });
});

describe.skipIf(process.platform === "win32" || !existsSync(distHook))("installed hook entrypoints in an isolated home", () => {
  function entryEnv(): NodeJS.ProcessEnv {
    return {
      HOME: home,
      TOKMIZER_HOME: join(home, ".tokmizer"),
      CLAUDE_CONFIG_DIR: config,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: root,
      TOKMIZER_AUTO_UPDATE: "0",
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
      TOKMIZER_TEST_FORBIDDEN_HOME: process.env.TOKMIZER_TEST_FORBIDDEN_HOME ?? "",
      TOKMIZER_TEST_VIOLATIONS: process.env.TOKMIZER_TEST_VIOLATIONS ?? ""
    };
  }

  const entries: [string, string, string[]][] = [
    ["node script", process.execPath, [distHook]],
    ...(singleBinary ? [["single binary", singleBinary, ["hook", "pre-tool-use"]] as [string, string, string[]]] : [])
  ];

  it.each(entries)("%s keeps fields, allow rules and shell functions intact", (_label, command, args) => {
    snapshot("# Functions\neval $'myfn () \\n{ \\n    echo fn\\n}'\n# Aliases\nalias -- ll='ls -la'\n");
    write(join(config, "settings.json"), { permissions: { allow: ["Bash(git status:*)"] } });
    const run = (input: unknown) => spawnSync(command, args, { input: typeof input === "string" ? input : JSON.stringify(input), env: entryEnv(), cwd: project, encoding: "utf8", timeout: 20000 });
    const payload = (tool_input: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "bypassPermissions", session_id: "s", cwd: project, tool_input });

    const kept = run(payload({ command: "git log -n 1", description: "log", timeout: 333333, dangerouslyDisableSandbox: true }));
    expect(kept.status).toBe(0);
    expect(kept.stderr).toBe("");
    const updated = JSON.parse(kept.stdout).hookSpecificOutput.updatedInput;
    expect(updated).toMatchObject({ description: "log", timeout: 333333, dangerouslyDisableSandbox: true });
    expect(updated.command).toMatch(/tkr-exec' git log -n 1$|' exec git log -n 1$/);

    for (const cmd of ["git status", "myfn arg", "ll", "cd sub", "source x"]) {
      const r = run(payload({ command: cmd }));
      expect([r.status, r.stdout, r.stderr], cmd).toEqual([0, "", ""]);
    }
    for (const raw of ["null", "[]", "42", JSON.stringify(payload({ command: 5 })), JSON.stringify({ tool_name: "Bash", tool_input: "x" })]) {
      const r = run(raw);
      expect([r.status, r.stdout, r.stderr], raw).toEqual([0, "", ""]);
    }
  });

  it("post-tool-use and codex entries stay silent on malformed payloads", () => {
    for (const [script, raw] of [[distPostHook, "null"], [distPostHook, JSON.stringify({ tool_name: "Bash", tool_input: { command: 5 }, tool_response: { stdout: "x" } })], [distCodexHook, "null"], [distCodexHook, "[]"]] as const) {
      if (!existsSync(script)) continue;
      const r = spawnSync(process.execPath, [script], { input: raw, env: entryEnv(), cwd: project, encoding: "utf8", timeout: 20000 });
      expect([r.status, r.stderr], `${script} ${raw}`).toEqual([0, ""]);
    }
  });
});

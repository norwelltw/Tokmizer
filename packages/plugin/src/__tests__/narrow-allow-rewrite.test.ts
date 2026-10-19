import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPreToolUseOutput, claudeLaunchArgs, claudeLaunchRestricted, osPolicyPresent, registryAnswer, rewriteShellCommand, rewriteShellDecision } from "../hooks-host/pre-tool-rewrite";
import { routePreToolUse } from "../hooks-host/hook-router";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distHook = join(pluginRoot, "dist", "hooks-host", "pre-tool-use.js");
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

function settings(permissions: Record<string, unknown>, file = join(config, "settings.json")): void {
  write(file, { permissions });
}

function decide(cmd: string, mode: string | null = "default", exec: string | null = "tkr-exec", projectDir?: string) {
  return rewriteShellDecision(cmd, { host: "claude-code", sessionId: "s", cwd: project, claudeDirs: { configDir: config, projectDir }, pathEnv, permissionMode: mode ?? undefined }, exec, () => {});
}

function hook(tool_input: Record<string, unknown>, permission_mode = "default") {
  const out = buildPreToolUseOutput({ tool_name: "Bash", permission_mode, session_id: "s", cwd: project, tool_input }, "claude-code", "tkr-exec", () => {}, { configDir: config }, pathEnv);
  return out === null ? null : JSON.parse(out);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-narrow-allow-")));
  home = join(root, "home");
  config = join(home, ".claude");
  project = join(root, "project");
  bin = join(root, "bin");
  for (const dir of [home, config, project, bin]) mkdirSync(dir, { recursive: true });
  for (const name of ["pytest", "npx", "cargo", "git", "cat", "vitest", "make"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\necho stub\n");
    chmodSync(join(bin, name), 0o755);
  }
  pathEnv = bin;
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("CLAUDE_PROJECT_DIR", "");
  vi.stubEnv("CLAUDE_PID", "");
  vi.stubEnv("TOKMIZER_HOME", join(home, ".tokmizer"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("Claude Code default modes rewrite commands covered by a narrow allow rule", () => {
  it("rewrites and returns allow, keeping every other tool field", () => {
    settings({ allow: ["Bash(pytest:*)"] });
    expect(hook({ command: "pytest -x tests", description: "run", timeout: 120000, dangerouslyDisableSandbox: true })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Tokmizer: allowed by your rule Bash(pytest:*)",
        updatedInput: { command: "tkr-exec pytest -x tests", description: "run", timeout: 120000, dangerouslyDisableSandbox: true }
      }
    });
  });

  it("applies in default, acceptEdits and dontAsk only", () => {
    settings({ allow: ["Bash(pytest:*)"] });
    for (const mode of ["default", "acceptEdits", "dontAsk"]) expect(decide("pytest", mode), mode).toEqual({ command: "tkr-exec pytest", allowedBy: "Bash(pytest:*)" });
    for (const mode of ["auto", "plan", "manual", "", null]) expect(decide("pytest", mode), String(mode)).toBeNull();
  });

  it("accepts the space-star, colon-star and exact rule forms with Claude Code's meaning", () => {
    settings({ allow: ["Bash(npx vitest *)", "Bash(cargo build:*)", "Bash(make test)"] });
    expect(decide("npx vitest")?.command).toBe("tkr-exec npx vitest");
    expect(decide("npx vitest run --reporter=dot")?.command).toBe("tkr-exec npx vitest run --reporter=dot");
    expect(decide("cargo build --release")?.command).toBe("tkr-exec cargo build --release");
    expect(decide("make test")?.command).toBe("tkr-exec make test");
    expect(decide("make test-all")?.allowedBy).toBeUndefined();
    expect(decide("make test -j4")?.allowedBy).toBeUndefined();
    expect(decide("npx vitestx")?.allowedBy).toBeUndefined();
    expect(decide("cargo test")?.allowedBy).toBeUndefined();
  });

  it("keeps commands without a matching allow rule on PostToolUse", () => {
    expect(decide("pytest -x")).toEqual({ command: "tkr-exec pytest -x", ask: true });
    settings({ allow: ["Bash(cargo build:*)", "Read(*)"] });
    expect(decide("pytest -x")).toEqual({ command: "tkr-exec pytest -x", ask: true });
    expect(decide("git status")).toBeNull();
  });

  it("applies deny rules sent from the claude.ai console", () => {
    settings({ allow: ["Bash(pytest:*)"] });
    expect(decide("pytest -x")?.command).toBe("tkr-exec pytest -x");
    write(join(config, "remote-settings.json"), { permissions: { deny: ["Bash(pytest:*)"] } });
    expect(decide("pytest -x")).toBeNull();
    expect(rewriteShellCommand("pytest -x", { host: "claude-code", sessionId: "s", cwd: project, claudeDirs: { configDir: config }, pathEnv, permissionMode: "bypassPermissions" }, "tkr-exec", () => {})).toBeNull();
  });

  it("stops rewriting when console rules cannot be read", () => {
    write(join(config, "remote-settings.json"), "{ not json");
    expect(rewriteShellCommand("git status", { host: "claude-code", sessionId: "s", cwd: project, claudeDirs: { configDir: config }, pathEnv, permissionMode: "bypassPermissions" }, "tkr-exec", () => {})).toBeNull();
  });

  it("reads the registry answer: found, absent, unlaunchable or too slow", () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    expect(registryAnswer({ status: 0 })).toBe(true);
    expect(registryAnswer({ status: 1 })).toBe(false);
    expect(registryAnswer({ status: null, error: err("ENOENT") })).toBe(false);
    expect(registryAnswer({ status: null, error: err("ETIMEDOUT") })).toBe(true);
  });

  it("detects an operating system policy it cannot read", () => {
    const present = (paths: string[]) => (path: string) => paths.includes(path);
    expect(osPolicyPresent("darwin", present([]), () => false)).toBe(false);
    expect(osPolicyPresent("darwin", present(["/Library/Managed Preferences/com.anthropic.claudecode.plist"]), () => false)).toBe(true);
    expect(osPolicyPresent("darwin", present(["/Library/Managed Preferences/jo/com.anthropic.claudecode.plist"]), () => false, "jo")).toBe(true);
    expect(osPolicyPresent("win32", present([]), () => true)).toBe(true);
    expect(osPolicyPresent("win32", present([]), () => false)).toBe(false);
    expect(osPolicyPresent("linux", present([]), () => true, "", () => false)).toBe(false);
    expect(osPolicyPresent("linux", present([]), () => false, "", () => true)).toBe(true);
    expect(osPolicyPresent("linux", present(["/proc/sys/fs/binfmt_misc/WSLInterop", "/mnt/c/Program Files/ClaudeCode"]), () => false, "")).toBe(true);
    expect(osPolicyPresent("linux", present(["/mnt/c/Program Files/ClaudeCode"]), () => false, "")).toBe(false);
  });

  it("leaves a huge command untouched and answers quickly", () => {
    settings({ allow: ["Bash(*)"] });
    const huge = `git status ${"&& true ".repeat(40_000)}`;
    const started = Date.now();
    expect(rewriteShellCommand(huge, { host: "claude-code", sessionId: "s", cwd: project, claudeDirs: { configDir: config }, pathEnv, permissionMode: "bypassPermissions" }, "tkr-exec", () => {})).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect(rewriteShellCommand(`git status${" ".repeat(30_000)}`, { host: "claude-code", sessionId: "s", cwd: project, claudeDirs: { configDir: config }, pathEnv, permissionMode: "bypassPermissions" }, "tkr-exec", () => {})).toBe(`tkr-exec git status${" ".repeat(30_000)}`);
  });

  it("answers quickly for a command made of many words holding several equals signs", () => {
    const started = Date.now();
    expect(decide(`${Array(24).fill("a=a=a=a=a").join(" ")} ; git status`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("ignores allow rules with an inner wildcard, which are not narrow", () => {
    settings({ allow: ["Bash(npx * run)", "Bash(*test*)", "Bash(pytest  *)"] });
    for (const cmd of ["npx vitest run", "pytest", "pytest -x"]) expect(decide(cmd), cmd).toBeNull();
  });

  it("never rewrites when a deny or ask rule matches the original command", () => {
    settings({ allow: ["Bash(pytest:*)", "Bash(cargo build:*)"], deny: ["Bash(pytest --lf:*)"], ask: ["Bash(cargo build --release:*)"] });
    expect(decide("pytest --lf")).toBeNull();
    expect(decide("cargo build --release")).toBeNull();
    expect(decide("pytest -x")?.command).toBe("tkr-exec pytest -x");
    expect(decide("cargo build")?.command).toBe("tkr-exec cargo build");
  });

  it("never rewrites when a deny or ask rule matches the rewritten command", () => {
    settings({ allow: ["Bash(pytest:*)"], deny: ["Bash(tkr-exec:*)"] });
    expect(decide("pytest -x")).toBeNull();
    settings({ allow: ["Bash(pytest:*)"], ask: ["Bash(tkr-exec pytest:*)"] });
    expect(decide("pytest -x")).toBeNull();
  });

  it("honours deny and ask rules from project and unloaded settings files", () => {
    settings({ allow: ["Bash(pytest:*)"] });
    settings({ deny: ["Bash(pytest:*)"] }, join(project, ".claude", "settings.local.json"));
    expect(decide("pytest")).toBeNull();
    rmSync(join(project, ".claude"), { recursive: true });
    settings({ ask: ["Bash(pytest:*)"] }, join(root, ".claude", "settings.json"));
    expect(decide("pytest")).toBeNull();
  });

  it("does not let project settings grant a rewrite, like the blanket allow rule", () => {
    for (const file of ["settings.json", "settings.local.json"]) {
      const dir = join(project, ".claude");
      settings({ allow: ["Bash(pytest:*)"] }, join(dir, file));
      expect(decide("pytest", "default", "tkr-exec", project), file).toBeNull();
      expect(decide("pytest"), file).toBeNull();
      rmSync(dir, { recursive: true });
    }
  });

  it("ignores user settings in the home folder when CLAUDE_CONFIG_DIR points elsewhere", () => {
    const other = join(root, "other-config");
    mkdirSync(other);
    settings({ allow: ["Bash(pytest:*)"], deny: [] });
    const run = (cmd: string) => rewriteShellDecision(cmd, { host: "claude-code", sessionId: "s", cwd: project, claudeDirs: { configDir: other }, pathEnv, permissionMode: "default" }, "tkr-exec", () => {});
    expect(run("pytest")).toBeNull();
    settings({ allow: ["Bash(pytest:*)"] }, join(other, "settings.json"));
    expect(run("pytest")?.allowedBy).toBe("Bash(pytest:*)");
  });

  it("keeps protected paths untouched", () => {
    settings({ allow: ["Bash(cat:*)", "Bash(pytest:*)"] });
    for (const cmd of ["cat .claude/settings.json", "cat .git/config", "pytest .husky/x", "cat '.zshrc'"]) expect(decide(cmd), cmd).toBeNull();
    expect(decide("cat README.md")?.command).toBe("tkr-exec cat README.md");
  });

  it("rewrites when the launcher itself lives in the Claude Code plugin cache", () => {
    settings({ allow: ["Bash(pytest:*)"] });
    const exec = "'/Users/u/.claude/plugins/cache/tokmizer/tokmizer/0.9.62/dist/bin/tkr-exec'";
    expect(decide("pytest -x", "default", exec)).toEqual({ command: `${exec} pytest -x`, allowedBy: "Bash(pytest:*)" });
  });

  it("does not trust a narrow rule from the user-level settings.local.json", () => {
    settings({ allow: ["Bash(pytest:*)"] }, join(config, "settings.local.json"));
    expect(decide("pytest")).toBeNull();
  });

  it("does not rewrite a shell function or alias", () => {
    settings({ allow: ["Bash(pytest:*)", "Bash(vitest:*)"] });
    write(join(config, "shell-snapshots", "snapshot-zsh-1-a.sh"), "# Functions\npytest () {\n  command pytest -q \"$@\"\n}\n# Aliases\nalias -- vitest='vitest --run'\n");
    expect(decide("pytest -x")).toBeNull();
    expect(decide("vitest")).toBeNull();
  });

  it("does not rewrite a command that is not on PATH", () => {
    settings({ allow: ["Bash(ruff:*)"] });
    expect(decide("ruff check")).toBeNull();
  });

  it("only takes single plain commands, so Claude Code's per-subcommand checks are never skipped", () => {
    settings({ allow: ["Bash(pytest:*)", "Bash(cat:*)"] });
    for (const cmd of [
      "pytest && rm -rf x", "pytest || true", "pytest; echo", "pytest | tail -5", "pytest & echo", "pytest\necho",
      "pytest $(echo x)", "pytest `echo x`", "pytest > out.txt", "pytest 2>&1", "pytest < in", "cat ~/secret",
      "pytest tests/*.py", "pytest test?.py", "pytest [ab]", "pytest  -x", "pytest\t-x", " pytest", "pytest ",
      "FOO=1 pytest", "pytest \\\n-x", "pytest {a,b}", "pytest !x", "pytest # c", "(pytest)"
    ]) expect(decide(cmd), JSON.stringify(cmd)).toBeNull();
  });

  it("checks the launcher before rewriting", () => {
    settings({ allow: ["Bash(pytest:*)"] });
    expect(decide("pytest", "default", null)).toBeNull();
    expect(decide("pytest", "default", "tkr-exec; rm")).toBeNull();
  });

  it("fails open on unreadable settings", () => {
    write(join(config, "settings.json"), "{ not json");
    expect(decide("pytest")).toBeNull();
    write(join(config, "settings.json"), { permissions: { allow: ["Bash(pytest:*)"], deny: "Bash(x)" } });
    expect(decide("pytest")).toBeNull();
  });

  it("leaves bypassPermissions and blanket allow behaviour unchanged", () => {
    settings({ allow: ["Bash(pytest:*)"] });
    expect(hook({ command: "pytest" }, "bypassPermissions")).toBeNull();
    expect(hook({ command: "cargo build" }, "bypassPermissions")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "tkr-exec cargo build" } } });
    settings({ allow: ["Bash", "Bash(pytest:*)"] });
    expect(hook({ command: "cargo build" })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "tkr-exec cargo build" } } });
  });

  it("keeps the string API and counts usage once", () => {
    settings({ allow: ["Bash(pytest:*)"] });
    const usage: boolean[] = [];
    const ctx = { host: "claude-code" as const, sessionId: "s", cwd: project, claudeDirs: { configDir: config }, pathEnv, permissionMode: "default" };
    expect(rewriteShellCommand("pytest", ctx, "tkr-exec", (_s, routed) => usage.push(routed))).toBe("tkr-exec pytest");
    expect(rewriteShellCommand("cargo build", ctx, "tkr-exec", (_s, routed) => usage.push(routed))).toBeNull();
    expect(usage).toEqual([true, true]);
  });

  it("does not change other hosts", () => {
    settings({ allow: ["Bash(pytest:*)"] });
    const codex = (command: string) => buildPreToolUseOutput({ tool_name: "Bash", permission_mode: "default", session_id: "s", cwd: project, tool_input: { command } }, "codex", "tkr-exec", () => {}, { configDir: config }, pathEnv);
    expect(codex("pytest")).toBeNull();
    expect(JSON.parse(codex("cat README.md")!).hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "tkr-exec cat README.md" } });
  });

  it("gives the same answer through the hook router", () => {
    settings({ allow: ["Bash(pytest:*)"] });
    const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "default", session_id: "s", prompt_id: "p", cwd: project, tool_input: { command: "pytest -x" } };
    const direct = buildPreToolUseOutput(payload, "claude-code", "tkr-exec", () => {}, { configDir: config }, pathEnv);
    expect(direct).toContain("\"permissionDecision\":\"allow\"");
    expect(routePreToolUse(payload, "claude-code", { recordUsage: () => {}, claudeDirs: { configDir: config }, pathEnv })).toBe(
      buildPreToolUseOutput(payload, "claude-code", undefined, () => {}, { configDir: config }, pathEnv) ?? ""
    );
  });
});

describe.skipIf(process.platform === "win32" || !existsSync(distHook))("installed entrypoints answer a narrow allow rule the same way", () => {
  function entryEnv(): NodeJS.ProcessEnv {
    return {
      HOME: home,
      TOKMIZER_HOME: join(home, ".tokmizer"),
      CLAUDE_CONFIG_DIR: config,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: root,
      TOKMIZER_AUTO_UPDATE: "0",
      TOKMIZER_NETWORK: "0",
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
      TOKMIZER_TEST_FORBIDDEN_HOME: process.env.TOKMIZER_TEST_FORBIDDEN_HOME ?? "",
      TOKMIZER_TEST_VIOLATIONS: process.env.TOKMIZER_TEST_VIOLATIONS ?? ""
    };
  }

  const entries: [string, string, string[]][] = [
    ["node script", process.execPath, [distHook]],
    ...(singleBinary ? [["tkr hook pre-tool-use", singleBinary, ["hook", "pre-tool-use"]] as [string, string, string[]]] : [])
  ];

  it.each(entries)("%s", (_label, command, args) => {
    settings({ allow: ["Bash(pytest:*)"], deny: ["Bash(pytest --lf:*)"] });
    const run = (cmd: string, permission_mode = "default") => spawnSync(command, args, {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode, session_id: "s", cwd: project, tool_input: { command: cmd, timeout: 7, description: "d" } }),
      env: entryEnv(), cwd: project, encoding: "utf8", timeout: 20000
    });
    const allowed = run("pytest -x");
    expect([allowed.status, allowed.stderr]).toEqual([0, ""]);
    const out = JSON.parse(allowed.stdout).hookSpecificOutput;
    expect(out).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Tokmizer: allowed by your rule Bash(pytest:*)" });
    expect(out.updatedInput).toMatchObject({ timeout: 7, description: "d" });
    expect(out.updatedInput.command).toMatch(/(tkr-exec|tkr-run)' pytest -x$|' exec pytest -x$/);
    const asked = run("cargo build");
    expect([asked.status, asked.stderr]).toEqual([0, ""]);
    const askOut = JSON.parse(asked.stdout).hookSpecificOutput;
    expect(askOut).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "ask" });
    expect(askOut.updatedInput).toMatchObject({ timeout: 7, description: "d" });
    expect(askOut.updatedInput.command).toMatch(/(tkr-exec|tkr-run)' cargo build$|' exec cargo build$/);
    for (const [cmd, mode] of [["pytest --lf", "default"], ["pytest && true", "default"], ["pytest", "plan"]]) {
      const r = run(cmd!, mode);
      expect([r.status, r.stdout, r.stderr], cmd).toEqual([0, "", ""]);
    }
  });
});

describe("Claude Code launched with command-line permission flags", () => {
  const launched = (args: string | null) => (tool_input: Record<string, unknown>) => {
    const out = buildPreToolUseOutput({ tool_name: "Bash", permission_mode: "default", session_id: "s", cwd: project, tool_input }, "claude-code", "tkr-exec", () => {}, { configDir: config }, pathEnv, () => args);
    return out === null ? null : JSON.parse(out);
  };

  it("leaves the command to Claude Code when --disallowedTools, --settings or --setting-sources is set", () => {
    settings({ allow: ["Bash(git:*)"] });
    for (const args of [
      "claude -p push --disallowedTools Bash(git push:*)",
      "claude --disallowed-tools=Bash(git push:*) -p push",
      "node /x/cli.js --settings {\"permissions\":{\"deny\":[\"Bash(git push:*)\"]}}",
      "claude --settings=/tmp/s.json",
      "claude --setting-sources project",
      null
    ]) expect(launched(args)({ command: "git push origin main" }), String(args)).toBeNull();
    expect(launched("claude -p push --allowedTools Bash")({ command: "git push origin main" })?.hookSpecificOutput).toMatchObject({ permissionDecision: "allow", updatedInput: { command: "tkr-exec git push origin main" } });
  });

  it("also skips the blanket-allow and bypass rewrites", () => {
    settings({ allow: ["Bash"] });
    expect(launched("claude")({ command: "git push origin main" })?.hookSpecificOutput.updatedInput.command).toBe("tkr-exec git push origin main");
    expect(launched("claude --disallowedTools Bash(git push:*)")({ command: "git push origin main" })).toBeNull();
  });

  it("matches whole flags only", () => {
    expect(claudeLaunchRestricted("claude -p 'see --settingsfile' --allowedTools Bash")).toBe(false);
    expect(claudeLaunchRestricted("claude --settings x")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("reads the command line of the Claude Code process", () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", "--", "--disallowedTools", "Bash(git push:*)"], { stdio: "ignore" });
    const pid = String(child.pid);
    try {
      const args = claudeLaunchArgs({ CLAUDE_PID: pid }, "linux");
      expect(args).toContain("--disallowedTools Bash(git push:*)");
      expect(claudeLaunchRestricted(args)).toBe(true);
    } finally {
      child.kill();
    }
    expect(claudeLaunchArgs({ CLAUDE_PID: pid }, "win32")).toBeNull();
  });
});

describe("default mode build and test commands", () => {
  const fire = (tool_input: Record<string, unknown>, permission_mode = "default") => {
    const out = buildPreToolUseOutput({ tool_name: "Bash", permission_mode, session_id: "s", cwd: project, tool_input }, "claude-code", "tkr-exec", () => {}, { configDir: config }, pathEnv, () => "claude");
    return out === null ? null : JSON.parse(out).hookSpecificOutput;
  };

  it("asks once with the shortened command and keeps every other field", () => {
    settings({});
    expect(fire({ command: "cargo test", timeout: 9, description: "t" })).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: "Tokmizer shortens this command's output; nothing else changes.",
      updatedInput: { command: "tkr-exec cargo test", timeout: 9, description: "t" }
    });
  });

  it("leaves denied, asked and read-only commands to Claude Code", () => {
    settings({ deny: ["Bash(cargo test:*)"], ask: ["Bash(npm test:*)"] });
    expect(fire({ command: "cargo test" })).toBeNull();
    expect(fire({ command: "npm test" })).toBeNull();
    expect(fire({ command: "git status" })).toBeNull();
    expect(fire({ command: "cargo test" }, "plan")).toBeNull();
  });
});

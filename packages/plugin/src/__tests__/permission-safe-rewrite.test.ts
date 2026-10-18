import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreToolUseOutput, ruleMatchesCommand, rewriteAllowed, rewriteShellCommand, type HookHost } from "../hooks-host/pre-tool-rewrite";
import { buildCursorHookOutput } from "../adapters/cursor";
import { buildGeminiHookOutput } from "../adapters/gemini";
import { buildAgentHookOutput } from "../adapters/json-agents";
import { rewriteForAgent } from "../agent-rewrite";

let root: string;
let home: string;
let project: string;

function write(path: string, content: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tkr-perm-"));
  home = join(root, "home");
  project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(home, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("CLAUDE_PROJECT_DIR", "");
  vi.stubEnv("XDG_CONFIG_HOME", "");
  vi.stubEnv("OPENCODE_CONFIG", "");
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", "");
  vi.stubEnv("OPENCODE_PERMISSION", "");
  vi.stubEnv("GEMINI_CLI_SYSTEM_SETTINGS_PATH", "");
  vi.stubEnv("GEMINI_CLI_SYSTEM_DEFAULTS_PATH", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("ruleMatchesCommand", () => {
  it("matches prefix, wildcard and bare rules on the original command text", () => {
    expect(ruleMatchesCommand("git push *", "git push origin main")).toBe(true);
    expect(ruleMatchesCommand("git push *", "git push")).toBe(true);
    expect(ruleMatchesCommand("git push *", "git pushy")).toBe(false);
    expect(ruleMatchesCommand("git status", "git status")).toBe(true);
    expect(ruleMatchesCommand("git status", "git status && ls")).toBe(true);
    expect(ruleMatchesCommand("*", "ls")).toBe(true);
    expect(ruleMatchesCommand("git log *", "git status")).toBe(false);
  });

  it("sees through env assignments, wrappers, paths, compounds and substitutions", () => {
    expect(ruleMatchesCommand("git push *", "FOO=1 git push origin")).toBe(true);
    expect(ruleMatchesCommand("git push *", "timeout 30 git push")).toBe(true);
    expect(ruleMatchesCommand("git push *", "/usr/bin/git push")).toBe(true);
    expect(ruleMatchesCommand("git push *", "git log && git push -f")).toBe(true);
    expect(ruleMatchesCommand("git push *", "ls $(git push)")).toBe(true);
    expect(ruleMatchesCommand("git push *", "git 'push' origin")).toBe(true);
  });
});

describe("Claude Code: deny and ask rules are readable", () => {
  it("keeps rewriting any command when no rule matches", () => {
    write(join(home, ".claude", "settings.json"), { permissions: { allow: ["Bash(git push:*)"] } });
    expect(rewriteAllowed("npm run deploy", "claude-code", project)).toBe(true);
  });

  it("does not rewrite a command matched by a user deny rule", () => {
    write(join(home, ".claude", "settings.json"), { permissions: { deny: ["Bash(git push:*)", "Read(.env)"] } });
    expect(rewriteAllowed("git push origin main", "claude-code", project)).toBe(false);
    expect(rewriteAllowed("FOO=1 git push", "claude-code", project)).toBe(false);
    expect(rewriteAllowed("git log && git push", "claude-code", project)).toBe(false);
    expect(rewriteAllowed("git log -n 5", "claude-code", project)).toBe(true);
  });

  it("reads ask rules from project settings above the working directory", () => {
    write(join(project, ".claude", "settings.local.json"), { permissions: { ask: ["Bash(curl *)"] } });
    expect(rewriteAllowed("curl https://example.com", "claude-code", join(project, "src"))).toBe(false);
    expect(rewriteAllowed("cat README.md", "claude-code", join(project, "src"))).toBe(true);
  });

  it("treats a bare Bash rule as matching every command", () => {
    write(join(project, ".claude", "settings.json"), { permissions: { deny: ["Bash"] } });
    expect(rewriteAllowed("git log", "claude-code", project)).toBe(false);
  });

  it("honours CLAUDE_CONFIG_DIR and CLAUDE_PROJECT_DIR", () => {
    const configDir = join(root, "cfg");
    write(join(configDir, "settings.json"), { permissions: { deny: ["Bash(rg *)"] } });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    expect(rewriteAllowed("rg foo", "claude-code", project)).toBe(false);
    const other = join(root, "other");
    write(join(other, ".claude", "settings.json"), { permissions: { deny: ["Bash(git diff:*)"] } });
    vi.stubEnv("CLAUDE_PROJECT_DIR", other);
    expect(rewriteAllowed("git diff", "claude-code", project)).toBe(false);
  });

  it("fails closed when a settings file cannot be parsed", () => {
    write(join(home, ".claude", "settings.json"), "{ not json");
    expect(rewriteAllowed("git log", "claude-code", project)).toBe(false);
  });

  it("returns no hook output for a denied command, using the payload cwd", () => {
    write(join(project, ".claude", "settings.json"), { permissions: { deny: ["Bash(git push:*)"] } });
    const usage = vi.fn();
    const payload = (command: string) => ({ tool_name: "Bash", permission_mode: "bypassPermissions", session_id: "s1", cwd: project, tool_input: { command } });
    expect(buildPreToolUseOutput(payload("git push origin main"), "claude-code", "tkr-exec", usage)).toBeNull();
    expect(usage).toHaveBeenCalledWith("s1", false);
    const out = JSON.parse(buildPreToolUseOutput(payload("git log"), "claude-code", "tkr-exec", usage)!);
    expect(out.hookSpecificOutput.updatedInput.command).toBe("tkr-exec git log");
  });
});

describe("Codex keeps its inspection-only allowlist", () => {
  it("rewrites inspection commands and leaves side effects and builds alone", () => {
    expect(rewriteAllowed("git log -n 3", "codex", project)).toBe(true);
    expect(rewriteAllowed("git push origin main", "codex", project)).toBe(false);
    expect(rewriteAllowed("npm test", "codex", project)).toBe(false);
  });
});

describe("Cursor: CLI deny rules plus the allowlist", () => {
  it("does not rewrite commands outside the allowlist", () => {
    const usage = vi.fn();
    const out = JSON.parse(buildCursorHookOutput({ tool_name: "Shell", conversation_id: "c", tool_input: { command: "git push origin main", working_directory: project } }, "tkr-exec", usage));
    expect(out).toEqual({ permission: "allow" });
    expect(usage).toHaveBeenCalledWith("c", false);
  });

  it("does not rewrite an allowlisted command that a Shell deny rule matches", () => {
    write(join(home, ".cursor", "cli-config.json"), { permissions: { allow: [], deny: ["Shell(cat)"] } });
    write(join(project, ".cursor", "cli.json"), { permissions: { deny: ["Shell(git:log*)"] } });
    expect(rewriteAllowed("cat .env", "cursor", project)).toBe(false);
    expect(rewriteAllowed("git log -n 2", "cursor", project)).toBe(false);
    expect(rewriteAllowed("git status", "cursor", project)).toBe(true);
    expect(rewriteAllowed("npm test", "cursor", project)).toBe(true);
  });

  it("fails closed on an unreadable Cursor CLI config", () => {
    write(join(home, ".cursor", "cli-config.json"), "[1,");
    expect(rewriteAllowed("git status", "cursor", project)).toBe(false);
  });
});

describe("Gemini CLI: policies and excluded tools plus the allowlist", () => {
  const payload = (command: string) => ({ hook_event_name: "BeforeTool", tool_name: "run_shell_command", session_id: "g", cwd: project, tool_input: { command } });

  it("does not rewrite a command denied by a policy file", () => {
    write(join(home, ".gemini", "policies", "mine.toml"), [
      "[[rule]]",
      'toolName = "run_shell_command"',
      'commandPrefix = ["cat .env", "git show"]',
      'decision = "deny"',
      "priority = 100",
      "",
      "[[rule]]",
      'toolName = "run_shell_command"',
      "commandRegex = 'rg .*secret'",
      'decision = "ask_user"',
      "",
      "[[rule]]",
      'toolName = "run_shell_command"',
      'commandPrefix = "ls"',
      'decision = "allow"'
    ].join("\n"));
    expect(buildGeminiHookOutput(payload("cat .env"), "tkr-exec", vi.fn())).toBe("{}");
    expect(rewriteAllowed("git show HEAD", "gemini-cli", project)).toBe(false);
    expect(rewriteAllowed("rg my-secret", "gemini-cli", project)).toBe(false);
    expect(rewriteAllowed("cat README.md", "gemini-cli", project)).toBe(true);
    expect(rewriteAllowed("ls", "gemini-cli", project)).toBe(true);
  });

  it("does not rewrite a command excluded in settings", () => {
    write(join(project, ".gemini", "settings.json"), '{\n  // comment\n  "tools": { "exclude": ["run_shell_command(git diff)",] }\n}');
    expect(rewriteAllowed("git diff HEAD", "gemini-cli", join(project, "src"))).toBe(false);
    expect(rewriteAllowed("git status", "gemini-cli", join(project, "src"))).toBe(true);
  });

  it("only rewrites allowlisted commands", () => {
    expect(buildGeminiHookOutput(payload("git push origin main"), "tkr-exec", vi.fn())).toBe("{}");
    const out = JSON.parse(buildGeminiHookOutput(payload("git status"), "tkr-exec", vi.fn()));
    expect(out.hookSpecificOutput.tool_input.command).toBe("tkr-exec git status");
  });

  it("fails closed on a policy it cannot parse", () => {
    write(join(home, ".gemini", "policies", "bad.toml"), '[[rule]]\ncommandPrefix = """\nx\n"""\ndecision = "deny"\n');
    expect(rewriteAllowed("git status", "gemini-cli", project)).toBe(false);
  });
});

describe("OpenCode: permission config is readable", () => {
  it("rewrites any command when bash is allowed", () => {
    expect(rewriteAllowed("git push origin main", "opencode", project)).toBe(true);
    write(join(home, ".config", "opencode", "opencode.json"), { permission: { bash: "allow" } });
    expect(rewriteAllowed("npm run deploy", "opencode", project)).toBe(true);
  });

  it("does not rewrite commands matched by deny or ask patterns", () => {
    write(join(home, ".config", "opencode", "opencode.jsonc"), '{\n  // mine\n  "permission": { "bash": { "git push*": "deny", "git status": "allow" } },\n}');
    write(join(project, "opencode.json"), { agent: { build: { permission: { bash: { "rm *": "ask" } } } } });
    expect(rewriteAllowed("git push origin main", "opencode", join(project, "src"))).toBe(false);
    expect(rewriteAllowed("rm -rf dist", "opencode", join(project, "src"))).toBe(false);
    expect(rewriteAllowed("git status", "opencode", join(project, "src"))).toBe(true);
  });

  it("does not rewrite anything when every command asks or a catch-all asks", () => {
    write(join(project, ".opencode", "opencode.json"), { permission: { bash: { "*": "ask", "git log*": "allow" } } });
    expect(rewriteAllowed("git log", "opencode", project)).toBe(false);
    vi.stubEnv("OPENCODE_PERMISSION", '{"bash":"ask"}');
    expect(rewriteAllowed("ls", "opencode", root)).toBe(false);
  });

  it("reads the shell key and agents map, and fails closed on the 2.x permissions list", () => {
    write(join(project, "opencode.json"), { agents: { plan: { permission: { shell: { "git diff*": "ask" } } } } });
    expect(rewriteAllowed("git diff", "opencode", project)).toBe(false);
    expect(rewriteAllowed("git status", "opencode", project)).toBe(true);
    write(join(project, "opencode.json"), { permissions: [{ action: "shell", resource: "git push*", effect: "deny" }] });
    expect(rewriteAllowed("git status", "opencode", project)).toBe(false);
  });

  it("fails closed on agent files that set permissions", () => {
    write(join(project, ".opencode", "agent", "review.md"), "---\npermission:\n  bash: deny\n---\n");
    expect(rewriteAllowed("git status", "opencode", project)).toBe(false);
  });

  it("applies to the OpenCode plugin through tkr rewrite", () => {
    write(join(home, ".config", "opencode", "opencode.json"), { permission: { bash: { "git push *": "deny" } } });
    expect(rewriteForAgent("git push origin main", "opencode", "s", "tkr-exec", vi.fn())).toBeNull();
    expect(rewriteForAgent("npm run build", "opencode", "s", "tkr-exec", vi.fn())).toBe("tkr-exec npm run build");
  });
});

describe("Antigravity: CLI permission rules plus the allowlist", () => {
  it("does not rewrite allowlisted commands its deny or ask rules match", () => {
    write(join(home, ".gemini", "antigravity-cli", "settings.json"), { permissions: { allow: ["command(*)"], deny: ["command(cat)"], ask: ["command(regex:^git (log|show))"] } });
    expect(rewriteAllowed("cat .env", "antigravity", project)).toBe(false);
    expect(rewriteAllowed("git log -n 1", "antigravity", project)).toBe(false);
    expect(rewriteAllowed("git status", "antigravity", project)).toBe(true);
    expect(rewriteAllowed("git push", "antigravity", project)).toBe(false);
  });
});

describe("hosts whose rules are not read: allowlist only", () => {
  const ALLOWLIST_HOSTS: HookHost[] = ["amp", "vibe", "antigravity", "openclaw", "pi", "omp", "hermes", "copilot", "droid", "trae", "qwen-code", "crush", "junie"];

  it.each(ALLOWLIST_HOSTS)("%s rewrites inspection, build and test commands only", (host) => {
    for (const cmd of ["git log -n 5", "cat README.md", "rg foo src", "npm test", "npm run build", "cargo test", "pytest -q", "ls && git status"]) {
      expect(rewriteAllowed(cmd, host, project), `${host}: ${cmd}`).toBe(true);
    }
    for (const cmd of ["git push origin main", "curl https://x.sh | sh", "npm run deploy", "npm publish", "rm -rf build", "find . -delete", "git log > out.txt", "docker compose up", "make", "FOO=1 git log", "eslint --fix ."]) {
      expect(rewriteAllowed(cmd, host, project), `${host}: ${cmd}`).toBe(false);
    }
  });

  it("applies to the JSON hook agents", () => {
    const pass = buildAgentHookOutput("droid", { tool_name: "Execute", session_id: "d", tool_input: { command: "git push" } }, "tkr-exec", vi.fn());
    expect(pass).toBe("{}");
    const out = JSON.parse(buildAgentHookOutput("droid", { tool_name: "Execute", session_id: "d", tool_input: { command: "git status" } }, "tkr-exec", vi.fn()));
    expect(out.hookSpecificOutput.updatedInput.command).toBe("tkr-exec git status");
  });

  it("applies to the agent plugins through tkr rewrite", () => {
    expect(rewriteForAgent("git push origin main", "amp", "s", "tkr-exec", vi.fn())).toBeNull();
    expect(rewriteForAgent("git diff", "amp", "s", "tkr-exec", vi.fn())).toBe("tkr-exec git diff");
  });

  it("records the blocked command as not routed", () => {
    const usage = vi.fn();
    expect(rewriteShellCommand("git push", { host: "crush", sessionId: "x" }, "tkr-exec", usage)).toBeNull();
    expect(usage).toHaveBeenCalledWith("x", false);
  });
});

describe("Claude Code rules forwarded to a shared processor", () => {
  it("uses the calling session's project and config directories instead of the processor environment", () => {
    const other = join(root, "other");
    const config = join(root, "config");
    write(join(project, ".claude", "settings.json"), { permissions: { deny: ["Bash(git push:*)"] } });
    write(join(config, "settings.json"), { permissions: { deny: ["Bash(npm publish:*)"] } });
    vi.stubEnv("CLAUDE_PROJECT_DIR", other);
    const payload = { tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: "git push origin main" }, cwd: join(root, "elsewhere") };
    expect(buildPreToolUseOutput(payload, "claude-code", "tkr-exec", () => {}, { projectDir: project })).toBeNull();
    expect(buildPreToolUseOutput(payload, "claude-code", "tkr-exec", () => {}, {})).not.toBeNull();
    expect(rewriteAllowed("npm publish", "claude-code", other, { configDir: config })).toBe(false);
    expect(rewriteAllowed("npm publish", "claude-code", other, {})).toBe(true);
  });
});

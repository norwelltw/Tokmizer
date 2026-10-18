import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeExecutables, claudeHooksPresent, claudeSettingsFile, ensureClaudeHooks, removeClaudeHooks } from "../claude-hooks";

let dir: string;
const executables = { tkr: "/opt/tokmizer/bin/tkr", exec: "/opt/tokmizer/bin/tkr-exec" };

function settings(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeSettingsFile(), "utf8"));
}

function commands(): Record<string, string[]> {
  const hooks = settings().hooks as Record<string, { matcher: string; hooks: { command: string }[] }[]>;
  return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, groups.flatMap((g) => g.hooks.map((h) => `${g.matcher}|${h.command}`))]));
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tkr-claude-hooks-")));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, "claude"));
});

const safe = (path: string): string => `[ ! -x '${path}' ] || exec '${path}'`;

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("Claude Code hooks for the standalone executable", () => {
  it("routes every plugin hook through the standalone executables", async () => {
    expect(await ensureClaudeHooks(executables, "darwin")).toBe("added");
    expect(commands()).toEqual({
      SessionStart: [
        `|${safe("/opt/tokmizer/bin/tkr")} hook session-start`,
        `|${safe("/opt/tokmizer/bin/tkr")} hook reducer-session-start`,
        `|${safe("/opt/tokmizer/bin/tkr")} hook session-recap`
      ],
      UserPromptSubmit: [`|${safe("/opt/tokmizer/bin/tkr")} hook reducer-prompt-submit`],
      Stop: [`|${safe("/opt/tokmizer/bin/tkr")} hook reducer-stop`],
      UserPromptExpansion: [`|${safe("/opt/tokmizer/bin/tkr")} hook command-expansion`],
      PreToolUse: [`Bash|${safe("/opt/tokmizer/bin/tkr-exec")} --pre-tool-use`],
      PostToolUse: [`Read|Grep|Glob|Bash|${safe("/opt/tokmizer/bin/tkr-exec")} --post-tool-use`]
    });
    expect(claudeHooksPresent(settings())).toBe(true);
  });

  it("is idempotent, keeps user settings and hooks, and updates moved executables", async () => {
    mkdirSync(join(dir, "claude"), { recursive: true });
    writeFileSync(claudeSettingsFile(), JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }] } }));
    expect(await ensureClaudeHooks(executables, "darwin")).toBe("added");
    expect(await ensureClaudeHooks(executables, "darwin")).toBe("present");
    expect(await ensureClaudeHooks({ tkr: "/new/tkr", exec: "/new/tkr-exec" }, "darwin")).toBe("updated");
    expect(settings().model).toBe("opus");
    expect(commands().PreToolUse).toEqual(["Bash|my-guard", `Bash|${safe("/new/tkr-exec")} --pre-tool-use`]);
    expect(Object.values(commands()).flat().filter((c) => c.includes("/opt/"))).toEqual([]);
  });

  it("upgrades hooks written by 0.9.58 in place, without duplicates", async () => {
    mkdirSync(join(dir, "claude"), { recursive: true });
    writeFileSync(claudeSettingsFile(), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'/old/tkr-exec' --pre-tool-use", timeout: 5 }] }] } }));
    expect(await ensureClaudeHooks(executables, "darwin")).toBe("added");
    expect(commands().PreToolUse).toEqual([`Bash|${safe("/opt/tokmizer/bin/tkr-exec")} --pre-tool-use`]);
  });

  it("a hook whose executable is gone exits 0 without output", () => {
    const r = spawnSync("/bin/sh", ["-c", `${safe(join(dir, "gone", "tkr-exec"))} --pre-tool-use`], { input: "{}", encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("does not duplicate the hooks of an enabled Tokmizer plugin", async () => {
    mkdirSync(join(dir, "claude"), { recursive: true });
    writeFileSync(claudeSettingsFile(), JSON.stringify({ enabledPlugins: { "tokmizer@tokmizer": true } }));
    expect(await ensureClaudeHooks(executables, "darwin")).toBe("plugin");
    expect(settings().hooks).toBeUndefined();
  });

  it("refuses to rewrite invalid settings", async () => {
    mkdirSync(join(dir, "claude"), { recursive: true });
    writeFileSync(claudeSettingsFile(), "{ not json");
    expect(await ensureClaudeHooks(executables, "darwin")).toBe("error");
    expect(readFileSync(claudeSettingsFile(), "utf8")).toBe("{ not json");
  });

  it("removes only its own hooks", async () => {
    mkdirSync(join(dir, "claude"), { recursive: true });
    writeFileSync(claudeSettingsFile(), JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "notify" }] }] } }));
    await ensureClaudeHooks(executables, "darwin");
    expect(await removeClaudeHooks()).toBe("removed");
    expect(settings().hooks).toEqual({ Stop: [{ matcher: "", hooks: [{ type: "command", command: "notify" }] }] });
    expect(await removeClaudeHooks()).toBe("absent");
  });

  it("prefers the stable PATH links over the versioned install directory", () => {
    const real = join(dir, "share", "tokmizer-1.0.0", "dist", "bin");
    const bin = join(dir, "bin");
    mkdirSync(real, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(real, "tkr"), "");
    writeFileSync(join(real, "tkr-exec"), "");
    symlinkSync(join(real, "tkr"), join(bin, "tkr"));
    symlinkSync(join(real, "tkr-exec"), join(bin, "tkr-exec"));
    expect(claudeExecutables(`${bin}:/usr/bin`, "darwin", join(real, "tkr"))).toEqual({ tkr: join(bin, "tkr"), exec: join(bin, "tkr-exec") });
    expect(claudeExecutables("/usr/bin", "darwin", join(real, "tkr"))).toEqual({ tkr: join(real, "tkr"), exec: join(real, "tkr-exec") });
  });
});

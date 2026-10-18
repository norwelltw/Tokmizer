import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env.TOKMIZER_SINGLE_TEST_BIN;
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tkr-single-")));
  mkdirSync(join(home, ".tokmizer"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[], input = "", extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(binary!, args, {
    input,
    encoding: "utf8",
    timeout: 10000,
    env: { PATH: "/usr/bin:/bin", HOME: home, TOKMIZER_HOME: join(home, ".tokmizer"), TOKMIZER_BASE_URL: "http://127.0.0.1:9", TOKMIZER_AUTO_UPDATE: "0", ...extra }
  });
}

describe.skipIf(process.platform === "win32" || !binary)("standalone executable", () => {
  it("answers its probe with the package version", () => {
    expect(run(["--single-check"]).stdout).toBe(`tokmizer-single ${version}\n`);
  });

  it("runs the CLI by default", () => {
    const result = run(["help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: tkr");
  });

  it("runs wrapped commands and keeps their streams and status", () => {
    const result = run(["exec", "/bin/sh", "-c", "printf out; printf err >&2; exit 3"]);
    expect(result).toMatchObject({ status: 3, stdout: "out", stderr: "err" });
  });

  it("rewrites Claude Code commands through the exec entry", () => {
    const result = run(["hook", "pre-tool-use"], JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: "git status" } }));
    expect(result.status).toBe(0);
    const command = JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command as string;
    expect(command.endsWith(" git status")).toBe(true);
    expect(command.includes("node ")).toBe(false);
  });

  it("runs the plugin session hook without Node", () => {
    const result = run(["hook", "session-start"], "{}", { CLAUDE_PLUGIN_ROOT: join(home, "plugin") });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Tokmizer is on");
    expect(existsSync(join(home, ".tokmizer", "onboarded"))).toBe(true);
  });
});

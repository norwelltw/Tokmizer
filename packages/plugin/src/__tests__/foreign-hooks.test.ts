import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { foreignTo, hookForm } from "../hook-forms";
import { foreignFindingLines, foreignFindings, healForeignHooks, healTargets, stripForeign } from "../foreign-hooks";
import { configBackupFile } from "../config-backup";

const MARKS: [string, string, string][] = [
  ["tkr-codex-hook", "codex", "codex"],
  ["tkr-cursor-hook", "cursor", "cursor"],
  ["tkr-gemini-hook", "gemini-cli", "gemini"],
  ["tkr-copilot-hook", "copilot", "copilot"],
  ["tkr-droid-hook", "droid", "droid"],
  ["tkr-trae-hook", "trae", "trae"],
  ["tkr-qwen-hook", "qwen-code", "qwen"],
  ["tkr-crush-hook", "crush", "crush"],
  ["tkr-junie-hook", "junie", "junie"],
  ["tkr-zcode-hook", "zcode", "zcode"],
  ["tkr-grok-hook", "grok", "grok"]
];

describe("hookForm", () => {
  it.each(MARKS)("reads every install form of %s", (mark, host, word) => {
    for (const command of [
      `[ ! -f '/h/.tokmizer/bin/tkr-hook' ] || exec /bin/sh '/h/.tokmizer/bin/tkr-hook' ${mark}`,
      `'/opt/homebrew/bin/tkr' hook ${word}`,
      `"C:/Users/a/tkr.exe" hook ${word}`,
      `node '/usr/lib/node_modules/@tokmizer/plugin/dist/bin/${mark}.js'`
    ]) expect(hookForm(command), command).toBe(host);
  });

  it("reads the Claude Code, agent-hook and context forms", () => {
    expect(hookForm("'/opt/homebrew/bin/tkr-exec' --pre-tool-use")).toBe("claude-code");
    expect(hookForm("node \"/x/tokmizer/dist/hooks-host/pre-tool-use.js\"")).toBe("claude-code");
    expect(hookForm("[ ! -f '/h/.tokmizer/bin/tkr-hook' ] || exec /bin/sh '/h/.tokmizer/bin/tkr-hook' tkr-agent-hook vibe")).toBe("vibe");
    expect(hookForm("'/p/tkr' hook agent antigravity")).toBe("antigravity");
    expect(hookForm("'/p/tkr' hook context hso session tkr-context-hook")).toBe("context");
    for (const other of ["orca-hook.sh", "tkr-exec git status", "'/p/tkr' hook agent", "node /x/dist/hooks-host/pre-tool-use.js", 7, null]) expect(hookForm(other)).toBeNull();
  });

  it("calls a hook foreign only when it belongs to another agent", () => {
    const toGemini = foreignTo("gemini-cli");
    expect(toGemini("'/p/tkr' hook gemini")).toBe(false);
    expect(toGemini("'/p/tkr' hook context gemini session tkr-context-hook")).toBe(false);
    expect(toGemini("my-hook.sh")).toBe(false);
    expect(toGemini("'/p/tkr' hook codex")).toBe(true);
    expect(toGemini("'/p/tkr-exec' --pre-tool-use")).toBe(true);
  });
});

describe("stripForeign", () => {
  it("removes foreign entries in every hook file shape and keeps the rest", () => {
    const foreign = foreignTo("cursor");
    const cursor = { version: 1, hooks: { preToolUse: [{ command: "'/p/tkr' hook codex" }, { command: "mine.sh" }], stop: [{ command: "'/p/tkr-exec' --post-tool-use" }] } };
    expect(stripForeign(cursor, foreign)).toEqual(["'/p/tkr' hook codex", "'/p/tkr-exec' --post-tool-use"]);
    expect(cursor).toEqual({ version: 1, hooks: { preToolUse: [{ command: "mine.sh" }] } });
    const nested = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'/p/tkr' hook droid" }] }, { matcher: "x", hooks: [] }] }, mcpServers: { a: { command: "npx a" } } };
    expect(stripForeign(nested, foreign)).toEqual(["'/p/tkr' hook droid"]);
    expect(nested).toEqual({ hooks: { PreToolUse: [{ matcher: "x", hooks: [] }] }, mcpServers: { a: { command: "npx a" } } });
    const untouched = { hooks: { preToolUse: [{ command: "'/p/tkr' hook cursor" }] } };
    expect(stripForeign(untouched, foreign)).toEqual([]);
    expect(untouched.hooks.preToolUse).toHaveLength(1);
  });
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-foreign-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("GEMINI_CLI_HOME", "");
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  vi.stubEnv("QWEN_HOME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function write(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

describe("healForeignHooks", () => {
  it("swaps a hook copied from Claude Code into Gemini for the Gemini hook, once, with a backup", async () => {
    const file = join(home, ".gemini", "settings.json");
    const copied = { theme: "x", hooks: { BeforeTool: [{ matcher: "*", hooks: [{ type: "command", command: "'/p/tkr-exec' --pre-tool-use" }, { type: "command", command: "mine.sh" }] }] } };
    write(file, copied);
    const findings = foreignFindings();
    expect(findings.map((f) => [f.target.id, f.file, f.commands])).toEqual([["gemini", file, ["'/p/tkr-exec' --pre-tool-use"]]]);
    expect(foreignFindingLines(findings)[0]).toContain("1 Tokmizer hook made for another agent");
    const ensure = vi.fn(async (id: string) => {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      parsed.hooks.BeforeTool.push({ matcher: "run_shell_command", hooks: [{ type: "command", command: "'/p/tkr' hook gemini" }] });
      writeFileSync(file, JSON.stringify(parsed));
      return id === "gemini" ? "added" : "error";
    });
    const lines = await healForeignHooks(ensure, false);
    expect(ensure).toHaveBeenCalledWith("gemini");
    expect(lines).toEqual([`Replaced 1 Tokmizer hook copied from another agent in ${file} with the Gemini CLI hook (backup in ~/.tokmizer/backup/config).`]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      theme: "x",
      hooks: { BeforeTool: [{ matcher: "*", hooks: [{ type: "command", command: "mine.sh" }] }, { matcher: "run_shell_command", hooks: [{ type: "command", command: "'/p/tkr' hook gemini" }] }] }
    });
    expect(readFileSync(configBackupFile(file), "utf8")).toContain("--pre-tool-use");
    expect(foreignFindings()).toEqual([]);
    expect(await healForeignHooks(ensure, false)).toEqual([]);
  });

  it("leaves the copied hooks in place when the agent's own hook cannot be set up", async () => {
    const file = join(home, ".qwen", "settings.json");
    write(file, { hooks: { PreToolUse: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: "'/p/tkr' hook codex" }] }] } });
    expect(await healForeignHooks(async () => "error", false)).toEqual([]);
    expect(await healForeignHooks(async () => "error", true)).toEqual([expect.stringContaining("they still work, but the Qwen Code hook could not be set up (run: tkr setup-qwen)")]);
    expect(readFileSync(file, "utf8")).toContain("hook codex");
  });

  it("skips unreadable files and every agent's own hooks", async () => {
    write(join(home, ".cursor", "hooks.json"), { version: 1, hooks: { preToolUse: [{ command: "'/p/tkr' hook cursor" }] } });
    mkdirSync(join(home, ".factory"), { recursive: true });
    writeFileSync(join(home, ".factory", "hooks.json"), "{ nope");
    expect(foreignFindings()).toEqual([]);
  });

  it("covers every agent with a JSON hook file", () => {
    expect(healTargets().map((t) => t.id)).toEqual(["claude", "cursor", "gemini", "antigravity", "copilot", "droid", "trae", "qwen-code", "crush", "junie", "zcode", "grok"]);
  });
});

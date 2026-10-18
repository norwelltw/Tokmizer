import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hookCommandFor, isTokmizerHookCommand } from "../hook-config";
import { codexHookInstalled, codexHooksFile, ensureCodexHook, removeCodexHook } from "../codex-hooks";
import { cursorHookInstalled, cursorHooksFile, ensureCursorHook, removeCursorHook } from "../cursor-hooks";
import { ensureGeminiHook, geminiHookInstalled, geminiSettingsFile, removeGeminiHook } from "../gemini-hooks";
import { copilotHooksFile, jsonHookAgent } from "../agent-hooks";
import { ensureJsonHookIn, jsonHookInstalledIn, removeJsonHookFrom, type JsonHookSpec } from "../json-hooks";
import { CONTEXT_MARK } from "../context-hooks";

const ENV = ["HOME", "USERPROFILE", "CODEX_HOME", "GEMINI_CLI_HOME", "COPILOT_HOME", "TOKMIZER_SINGLE_BINARY"];
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-win-hooks-"));
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const OLD = String.raw`'C:\Users\Ann\AppData\Local\Tokmizer\0.9.58\tkr.exe'`;
const NEW = String.raw`'C:\Users\Ann\.local\bin\tkr.exe'`;
const win = (exe: string, words: string): string => `${exe} ${words}`;
const read = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const seed = (file: string, data: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
};

describe("isTokmizerHookCommand", () => {
  it("recognises the single-binary command whatever the quoting or separator", () => {
    for (const command of [
      win(OLD, "hook codex"),
      win(`"C:/Program Files/Tokmizer/TKR.EXE"`, "hook codex"),
      win(String.raw`C:\Tools\tkr.exe`, "hook  codex"),
      win(String.raw`'C:\Users\Ann\AppData\Roaming\npm\tkr.cmd'`, "hook codex"),
      win(String.raw`'C:\Users\O'\''Neil\tkr.exe'`, "hook codex"),
      "tkr hook codex",
      "/usr/local/bin/tkr hook codex --flag",
      "/bin/sh '/home/a/.tokmizer/bin/tkr-hook-launch' tkr-codex-hook"
    ]) {
      expect(isTokmizerHookCommand(command, "tkr-codex-hook"), command).toBe(true);
    }
  });

  it("rejects other hooks, other programs and lookalikes", () => {
    for (const command of [
      win(OLD, "hook cursor"),
      win(OLD, "hook codexx"),
      win(String.raw`'C:\x\notkr.exe'`, "hook codex"),
      win(String.raw`'C:\x\tkr.exe.bak'`, "hook codex"),
      "echo tkr hook codex",
      "./guard.sh",
      undefined,
      42
    ]) {
      expect(isTokmizerHookCommand(command, "tkr-codex-hook"), String(command)).toBe(false);
    }
  });

  it("recognises the command the Windows single binary actually writes", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const execPath = process.execPath;
    Object.defineProperty(process, "platform", { value: "win32" });
    process.execPath = String.raw`C:\Users\Ann\.local\bin\tkr.exe`;
    process.env.TOKMIZER_SINGLE_BINARY = "1";
    try {
      const command = hookCommandFor("tkr-codex-hook", "", "/pkg/dist/bin/tkr-codex-hook.js");
      expect(command).toBe(win(NEW, "hook codex"));
      expect(command).not.toContain("tkr-codex-hook");
      expect(isTokmizerHookCommand(command, "tkr-codex-hook")).toBe(true);
      expect(isTokmizerHookCommand(command, "tkr-gemini-hook")).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", platform);
      process.execPath = execPath;
    }
  });
});

describe("Windows single-binary hooks: no duplicates, removable, path changes collapse", () => {
  it("codex", async () => {
    process.env.CODEX_HOME = join(dir, ".codex");
    const user = { matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] };
    seed(codexHooksFile(), { hooks: { PreToolUse: [user, { matcher: "Bash", hooks: [{ type: "command", command: win(OLD, "hook codex"), timeout: 10 }] }, { matcher: "Bash", hooks: [{ type: "command", command: win(NEW, "hook codex"), timeout: 10 }] }] } });
    expect(codexHookInstalled()).toBe(true);
    expect(await ensureCodexHook(win(NEW, "hook codex"))).toBe("updated");
    expect(read(codexHooksFile()).hooks.PreToolUse).toEqual([user, { matcher: "Bash", hooks: [{ type: "command", command: win(NEW, "hook codex"), timeout: 10 }] }]);
    expect(await ensureCodexHook(win(NEW, "hook codex"))).toBe("present");
    expect(await removeCodexHook()).toBe("removed");
    expect(read(codexHooksFile()).hooks.PreToolUse).toEqual([user]);
    expect(await removeCodexHook()).toBe("absent");
  });

  it("cursor", async () => {
    seed(cursorHooksFile(), { version: 1, hooks: { preToolUse: [{ command: win(OLD, "hook cursor"), matcher: "Shell", timeout: 10 }, { command: "./mine.sh" }, { command: win(NEW, "hook cursor"), matcher: "Shell", timeout: 10 }] } });
    expect(await ensureCursorHook(win(NEW, "hook cursor"))).toBe("updated");
    expect(read(cursorHooksFile()).hooks.preToolUse).toEqual([{ command: win(NEW, "hook cursor"), matcher: "Shell", timeout: 10 }, { command: "./mine.sh" }]);
    expect(await ensureCursorHook(win(NEW, "hook cursor"))).toBe("present");
    expect(await removeCursorHook()).toBe("removed");
    expect(cursorHookInstalled()).toBe(false);
    expect(read(cursorHooksFile()).hooks.preToolUse).toEqual([{ command: "./mine.sh" }]);
  });

  it("gemini", async () => {
    seed(geminiSettingsFile(), { hooks: { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ name: "tokmizer", type: "command", command: win(OLD, "hook gemini"), timeout: 10000 }] }, { matcher: "run_shell_command", hooks: [{ name: "tokmizer", type: "command", command: win(NEW, "hook gemini"), timeout: 10000 }] }] } });
    expect(await ensureGeminiHook(win(NEW, "hook gemini"))).toBe("updated");
    expect(read(geminiSettingsFile()).hooks.BeforeTool).toHaveLength(1);
    expect(read(geminiSettingsFile()).hooks.BeforeTool[0].hooks[0].command).toBe(win(NEW, "hook gemini"));
    expect(await removeGeminiHook()).toBe("removed");
    expect(geminiHookInstalled()).toBe(false);
  });

  it("JSON hook agents", async () => {
    const copilot = jsonHookAgent("copilot")!;
    const entry = (command: string) => ({ type: "command", command, bash: command, powershell: command, timeout: 10, timeoutSec: 10 });
    seed(copilotHooksFile(), { version: 1, hooks: { PreToolUse: [entry(win(OLD, "hook copilot")), { type: "command", command: "./mine.sh" }, entry(win(NEW, "hook copilot"))] } });
    expect(copilot.installed()).toBe(true);
    expect(await copilot.ensure(win(NEW, "hook copilot"))).toBe("updated");
    expect(read(copilotHooksFile()).hooks.PreToolUse).toEqual([entry(win(NEW, "hook copilot")), { type: "command", command: "./mine.sh" }]);
    expect(await copilot.ensure(win(NEW, "hook copilot"))).toBe("present");
    expect(await copilot.remove()).toBe("removed");
    expect(copilot.installed()).toBe(false);
  });

  it("reducer context hooks", async () => {
    const file = join(dir, "hooks.json");
    const spec: JsonHookSpec = { mark: CONTEXT_MARK, event: "SessionStart", nested: true, matcher: "", entry: (command) => ({ type: "command", command, timeout: 10 }) };
    const old = win(OLD, "hook context hso session");
    const next = win(NEW, "hook context hso session");
    seed(file, { hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: old, timeout: 10 }] }, { matcher: "", hooks: [{ type: "command", command: "./mine.sh" }] }] } });
    expect(jsonHookInstalledIn(file, spec)).toBe(true);
    expect(await ensureJsonHookIn(file, spec, next)).toBe("updated");
    expect(read(file).hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command))).toEqual([next, "./mine.sh"]);
    expect(await removeJsonHookFrom(file, spec)).toBe("removed");
    expect(read(file).hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command))).toEqual(["./mine.sh"]);
  });
});

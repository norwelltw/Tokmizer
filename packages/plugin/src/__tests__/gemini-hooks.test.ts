import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configBackupFile } from "../config-backup";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGeminiHook, geminiHookCommand, geminiHookInstalled, geminiSettingsFile, removeGeminiHook } from "../gemini-hooks";

let dir: string;
let orig: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-gemini-"));
  orig = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (orig === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = orig;
});

const read = () => JSON.parse(readFileSync(geminiSettingsFile(), "utf8"));
const entry = (command: string) => ({
  matcher: "run_shell_command",
  hooks: [{ name: "tokmizer", type: "command", command, timeout: 10000 }]
});

describe("ensureGeminiHook", () => {
  it("creates ~/.gemini/settings.json with a BeforeTool entry on run_shell_command", async () => {
    expect(geminiSettingsFile()).toBe(join(dir, ".gemini", "settings.json"));
    expect(await ensureGeminiHook("/bin/tkr-gemini-hook")).toBe("added");
    expect(read()).toEqual({ hooks: { BeforeTool: [entry("/bin/tkr-gemini-hook")] } });
    expect(geminiHookInstalled()).toBe(true);
  });

  it("keeps every existing setting and hook and backs the file up first", async () => {
    const existing = {
      theme: "GitHub",
      general: { vimMode: true },
      hooks: {
        BeforeTool: [{ matcher: "write_file|replace", hooks: [{ name: "security-check", type: "command", command: "security.sh", timeout: 5000 }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "hello.sh" }] }]
      }
    };
    mkdirSync(join(dir, ".gemini"));
    writeFileSync(geminiSettingsFile(), JSON.stringify(existing));
    expect(await ensureGeminiHook("/bin/tkr-gemini-hook")).toBe("added");
    const after = read();
    expect(after.theme).toBe("GitHub");
    expect(after.general).toEqual({ vimMode: true });
    expect(after.hooks.SessionStart).toEqual(existing.hooks.SessionStart);
    expect(after.hooks.BeforeTool[0]).toEqual(existing.hooks.BeforeTool[0]);
    expect(after.hooks.BeforeTool).toHaveLength(2);
    expect(JSON.parse(readFileSync(configBackupFile(geminiSettingsFile()), "utf8"))).toEqual(existing);
  });

  it("is idempotent and refreshes an outdated command", async () => {
    await ensureGeminiHook("/old/tkr-gemini-hook");
    expect(await ensureGeminiHook("/new/tkr-gemini-hook")).toBe("updated");
    expect(await ensureGeminiHook("/new/tkr-gemini-hook")).toBe("present");
    const groups = read().hooks.BeforeTool;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks[0].command).toBe("/new/tkr-gemini-hook");
  });

  it("refuses to touch a settings file that is not valid JSON", async () => {
    mkdirSync(join(dir, ".gemini"));
    writeFileSync(geminiSettingsFile(), "{ not json");
    expect(await ensureGeminiHook("/bin/tkr-gemini-hook")).toBe("error");
    expect(readFileSync(geminiSettingsFile(), "utf8")).toBe("{ not json");
    expect(existsSync(configBackupFile(geminiSettingsFile()))).toBe(false);
    expect(geminiHookInstalled()).toBe(false);
  });
});

describe("removeGeminiHook", () => {
  it("removes only the tokmizer hook and keeps other groups and settings", async () => {
    const other = { matcher: "write_file", hooks: [{ type: "command", command: "security.sh" }] };
    mkdirSync(join(dir, ".gemini"));
    writeFileSync(geminiSettingsFile(), JSON.stringify({ theme: "GitHub", hooks: { BeforeTool: [other] } }));
    await ensureGeminiHook("/bin/tkr-gemini-hook");
    expect(await removeGeminiHook()).toBe("removed");
    expect(read()).toEqual({ theme: "GitHub", hooks: { BeforeTool: [other] } });
    expect(geminiHookInstalled()).toBe(false);
    expect(await removeGeminiHook()).toBe("absent");
  });

  it("removes only our command from a shared group", async () => {
    mkdirSync(join(dir, ".gemini"));
    writeFileSync(geminiSettingsFile(), JSON.stringify({
      hooks: { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: "audit.sh" }, { type: "command", command: "/bin/tkr-gemini-hook" }] }] }
    }));
    expect(await removeGeminiHook()).toBe("removed");
    expect(read().hooks.BeforeTool).toEqual([{ matcher: "run_shell_command", hooks: [{ type: "command", command: "audit.sh" }] }]);
  });

  it("drops the empty BeforeTool list when the hook was the only one", async () => {
    await ensureGeminiHook("/bin/tkr-gemini-hook");
    expect(await removeGeminiHook()).toBe("removed");
    expect(read()).toEqual({ hooks: {} });
  });

  it("reports absent when there is no file and error when it is unreadable", async () => {
    expect(await removeGeminiHook()).toBe("absent");
    mkdirSync(join(dir, ".gemini"));
    writeFileSync(geminiSettingsFile(), "{ not json");
    expect(await removeGeminiHook()).toBe("error");
    expect(readFileSync(geminiSettingsFile(), "utf8")).toBe("{ not json");
  });
});

const stableHook = async (mark: string): Promise<string> => {
  const { hookLauncherFile } = await import("../shim/launcher");
  return `[ ! -f '${hookLauncherFile()}' ] || exec /bin/sh '${hookLauncherFile()}' ${mark}`;
};

describe.skipIf(process.platform === "win32")("geminiHookCommand", () => {
  it("points the hook at the stable launcher", async () => {
    expect(geminiHookCommand("/nonexistent", "/x y/tkr-gemini-hook.js")).toBe(await stableHook("tkr-gemini-hook"));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTokmizerHookCommand, readJsonConfig } from "../hook-config";
import { claudeFormHook, hookForm } from "../hook-forms";
import { claudeExecutables, claudeHooksPresent, claudeSettingsFile, ensureClaudeHooks, removeClaudeHooks } from "../claude-hooks";
import { parseJsonText } from "../json-text";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-rtk-classes-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, "claude"));
  mkdirSync(join(dir, "claude"), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const read = (): any => JSON.parse(readFileSync(claudeSettingsFile(), "utf8"));
const commandsOf = (event: string): string[] => (read().hooks[event] ?? []).flatMap((g: any) => g.hooks.map((h: any) => h.command));

describe("hook ownership is exact, not a substring match", () => {
  it("never claims compound or lookalike commands", () => {
    for (const command of [
      "my-audit;/usr/local/bin/tkr hook codex",
      "my-audit && /opt/x/tkr hook codex",
      "/opt/x/tkr hook codex || true",
      "/opt/x/tkr hook codex | tee log",
      "/opt/x/tkr hook codex\nrm -rf x",
      "cat tkr-codex-hook.log",
      "echo tkr-codex-hook",
      "my-guard --for tkr-codex-hook",
      "[ ! -x '/a/tkr-codex-hook' ] || exec '/a/tkr-codex-hook'; evil",
      "/bin/sh '/opt/u/.tokmizer/bin/tkr-hook' tkr-codex-hook && evil",
      "/bin/sh ./my-script.sh tkr-codex-hook"
    ]) expect(isTokmizerHookCommand(command, "tkr-codex-hook"), command).toBe(false);
    expect(claudeFormHook("echo tkr hook session-start")).toBe(false);
    expect(claudeFormHook("a; tkr-exec --pre-tool-use")).toBe(false);
    expect(hookForm("cat tkr-cursor-hook.log")).toBeNull();
    expect(hookForm("my-audit;'/p/tkr' hook cursor")).toBeNull();
  });

  it("still recognises every form Tokmizer wrote", () => {
    for (const command of [
      "/old/tkr-codex-hook",
      "'/old/tkr-codex-hook'",
      "[ ! -x '/a/tkr-codex-hook' ] || exec '/a/tkr-codex-hook'",
      "[ ! -f '/a/tkr-codex-hook.js' ] || exec node '/a/tkr-codex-hook.js'",
      "node '/a/tkr-codex-hook.js'",
      "[ ! -f '/h/.tokmizer/bin/tkr-hook' ] || exec /bin/sh '/h/.tokmizer/bin/tkr-hook' tkr-codex-hook",
      "TOKMIZER_HOST=codex '/p/tkr' hook codex"
    ]) expect(isTokmizerHookCommand(command, "tkr-codex-hook"), command).toBe(true);
  });
});

describe("Claude settings hooks", () => {
  const exes = claudeExecutables("/nonexistent", "linux", "/opt/tkr/tkr");

  it("removeClaudeHooks keeps user hooks that merely contain a tkr path", async () => {
    const mine = [
      "my-audit;/usr/local/bin/tkr hook session-start",
      "my-audit && /opt/x/tkr-exec --pre-tool-use",
      "cat /opt/x/tkr-exec --pre-tool-use | grep a"
    ];
    writeFileSync(claudeSettingsFile(), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: mine[0] }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: mine[1] }, { type: "command", command: mine[2] }] }]
    } }));
    expect(await ensureClaudeHooks(exes, "linux")).toBe("added");
    expect(await removeClaudeHooks()).toBe("removed");
    expect(commandsOf("SessionStart")).toEqual([mine[0]]);
    expect(commandsOf("PreToolUse")).toEqual([mine[1], mine[2]]);
    expect(claudeHooksPresent(read())).toBe(false);
  });

  it("replaces an old exact form on upgrade without duplicating", async () => {
    writeFileSync(claudeSettingsFile(), JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "'/old/tkr' hook session-start", timeout: 5 }] }] } }));
    expect(await ensureClaudeHooks(exes, "linux")).toBe("added");
    expect(commandsOf("SessionStart").filter((c) => c.endsWith(" hook session-start"))).toHaveLength(1);
    expect(commandsOf("SessionStart").some((c) => c.includes("/old/tkr"))).toBe(false);
  });

  it("parses a settings.json that starts with a UTF-8 BOM and keeps its content", async () => {
    writeFileSync(claudeSettingsFile(), `﻿${JSON.stringify({ model: "opus", hooks: {} })}`);
    expect(await readJsonConfig(claudeSettingsFile())).toEqual({ model: "opus", hooks: {} });
    expect(await ensureClaudeHooks(exes, "linux")).toBe("added");
    const out = readFileSync(claudeSettingsFile(), "utf8");
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
    expect(read().model).toBe("opus");
    expect(claudeHooksPresent(read())).toBe(true);
    expect(await removeClaudeHooks()).toBe("removed");
  });

  it("parseJsonText strips a leading BOM only", () => {
    expect(parseJsonText("﻿{\"a\":1}")).toEqual({ a: 1 });
    expect(parseJsonText("{\"a\":1}")).toEqual({ a: 1 });
  });
});

describe("BOM-prefixed agent hook files", () => {
  it("codex and cursor detect an installed hook when the file starts with a BOM", async () => {
    vi.stubEnv("CODEX_HOME", join(dir, ".codex"));
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    const { codexHookInstalled, codexHooksFile } = await import("../codex-hooks");
    const { cursorHookInstalled, cursorHooksFile } = await import("../cursor-hooks");
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(codexHooksFile(), `﻿${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'/p/tkr' hook codex" }] }] } })}`);
    expect(codexHookInstalled()).toBe(true);
    mkdirSync(join(cursorHooksFile(), ".."), { recursive: true });
    writeFileSync(cursorHooksFile(), `﻿${JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: "'/p/tkr' hook cursor" }] } })}`);
    expect(cursorHookInstalled()).toBe(true);
  });
});

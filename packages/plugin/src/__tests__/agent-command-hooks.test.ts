import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configBackupFile } from "../config-backup";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentHookCommand,
  antigravityHookInstalled,
  antigravityHooksFile,
  ensureAntigravityHook,
  ensureVibeHook,
  removeAntigravityHook,
  removeVibeHook,
  vibeHookInstalled,
  vibeHooksFile
} from "../agent-command-hooks";
import { agentHookResponse, buildAntigravityHookOutput, buildVibeHookOutput } from "../adapters/agent-hooks";

let dir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-agent-hooks-"));
  for (const k of ["HOME", "USERPROFILE", "VIBE_HOME"]) saved[k] = process.env[k];
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.VIBE_HOME;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const rewrite = (cmd: string) => (cmd === "cd x" ? null : `tkr-exec ${cmd}`);

describe("Vibe pre_tool hook output", () => {
  const payload = (tool: string, input: Record<string, unknown>) => ({ hook_event_name: "pre_tool", session_id: "s", tool_name: tool, tool_input: input });

  it("replaces the full arguments with the rewritten command and keeps the other fields", () => {
    expect(JSON.parse(buildVibeHookOutput(payload("bash", { command: "git log", timeout: 30 }), rewrite))).toEqual({
      hook_specific_output: { tool_input: { command: "tkr-exec git log", timeout: 30 } }
    });
    expect(JSON.parse(buildVibeHookOutput(payload("file_system.bash", { command: "git log" }), rewrite)).hook_specific_output.tool_input.command).toBe("tkr-exec git log");
  });

  it("passes through with empty output otherwise", () => {
    expect(buildVibeHookOutput(payload("bash", { command: "cd x" }), rewrite)).toBe("");
    expect(buildVibeHookOutput(payload("read_file", { command: "git log" }), rewrite)).toBe("");
    expect(buildVibeHookOutput(payload("bash", { command: 3 }), rewrite)).toBe("");
    expect(buildVibeHookOutput({ ...payload("bash", { command: "git log" }), hook_event_name: "post_tool" }, rewrite)).toBe("");
    expect(agentHookResponse("vibe", "not json")).toBe("");
    expect(agentHookResponse("unknown", "{}")).toBe("");
  });
});

describe("Antigravity PreToolUse hook output", () => {
  const payload = (name: string, args: Record<string, unknown>) => ({ toolCall: { name, args }, conversationId: "c" });

  it("overwrites only CommandLine", () => {
    const usage = vi.fn(rewrite);
    expect(JSON.parse(buildAntigravityHookOutput(payload("run_command", { CommandLine: "git log", Cwd: "/w" }), usage))).toEqual({
      decision: "allow",
      overwrite: { CommandLine: "tkr-exec git log" }
    });
    expect(usage).toHaveBeenCalledWith("git log", "c");
  });

  it("always answers allow when it cannot or need not rewrite", () => {
    const allow = { decision: "allow" };
    expect(JSON.parse(buildAntigravityHookOutput(payload("run_command", { CommandLine: "cd x" }), rewrite))).toEqual(allow);
    expect(JSON.parse(buildAntigravityHookOutput(payload("view_file", { CommandLine: "git log" }), rewrite))).toEqual(allow);
    expect(JSON.parse(buildAntigravityHookOutput({}, rewrite))).toEqual(allow);
    expect(JSON.parse(agentHookResponse("antigravity", "{broken"))).toEqual(allow);
  });
});

const stableHook = async (mark: string): Promise<string> => {
  const { hookLauncherFile } = await import("../shim/launcher");
  return `[ ! -f '${hookLauncherFile()}' ] || exec /bin/sh '${hookLauncherFile()}' ${mark}`;
};

describe.skipIf(process.platform === "win32")("agentHookCommand", () => {
  it("passes the host as an argument", async () => {
    expect(agentHookCommand("vibe", "", "/pkg/dist/bin/tkr-agent-hook.js")).toBe(`${await stableHook("tkr-agent-hook")} vibe`);
  });
});

describe("Vibe hooks.toml setup", () => {
  it("honours VIBE_HOME", () => {
    process.env.VIBE_HOME = join(dir, "vh");
    expect(vibeHooksFile()).toBe(join(dir, "vh", "hooks.toml"));
  });

  it("appends a [[hooks]] table, keeps user hooks, backs up, and is idempotent", async () => {
    const user = '[[hooks]]\nname = "guard"\ntype = "pre_tool"\nmatch = "bash"\ncommand = "guard.sh"\n';
    mkdirSync(join(dir, ".vibe"));
    writeFileSync(vibeHooksFile(), user);
    expect(await ensureVibeHook("tkr-agent-hook vibe")).toBe("added");
    const text = readFileSync(vibeHooksFile(), "utf8");
    expect(text.startsWith(user)).toBe(true);
    expect(text).toContain('name = "tokmizer-rewrite"');
    expect(text).toContain('command = "tkr-agent-hook vibe"');
    expect(readFileSync(configBackupFile(vibeHooksFile()), "utf8")).toBe(user);
    expect(vibeHookInstalled()).toBe(true);
    expect(await ensureVibeHook("tkr-agent-hook vibe")).toBe("present");
    expect(await ensureVibeHook("/new/tkr-agent-hook vibe")).toBe("updated");
    expect(readFileSync(vibeHooksFile(), "utf8").match(/tokmizer-rewrite/g)).toHaveLength(1);
    expect(await removeVibeHook()).toBe("removed");
    expect(readFileSync(vibeHooksFile(), "utf8")).toBe(user);
    expect(await removeVibeHook()).toBe("absent");
  });

  it("keeps tables that follow ours when removing", async () => {
    expect(await ensureVibeHook("tkr-agent-hook vibe")).toBe("added");
    const after = '[[hooks]]\nname = "later"\ntype = "post_agent"\ncommand = "x"\n';
    writeFileSync(vibeHooksFile(), `${readFileSync(vibeHooksFile(), "utf8")}\n${after}`);
    expect(await removeVibeHook()).toBe("removed");
    expect(readFileSync(vibeHooksFile(), "utf8")).toBe(after);
  });

  it("keeps the user's comments and quoted tables written right after ours", async () => {
    expect(await ensureVibeHook("tkr-agent-hook vibe")).toBe("added");
    const after = '# my notes\n["quoted.table"]\nkey = "user value"\n';
    writeFileSync(vibeHooksFile(), `${readFileSync(vibeHooksFile(), "utf8")}${after}`);
    expect(await ensureVibeHook("/new/tkr-agent-hook vibe")).toBe("updated");
    expect(readFileSync(vibeHooksFile(), "utf8")).toContain('key = "user value"');
    expect(readFileSync(vibeHooksFile(), "utf8")).toContain("# my notes");
    expect(await removeVibeHook()).toBe("removed");
    expect(readFileSync(vibeHooksFile(), "utf8")).toBe(after);
  });

  it("reports absent when no file exists", async () => {
    expect(await removeVibeHook()).toBe("absent");
    expect(existsSync(vibeHooksFile())).toBe(false);
  });
});

describe("Antigravity hooks.json setup", () => {
  const read = () => JSON.parse(readFileSync(antigravityHooksFile(), "utf8"));

  it("adds a named PreToolUse entry next to the user's hooks and removes only it", async () => {
    expect(antigravityHooksFile()).toBe(join(dir, ".gemini", "config", "hooks.json"));
    const user = { "safety-gate": { enabled: true, PreToolUse: [{ matcher: "run_command", hooks: [{ command: "./check.sh" }] }] } };
    mkdirSync(join(dir, ".gemini", "config"), { recursive: true });
    writeFileSync(antigravityHooksFile(), JSON.stringify(user));
    expect(await ensureAntigravityHook("tkr-agent-hook antigravity")).toBe("added");
    expect(read()["safety-gate"]).toEqual(user["safety-gate"]);
    expect(read()["tokmizer-rewrite"]).toEqual({
      enabled: true,
      PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "tkr-agent-hook antigravity", timeout: 10 }] }]
    });
    expect(antigravityHookInstalled()).toBe(true);
    expect(await ensureAntigravityHook("tkr-agent-hook antigravity")).toBe("present");
    expect(await ensureAntigravityHook("/x/tkr-agent-hook antigravity")).toBe("updated");
    expect(await removeAntigravityHook()).toBe("removed");
    expect(read()).toEqual(user);
    expect(await removeAntigravityHook()).toBe("absent");
  });

  it("refuses to touch invalid JSON", async () => {
    mkdirSync(join(dir, ".gemini", "config"), { recursive: true });
    writeFileSync(antigravityHooksFile(), "{oops");
    expect(await ensureAntigravityHook("x")).toBe("error");
    expect(readFileSync(antigravityHooksFile(), "utf8")).toBe("{oops");
  });
});

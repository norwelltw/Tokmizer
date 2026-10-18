import { describe, expect, it, vi } from "vitest";
import { agentHookResponse, buildAgentHookOutput } from "../adapters/json-agents";
import type { JsonHookAgentId } from "../agent-hooks";

const claude = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  session_id: "sess-1",
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: input,
  ...extra
});

const run = (agent: JsonHookAgentId, payload: unknown, usage = vi.fn()) => buildAgentHookOutput(agent, payload, "tkr-exec", usage);

describe("Copilot hook (VS Code and Copilot CLI)", () => {
  it.each(["runTerminalCommand", "run_in_terminal", "Bash", "bash"])("rewrites the %s terminal tool with a full updatedInput", (tool) => {
    const usage = vi.fn();
    const out = JSON.parse(run("copilot", claude(tool, { command: "git status && cat a.txt", explanation: "x", isBackground: false }), usage));
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: "tkr-exec git status && tkr-exec cat a.txt", explanation: "x", isBackground: false }
      }
    });
    expect(out.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(usage).toHaveBeenCalledWith("sess-1", true);
  });

  it("rewrites the native Copilot CLI payload through modifiedArgs, from a JSON string or an object", () => {
    const usage = vi.fn();
    const args = { command: "git log", description: "history" };
    const native = { sessionId: "cli-1", timestamp: 1, cwd: "/p", toolName: "bash", toolArgs: JSON.stringify(args) };
    expect(JSON.parse(run("copilot", native, usage))).toEqual({ modifiedArgs: { command: "tkr-exec git log", description: "history" } });
    expect(JSON.parse(run("copilot", { ...native, toolArgs: args }, usage))).toEqual({ modifiedArgs: { command: "tkr-exec git log", description: "history" } });
    expect(usage).toHaveBeenCalledWith("cli-1", true);
  });

  it("passes other tools, background runs, unparsable toolArgs and PowerShell", () => {
    const usage = vi.fn();
    expect(run("copilot", claude("read_file", { command: "git log" }), usage)).toBe("{}");
    expect(run("copilot", claude("run_in_terminal", { command: "npm run dev", isBackground: true }), usage)).toBe("{}");
    expect(run("copilot", { toolName: "bash", toolArgs: "{ nope" }, usage)).toBe("{}");
    expect(run("copilot", { toolName: "powershell", toolArgs: JSON.stringify({ command: "Get-ChildItem" }) }, usage)).toBe("{}");
    expect(run("copilot", { toolName: "bash", toolArgs: JSON.stringify({ command: "" }) }, usage)).toBe("{}");
    expect(usage).not.toHaveBeenCalled();
  });
});

describe("Claude-style updatedInput hooks", () => {
  it.each([
    ["droid", "Execute"],
    ["trae", "RunCommand"],
    ["qwen-code", "run_shell_command"]
  ] as const)("%s rewrites %s and keeps every other input field", (agent, tool) => {
    const usage = vi.fn();
    const out = JSON.parse(run(agent, claude(tool, { command: "ls -la", description: "list", timeout: 60 }), usage));
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "tkr-exec ls -la", description: "list", timeout: 60 } }
    });
    expect(out.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(usage).toHaveBeenCalledWith("sess-1", true);
  });

  it.each([
    ["droid", "Bash"],
    ["trae", "Execute"],
    ["qwen-code", "Bash"]
  ] as const)("%s ignores the %s tool", (agent, tool) => {
    expect(run(agent, claude(tool, { command: "ls" }))).toBe("{}");
  });

  it("leaves Qwen Code background commands alone", () => {
    const usage = vi.fn();
    expect(run("qwen-code", claude("run_shell_command", { command: "npm run dev", is_background: true }), usage)).toBe("{}");
    expect(usage).not.toHaveBeenCalled();
  });
});

describe("Crush hook", () => {
  it("returns a shallow updated_input patch without a decision", () => {
    const usage = vi.fn();
    const out = JSON.parse(run("crush", { event: "PreToolUse", session_id: "c-1", tool_name: "bash", tool_input: { command: "git diff", description: "d" } }, usage));
    expect(out).toEqual({ updated_input: { command: "tkr-exec git diff" } });
    expect(usage).toHaveBeenCalledWith("c-1", true);
  });

  it("passes background commands and other tools", () => {
    expect(run("crush", { tool_name: "bash", tool_input: { command: "npm run dev", run_in_background: true } })).toBe("{}");
    expect(run("crush", { tool_name: "view", tool_input: { command: "git diff" } })).toBe("{}");
  });
});

describe("Junie CLI hook", () => {
  it("returns a top-level updatedInput that replaces the whole input", () => {
    const out = JSON.parse(run("junie", claude("Bash", { command: "git status", run_in_background: false, timeout: 30 })));
    expect(out).toEqual({ updatedInput: { command: "tkr-exec git status", run_in_background: false, timeout: 30 } });
  });

  it("passes background commands and other tools", () => {
    expect(run("junie", claude("Bash", { command: "sleep 60", run_in_background: true }))).toBe("{}");
    expect(run("junie", claude("Write", { command: "git status" }))).toBe("{}");
  });
});

describe.each(["copilot", "droid", "trae", "qwen-code", "crush", "junie"] as const)("%s error handling", (agent) => {
  it("passes when nothing is rewritten and records the miss", () => {
    const usage = vi.fn();
    const tool = { copilot: "Bash", droid: "Execute", trae: "RunCommand", "qwen-code": "run_shell_command", crush: "bash", junie: "Bash" }[agent];
    expect(run(agent, claude(tool, { command: "cd /tmp" }), usage)).toBe("{}");
    expect(usage).toHaveBeenCalledWith("sess-1", false);
    expect(buildAgentHookOutput(agent, claude(tool, { command: "git log" }), null, vi.fn())).toBe("{}");
    expect(run(agent, claude(tool, { command: 42 }))).toBe("{}");
    expect(run(agent, claude(tool, "not an object" as unknown as Record<string, unknown>))).toBe("{}");
  });

  it("always answers with JSON the agent can parse", () => {
    expect(agentHookResponse(agent, "")).toBe("{}");
    expect(agentHookResponse(agent, "{ not json")).toBe("{}");
    expect(agentHookResponse(agent, "null")).toBe("{}");
    expect(agentHookResponse(agent, "[1,2]")).toBe("{}");
    expect(agentHookResponse(agent, JSON.stringify({ hook_event_name: "SessionStart" }))).toBe("{}");
  });
});

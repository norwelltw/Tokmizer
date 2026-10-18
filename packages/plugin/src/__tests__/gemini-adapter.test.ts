import { describe, expect, it, vi } from "vitest";
import { buildGeminiHookOutput, geminiHookResponse } from "../adapters/gemini";

const payload = (command: unknown, extra: Record<string, unknown> = {}, input: Record<string, unknown> = {}) => ({
  session_id: "sess-1",
  cwd: "/project",
  hook_event_name: "BeforeTool",
  tool_name: "run_shell_command",
  tool_input: { command, description: "list files", ...input },
  ...extra
});

describe("buildGeminiHookOutput", () => {
  it("rewrites run_shell_command through tkr-exec with a merge-only tool_input", () => {
    const usage = vi.fn();
    const out = JSON.parse(buildGeminiHookOutput(payload("git status && cat a.txt"), "tkr-exec", usage));
    expect(out).toEqual({ hookSpecificOutput: { tool_input: { command: "tkr-exec git status && tkr-exec cat a.txt" } } });
    expect(usage).toHaveBeenCalledWith("sess-1", true);
  });

  it("returns an empty object when nothing is rewritten", () => {
    const usage = vi.fn();
    expect(buildGeminiHookOutput(payload("cd /tmp"), "tkr-exec", usage)).toBe("{}");
    expect(usage).toHaveBeenCalledWith("sess-1", false);
  });

  it("leaves background commands alone", () => {
    const usage = vi.fn();
    expect(buildGeminiHookOutput(payload("npm run dev", {}, { is_background: true }), "tkr-exec", usage)).toBe("{}");
    expect(usage).not.toHaveBeenCalled();
  });

  it("ignores other tools and other events", () => {
    const usage = vi.fn();
    expect(buildGeminiHookOutput(payload("git log", { tool_name: "read_file" }), "tkr-exec", usage)).toBe("{}");
    expect(buildGeminiHookOutput(payload("git log", { hook_event_name: "AfterTool" }), "tkr-exec", usage)).toBe("{}");
    expect(usage).not.toHaveBeenCalled();
  });

  it("passes when the command is missing or no entrypoint exists", () => {
    expect(buildGeminiHookOutput(payload(undefined), "tkr-exec", vi.fn())).toBe("{}");
    expect(buildGeminiHookOutput(payload("git log"), null, vi.fn())).toBe("{}");
  });
});

describe("geminiHookResponse", () => {
  it("always answers with JSON Gemini can parse", () => {
    expect(geminiHookResponse("")).toBe("{}");
    expect(geminiHookResponse("{ not json")).toBe("{}");
    expect(geminiHookResponse("null")).toBe("{}");
    expect(geminiHookResponse(JSON.stringify({ hook_event_name: "SessionStart" }))).toBe("{}");
  });
});

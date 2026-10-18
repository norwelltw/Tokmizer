import { describe, expect, it, vi } from "vitest";
import { buildCursorHookOutput, cursorHookResponse } from "../adapters/cursor";

const payload = (command: unknown, extra: Record<string, unknown> = {}) => ({
  hook_event_name: "preToolUse",
  conversation_id: "conv-1",
  tool_name: "Shell",
  tool_input: { command, working_directory: "/project" },
  ...extra
});

describe("buildCursorHookOutput", () => {
  it("rewrites a Shell command through tkr-exec and keeps the other input fields", () => {
    const usage = vi.fn();
    const out = JSON.parse(buildCursorHookOutput(payload("git log"), "tkr-exec", usage));
    expect(out).toEqual({ permission: "allow", updated_input: { command: "tkr-exec git log", working_directory: "/project" } });
    expect(usage).toHaveBeenCalledWith("conv-1", true);
  });

  it("allows without updated_input when nothing is rewritten", () => {
    const usage = vi.fn();
    expect(JSON.parse(buildCursorHookOutput(payload("cd /tmp"), "tkr-exec", usage))).toEqual({ permission: "allow" });
    expect(usage).toHaveBeenCalledWith("conv-1", false);
  });

  it("ignores tools other than Shell", () => {
    const usage = vi.fn();
    expect(JSON.parse(buildCursorHookOutput(payload("git log", { tool_name: "Read" }), "tkr-exec", usage))).toEqual({ permission: "allow" });
    expect(usage).not.toHaveBeenCalled();
  });

  it("allows when the command is missing or not a string", () => {
    expect(JSON.parse(buildCursorHookOutput(payload(42), "tkr-exec", vi.fn()))).toEqual({ permission: "allow" });
    expect(JSON.parse(buildCursorHookOutput({ tool_name: "Shell" }, "tkr-exec", vi.fn()))).toEqual({ permission: "allow" });
  });

  it("allows when no tkr-exec entrypoint is available", () => {
    expect(JSON.parse(buildCursorHookOutput(payload("git log"), null, vi.fn()))).toEqual({ permission: "allow" });
  });
});

describe("cursorHookResponse", () => {
  it("always answers with a valid permission envelope", () => {
    expect(JSON.parse(cursorHookResponse(""))).toEqual({ permission: "allow" });
    expect(JSON.parse(cursorHookResponse("{ not json"))).toEqual({ permission: "allow" });
    expect(JSON.parse(cursorHookResponse("null"))).toEqual({ permission: "allow" });
    expect(JSON.parse(cursorHookResponse(JSON.stringify({ hook_event_name: "afterShellExecution", command: "ls", output: "x" })))).toEqual({ permission: "allow" });
  });
});

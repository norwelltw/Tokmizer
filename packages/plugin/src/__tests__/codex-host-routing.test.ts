import { describe, expect, it, vi } from "vitest";
import { claudeOrCodex } from "../hooks-host/payload-host";
import { preToolUseResponse } from "../hooks-host/pre-tool-use";
import { codexHookResponse } from "../adapters/codex";

vi.mock("../hooks-host/pre-tool-rewrite", async (original) => ({
  ...await original<typeof import("../hooks-host/pre-tool-rewrite")>(),
  execInvocation: () => "'/pkg/bin/tkr-exec'"
}));
vi.mock("../usage", () => ({ recordUsageSync: vi.fn() }));

const CODEX = {
  session_id: "019a0000-0000-7000-8000-000000000001",
  turn_id: "t1",
  transcript_path: null,
  cwd: "/private/tmp",
  hook_event_name: "PreToolUse",
  model: "gpt-5.5",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: "git status" },
  tool_use_id: "call_1"
};

const CLAUDE = {
  session_id: "abc123",
  prompt_id: "550e8400-e29b-41d4-a716-446655440000",
  transcript_path: "/home/user/.claude/projects/x/transcript.jsonl",
  cwd: "/private/tmp",
  permission_mode: "bypassPermissions",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git status", description: "Status" },
  tool_use_id: "toolu_01ABC123"
};

describe("claudeOrCodex", () => {
  it("reads the calling host from the payload before the declared one", () => {
    expect(claudeOrCodex(CODEX, "claude-code")).toBe("codex");
    expect(claudeOrCodex(CLAUDE, "codex")).toBe("claude-code");
    expect(claudeOrCodex({ hook_event_name: "SessionStart", model: "claude-opus-5" }, "codex")).toBe("claude-code");
    expect(claudeOrCodex({ hook_event_name: "PreToolUse", effort: { level: "high" } }, "codex")).toBe("claude-code");
    expect(claudeOrCodex({ hook_event_name: "PreToolUse", scratchpad_dir: "/tmp/s" }, "codex")).toBe("claude-code");
  });

  it("keeps Claude Code when the payload carries no host field, and needs turn_id before answering as Codex", () => {
    const bare = { tool_name: "Bash", tool_input: { command: "git status" } };
    expect(claudeOrCodex(bare, "claude-code")).toBe("claude-code");
    expect(claudeOrCodex(bare, "codex")).toBeNull();
    expect(claudeOrCodex({ ...bare, turn_id: "" }, "claude-code")).toBe("claude-code");
  });

  it("lets turn_id win over a Claude model or tool id, as Codex can run Anthropic models", () => {
    expect(claudeOrCodex({ ...CODEX, model: "claude-opus-5", tool_use_id: "toolu_01" }, "claude-code")).toBe("codex");
    expect(claudeOrCodex({ ...CODEX, effort: [] }, "claude-code")).toBe("codex");
    expect(claudeOrCodex({ effort: [] }, "codex")).toBeNull();
  });

  it("refuses contradictory or non-object payloads", () => {
    expect(claudeOrCodex({ ...CODEX, prompt_id: "p" }, "claude-code")).toBeNull();
    expect(claudeOrCodex({ ...CODEX, effort: { level: "max" } }, "claude-code")).toBeNull();
    expect(claudeOrCodex(null, "claude-code")).toBeNull();
    expect(claudeOrCodex([CODEX], "codex")).toBeNull();
    expect(claudeOrCodex("x", "codex")).toBeNull();
  });
});

describe("Claude Code PreToolUse entry run by Codex", () => {
  it("answers Codex with permissionDecision allow and keeps the Codex input keys", () => {
    const out = JSON.parse(preToolUseResponse(JSON.stringify(CODEX)));
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "'/pkg/bin/tkr-exec' git status" } }
    });
  });

  it("applies the Codex safety gates: unknown input keys and non read-only commands stay untouched", () => {
    expect(preToolUseResponse(JSON.stringify({ ...CODEX, tool_input: { command: "git status", sandbox_permissions: "require_escalated" } }))).toBe("");
    expect(preToolUseResponse(JSON.stringify({ ...CODEX, tool_input: { command: "npm install" } }))).toBe("");
  });

  it("still answers Claude Code in the Claude shape", () => {
    const out = JSON.parse(preToolUseResponse(JSON.stringify(CLAUDE)));
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.updatedInput).toEqual({ command: "'/pkg/bin/tkr-exec' git status", description: "Status" });
  });

  it("prints nothing for contradictory, empty or broken payloads", () => {
    expect(preToolUseResponse(JSON.stringify({ ...CODEX, prompt_id: "p" }))).toBe("");
    expect(preToolUseResponse("null")).toBe("");
    expect(preToolUseResponse("{ nope")).toBe("");
  });

  it("never emits updatedInput without permissionDecision allow for any Codex payload", () => {
    for (const command of ["git status", "cat a && cat b", "ls -la", "git log --oneline", "rg foo", "tail -f x", "git push"]) {
      const out = preToolUseResponse(JSON.stringify({ ...CODEX, tool_input: { command, workdir: "/tmp" } }));
      if (!out) continue;
      const parsed = JSON.parse(out).hookSpecificOutput;
      expect(parsed.permissionDecision).toBe("allow");
      expect(typeof parsed.updatedInput.command).toBe("string");
      expect(parsed.updatedInput.workdir).toBe("/tmp");
    }
  });
});

describe("Codex PreToolUse entry run by Claude Code", () => {
  it("never auto-allows a Claude Code tool call", async () => {
    const out = JSON.parse(await codexHookResponse(JSON.stringify(CLAUDE)));
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.updatedInput).toEqual({ command: "'/pkg/bin/tkr-exec' git status", description: "Status" });
  });

  it("keeps answering Codex as before", async () => {
    expect(JSON.parse(await codexHookResponse(JSON.stringify(CODEX))).hookSpecificOutput.permissionDecision).toBe("allow");
  });
});

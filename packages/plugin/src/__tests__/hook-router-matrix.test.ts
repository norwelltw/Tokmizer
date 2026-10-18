import { describe, expect, it, vi } from "vitest";
import { payloadHost, payloadSignals, type RouteHost } from "../hooks-host/payload-host";
import { preToolUseFor, routePreToolUse } from "../hooks-host/hook-router";
import { preToolUseResponse } from "../hooks-host/pre-tool-use";
import { codexHookResponse } from "../adapters/codex";
import { cursorHookResponse } from "../adapters/cursor";
import { geminiHookResponse } from "../adapters/gemini";
import { agentHookResponse as commandAgentResponse } from "../adapters/agent-hooks";
import { agentHookResponse as jsonAgentResponse } from "../adapters/json-agents";
import { contextFormatFor, HOST_CONTEXT_FORMAT } from "../context-hooks";
import { AGENT_BONUSES } from "../agent-bonuses";
import type { JsonHookAgentId } from "../agent-hooks";

vi.mock("../hooks-host/pre-tool-rewrite", async (original) => ({
  ...await original<typeof import("../hooks-host/pre-tool-rewrite")>(),
  execInvocation: () => "'/pkg/bin/tkr-exec'"
}));
vi.mock("../usage", () => ({ recordUsageSync: vi.fn() }));

const CMD = "git status";
const WRAPPED = "'/pkg/bin/tkr-exec' git status";

const FIXTURES: Record<RouteHost, Record<string, unknown>> = {
  "claude-code": { session_id: "s", prompt_id: "550e8400-e29b-41d4-a716-446655440000", transcript_path: "/t.jsonl", cwd: "/p", permission_mode: "bypassPermissions", effort: { level: "high" }, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: CMD, description: "d" }, tool_use_id: "toolu_01" },
  codex: { session_id: "s", turn_id: "t1", transcript_path: null, cwd: "/p", hook_event_name: "PreToolUse", model: "gpt-5.5", permission_mode: "default", tool_name: "Bash", tool_input: { command: CMD }, tool_use_id: "call_1" },
  cursor: { conversation_id: "c", generation_id: "g", model: "claude-opus-4-7", hook_event_name: "preToolUse", cursor_version: "1.7.0", workspace_roots: ["/p"], user_email: null, tool_name: "Shell", tool_input: { command: CMD, working_directory: "/p" }, tool_use_id: "abc123", cwd: "/p" },
  "gemini-cli": { session_id: "s", transcript_path: "/t.json", cwd: "/p", hook_event_name: "BeforeTool", timestamp: "2026-10-17T10:00:00Z", tool_name: "run_shell_command", tool_input: { command: CMD } },
  "qwen-code": { session_id: "s", transcript_path: "/t", cwd: "/p", hook_event_name: "PreToolUse", tool_name: "run_shell_command", tool_input: { command: CMD } },
  vibe: { hook_event_name: "pre_tool", session_id: "s", tool_name: "bash", tool_input: { command: CMD } },
  antigravity: { conversationId: "c", toolCall: { name: "run_command", args: { CommandLine: CMD } } },
  copilot: { timestamp: 1, cwd: "/p", toolName: "bash", toolArgs: JSON.stringify({ command: CMD }) },
  grok: { sessionId: "s", toolName: "run_terminal_command", toolInput: { command: CMD } },
  droid: { session_id: "s", cwd: "/p", hook_event_name: "PreToolUse", tool_name: "Execute", tool_input: { command: CMD } },
  trae: { session_id: "s", hook_event_name: "PreToolUse", tool_name: "RunCommand", tool_input: { command: CMD } },
  crush: { event: "PreToolUse", session_id: "s", tool_name: "bash", tool_input: { command: CMD } },
  junie: { session_id: "s", cwd: "/p", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: CMD } },
  zcode: { session_id: "s", cwd: "/p", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: CMD } }
};

const CLAUDE_STYLE = (o: any) => o.hookSpecificOutput.hookEventName === "PreToolUse" && o.hookSpecificOutput.updatedInput.command === WRAPPED && o.hookSpecificOutput.permissionDecision === undefined;

const VALID: Record<RouteHost, (o: any) => boolean> = {
  "claude-code": CLAUDE_STYLE,
  codex: (o) => o.hookSpecificOutput.permissionDecision === "allow" && o.hookSpecificOutput.updatedInput.command === WRAPPED,
  cursor: (o) => o.permission === "allow" && o.updated_input.command === WRAPPED,
  "gemini-cli": (o) => o.hookSpecificOutput.tool_input.command === WRAPPED,
  "qwen-code": CLAUDE_STYLE,
  vibe: (o) => o.hook_specific_output.tool_input.command === WRAPPED,
  antigravity: (o) => o.decision === "allow" && o.overwrite.CommandLine === WRAPPED,
  copilot: (o) => o.modifiedArgs.command === WRAPPED,
  grok: CLAUDE_STYLE,
  droid: CLAUDE_STYLE,
  trae: CLAUDE_STYLE,
  crush: (o) => o.updated_input.command === WRAPPED,
  junie: (o) => o.updatedInput.command === WRAPPED && o.hookSpecificOutput === undefined,
  zcode: CLAUDE_STYLE
};

const HOSTS = Object.keys(FIXTURES) as RouteHost[];
const TWINS = new Set<RouteHost>(["junie", "zcode"]);
const JSON_AGENTS: JsonHookAgentId[] = ["copilot", "droid", "trae", "qwen-code", "crush", "junie", "zcode", "grok"];

const ENTRIES: [string, RouteHost, (raw: string) => Promise<string> | string, string][] = [
  ["hooks-host/pre-tool-use.js", "claude-code", preToolUseResponse, ""],
  ["tkr-codex-hook", "codex", codexHookResponse, ""],
  ["tkr-cursor-hook", "cursor", cursorHookResponse, JSON.stringify({ permission: "allow" })],
  ["tkr-gemini-hook", "gemini-cli", geminiHookResponse, "{}"],
  ["tkr-agent-hook vibe", "vibe", (raw) => commandAgentResponse("vibe", raw), ""],
  ["tkr-agent-hook antigravity", "antigravity", (raw) => commandAgentResponse("antigravity", raw), JSON.stringify({ decision: "allow" })],
  ...JSON_AGENTS.map((id): [string, RouteHost, (raw: string) => string, string] => [`tkr-${id === "qwen-code" ? "qwen" : id}-hook`, id, (raw) => jsonAgentResponse(id, raw), "{}"])
];

describe("payload signals", () => {
  it.each(HOSTS.filter((h) => !TWINS.has(h)))("recognise a %s payload on its own", (host) => {
    expect(payloadSignals(FIXTURES[host])).toEqual([host]);
  });

  it.each([...TWINS])("treat a %s payload, which matches Claude Code's, as carrying no host field", (host) => {
    expect(payloadSignals(FIXTURES[host])).toEqual([]);
    expect(payloadHost(FIXTURES[host], host)).toBe(host);
    expect(payloadHost(FIXTURES[host], "claude-code")).toBe("claude-code");
  });

  it("refuses a payload that carries fields of two hosts", () => {
    expect(payloadHost({ ...FIXTURES.codex, prompt_id: "p" }, "codex")).toBeNull();
    expect(payloadHost({ ...FIXTURES.cursor, toolCall: { name: "run_command" } }, "cursor")).toBeNull();
    expect(routePreToolUse({ ...FIXTURES["gemini-cli"], turn_id: "t" }, "gemini-cli")).toBe("");
  });

  it.each(HOSTS)("each host's own output for a %s payload is valid for that host", (host) => {
    expect(VALID[host](JSON.parse(preToolUseFor(host, FIXTURES[host])))).toBe(true);
  });
});

describe.each(ENTRIES)("entry %s", (_name, declared, respond, fallback) => {
  it.each(HOSTS)("answers a %s payload in that host's shape", async (host) => {
    const out = await respond(JSON.stringify(FIXTURES[host]));
    if (TWINS.has(host) && declared === "codex") {
      expect(out).toBe("");
      return;
    }
    expect(out).toBe(preToolUseFor(TWINS.has(host) ? declared : host, FIXTURES[host]));
    if (!TWINS.has(host)) expect(VALID[host](JSON.parse(out))).toBe(true);
  });

  it("changes nothing on a contradictory payload and gives its own neutral answer", async () => {
    expect(await respond(JSON.stringify({ ...FIXTURES.codex, prompt_id: "p" }))).toBe(fallback);
  });

  it("leaves a Claude Code call in default permission mode to Claude Code's own prompt", async () => {
    expect(await respond(JSON.stringify({ ...FIXTURES["claude-code"], permission_mode: "default" }))).not.toContain("updatedInput");
  });
});

describe("Codex hook without turn_id", () => {
  it("never auto-allows a payload that does not come from Codex", async () => {
    expect(await codexHookResponse(JSON.stringify(FIXTURES.junie))).toBe("");
    expect(await codexHookResponse(JSON.stringify({ tool_name: "Bash", tool_input: { command: CMD } }))).toBe(JSON.stringify({ action: "continue" }));
    expect(await codexHookResponse("{}")).toBe(JSON.stringify({ action: "continue" }));
  });
});

describe("Codex config.toml", () => {
  it("unquotes commands before reading them, so single-binary forms are found too", async () => {
    const { stripTomlHooks } = await import("../codex-repair");
    const { foreignTo } = await import("../hook-forms");
    const text = "[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ncommand = \"'/p/tkr' hook cursor\"\n# command = \"'/p/tkr' hook droid\"\n";
    expect(stripTomlHooks(text, foreignTo("codex"))).toEqual({ text: "", removed: ["\"'/p/tkr' hook cursor\""], inline: [] });
    expect(stripTomlHooks("[x]\nlist = [{ command = 'tkr hook gemini' }]\n", foreignTo("codex")).inline).toEqual(["list = [{ command = 'tkr hook gemini' }]"]);
  });
});

describe("reducer context format", () => {
  it("follows the payload host when it is known", () => {
    expect(contextFormatFor(JSON.stringify({ hook_event_name: "BeforeAgent", prompt: "x" }), "hso")).toBe("gemini");
    expect(contextFormatFor(JSON.stringify({ hook_event_name: "sessionStart", cursor_version: "1" }), "hso")).toBe("cursor");
    expect(contextFormatFor(JSON.stringify({ hook_event_name: "UserPromptSubmit", turn_id: "t" }), "gemini")).toBe("hso");
    expect(contextFormatFor(JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }), "copilot")).toBe("copilot");
    expect(contextFormatFor("", "plain")).toBe("plain");
    expect(contextFormatFor("{nope", "plain")).toBe("plain");
    expect(contextFormatFor(JSON.stringify({ turn_id: "t", prompt_id: "p" }), "hso")).toBeNull();
  });

  it("matches the format each agent's reducer hook is installed with", () => {
    const ids: Record<string, RouteHost> = { gemini: "gemini-cli" };
    for (const bonus of AGENT_BONUSES) {
      if (bonus.reducer.kind !== "hooks") continue;
      expect(HOST_CONTEXT_FORMAT[ids[bonus.id] ?? (bonus.id as RouteHost)], bonus.id).toBe(bonus.reducer.format);
    }
  });
});

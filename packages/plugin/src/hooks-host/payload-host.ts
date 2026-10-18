import type { JsonHookAgentId } from "../agent-hooks";

export type ClaudeOrCodex = "claude-code" | "codex";
export type RouteHost = ClaudeOrCodex | "cursor" | "gemini-cli" | "vibe" | "antigravity" | JsonHookAgentId;

type Payload = Record<string, unknown>;

function text(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value ? value : null;
}

function isObject(value: unknown): value is Payload {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function claudeOnly(payload: Payload): boolean {
  if (text(payload, "prompt_id") || text(payload, "scratchpad_dir")) return true;
  return isObject(payload.effort);
}

function claudeLike(payload: Payload): boolean {
  return text(payload, "tool_use_id")?.startsWith("toolu_") === true || /^claude/i.test(text(payload, "model") ?? "");
}

const GEMINI_EVENTS = new Set(["BeforeTool", "AfterTool", "BeforeAgent", "AfterAgent", "BeforeModel", "AfterModel", "BeforeToolSelection"]);
const CURSOR_EVENTS = new Set(["preToolUse", "postToolUse", "beforeShellExecution", "afterShellExecution", "beforeSubmitPrompt", "sessionStart", "sessionEnd", "stop"]);
const VIBE_EVENTS = new Set(["pre_tool", "post_tool"]);
const CODEX_LEGACY_EVENTS = new Set(["before_tool_call", "after_tool_call"]);
const COPILOT_VSCODE_TOOLS = new Set(["runTerminalCommand", "run_in_terminal"]);

const SIGNALS: readonly [RouteHost, (p: Payload) => boolean][] = [
  ["codex", (p) => text(p, "turn_id") !== null],
  ["claude-code", claudeOnly],
  ["cursor", (p) => text(p, "cursor_version") !== null || text(p, "generation_id") !== null || text(p, "conversation_id") !== null || Array.isArray(p.workspace_roots) || CURSOR_EVENTS.has(text(p, "hook_event_name") ?? "")],
  ["gemini-cli", (p) => GEMINI_EVENTS.has(text(p, "hook_event_name") ?? "")],
  ["qwen-code", (p) => p.hook_event_name === "PreToolUse" && p.tool_name === "run_shell_command"],
  ["vibe", (p) => VIBE_EVENTS.has(text(p, "hook_event_name") ?? "")],
  ["antigravity", (p) => isObject(p.toolCall)],
  ["copilot", (p) => (text(p, "toolName") !== null && "toolArgs" in p) || COPILOT_VSCODE_TOOLS.has(text(p, "tool_name") ?? "")],
  ["grok", (p) => p.toolName === "run_terminal_command" || p.tool_name === "run_terminal_command" || (isObject(p.toolInput) && !("toolArgs" in p))],
  ["droid", (p) => p.tool_name === "Execute"],
  ["trae", (p) => p.tool_name === "RunCommand"],
  ["crush", (p) => p.hook_event_name === undefined && text(p, "event") !== null && !CODEX_LEGACY_EVENTS.has(text(p, "event")!)]
];

const ALLOWING_HOSTS = new Set<RouteHost>(["codex", "antigravity"]);

export function payloadSignals(payload: unknown): RouteHost[] {
  if (!isObject(payload)) return [];
  return SIGNALS.filter(([, test]) => test(payload)).map(([host]) => host);
}

export function payloadHost(payload: unknown, declared: RouteHost): RouteHost | null {
  if (!isObject(payload)) return null;
  const signals = payloadSignals(payload);
  if (signals.length > 1) return null;
  if (signals.length === 1) return signals[0]!;
  if (claudeLike(payload) && ALLOWING_HOSTS.has(declared)) return "claude-code";
  return declared === "codex" ? null : declared;
}

export function claudeOrCodex(payload: unknown, declared: ClaudeOrCodex): ClaudeOrCodex | null {
  const host = payloadHost(payload, declared);
  return host === "claude-code" || host === "codex" ? host : null;
}

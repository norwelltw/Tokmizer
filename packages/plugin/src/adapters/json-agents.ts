import { readStdin } from "../stdin";
import { recordUsageSync } from "../usage";
import { execInvocation, rewriteShellCommand } from "../hooks-host/pre-tool-rewrite";
import type { JsonHookAgentId } from "../agent-hooks";
import { failOpenActive } from "../shim/sh";
import { routePreToolUse } from "../hooks-host/hook-router";

type Json = Record<string, unknown>;
type Usage = (sessionId: string, routed: boolean) => void;

export const PASS = "{}";

const COPILOT_TERMINAL_TOOLS = new Set(["runTerminalCommand", "run_in_terminal", "Bash", "bash"]);
const BACKGROUND_KEYS = ["run_in_background", "is_background", "isBackground"];

function isObject(value: unknown): value is Json {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sessionOf(payload: Json): string {
  const id = payload.session_id ?? payload.sessionId;
  return typeof id === "string" && id ? id : "unknown";
}

function cwdOf(payload: Json, input: Json): string | undefined {
  const cwd = payload.cwd ?? input.cwd ?? input.workdir ?? input.working_directory;
  return typeof cwd === "string" && cwd ? cwd : undefined;
}

function rewriteInput(agent: JsonHookAgentId, input: unknown, payload: Json, exec: string | null, recordUsage: Usage): string | null {
  if (!isObject(input)) return null;
  if (BACKGROUND_KEYS.some((k) => input[k] === true)) return null;
  const cmd = input.command;
  if (typeof cmd !== "string" || !cmd) return null;
  return rewriteShellCommand(cmd, { host: agent, sessionId: sessionOf(payload), cwd: cwdOf(payload, input) }, failOpenActive() ? null : exec, recordUsage);
}

function claudeStyle(input: Json, rewritten: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, command: rewritten } } });
}

function parseArgs(raw: unknown): Json | null {
  if (isObject(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function copilot(payload: Json, exec: string | null, recordUsage: Usage): string {
  if (typeof payload.tool_name === "string") {
    if (!COPILOT_TERMINAL_TOOLS.has(payload.tool_name)) return PASS;
    const input = payload.tool_input;
    const rewritten = rewriteInput("copilot", input, payload, exec, recordUsage);
    return rewritten ? claudeStyle(input as Json, rewritten) : PASS;
  }
  if (payload.toolName !== "bash") return PASS;
  const args = parseArgs(payload.toolArgs);
  const rewritten = rewriteInput("copilot", args, payload, exec, recordUsage);
  return rewritten ? JSON.stringify({ modifiedArgs: { ...args, command: rewritten } }) : PASS;
}

function byTool(agent: JsonHookAgentId, tool: string, respond: (input: Json, rewritten: string) => string) {
  return (payload: Json, exec: string | null, recordUsage: Usage): string => {
    if (payload.tool_name !== tool) return PASS;
    const input = payload.tool_input;
    const rewritten = rewriteInput(agent, input, payload, exec, recordUsage);
    return rewritten ? respond(input as Json, rewritten) : PASS;
  };
}

const GROK_SHELL_TOOLS = new Set(["run_terminal_command", "Bash", "bash"]);

function grok(payload: Json, exec: string | null, recordUsage: Usage): string {
  const tool = payload.toolName ?? payload.tool_name;
  if (typeof tool !== "string" || !GROK_SHELL_TOOLS.has(tool)) return PASS;
  const input = payload.toolInput ?? payload.tool_input;
  const rewritten = rewriteInput("grok", input, payload, exec, recordUsage);
  return rewritten ? claudeStyle(input as Json, rewritten) : PASS;
}

const BUILDERS: Record<JsonHookAgentId, (payload: Json, exec: string | null, recordUsage: Usage) => string> = {
  copilot,
  droid: byTool("droid", "Execute", claudeStyle),
  trae: byTool("trae", "RunCommand", claudeStyle),
  "qwen-code": byTool("qwen-code", "run_shell_command", claudeStyle),
  crush: byTool("crush", "bash", (_input, rewritten) => JSON.stringify({ updated_input: { command: rewritten } })),
  junie: byTool("junie", "Bash", (input, rewritten) => JSON.stringify({ updatedInput: { ...input, command: rewritten } })),
  zcode: byTool("zcode", "Bash", claudeStyle),
  grok
};

export function buildAgentHookOutput(
  agent: JsonHookAgentId,
  payload: unknown,
  exec: string | null = execInvocation(agent),
  recordUsage: Usage = recordUsageSync
): string {
  if (!isObject(payload)) return PASS;
  return BUILDERS[agent](payload, exec, recordUsage);
}

export function agentHookResponse(agent: JsonHookAgentId, raw: string): string {
  if (!raw) return PASS;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return PASS;
  }
  return isObject(payload) ? routePreToolUse(payload, agent, { fallback: PASS }) : PASS;
}

export async function runAgentHookFromStdin(agent: JsonHookAgentId): Promise<void> {
  process.stdout.write(agentHookResponse(agent, await readStdin()));
}

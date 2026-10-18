import { readStdin } from "../stdin";
import { isJsonObject } from "../hook-config";
import { rewriteForAgent } from "../agent-rewrite";
import { routePreToolUse } from "../hooks-host/hook-router";

type Rewriter = (cmd: string, sessionId: string) => string | null;

const VIBE_SHELL_TOOLS = new Set(["bash", "file_system.bash"]);
const ANTIGRAVITY_ALLOW = JSON.stringify({ decision: "allow" });

export function buildVibeHookOutput(payload: unknown, rewrite: Rewriter = (c, s) => rewriteForAgent(c, "vibe", s)): string {
  if (!isJsonObject(payload) || payload.hook_event_name !== "pre_tool") return "";
  if (typeof payload.tool_name !== "string" || !VIBE_SHELL_TOOLS.has(payload.tool_name)) return "";
  const input = payload.tool_input;
  if (!isJsonObject(input) || typeof input.command !== "string" || !input.command) return "";
  const rewritten = rewrite(input.command, typeof payload.session_id === "string" ? payload.session_id : "unknown");
  if (!rewritten) return "";
  return JSON.stringify({ hook_specific_output: { tool_input: { ...input, command: rewritten } } });
}

export function buildAntigravityHookOutput(payload: unknown, rewrite: Rewriter = (c, s) => rewriteForAgent(c, "antigravity", s)): string {
  if (!isJsonObject(payload) || !isJsonObject(payload.toolCall) || payload.toolCall.name !== "run_command") return ANTIGRAVITY_ALLOW;
  const args = payload.toolCall.args;
  if (!isJsonObject(args) || typeof args.CommandLine !== "string" || !args.CommandLine) return ANTIGRAVITY_ALLOW;
  const rewritten = rewrite(args.CommandLine, typeof payload.conversationId === "string" ? payload.conversationId : "unknown");
  if (!rewritten) return ANTIGRAVITY_ALLOW;
  return JSON.stringify({ decision: "allow", overwrite: { CommandLine: rewritten } });
}

const BUILDERS: Record<string, { build: (payload: unknown) => string; fallback: string }> = {
  vibe: { build: (p) => buildVibeHookOutput(p), fallback: "" },
  antigravity: { build: (p) => buildAntigravityHookOutput(p), fallback: ANTIGRAVITY_ALLOW }
};

export function agentHookFallback(host: string | undefined): string {
  return BUILDERS[host ?? ""]?.fallback ?? "";
}

export function agentHookResponse(host: string | undefined, raw: string): string {
  const builder = BUILDERS[host ?? ""];
  if (!builder) return "";
  let payload: unknown;
  try {
    payload = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return builder.fallback;
  }
  return isJsonObject(payload) ? routePreToolUse(payload, host as "vibe" | "antigravity", { fallback: builder.fallback }) : builder.build(payload);
}

export async function runAgentHookFromStdin(host: string | undefined): Promise<void> {
  process.stdout.write(agentHookResponse(host, await readStdin()));
}

import { readStdin } from "../stdin";
import { recordUsageSync } from "../usage";
import { execInvocation, rewriteShellCommand } from "../hooks-host/pre-tool-rewrite";
import { failOpenActive } from "../shim/sh";
import { routePreToolUse } from "../hooks-host/hook-router";

export type CursorHookPayload = {
  hook_event_name?: string;
  conversation_id?: string;
  tool_name?: string;
  tool_input?: { command?: unknown; [key: string]: unknown };
};

const ALLOW = JSON.stringify({ permission: "allow" });

export function buildCursorHookOutput(
  payload: CursorHookPayload,
  exec: string | null = execInvocation("cursor"),
  recordUsage: (sessionId: string, routed: boolean) => void = recordUsageSync
): string {
  if (payload.tool_name !== "Shell") return ALLOW;
  const input = payload.tool_input ?? {};
  const cmd = input.command;
  if (typeof cmd !== "string" || !cmd) return ALLOW;
  const cwd = typeof input.working_directory === "string" ? input.working_directory : undefined;
  const rewritten = rewriteShellCommand(cmd, { host: "cursor", sessionId: payload.conversation_id ?? "unknown", cwd }, failOpenActive() ? null : exec, recordUsage);
  if (!rewritten) return ALLOW;
  return JSON.stringify({ permission: "allow", updated_input: { ...input, command: rewritten } });
}

export function cursorHookResponse(raw: string): string {
  if (!raw) return ALLOW;
  let payload: CursorHookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return ALLOW;
  }
  if (!payload || typeof payload !== "object") return ALLOW;
  return routePreToolUse(payload, "cursor", { fallback: ALLOW });
}

export async function runCursorHookFromStdin(): Promise<void> {
  process.stdout.write(cursorHookResponse(await readStdin()));
}

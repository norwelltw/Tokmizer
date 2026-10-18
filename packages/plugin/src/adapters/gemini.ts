import { readStdin } from "../stdin";
import { recordUsageSync } from "../usage";
import { execInvocation, rewriteShellCommand } from "../hooks-host/pre-tool-rewrite";
import { failOpenActive } from "../shim/sh";
import { routePreToolUse } from "../hooks-host/hook-router";

export type GeminiHookPayload = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: unknown;
  tool_name?: string;
  tool_input?: { command?: unknown; is_background?: unknown; [key: string]: unknown };
};

const PASS = "{}";

export function buildGeminiHookOutput(
  payload: GeminiHookPayload,
  exec: string | null = execInvocation("gemini-cli"),
  recordUsage: (sessionId: string, routed: boolean) => void = recordUsageSync
): string {
  if (payload.hook_event_name !== "BeforeTool" || payload.tool_name !== "run_shell_command") return PASS;
  const input = payload.tool_input ?? {};
  if (input.is_background) return PASS;
  const cmd = input.command;
  if (typeof cmd !== "string" || !cmd) return PASS;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const rewritten = rewriteShellCommand(cmd, { host: "gemini-cli", sessionId: payload.session_id ?? "unknown", cwd }, failOpenActive() ? null : exec, recordUsage);
  if (!rewritten) return PASS;
  return JSON.stringify({ hookSpecificOutput: { tool_input: { command: rewritten } } });
}

export function geminiHookResponse(raw: string): string {
  if (!raw) return PASS;
  let payload: GeminiHookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return PASS;
  }
  if (!payload || typeof payload !== "object") return PASS;
  return routePreToolUse(payload, "gemini-cli", { fallback: PASS });
}

export async function runGeminiHookFromStdin(): Promise<void> {
  process.stdout.write(geminiHookResponse(await readStdin()));
}

import { recordUsageSync } from "./usage";
import { execInvocation, rewriteShellCommand, type HookHost } from "./hooks-host/pre-tool-rewrite";
import { failOpenActive } from "./shim/sh";

export const AGENT_HOSTS = ["opencode", "kilo", "amp", "vibe", "antigravity", "openclaw", "pi", "omp", "hermes"] as const;
export type AgentHost = (typeof AGENT_HOSTS)[number];

export function isAgentHost(value: unknown): value is AgentHost {
  return typeof value === "string" && (AGENT_HOSTS as readonly string[]).includes(value);
}

export function rewriteForAgent(
  cmd: string,
  host: AgentHost,
  sessionId = "unknown",
  exec: string | null = execInvocation(host as HookHost),
  recordUsage: (sessionId: string, routed: boolean) => void = recordUsageSync
): string | null {
  if (!cmd) return null;
  return rewriteShellCommand(cmd, { host, sessionId }, failOpenActive() ? null : exec, recordUsage);
}

export function parseRewriteArgs(args: string[]): { host: AgentHost; session?: string } | null {
  let host: string | undefined;
  let session: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if ((flag === "--host" || flag === "--session") && value !== undefined) {
      if (flag === "--host") host = value;
      else session = value;
      i += 1;
      continue;
    }
    return null;
  }
  return isAgentHost(host) ? { host, ...(session ? { session } : {}) } : null;
}

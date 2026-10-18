import { recordUsageSync } from "../usage";
import { failOpenActive } from "../shim/sh";
import { buildPreToolUseOutput, claudeLaunchArgs, currentClaudeDirs, execInvocation, type ClaudeDirs, type PreToolUsePayload } from "./pre-tool-rewrite";
import { payloadHost, type RouteHost } from "./payload-host";
import { buildCursorHookOutput } from "../adapters/cursor";
import { buildGeminiHookOutput } from "../adapters/gemini";
import { buildAntigravityHookOutput, buildVibeHookOutput } from "../adapters/agent-hooks";
import { buildAgentHookOutput } from "../adapters/json-agents";
import { rewriteForAgent } from "../agent-rewrite";

type Usage = (sessionId: string, routed: boolean) => void;

export type RouteOptions = { recordUsage?: Usage; claudeDirs?: ClaudeDirs; fallback?: string; pathEnv?: string; launchArgs?: () => string | null };

function execFor(host: RouteHost): string | null {
  return failOpenActive() ? null : execInvocation(host);
}

export function preToolUseFor(host: RouteHost, payload: Record<string, unknown>, options: RouteOptions = {}): string {
  const recordUsage = options.recordUsage ?? recordUsageSync;
  switch (host) {
    case "claude-code":
    case "codex":
      if (payload.hook_event_name !== undefined && payload.hook_event_name !== "PreToolUse") return "";
      return buildPreToolUseOutput(payload as PreToolUsePayload, host, execFor(host), recordUsage, options.claudeDirs ?? currentClaudeDirs(), options.pathEnv ?? process.env.PATH, options.launchArgs ?? claudeLaunchArgs) ?? "";
    case "cursor":
      return buildCursorHookOutput(payload, execFor(host), recordUsage);
    case "gemini-cli":
      return buildGeminiHookOutput(payload, execFor(host), recordUsage);
    case "vibe":
      return buildVibeHookOutput(payload, (cmd, session) => rewriteForAgent(cmd, "vibe", session, execFor(host), recordUsage));
    case "antigravity":
      return buildAntigravityHookOutput(payload, (cmd, session) => rewriteForAgent(cmd, "antigravity", session, execFor(host), recordUsage));
    default:
      return buildAgentHookOutput(host, payload, execFor(host), recordUsage);
  }
}

export function routePreToolUse(payload: unknown, declared: RouteHost, options: RouteOptions = {}): string {
  const host = payloadHost(payload, declared);
  if (!host) return options.fallback ?? "";
  return preToolUseFor(host, payload as Record<string, unknown>, options);
}

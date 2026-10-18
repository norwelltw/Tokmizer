import { isTokmizerHookCommand } from "./hook-config";
import { CONTEXT_MARK } from "./context-hooks";
import type { RouteHost } from "./hooks-host/payload-host";

const CLAUDE_EXEC_FORM = /tkr-exec(?:\.exe)?['"]?\s+--(?:pre-tool-use|post-tool-use|session-start)(?=\s|['"]|$)/i;
const CLAUDE_HOOK_FORM = /(?:^|[\s'"\\/])tkr(?:\.exe)?['"]?\s+hook\s+(?:pre-tool-use|post-tool-use|session-start|session-recap|reducer-session-start|reducer-prompt-submit|reducer-stop|command-expansion)(?=\s|['"]|$)/i;
const CLAUDE_SCRIPT_FORM = /(?:tokmizer|\$\{?CLAUDE_PLUGIN_ROOT\}?)[^'"\n]*?[\\/]+(?:dist[\\/]+hooks-host[\\/]+(?:pre-tool-use|post-tool-use|session-recap|reducer-session-start|reducer-prompt-submit|reducer-stop|command-expansion)\.js|hooks[\\/]+on-session-start\.mjs)/i;

export function claudeFormHook(command: unknown): boolean {
  return typeof command === "string" && (CLAUDE_EXEC_FORM.test(command) || CLAUDE_HOOK_FORM.test(command) || CLAUDE_SCRIPT_FORM.test(command));
}

const MARKS: readonly [string, RouteHost][] = [
  ["tkr-codex-hook", "codex"],
  ["tkr-cursor-hook", "cursor"],
  ["tkr-gemini-hook", "gemini-cli"],
  ["tkr-copilot-hook", "copilot"],
  ["tkr-droid-hook", "droid"],
  ["tkr-trae-hook", "trae"],
  ["tkr-qwen-hook", "qwen-code"],
  ["tkr-crush-hook", "crush"],
  ["tkr-junie-hook", "junie"],
  ["tkr-zcode-hook", "zcode"],
  ["tkr-grok-hook", "grok"]
];

export type HookForm = RouteHost | "context";

export function hookForm(command: unknown): HookForm | null {
  if (typeof command !== "string") return null;
  if (isTokmizerHookCommand(command, CONTEXT_MARK)) return "context";
  if (claudeFormHook(command)) return "claude-code";
  for (const [mark, host] of MARKS) if (isTokmizerHookCommand(command, mark)) return host;
  if (!isTokmizerHookCommand(command, "tkr-agent-hook")) return null;
  const host = /\b(vibe|antigravity)['"]?\s*$/.exec(command)?.[1];
  return (host as HookForm | undefined) ?? null;
}

export function foreignTo(host: RouteHost): (command: unknown) => boolean {
  return (command) => {
    const form = hookForm(command);
    return form !== null && form !== "context" && form !== host;
  };
}

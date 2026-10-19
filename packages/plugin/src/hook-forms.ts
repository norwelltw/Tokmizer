import { isTokmizerHookCommand, parseHookCommand } from "./hook-config";
import { CONTEXT_MARK } from "./context-hooks";
import type { RouteHost } from "./hooks-host/payload-host";

const CLAUDE_EXEC_FLAGS = new Set(["--pre-tool-use", "--post-tool-use", "--session-start"]);
const CLAUDE_HOOK_WORDS = new Set(["pre-tool-use", "post-tool-use", "session-start", "session-recap", "reducer-session-start", "reducer-prompt-submit", "reducer-stop", "command-expansion"]);
const CLAUDE_SCRIPT_NAMES = new Set(["pre-tool-use", "post-tool-use", "session-recap", "reducer-session-start", "reducer-prompt-submit", "reducer-stop", "command-expansion", "on-session-start"]);
const CLAUDE_SCRIPT_FORM = /(?:tokmizer|\$\{?CLAUDE_PLUGIN_ROOT\}?)[^'"\n]*?[\\/]+(?:dist[\\/]+hooks-host[\\/]+(?:pre-tool-use|post-tool-use|session-recap|reducer-session-start|reducer-prompt-submit|reducer-stop|command-expansion)\.js|hooks[\\/]+on-session-start\.mjs)/i;

export function claudeFormHook(command: unknown): boolean {
  const parsed = parseHookCommand(command);
  if (!parsed || parsed.launcherMark !== undefined) return false;
  if (parsed.program === "tkr-exec") return parsed.args.length === 1 && CLAUDE_EXEC_FLAGS.has(parsed.args[0]!);
  if (parsed.program === "tkr") return parsed.args.length === 2 && parsed.args[0] === "hook" && CLAUDE_HOOK_WORDS.has(parsed.args[1]!);
  return CLAUDE_SCRIPT_NAMES.has(parsed.program) && CLAUDE_SCRIPT_FORM.test(command as string);
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

import { basename } from "node:path";

export const SINGLE_CHECK_FLAG = "--single-check";

export type SingleEntry =
  | "tkr" | "tkr-exec" | "tkr-processor" | "tkr-daemon" | "tkr-shim"
  | "tkr-codex-hook" | "tkr-cursor-hook" | "tkr-gemini-hook" | "tkr-agent-hook" | "tkr-copilot-hook"
  | "tkr-droid-hook" | "tkr-trae-hook" | "tkr-qwen-hook" | "tkr-crush-hook" | "tkr-junie-hook" | "tkr-zcode-hook" | "tkr-grok-hook" | "tkr-context-hook"
  | "pre-tool-use" | "post-tool-use" | "session-recap" | "on-session-start"
  | "reducer-session-start" | "reducer-prompt-submit" | "reducer-stop" | "command-expansion";

const COMMANDS: Record<string, SingleEntry> = {
  exec: "tkr-exec",
  processor: "tkr-processor",
  daemon: "tkr-daemon",
  "shim-run": "tkr-shim"
};

const HOOKS: Record<string, SingleEntry> = {
  codex: "tkr-codex-hook",
  cursor: "tkr-cursor-hook",
  gemini: "tkr-gemini-hook",
  agent: "tkr-agent-hook",
  copilot: "tkr-copilot-hook",
  droid: "tkr-droid-hook",
  trae: "tkr-trae-hook",
  qwen: "tkr-qwen-hook",
  crush: "tkr-crush-hook",
  junie: "tkr-junie-hook",
  zcode: "tkr-zcode-hook",
  grok: "tkr-grok-hook",
  context: "tkr-context-hook",
  "pre-tool-use": "pre-tool-use",
  "post-tool-use": "post-tool-use",
  "session-recap": "session-recap",
  "session-start": "on-session-start",
  "reducer-session-start": "reducer-session-start",
  "reducer-prompt-submit": "reducer-prompt-submit",
  "reducer-stop": "reducer-stop",
  "command-expansion": "command-expansion"
};

export function selectEntry(args: readonly string[]): { entry: SingleEntry; args: string[] } {
  const [first, second] = args;
  if (first !== undefined && Object.hasOwn(COMMANDS, first)) return { entry: COMMANDS[first]!, args: args.slice(1) };
  if (first === "hook" && second !== undefined && Object.hasOwn(HOOKS, second)) return { entry: HOOKS[second]!, args: args.slice(2) };
  return { entry: "tkr", args: [...args] };
}

export function entryWords(script: string): string[] | null {
  const name = basename(script).replace(/\.(m?js|ts)$/, "");
  if (name === "tkr") return [];
  for (const [word, entry] of Object.entries(COMMANDS)) if (entry === name) return [word];
  for (const [word, entry] of Object.entries(HOOKS)) if (entry === name) return ["hook", word];
  return null;
}

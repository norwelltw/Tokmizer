import type { ReducerContextKind } from "./bonuses";
import { payloadSignals, type RouteHost } from "./hooks-host/payload-host";

export const CONTEXT_MARK = "tkr-context-hook";

export const CONTEXT_FORMATS = ["hso", "gemini", "plain", "top", "cursor", "copilot", "antigravity"] as const;
export type ContextFormat = (typeof CONTEXT_FORMATS)[number];

const PROMPT_EVENT: Partial<Record<ContextFormat, string>> = { hso: "UserPromptSubmit", gemini: "BeforeAgent" };

export function parseContextHookArgs(argv: readonly string[]): { format: ContextFormat; kind: ReducerContextKind } | null {
  const [format, kind] = argv;
  if (!(CONTEXT_FORMATS as readonly string[]).includes(format ?? "")) return null;
  if (kind !== "session" && kind !== "prompt") return null;
  return { format: format as ContextFormat, kind };
}

export function contextHookOutput(format: ContextFormat, kind: ReducerContextKind, text: string): string {
  if (format === "plain") return text;
  if (format === "top") return JSON.stringify({ additionalContext: text });
  if (format === "cursor") return JSON.stringify({ additional_context: text });
  if (format === "antigravity") return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] });
  if (format === "copilot") return JSON.stringify({ additionalContext: text, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
  const event = kind === "session" ? "SessionStart" : (PROMPT_EVENT[format] ?? "UserPromptSubmit");
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

export const HOST_CONTEXT_FORMAT: Partial<Record<RouteHost, ContextFormat>> = {
  "claude-code": "hso",
  codex: "hso",
  "gemini-cli": "gemini",
  cursor: "cursor",
  copilot: "copilot",
  droid: "hso",
  "qwen-code": "hso",
  zcode: "hso",
  trae: "plain",
  antigravity: "antigravity"
};

export function contextFormatFor(raw: string, declared: ContextFormat): ContextFormat | null {
  let payload: unknown;
  try {
    payload = raw.trim() ? JSON.parse(raw.replace(/^\uFEFF/, "")) : null;
  } catch {
    return declared;
  }
  const signals = payloadSignals(payload);
  if (signals.length > 1) return null;
  return (signals[0] && HOST_CONTEXT_FORMAT[signals[0]]) || declared;
}

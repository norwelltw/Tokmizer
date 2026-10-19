import { existsSync, readFileSync } from "node:fs";
import { parseJsonText } from "./json-text";
import { join } from "node:path";
import os from "node:os";
import { hookCommandFor, isJsonObject, isTokmizerHookCommand, keepFirstHook, readJsonConfig, writeJsonConfig, type HookInstall, type HookRemoval } from "./hook-config";

const MARK = "tkr-gemini-hook";
const EVENT = "BeforeTool";
const MATCHER = "run_shell_command";

type GeminiHook = { name?: string; type?: string; command?: string; timeout?: number } & Record<string, unknown>;
type GeminiGroup = { matcher?: string; hooks?: GeminiHook[] } & Record<string, unknown>;
type GeminiSettings = { hooks?: Record<string, unknown> } & Record<string, unknown>;

export function geminiSettingsFile(): string {
  return join(process.env.GEMINI_CLI_HOME || os.homedir(), ".gemini", "settings.json");
}

function isOurs(hook: unknown): boolean {
  return isJsonObject(hook) && isTokmizerHookCommand(hook.command, MARK);
}

function ours(group: GeminiGroup): GeminiHook | undefined {
  return (Array.isArray(group.hooks) ? group.hooks : []).find(isOurs);
}

function beforeTool(parsed: GeminiSettings): { hooks: Record<string, unknown>; groups: GeminiGroup[] } {
  const hooks = isJsonObject(parsed.hooks) ? parsed.hooks : {};
  const groups = Array.isArray(hooks[EVENT]) ? (hooks[EVENT] as GeminiGroup[]) : [];
  return { hooks, groups };
}

export function geminiHookInstalled(): boolean {
  try {
    const parsed = parseJsonText(readFileSync(geminiSettingsFile(), "utf8")) as GeminiSettings;
    return beforeTool(parsed).groups.some((g) => ours(g) != null);
  } catch {
    return false;
  }
}

export async function ensureGeminiHook(command: string): Promise<HookInstall> {
  const file = geminiSettingsFile();
  const parsed = (await readJsonConfig(file)) as GeminiSettings | null;
  if (!parsed) return "error";
  const { hooks, groups } = beforeTool(parsed);
  let status: HookInstall = "added";
  const existing = groups.map(ours).find((h) => h != null);
  if (existing) {
    const collapsed = keepFirstHook(groups, isOurs, existing, true);
    if (existing.command === command && existing.timeout === 10000 && !collapsed) return "present";
    existing.command = command;
    existing.timeout = 10000;
    status = "updated";
  } else {
    groups.push({ matcher: MATCHER, hooks: [{ name: "tokmizer", type: "command", command, timeout: 10000 }] });
  }
  hooks[EVENT] = groups;
  parsed.hooks = hooks;
  return (await writeJsonConfig(file, parsed)) ? status : "error";
}

export async function removeGeminiHook(): Promise<HookRemoval> {
  const file = geminiSettingsFile();
  if (!existsSync(file)) return "absent";
  const parsed = (await readJsonConfig(file)) as GeminiSettings | null;
  if (!parsed) return "error";
  const { hooks, groups } = beforeTool(parsed);
  if (!groups.some((g) => ours(g) != null)) return "absent";
  const kept = groups
    .map((g) => (Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
  if (kept.length) hooks[EVENT] = kept;
  else delete hooks[EVENT];
  parsed.hooks = hooks;
  return (await writeJsonConfig(file, parsed)) ? "removed" : "error";
}

export function geminiHookCommand(pathEnv: string, installedJs: string): string {
  return hookCommandFor(MARK, pathEnv, installedJs);
}

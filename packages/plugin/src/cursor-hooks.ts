import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { hookCommandFor, isJsonObject, isTokmizerHookCommand, keepFirstHook, readJsonConfig, writeJsonConfig, type HookInstall, type HookRemoval } from "./hook-config";

const MARK = "tkr-cursor-hook";
const EVENT = "preToolUse";
const MATCHER = "Shell";

type CursorHook = { command?: string; matcher?: string; timeout?: number } & Record<string, unknown>;
type CursorHooksFile = { version?: unknown; hooks?: Record<string, unknown> } & Record<string, unknown>;

export function cursorHooksFile(): string {
  return join(os.homedir(), ".cursor", "hooks.json");
}

function ours(hook: unknown): boolean {
  return isJsonObject(hook) && isTokmizerHookCommand(hook.command, MARK);
}

function preToolUse(parsed: CursorHooksFile): { hooks: Record<string, unknown>; entries: CursorHook[] } {
  const hooks = isJsonObject(parsed.hooks) ? parsed.hooks : {};
  const entries = Array.isArray(hooks[EVENT]) ? (hooks[EVENT] as CursorHook[]) : [];
  return { hooks, entries };
}

export function cursorHookInstalled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(cursorHooksFile(), "utf8")) as CursorHooksFile;
    return preToolUse(parsed).entries.some(ours);
  } catch {
    return false;
  }
}

export async function ensureCursorHook(command: string): Promise<HookInstall> {
  const file = cursorHooksFile();
  const parsed = (await readJsonConfig(file)) as CursorHooksFile | null;
  if (!parsed) return "error";
  const { hooks, entries } = preToolUse(parsed);
  let status: HookInstall = "added";
  const existing = entries.find(ours);
  if (existing) {
    const collapsed = keepFirstHook(entries, ours, existing, false);
    if (existing.command === command && existing.matcher === MATCHER && existing.timeout === 10 && !collapsed) return "present";
    existing.command = command;
    existing.matcher = MATCHER;
    existing.timeout = 10;
    status = "updated";
  } else {
    entries.push({ command, matcher: MATCHER, timeout: 10 });
  }
  hooks[EVENT] = entries;
  parsed.hooks = hooks;
  if (typeof parsed.version !== "number") parsed.version = 1;
  return (await writeJsonConfig(file, parsed)) ? status : "error";
}

export async function removeCursorHook(): Promise<HookRemoval> {
  const file = cursorHooksFile();
  if (!existsSync(file)) return "absent";
  const parsed = (await readJsonConfig(file)) as CursorHooksFile | null;
  if (!parsed) return "error";
  const { hooks, entries } = preToolUse(parsed);
  const kept = entries.filter((h) => !ours(h));
  if (kept.length === entries.length) return "absent";
  if (kept.length) hooks[EVENT] = kept;
  else delete hooks[EVENT];
  parsed.hooks = hooks;
  return (await writeJsonConfig(file, parsed)) ? "removed" : "error";
}

export function cursorHookCommand(pathEnv: string, installedJs: string): string {
  return hookCommandFor(MARK, pathEnv, installedJs);
}

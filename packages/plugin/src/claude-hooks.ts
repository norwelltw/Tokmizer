import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { failOpenHook, isJsonObject, readJsonConfig, writeJsonConfig, type HookInstall, type HookRemoval, type JsonObject } from "./hook-config";
import { stableSelfPath } from "./self-command";

type ClaudeHookSpec = { event: string; matcher: string; words: string; exec: boolean; timeout: number };

const CLAUDE_HOOKS: ClaudeHookSpec[] = [
  { event: "SessionStart", matcher: "", words: "hook session-start", exec: false, timeout: 5 },
  { event: "SessionStart", matcher: "", words: "hook reducer-session-start", exec: false, timeout: 5 },
  { event: "SessionStart", matcher: "", words: "hook session-recap", exec: false, timeout: 5 },
  { event: "UserPromptSubmit", matcher: "", words: "hook reducer-prompt-submit", exec: false, timeout: 5 },
  { event: "Stop", matcher: "", words: "hook reducer-stop", exec: false, timeout: 5 },
  { event: "UserPromptExpansion", matcher: "", words: "hook command-expansion", exec: false, timeout: 10 },
  { event: "PreToolUse", matcher: "Bash", words: "--pre-tool-use", exec: true, timeout: 5 },
  { event: "PostToolUse", matcher: "Read|Grep|Glob|Bash", words: "--post-tool-use", exec: true, timeout: 10 }
];

const PLUGIN_ID = "tokmizer@tokmizer";

type Hook = { command?: unknown } & JsonObject;
type Group = { matcher?: unknown; hooks?: unknown } & JsonObject;

export type ClaudeExecutables = { tkr: string; exec: string };

export function claudeSettingsFile(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), ".claude"), "settings.json");
}

function quote(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `"${path}"` : `'${path.replace(/'/g, "'\\''")}'`;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function claudeExecutables(pathEnv: string = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform, self: string = process.execPath): ClaudeExecutables {
  const execName = platform === "win32" ? "tkr-exec.exe" : "tkr-exec";
  const tkr = stableSelfPath(pathEnv, platform, self);
  const realExec = join(dirname(realOrNull(self) ?? self), execName);
  const besideStable = join(dirname(tkr), execName);
  const exec = existsSync(besideStable) && realOrNull(besideStable) === realOrNull(realExec) ? besideStable : realExec;
  return { tkr, exec };
}

function commandFor(spec: ClaudeHookSpec, executables: ClaudeExecutables, platform: NodeJS.Platform): string {
  const target = spec.exec ? executables.exec : executables.tkr;
  return `${failOpenHook(target, quote(target, platform), platform)} ${spec.words}`;
}

function isOurs(hook: unknown, spec: ClaudeHookSpec): hook is Hook {
  return isJsonObject(hook) && typeof hook.command === "string" &&
    hook.command.endsWith(` ${spec.words}`) && /tkr(?:-exec)?(?:\.exe)?['"]? /.test(hook.command);
}

function groupsOf(parsed: JsonObject, event: string): Group[] {
  const hooks = isJsonObject(parsed.hooks) ? parsed.hooks : {};
  return Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).filter(isJsonObject) as Group[] : [];
}

function hooksOf(group: Group): unknown[] {
  return Array.isArray(group.hooks) ? group.hooks : [];
}

export function claudePluginEnabled(parsed: JsonObject): boolean {
  return isJsonObject(parsed.enabledPlugins) && parsed.enabledPlugins[PLUGIN_ID] === true;
}

export function claudeHooksPresent(parsed: JsonObject): boolean {
  return CLAUDE_HOOKS.every((spec) => groupsOf(parsed, spec.event).some((group) => hooksOf(group).some((hook) => isOurs(hook, spec))));
}

export type ClaudeSetup = HookInstall | "plugin";

export async function ensureClaudeHooks(executables: ClaudeExecutables, platform: NodeJS.Platform = process.platform): Promise<ClaudeSetup> {
  const file = claudeSettingsFile();
  const parsed = await readJsonConfig(file);
  if (!parsed) return "error";
  if (claudePluginEnabled(parsed)) return "plugin";
  const hooks = isJsonObject(parsed.hooks) ? parsed.hooks : {};
  parsed.hooks = hooks;
  let changed = false;
  let added = false;
  for (const spec of CLAUDE_HOOKS) {
    const command = commandFor(spec, executables, platform);
    const groups = groupsOf(parsed, spec.event);
    const existing = groups.flatMap(hooksOf).find((hook): hook is Hook => isOurs(hook, spec));
    if (existing) {
      if (existing.command !== command || existing.timeout !== spec.timeout) {
        existing.command = command;
        existing.timeout = spec.timeout;
        changed = true;
      }
      continue;
    }
    const entry = { type: "command", command, timeout: spec.timeout };
    const group = groups.find((g) => g.matcher === spec.matcher);
    if (group) group.hooks = [...hooksOf(group), entry];
    else groups.push({ matcher: spec.matcher, hooks: [entry] });
    hooks[spec.event] = groups;
    changed = true;
    added = true;
  }
  if (!changed) return "present";
  if (!(await writeJsonConfig(file, parsed))) return "error";
  return added ? "added" : "updated";
}

export async function removeClaudeHooks(): Promise<HookRemoval> {
  const file = claudeSettingsFile();
  if (!existsSync(file)) return "absent";
  const parsed = await readJsonConfig(file);
  if (!parsed) return "error";
  if (!isJsonObject(parsed.hooks)) return "absent";
  const hooks = parsed.hooks;
  let removed = false;
  for (const event of new Set(CLAUDE_HOOKS.map((spec) => spec.event))) {
    const specs = CLAUDE_HOOKS.filter((spec) => spec.event === event);
    const groups = groupsOf(parsed, event);
    const kept = groups
      .map((group) => {
        const before = hooksOf(group);
        const after = before.filter((hook) => !specs.some((spec) => isOurs(hook, spec)));
        if (after.length !== before.length) removed = true;
        return { ...group, hooks: after };
      })
      .filter((group) => (group.hooks as unknown[]).length > 0);
    if (kept.length) hooks[event] = kept;
    else if (groups.length) delete hooks[event];
  }
  if (!removed) return "absent";
  return (await writeJsonConfig(file, parsed)) ? "removed" : "error";
}

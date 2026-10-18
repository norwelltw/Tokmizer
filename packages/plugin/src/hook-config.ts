import { readFile, writeFile, rename, mkdir, chmod, stat, unlink } from "node:fs/promises";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { entryWords } from "./single-entries";
import { singleBinary, stableSelfPath } from "./self-command";
import { ensureHookLauncherSync, hookLauncherFile } from "./shim/launcher";
import { writeConfigText } from "./config-backup";

export type JsonObject = Record<string, unknown>;

export type HookInstall = "added" | "updated" | "present" | "error";
export type HookRemoval = "removed" | "absent" | "error";

export function isJsonObject(value: unknown): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export async function readJsonConfig(file: string): Promise<JsonObject | null> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveConfigPath(file: string): string {
  let current = resolve(file);
  for (let depth = 0; depth < 32; depth++) {
    try {
      return realpathSync(current);
    } catch {}
    try {
      if (!lstatSync(current).isSymbolicLink()) break;
      current = resolve(dirname(current), readlinkSync(current));
    } catch {
      break;
    }
  }
  try {
    return join(realpathSync(dirname(current)), basename(current));
  } catch {
    return current;
  }
}

export async function writeTextPreserving(file: string, text: string): Promise<boolean> {
  const target = resolveConfigPath(file);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    await mkdir(dirname(target), { recursive: true });
    let mode = 0o600;
    try {
      mode = (await stat(target)).mode & 0o777;
    } catch {}
    await writeFile(tmp, text, { mode });
    await chmod(tmp, mode);
    await rename(tmp, target);
    return true;
  } catch {
    try {
      await unlink(tmp);
    } catch {}
    return false;
  }
}

export async function writeJsonConfig(file: string, data: JsonObject): Promise<boolean> {
  try {
    await mkdir(dirname(file), { recursive: true });
  } catch {
    return false;
  }
  return writeConfigText(file, `${JSON.stringify(data, null, 2)}\n`);
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function failOpenHook(target: string, run: string, platform: NodeJS.Platform = process.platform, test: "-x" | "-f" = "-x"): string {
  return platform === "win32" ? run : `[ ! ${test} ${shQuote(target)} ] || exec ${run}`;
}

export function hookCommandFor(mark: string, pathEnv: string, installedJs: string): string {
  if (process.platform !== "win32") {
    ensureHookLauncherSync(installedJs);
    return failOpenHook(hookLauncherFile(), `/bin/sh ${shQuote(hookLauncherFile())} ${mark}`, process.platform, "-f");
  }
  const words = singleBinary() ? entryWords(installedJs) : null;
  if (words) return [shQuote(stableSelfPath(pathEnv)), ...words].join(" ");
  return `node ${shQuote(installedJs)}`;
}

const QUOTED_TKR = String.raw`(?:'(?:(?:[^']|'\\'')*[\\/])?tkr(?:\.(?:exe|cmd|bat|ps1))?'|"(?:[^"]*[\\/])?tkr(?:\.(?:exe|cmd|bat|ps1))?"|(?:[^\s'"]*[\\/])?tkr(?:\.(?:exe|cmd|bat|ps1))?)`;

export function isTokmizerHookCommand(command: unknown, mark: string): boolean {
  if (typeof command !== "string") return false;
  if (command.includes(mark)) return true;
  const words = entryWords(mark);
  if (!words?.length) return false;
  return new RegExp(`^\\s*${QUOTED_TKR}\\s+${words.join("\\s+")}(?:\\s|$)`, "i").test(command);
}

export function keepFirstHook(list: unknown[], ours: (hook: unknown) => boolean, keep: unknown, nested: boolean): boolean {
  const drop = (hook: unknown): boolean => hook !== keep && ours(hook);
  let dropped = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (!nested) {
      if (drop(item)) {
        list.splice(i, 1);
        dropped = true;
      }
      continue;
    }
    if (!isJsonObject(item) || !Array.isArray(item.hooks)) continue;
    const hooks = item.hooks.filter((h) => !drop(h));
    if (hooks.length === item.hooks.length) continue;
    dropped = true;
    if (hooks.length) item.hooks = hooks;
    else list.splice(i, 1);
  }
  return dropped;
}

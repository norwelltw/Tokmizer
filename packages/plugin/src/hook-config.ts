import { readFile, writeFile, rename, mkdir, chmod, stat, unlink } from "node:fs/promises";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { entryWords } from "./single-entries";
import { singleBinary, stableSelfPath } from "./self-command";
import { ensureHookLauncherSync, hookLauncherFile } from "./shim/launcher";
import { writeConfigText } from "./config-backup";
import { parseJsonText } from "./json-text";

export type JsonObject = Record<string, unknown>;

export type HookInstall = "added" | "updated" | "present" | "error";
export type HookRemoval = "removed" | "absent" | "error";

export function isJsonObject(value: unknown): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export async function readJsonConfig(file: string): Promise<JsonObject | null> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = parseJsonText(await readFile(file, "utf8"));
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

type ShellWord = string;

// Splits a simple shell command into words. Returns null when it contains anything
// that makes it more than one plain command (unquoted ; & | ` $( or newlines).
function shellWords(command: string): ShellWord[] | null {
  const words: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += command.slice(i + 1, end);
      has = true;
      i = end;
    } else if (c === '"') {
      const end = command.indexOf('"', i + 1);
      if (end < 0) return null;
      const inner = command.slice(i + 1, end);
      if (/`|\$\(/.test(inner)) return null;
      cur += inner;
      has = true;
      i = end;
    } else if (c === "\\" && command[i + 1] === "'") {
      cur += "'";
      has = true;
      i++;
    } else if (c === " " || c === "\t") {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else if (c === ";" || c === "&" || c === "|" || c === "`" || c === "\n" || c === "\r" || (c === "$" && command[i + 1] === "(")) {
      return null;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words;
}

const FAIL_OPEN_PREFIX = /^\s*\[ ! -[a-z] (?:'(?:[^']|'\\'')*'|"[^"]*") \] \|\| /;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|m?js|sh)$/, "");
}

export type HookProgram = { program: string; args: string[]; launcherMark?: string };

// Parses a command only when it is a single plain command of a form Tokmizer writes:
// optional fail-open test prefix, optional NAME=value env prefix, optional exec, then program and args.
export function parseHookCommand(command: unknown): HookProgram | null {
  if (typeof command !== "string") return null;
  const rest = command.replace(FAIL_OPEN_PREFIX, "");
  const words = shellWords(rest);
  if (!words) return null;
  let i = 0;
  while (i < words.length && ENV_ASSIGN.test(words[i]!)) i++;
  if (words[i] === "exec") i++;
  if (i >= words.length || ENV_ASSIGN.test(words[i]!)) return null;
  const program = programName(words[i]!);
  const args = words.slice(i + 1);
  if (program === "sh" || program === "bash") {
    const launcher = args[0] !== undefined ? programName(args[0]) : "";
    if (/^tkr-hook(?:-launch)?$/.test(launcher)) return { program: launcher, args: args.slice(2), launcherMark: args[1] ?? "" };
    return { program, args };
  }
  if (program === "node") {
    return { program: args[0] !== undefined ? programName(args[0]) : "node", args: args.slice(1) };
  }
  return { program, args };
}

export function isTokmizerHookCommand(command: unknown, mark: string): boolean {
  const parsed = parseHookCommand(command);
  if (!parsed) return false;
  if (parsed.launcherMark !== undefined) return parsed.launcherMark === mark;
  if (parsed.program === mark) return true;
  if (parsed.program !== "tkr") return false;
  const words = entryWords(mark);
  if (!words?.length) return false;
  return words.every((w, i) => parsed.args[i] === w);
}

// Exact Claude settings form: tkr/tkr-exec followed by exactly the spec words.
export function isTokmizerProgramCommand(command: unknown, programs: readonly string[], words: string): boolean {
  const parsed = parseHookCommand(command);
  if (!parsed || !programs.includes(parsed.program) || parsed.launcherMark !== undefined) return false;
  return parsed.args.join(" ") === words;
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

import { readFile, mkdir } from "node:fs/promises";
import { parseJsonText } from "./json-text";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { hookCommandFor, isJsonObject, readJsonConfig, writeJsonConfig, writeTextPreserving, type HookInstall, type HookRemoval } from "./hook-config";
import { writeConfigText } from "./config-backup";

const MARK = "tkr-agent-hook";
const VIBE_NAME = "tokmizer-rewrite";
const ANTIGRAVITY_KEY = "tokmizer-rewrite";

export function agentHookCommand(host: "vibe" | "antigravity", pathEnv: string, installedJs: string): string {
  return `${hookCommandFor(MARK, pathEnv, installedJs)} ${host}`;
}

export function vibeHooksFile(): string {
  return join(process.env.VIBE_HOME || join(os.homedir(), ".vibe"), "hooks.toml");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function vibeBlock(command: string): string {
  return [
    "[[hooks]]",
    `name = ${tomlString(VIBE_NAME)}`,
    'type = "pre_tool"',
    'match = "bash"',
    `command = ${tomlString(command)}`,
    "timeout = 10.0",
    "strict = false",
    'description = "Route shell commands through tokmizer."',
    ""
  ].join("\n");
}

function splitTomlTables(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/(?<=\n)/)) {
    if (/^\s*\[\[?\s*[A-Za-z0-9_"'-]/.test(line) && current.length) {
      chunks.push(current.join(""));
      current = [];
    }
    current.push(line);
  }
  if (current.length) chunks.push(current.join(""));
  return chunks;
}

function isOurVibeTable(chunk: string): boolean {
  return /^\s*\[\[hooks\]\]/.test(chunk) && new RegExp(`^\\s*name\\s*=\\s*"${VIBE_NAME}"\\s*$`, "m").test(chunk);
}

function withoutOurTable(chunk: string): string {
  if (!isOurVibeTable(chunk)) return chunk;
  const lines = chunk.split(/(?<=\n)/);
  let end = 1;
  while (end < lines.length && !/^\s*(?:#.*)?\r?\n?$/.test(lines[end]!)) end++;
  while (end < lines.length && /^\s*\r?\n?$/.test(lines[end]!)) end++;
  return lines.slice(end).join("");
}

async function writeText(file: string, text: string): Promise<boolean> {
  try {
    await mkdir(dirname(file), { recursive: true });
  } catch {
    return false;
  }
  return writeConfigText(file, text);
}

export function vibeHookInstalled(): boolean {
  try {
    return splitTomlTables(readFileSync(vibeHooksFile(), "utf8")).some(isOurVibeTable);
  } catch {
    return false;
  }
}

export async function ensureVibeHook(command: string): Promise<HookInstall> {
  const file = vibeHooksFile();
  let text = "";
  try {
    if (existsSync(file)) text = await readFile(file, "utf8");
  } catch {
    return "error";
  }
  const block = vibeBlock(command);
  const chunks = splitTomlTables(text);
  const ours = chunks.filter(isOurVibeTable);
  if (ours.length === 1 && ours[0]!.trimEnd() === block.trimEnd()) return "present";
  const kept = chunks.map(withoutOurTable).join("").trimEnd();
  const next = kept ? `${kept}\n\n${block}` : block;
  return (await writeText(file, next)) ? (ours.length ? "updated" : "added") : "error";
}

export async function removeVibeHook(): Promise<HookRemoval> {
  const file = vibeHooksFile();
  if (!existsSync(file)) return "absent";
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return "error";
  }
  const chunks = splitTomlTables(text);
  if (!chunks.some(isOurVibeTable)) return "absent";
  const rest = chunks.map(withoutOurTable).join("").trimEnd();
  const kept = rest ? `${rest}\n` : "";
  return (await writeText(file, kept)) ? "removed" : "error";
}

export function antigravityHooksFile(): string {
  return join(os.homedir(), ".gemini", "config", "hooks.json");
}

function antigravityEntry(command: string): Record<string, unknown> {
  return {
    enabled: true,
    PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command, timeout: 10 }] }]
  };
}

export function antigravityHookInstalled(): boolean {
  try {
    const parsed: unknown = parseJsonText(readFileSync(antigravityHooksFile(), "utf8"));
    return isJsonObject(parsed) && isJsonObject(parsed[ANTIGRAVITY_KEY]);
  } catch {
    return false;
  }
}

export async function ensureAntigravityHook(command: string): Promise<HookInstall> {
  const file = antigravityHooksFile();
  const parsed = await readJsonConfig(file);
  if (!parsed) return "error";
  const entry = antigravityEntry(command);
  const existing = parsed[ANTIGRAVITY_KEY];
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(entry)) return "present";
  parsed[ANTIGRAVITY_KEY] = entry;
  return (await writeJsonConfig(file, parsed)) ? (existing === undefined ? "added" : "updated") : "error";
}

export async function removeAntigravityHook(): Promise<HookRemoval> {
  const file = antigravityHooksFile();
  if (!existsSync(file)) return "absent";
  const parsed = await readJsonConfig(file);
  if (!parsed) return "error";
  if (!(ANTIGRAVITY_KEY in parsed)) return "absent";
  delete parsed[ANTIGRAVITY_KEY];
  return (await writeJsonConfig(file, parsed)) ? "removed" : "error";
}

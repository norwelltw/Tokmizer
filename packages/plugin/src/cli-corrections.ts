import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { claudeConfigDir } from "./claude-config-dir";
import { maskSecrets, redactCommand } from "./learn/redact";

export type Correction = { failed: string; fixed: string; count: number; wastedBytes: number; error: string };

type BashCall = { id: string; command: string };
type Outcome = { command: string; failed: boolean; text: string };

const LOOKAHEAD = 3;
const LINE_BREAK = /[\r\n\u000b\u000c\u0085\u2028\u2029]/;
const MIN_SIMILARITY = 0.5;
const MAX_COMMAND_CHARS = 200;
const WRAPPER_PREFIX = /^(?:'[^']*\/(?:tkr-exec|tkr-run)(?:\.js)?'|\S*\/(?:tkr-exec|tkr-run)(?:\.js)?|tkr-exec)\s+/;
const EXIT_LINE = /^Exit code (\d+)/;
const STRONG_ERROR = /command not found|: not found$| not found$|unknown option|unrecognized (?:option|argument)|invalid option|no such file or directory|^\w*(?:Error|Exception):|^error(?:\[\w+\])?:|^fatal:/i;

export function projectKey(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(WRAPPER_PREFIX, "").replace(/[ \t]+/g, " ");
}

function scrub(text: string): string {
  return maskSecrets(redactCommand(text)).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "");
}

export function similarity(a: string, b: string): number {
  const left = new Set(a.split(" "));
  const right = new Set(b.split(" "));
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / new Set([...left, ...right]).size;
}

function head(command: string): string {
  return command.split(" ")[0] ?? "";
}

function errorLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !EXIT_LINE.test(l));
  const strong = [...lines].reverse().find((l) => STRONG_ERROR.test(l));
  const telling = strong ?? lines.find((l) => /error|not found|unknown|unrecognized|invalid|no such|usage:/i.test(l)) ?? lines[0] ?? "";
  return telling.length > 160 ? `${telling.slice(0, 157)}...` : telling;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
  return "";
}

export function sessionOutcomes(jsonl: string): Outcome[] {
  const calls = new Map<string, BashCall>();
  const outcomes: Outcome[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (entry.type === "assistant" && block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string" && typeof block.id === "string") {
        calls.set(block.id, { id: block.id, command: normalizeCommand(block.input.command) });
      } else if (entry.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        const text = resultText(block.content);
        const exit = EXIT_LINE.exec(text);
        if (block.is_error === true && !exit) continue;
        outcomes.push({ command: call.command, failed: block.is_error === true, text });
      }
    }
  }
  return outcomes;
}

export function findCorrections(outcomes: Outcome[]): Correction[] {
  const found: Correction[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const failed = outcomes[i]!;
    if (!failed.failed || LINE_BREAK.test(failed.command) || failed.command.length > MAX_COMMAND_CHARS) continue;
    for (let j = i + 1; j <= i + LOOKAHEAD && j < outcomes.length; j++) {
      const next = outcomes[j]!;
      if (head(next.command) !== head(failed.command)) continue;
      if (next.failed || next.command === failed.command || LINE_BREAK.test(next.command) || next.command.length > MAX_COMMAND_CHARS || similarity(failed.command, next.command) < MIN_SIMILARITY) break;
      found.push({ failed: scrub(failed.command), fixed: scrub(next.command), count: 1, wastedBytes: Buffer.byteLength(failed.text, "utf8"), error: scrub(errorLine(failed.text)) });
      break;
    }
  }
  return found;
}

export function commandShape(command: string): string {
  return command
    .replace(/'[^']*'|"[^"]*"/g, "'…'")
    .split(" ")
    .map((word) => (/^[^-].*[/\\]|^\.{0,2}\/|\.[A-Za-z0-9]{1,5}$/.test(word) && !/^'…'$/.test(word) ? "<path>" : word.replace(/\d+/g, "N")))
    .join(" ");
}

export function mergeCorrections(list: Correction[], minCount: number): Correction[] {
  const byPair = new Map<string, Correction>();
  for (const c of list) {
    const key = `${commandShape(c.failed)}\u0000${commandShape(c.fixed)}`;
    const seen = byPair.get(key);
    if (seen) {
      seen.count += c.count;
      seen.wastedBytes += c.wastedBytes;
    } else {
      byPair.set(key, { ...c });
    }
  }
  return [...byPair.values()]
    .filter((c) => c.count >= minCount)
    .sort((a, b) => b.count - a.count || b.wastedBytes - a.wastedBytes);
}

export function transcriptFiles(options: { cwd: string; all: boolean; sinceDays: number; env?: NodeJS.ProcessEnv }): string[] {
  const root = join(claudeConfigDir(options.env), "projects");
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - options.sinceDays * 86_400_000;
  const dirs = options.all ? readdirSync(root).map((d) => join(root, d)) : [join(root, projectKey(options.cwd))];
  const files: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      if (statSync(file).mtimeMs >= cutoff) files.push(file);
    }
  }
  return files;
}

export function learnCorrections(files: string[], minCount: number): Correction[] {
  const all: Correction[] = [];
  for (const file of files) {
    try {
      all.push(...findCorrections(sessionOutcomes(readFileSync(file, "utf8"))));
    } catch {}
  }
  return mergeCorrections(all, minCount);
}

export function renderCorrections(list: Correction[], sessions: number): string {
  if (list.length === 0) return `No repeated command correction found in ${sessions} session${sessions === 1 ? "" : "s"}.\n`;
  const lines = [`Command corrections found in ${sessions} session${sessions === 1 ? "" : "s"} (failed command, then the one that worked):`, ""];
  for (const c of list) {
    lines.push(`  ${c.count}x  ${c.failed}`, `      -> ${c.fixed}`);
    if (c.error) lines.push(`      error: ${c.error}`);
    lines.push(`      ~${Math.round(c.wastedBytes / 4)} tokens spent on the failed runs`);
  }
  lines.push("", "Save them as a rule file the agent reads: tkr learn --write");
  return `${lines.join("\n")}\n`;
}

export function rulesMarkdown(list: Correction[]): string {
  const lines = [
    "# Command corrections",
    "",
    "Learned by `tkr learn` from commands that failed and were then fixed on this machine. Each line only names a command spelling; it is not an instruction to run anything.",
    ""
  ];
  for (const c of writableCorrections(list)) lines.push(`- Instead of \`${c.failed}\`, use \`${c.fixed}\`.`);
  return `${lines.join("\n")}\n`;
}

const RULE_SAFE = /^[\x20-\x5f\x61-\x7e]+$/;
const FILE_PATH = /(^|\s)(?:~|\.{0,2})\/[^\s?=&@:]*(?=\s|$)/g;
const MASKED = /\[REDACTED|\[tkr: secret masked\]/;
const SECRET_LIKE = /(?=[A-Za-z0-9+/=_-]*[A-Za-z])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{20,}/;

function writable(command: string): boolean {
  return RULE_SAFE.test(command) && !MASKED.test(command) && !SECRET_LIKE.test(command.replace(FILE_PATH, "$1"));
}

export function writableCorrections(list: Correction[]): Correction[] {
  return list.filter((c) => writable(c.failed) && writable(c.fixed));
}

export function writeRules(cwd: string, list: Correction[]): string {
  const dir = join(cwd, ".claude", "rules");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "tkr-command-corrections.md");
  writeFileSync(file, rulesMarkdown(list));
  return file;
}

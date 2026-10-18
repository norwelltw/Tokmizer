import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { isJsonObject, readJsonConfig, writeJsonConfig, type JsonObject } from "./hook-config";
import { writeConfigText } from "./config-backup";
import { foreignTo } from "./hook-forms";

export { claudeFormHook } from "./hook-forms";

const foreign = foreignTo("codex");

export function codexHome(): string {
  return process.env.CODEX_HOME || join(os.homedir(), ".codex");
}

export function codexConfigFile(): string {
  return join(codexHome(), "config.toml");
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

type TomlTable = { header: string; start: number; end: number };

const TOML_HEADER = /^\s*\[\[?[^\[\]=,]+\]\]?\s*(?:#.*)?$/;

function tomlTables(lines: string[]): TomlTable[] {
  const tables: TomlTable[] = [];
  let quote: string | null = null;
  lines.forEach((line, i) => {
    const opening = quote === null && TOML_HEADER.test(line);
    for (const m of line.matchAll(/"""|'''/g)) {
      if (quote === null) quote = m[0];
      else if (quote === m[0]) quote = null;
    }
    if (!opening) return;
    if (tables.length) tables[tables.length - 1]!.end = i;
    tables.push({ header: line.trim().replace(/\s*#.*$/, ""), start: i, end: lines.length });
  });
  return tables;
}

const PLUGIN_HEADER = /^\[\s*plugins\s*\.\s*(?:"tokmizer@([^"]+)"|'tokmizer@([^']+)')\s*\]$/;
const PLUGIN_INLINE = /^(\s*(?:plugins\s*\.\s*)?(["'])tokmizer@([^"']+)\2\s*=\s*\{)([^}]*)(\}.*)$/;

export type CodexPluginState = "hooked" | "legacy";
export type CodexPlugin = { id: string; marketplace: string; enabled: boolean; state: CodexPluginState | null };

function versionKey(name: string): number[] {
  return name.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : -1));
}

function newestFirst(a: string, b: string): number {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? -1) - (x[i] ?? -1);
    if (d) return d;
  }
  return b.localeCompare(a);
}

function cachedState(marketplace: string): CodexPluginState | null {
  const root = join(codexHome(), "plugins", "cache", marketplace, "tokmizer");
  let newest: string | undefined;
  try {
    newest = readdirSync(root).sort(newestFirst)[0];
  } catch {
    return null;
  }
  if (!newest) return null;
  const dir = join(root, newest);
  const manifest = readText(join(dir, ".codex-plugin", "plugin.json"));
  try {
    if (manifest !== null && JSON.parse(manifest).hooks != null) return "hooked";
  } catch {}
  return existsSync(join(dir, "hooks", "hooks.json")) ? "legacy" : null;
}

type PluginEntry = { marketplace: string; enabled: boolean; table?: TomlTable; line?: number };

function pluginEntries(lines: string[]): PluginEntry[] {
  const entries: PluginEntry[] = [];
  const tables = tomlTables(lines);
  for (const table of tables) {
    const m = PLUGIN_HEADER.exec(table.header);
    if (!m) continue;
    const body = lines.slice(table.start + 1, table.end);
    entries.push({ marketplace: (m[1] ?? m[2])!, enabled: !body.some((line) => /^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(line)), table });
  }
  lines.forEach((line, i) => {
    const m = PLUGIN_INLINE.exec(line);
    if (!m) return;
    const owner = tables.filter((t) => t.start < i && i < t.end)[0];
    const bare = !/^\s*plugins\s*\./.test(line);
    if (bare ? owner?.header !== "[plugins]" : owner !== undefined) return;
    entries.push({ marketplace: m[3]!, enabled: !/(?:^|,)\s*enabled\s*=\s*false\s*(?:,|$)/.test(m[4]!), line: i });
  });
  return entries;
}

export function codexPlugins(text: string | null = readText(codexConfigFile())): CodexPlugin[] {
  if (!text) return [];
  return pluginEntries(text.split(/\r?\n/)).map((e) => ({ id: `tokmizer@${e.marketplace}`, marketplace: e.marketplace, enabled: e.enabled, state: cachedState(e.marketplace) }));
}

export function codexPluginProvidesHook(): boolean {
  const active = codexPlugins().filter((p) => p.enabled && p.state);
  return active.length > 0 && active.every((p) => p.state === "hooked");
}

export function disableLegacyPlugins(text: string, ids: readonly string[]): string {
  const lines = text.split(/(?<=\n)/);
  const bare = lines.map((line) => line.replace(/\r?\n$/, ""));
  const entries = pluginEntries(bare).filter((e) => ids.includes(`tokmizer@${e.marketplace}`));
  for (const entry of entries.sort((x, y) => (y.table?.start ?? y.line!) - (x.table?.start ?? x.line!))) {
    if (entry.line !== undefined) {
      const m = PLUGIN_INLINE.exec(bare[entry.line]!)!;
      const fields = /\benabled\s*=\s*\w+/.test(m[4]!) ? m[4]!.replace(/\benabled\s*=\s*\w+/, "enabled = false") : m[4]!.trim() ? ` enabled = false,${m[4]}` : " enabled = false ";
      lines[entry.line] = `${m[1]}${fields}${m[5]}${lines[entry.line]!.slice(bare[entry.line]!.length)}`;
      continue;
    }
    const table = entry.table!;
    const eol = /\r\n$/.test(lines[table.start] ?? "") ? "\r\n" : "\n";
    const at = bare.slice(table.start + 1, table.end).findIndex((line) => /^\s*enabled\s*=/.test(line));
    if (at >= 0) lines[table.start + 1 + at] = `enabled = false${eol}`;
    else lines.splice(table.start + 1, 0, `enabled = false${eol}`);
    if (!/\n$/.test(lines[table.start]!)) lines[table.start] += eol;
  }
  return lines.join("");
}

const HOOK_GROUP = /^\[\[\s*hooks\s*\.\s*(["']?)([A-Za-z]+)\1\s*\]\]$/;
const HOOK_ENTRY = /^\[\[\s*hooks\s*\.\s*(["']?)([A-Za-z]+)\1\s*\.\s*(["']?)hooks\3\s*\]\]$/;
const TOML_COMMAND = /^\s*command\s*=\s*(.+)$/;
const TOML_COMMANDS = /\bcommand\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')/g;

function tomlText(value: string): string {
  const v = value.trim();
  if (v.startsWith("'")) return /^'([^']*)'/.exec(v)?.[1] ?? v;
  const m = /^"((?:\\.|[^"\\])*)"/.exec(v);
  if (!m) return v;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1]!;
  }
}

export type TomlHookScan = { text: string; removed: string[]; inline: string[] };

export function stripTomlHooks(text: string, foreign: (command: string) => boolean): TomlHookScan {
  const lines = text.split(/(?<=\n)/);
  const bare = lines.map((line) => line.replace(/\r?\n$/, ""));
  const tables = tomlTables(bare);
  const drop = new Set<TomlTable>();
  const children = new Map<TomlTable, TomlTable[]>();
  const removed: string[] = [];
  const inline: string[] = [];
  tables.forEach((table, i) => {
    const body = bare.slice(table.start + 1, table.end);
    if (HOOK_ENTRY.test(table.header)) {
      const command = body.map((line) => TOML_COMMAND.exec(line)?.[1]).find((v) => v != null);
      if (command && foreign(tomlText(command))) {
        drop.add(table);
        removed.push(command.trim());
      }
      return;
    }
    const group = HOOK_GROUP.exec(table.header);
    if (!group) return;
    const own: TomlTable[] = [];
    for (const next of tables.slice(i + 1)) {
      if (HOOK_ENTRY.exec(next.header)?.[2] !== group[2]) break;
      own.push(next);
    }
    children.set(table, own);
  });
  for (const [group, own] of children) if (own.length && own.every((c) => drop.has(c))) drop.add(group);
  for (const table of [...drop].sort((a, b) => b.start - a.start)) {
    let end = table.end;
    let tail = end;
    while (tail - 1 > table.start && /^\s*(?:#.*)?$/.test(bare[tail - 1]!)) tail--;
    const note = bare.slice(tail, end).findIndex((line) => /^\s*#/.test(line));
    if (note >= 0 && end < bare.length) end = tail + note;
    lines.splice(table.start, end - table.start);
  }
  const text2 = lines.join("");
  for (const line of text2.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(TOML_COMMANDS)) if (foreign(tomlText(m[1]!))) inline.push(line.trim());
  }
  return { text: text2, removed, inline };
}

type HookGroup = JsonObject & { hooks?: unknown };

export function stripJsonHooks(parsed: JsonObject, foreign: (command: unknown) => boolean): string[] {
  const removed: string[] = [];
  if (!isJsonObject(parsed.hooks)) return removed;
  const events = parsed.hooks;
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isJsonObject(group) || !Array.isArray((group as HookGroup).hooks)) {
        kept.push(group);
        continue;
      }
      const hooks = (group.hooks as unknown[]).filter((hook) => {
        const ours = isJsonObject(hook) && foreign(hook.command);
        if (ours) removed.push(String((hook as JsonObject).command));
        return !ours;
      });
      if (hooks.length) kept.push(hooks.length === (group.hooks as unknown[]).length ? group : { ...group, hooks });
    }
    if (kept.length) events[event] = kept;
    else delete events[event];
  }
  return removed;
}

export type CodexFinding =
  | { kind: "hooks-json"; file: string; commands: string[] }
  | { kind: "config-toml"; file: string; commands: string[]; inline: string[] }
  | { kind: "legacy-plugin"; file: string; ids: string[] };

function hooksJsonFile(): string {
  return join(codexHome(), "hooks.json");
}

export function projectCodexDirs(cwd: string = process.cwd()): string[] {
  const dirs: string[] = [];
  const stop = new Set([resolve(os.homedir()), resolve(codexHome(), "..")]);
  let dir = resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    const codex = join(dir, ".codex");
    if (resolve(codex) !== resolve(codexHome()) && existsSync(codex)) dirs.push(codex);
    if (existsSync(join(dir, ".git")) || stop.has(dir) || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return dirs;
}

function jsonFinding(file: string): CodexFinding | null {
  const json = readText(file);
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isJsonObject(parsed)) return null;
    const commands = stripJsonHooks(structuredClone(parsed), foreign);
    return commands.length ? { kind: "hooks-json", file, commands } : null;
  } catch {
    return null;
  }
}

function tomlFinding(file: string, toml: string | null = readText(file)): CodexFinding | null {
  if (!toml) return null;
  const scan = stripTomlHooks(toml, foreign);
  return scan.removed.length || scan.inline.length ? { kind: "config-toml", file, commands: scan.removed, inline: scan.inline } : null;
}

export function codexFindings(cwd: string = process.cwd(), project = false): CodexFinding[] {
  const findings: (CodexFinding | null)[] = [jsonFinding(hooksJsonFile())];
  const toml = readText(codexConfigFile());
  findings.push(tomlFinding(codexConfigFile(), toml));
  const legacy = toml ? codexPlugins(toml).filter((p) => p.enabled && p.state === "legacy").map((p) => p.id) : [];
  if (legacy.length) findings.push({ kind: "legacy-plugin", file: codexConfigFile(), ids: legacy });
  if (project) for (const dir of projectCodexDirs(cwd)) findings.push(jsonFinding(join(dir, "hooks.json")), tomlFinding(join(dir, "config.toml")));
  return findings.filter((f): f is CodexFinding => f !== null);
}

export function codexFindingLines(findings: readonly CodexFinding[]): string[] {
  return findings.map((f) =>
    f.kind === "legacy-plugin"
      ? `Codex:    the ${f.ids.join(", ")} plugin is an old build that makes Codex run the Claude Code hooks (error "updatedInput without permissionDecision:allow") — run: tkr doctor --fix`
      : f.kind === "config-toml" && f.inline.length && !f.commands.length
        ? `Codex:    ${f.file} has Tokmizer hooks made for another agent, written in a form tkr cannot edit safely — remove them by hand, then run: tkr setup-codex`
        : `Codex:    ${f.file} has ${f.commands.length} Tokmizer hook${f.commands.length === 1 ? "" : "s"} made for another agent (copied or imported, e.g. by Codex /import) — run: tkr doctor --fix`
  );
}

export type CodexRepair = { lines: string[]; changed: boolean; error: boolean };

export async function repairCodexConfig(findings: readonly CodexFinding[] = codexFindings()): Promise<CodexRepair> {
  const lines: string[] = [];
  let changed = false;
  let error = false;
  for (const f of findings) {
    if (f.kind === "hooks-json") {
      const parsed = await readJsonConfig(f.file);
      const removed = parsed ? stripJsonHooks(parsed, foreign) : [];
      if (!parsed || (removed.length && !(await writeJsonConfig(f.file, parsed)))) {
        error = true;
        lines.push(`Could not update ${f.file}; remove the Tokmizer hooks made for another agent from it by hand.`);
        continue;
      }
      if (removed.length) {
        changed = true;
        lines.push(`Removed ${removed.length} Tokmizer hook${removed.length === 1 ? "" : "s"} made for another agent from ${f.file} (backup in ~/.tokmizer/backup/config).`);
      }
      continue;
    }
    const current = readText(f.file);
    if (current === null) continue;
    if (f.kind === "config-toml") {
      const scan = stripTomlHooks(current, foreign);
      if (!scan.removed.length) continue;
      if (!(await writeConfigText(f.file, scan.text, current))) {
        error = true;
        lines.push(`Could not update ${f.file}; remove the Tokmizer hooks made for another agent from it by hand.`);
        continue;
      }
      changed = true;
      lines.push(`Removed ${scan.removed.length} Tokmizer hook${scan.removed.length === 1 ? "" : "s"} made for another agent from ${f.file} (backup in ~/.tokmizer/backup/config).`);
      continue;
    }
    if (!(await writeConfigText(f.file, disableLegacyPlugins(current, f.ids), current))) {
      error = true;
      lines.push(`Could not update ${f.file}; run: codex plugin remove ${f.ids[0]}`);
      continue;
    }
    changed = true;
    lines.push(`Turned off the old ${f.ids.join(", ")} Codex plugin, which ran the Claude Code hooks (backup in ~/.tokmizer/backup/config). Once a newer Tokmizer is out, codex plugin marketplace upgrade then codex plugin add ${f.ids[0]} brings it back.`);
  }
  return { lines, changed, error };
}

import { chmod, mkdir, readFile, writeFile, stat, readdir, rm, rename } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { maskSecrets } from "./learn/redact";
import { READ_EDIT_NOTICE } from "./engine/read-notice";
import { contentCacheDir, contentCacheFile, restoreConfigFile, tokmizerHome } from "./paths";
import { yoloEnabled } from "./yolo-mode";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 30 * DAY_MS;
const DEFAULT_DIR_CAP_BYTES = 200 * 1024 * 1024;
const DEFAULT_ENTRY_MAX_BYTES = 8 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{8,64}$/i;
const ENTRY_NAME_RE = /^[0-9a-f]{8,64}$/;
const META_SUFFIX = ".meta";
const LIST_LIMIT = 30;
const GREP_LIMIT = 200;
const RESTORE_USAGE = [
  "usage: tkr restore <hash> [--lines a:b] [--grep pattern]",
  "       tkr restore --list [--all-projects]",
  "       tkr restore --grep <pattern> [--all-projects]",
  ""
].join("\n");

export type CacheEntryMeta = { at: number; bytes: number; lines: number; partial: boolean; label?: string; project?: string };

export type CacheEntry = { hash: string; at: number; bytes: number; lines: number | null; partial: boolean | null; label: string | null; project: string | null };

type RestoreResult = { stdout?: string; stderr?: string; code: number; restoredTokens?: number };

export type RestoreConfig = { maxAgeDays?: number; disabled?: boolean };

export function readRestoreConfig(): RestoreConfig {
  try {
    const parsed = JSON.parse(readFileSync(restoreConfigFile(), "utf8")) as Record<string, unknown>;
    const days = parsed.maxAgeDays;
    return {
      ...(typeof days === "number" && Number.isFinite(days) && days > 0 ? { maxAgeDays: Math.min(days, 365) } : {}),
      ...(parsed.disabled === true ? { disabled: true } : {})
    };
  } catch {
    return {};
  }
}

function defaultMaxAgeMs(): number {
  const days = readRestoreConfig().maxAgeDays;
  return days ? days * DAY_MS : DEFAULT_MAX_AGE_MS;
}

function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function contentCacheLimits(env: NodeJS.ProcessEnv = process.env): { maxAgeMs: number; maxBytes: number; entryMaxBytes: number } {
  return {
    maxAgeMs: envInt("TOKMIZER_CCR_MAX_AGE_MS", defaultMaxAgeMs(), env),
    maxBytes: envInt("TOKMIZER_CCR_DIR_CAP_BYTES", DEFAULT_DIR_CAP_BYTES, env),
    entryMaxBytes: envInt("TOKMIZER_CCR_ENTRY_MAX_BYTES", DEFAULT_ENTRY_MAX_BYTES, env)
  };
}

function metaFile(hash: string): string {
  return `${contentCacheFile(hash)}${META_SUFFIX}`;
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {}
}

function projectRoot(cwd: string = process.cwd()): string {
  let dir: string;
  try {
    dir = realpathSync(resolve(cwd));
  } catch {
    dir = resolve(cwd);
  }
  for (let cur = dir; ; cur = dirname(cur)) {
    if (existsSync(join(cur, ".git"))) return cur;
    if (dirname(cur) === cur) return dir;
  }
}

function splitLines(content: string): string[] {
  if (content === "") return [];
  return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n");
}

export async function writeContentCache(
  hash: string,
  content: string,
  env: NodeJS.ProcessEnv = process.env,
  info: { partial?: boolean; label?: string | undefined; cwd?: string } = {}
): Promise<boolean> {
  if (yoloEnabled()) return false;
  if (!HASH_RE.test(hash)) return false;
  content = maskSecrets(content);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > envInt("TOKMIZER_CCR_ENTRY_MAX_BYTES", DEFAULT_ENTRY_MAX_BYTES, env)) {
    return false;
  }
  const target = contentCacheFile(hash);
  const tmp = `${target}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  try {
    await ensurePrivateDir(tokmizerHome());
    await ensurePrivateDir(contentCacheDir());
    if (yoloEnabled()) return false;
    await writeFile(tmp, content, { mode: 0o600 });
    await chmod(tmp, 0o600);
    if (yoloEnabled()) {
      await rm(tmp, { force: true });
      return false;
    }
    await rename(tmp, target);
  } catch {
    try {
      await rm(tmp);
    } catch {}
    return false;
  }
  const meta: CacheEntryMeta = {
    at: Date.now(),
    bytes,
    lines: splitLines(content).length,
    partial: info.partial === true,
    ...(info.label ? { label: info.label.slice(0, 40) } : {}),
    project: projectRoot(info.cwd)
  };
  try {
    await writeFile(metaFile(hash), JSON.stringify(meta), { mode: 0o600 });
  } catch {}
  return true;
}

function ccrDisabled(env: NodeJS.ProcessEnv): boolean {
  const disabled = env.TOKMIZER_CCR_DISABLED;
  return disabled === "1" || disabled === "true" || yoloEnabled() || readRestoreConfig().disabled === true;
}

const MARKER_LOOKALIKE_RE = /^(?=\[tkr |\[tokmizer\])/gm;
const NOTICE_LINE_RE = /^\[tkr:/;
const NOTICE_KINDS: ReadonlyArray<(line: string) => boolean> = [
  (line) => line === READ_EDIT_NOTICE,
  (line) => /^\[tkr: previous log line repeated \d+ additional times\]$/.test(line)
];

function neutralizeMarkers(text: string, input: string | null | undefined): string {
  const marked = text.replace(MARKER_LOOKALIKE_RE, "> ");
  if (!marked.includes("[tkr:")) return marked;
  const inputLines = input == null ? null : input.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => NOTICE_LINE_RE.test(line));
  const genuine = (line: string): boolean => {
    if (inputLines == null) return false;
    const kind = NOTICE_KINDS.find((matches) => matches(line));
    return kind != null && !inputLines.some(kind);
  };
  return marked.split("\n").map((line) => (NOTICE_LINE_RE.test(line) && !genuine(line) ? `> ${line}` : line)).join("\n");
}

async function storeEntry(content: string, partial: boolean, label: string | undefined, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return (await writeContentCache(hash, content, env, { partial, label })) ? hash : null;
}

export async function captureForRestore(
  droppedTail: string | null,
  compressed: string,
  env: NodeJS.ProcessEnv = process.env,
  source: { raw?: string | null | undefined; label?: string | undefined } = {}
): Promise<string> {
  compressed = neutralizeMarkers(compressed, source.raw);
  if (ccrDisabled(env)) return compressed;
  if (!droppedTail) return compressed;
  const hint = (hash: string): string => `\n[tkr restore ${hash}]`;
  if (Buffer.byteLength(droppedTail, "utf8") <= Buffer.byteLength(hint("0".repeat(16)), "utf8")) return compressed;
  if (source.raw) {
    const full = await storeEntry(source.raw, false, source.label, env);
    if (full) return `${compressed}${hint(full)}`;
  }
  const tail = await storeEntry(droppedTail, true, source.label, env);
  return tail ? `${compressed}${hint(tail)}` : compressed;
}

export async function captureOriginalForRestore(
  original: string | null,
  compressed: string,
  env: NodeJS.ProcessEnv = process.env,
  source: { label?: string | undefined } = {}
): Promise<string> {
  compressed = neutralizeMarkers(compressed, original);
  if (ccrDisabled(env)) return compressed;
  if (!original) return compressed;
  const hash = await storeEntry(original, false, source.label, env);
  return hash ? `${compressed}\n[tkr restore ${hash}]` : compressed;
}

async function readMeta(hash: string): Promise<CacheEntryMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(metaFile(hash), "utf8")) as Partial<CacheEntryMeta>;
    if (typeof parsed.at !== "number" || typeof parsed.bytes !== "number" || typeof parsed.lines !== "number" || typeof parsed.partial !== "boolean") return null;
    return {
      at: parsed.at,
      bytes: parsed.bytes,
      lines: parsed.lines,
      partial: parsed.partial,
      ...(typeof parsed.label === "string" && parsed.label ? { label: parsed.label } : {}),
      ...(typeof parsed.project === "string" && parsed.project ? { project: parsed.project } : {})
    };
  } catch {
    return null;
  }
}

export async function listContentCache(): Promise<CacheEntry[]> {
  let names: string[];
  try {
    names = await readdir(contentCacheDir());
  } catch {
    return [];
  }
  const maxAge = contentCacheLimits().maxAgeMs;
  const now = Date.now();
  const entries: CacheEntry[] = [];
  for (const name of names) {
    if (!ENTRY_NAME_RE.test(name)) continue;
    try {
      const s = await stat(contentCacheFile(name));
      if (now - s.mtimeMs > maxAge) continue;
      const meta = await readMeta(name);
      entries.push({
        hash: name,
        at: s.mtimeMs,
        bytes: s.size,
        lines: meta?.lines ?? null,
        partial: meta?.partial ?? null,
        label: meta?.label ?? null,
        project: meta?.project ?? null
      });
    } catch {}
  }
  return entries.sort((a, b) => b.at - a.at);
}

export async function contentCacheStats(): Promise<{ entries: number; bytes: number; partialEntries: number; retentionDays: number; entryMaxBytes: number; maxBytes: number }> {
  const entries = await listContentCache();
  const limits = contentCacheLimits();
  return {
    entries: entries.length,
    bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    partialEntries: entries.filter((e) => e.partial === true).length,
    retentionDays: Math.round((limits.maxAgeMs / DAY_MS) * 100) / 100,
    entryMaxBytes: limits.entryMaxBytes,
    maxBytes: limits.maxBytes
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function ageLabel(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

export function retentionLabel(maxAgeMs: number = contentCacheLimits().maxAgeMs): string {
  if (maxAgeMs < DAY_MS) return ageLabel(maxAgeMs);
  const days = Math.round(maxAgeMs / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function renderList(entries: CacheEntry[]): string {
  const kept = retentionLabel();
  if (entries.length === 0) {
    return `  Restore cache is empty. An entry appears when an output is shortened and is kept ${kept}.\n`;
  }
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  const rule = "  " + "─".repeat(60);
  const now = Date.now();
  const lines = [
    `  Restore cache · ${entries.length} entr${entries.length === 1 ? "y" : "ies"} · ${formatBytes(total)} · kept ${kept}`,
    rule,
    `  ${"Hash".padEnd(18)}${"Age".padEnd(6)}${"Size".padStart(9)}${"Lines".padStart(8)}  Command`,
    rule
  ];
  for (const e of entries.slice(0, LIST_LIMIT)) {
    const count = e.lines == null ? "?" : String(e.lines).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const flag = e.partial ? "  (partial)" : "";
    lines.push(`  ${e.hash.padEnd(18)}${ageLabel(now - e.at).padEnd(6)}${formatBytes(e.bytes).padStart(9)}${count.padStart(8)}  ${e.label ?? "—"}${flag}`);
  }
  lines.push(rule);
  if (entries.length > LIST_LIMIT) lines.push(`  ${entries.length - LIST_LIMIT} older entries not shown.`);
  lines.push("  Show one: tkr restore <hash> [--lines a:b] [--grep pattern]", "");
  return lines.join("\n");
}

async function resolveHash(prefix: string): Promise<{ hash: string } | { error: string }> {
  if (!HASH_RE.test(prefix)) return { error: `tkr restore: no cached content for ${prefix}\n` };
  const exact = prefix.toLowerCase();
  const entries = await listContentCache();
  if (entries.some((e) => e.hash === exact)) return { hash: exact };
  const matches = entries.filter((e) => e.hash.startsWith(exact));
  if (matches.length === 1) return { hash: matches[0]!.hash };
  if (matches.length > 1) return { error: `tkr restore: ${prefix} matches ${matches.length} entries, use more characters\n` };
  return { error: `tkr restore: no cached content for ${prefix} (entries are kept ${retentionLabel()}; see tkr restore --list)\n` };
}

function parseRange(spec: string, total: number): { from: number; to: number } | null {
  const m = /^(\d*):(\d*)$/.exec(spec) ?? /^(\d+)()$/.exec(spec);
  if (!m) return null;
  const single = !spec.includes(":");
  const from = m[1] ? Number(m[1]) : 1;
  const to = single ? from : m[2] ? Number(m[2]) : total;
  if (from < 1 || to < from) return null;
  return { from, to: Math.min(to, total) };
}

function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

async function grepAll(re: RegExp, pattern: string, project: string | null): Promise<RestoreResult> {
  const out: string[] = [];
  let more = 0;
  for (const entry of await listContentCache()) {
    if (project != null && entry.project !== project) continue;
    const content = await readContentCache(entry.hash);
    if (content == null) continue;
    splitLines(content).forEach((line, i) => {
      if (!re.test(line)) return;
      if (out.length < GREP_LIMIT) out.push(`${entry.hash}:${i + 1}:${line}`);
      else more += 1;
    });
  }
  if (out.length === 0) {
    const scope = project != null ? " in this project (add --all-projects to search every project)" : "";
    return { stderr: `tkr restore: no cached line matches ${pattern}${scope}\n`, code: 1 };
  }
  const stdout = out.join("\n") + "\n";
  return {
    stdout,
    ...(more ? { stderr: `tkr restore: ${more} more matches not shown; narrow with tkr restore <hash> --grep <pattern>\n` } : {}),
    code: 0,
    restoredTokens: Math.round(Buffer.byteLength(stdout, "utf8") / 4)
  };
}

export async function restoreCommand(argv: string[], cwd: string = process.cwd()): Promise<RestoreResult> {
  let hash: string | undefined;
  let list = false;
  let allProjects = false;
  let pattern: string | undefined;
  let range: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--list" && !list) list = true;
    else if (arg === "--all-projects" && !allProjects) allProjects = true;
    else if (arg === "--grep" && pattern == null && argv[i + 1] != null) pattern = argv[++i];
    else if (arg === "--lines" && range == null && argv[i + 1] != null) range = argv[++i];
    else if (!arg.startsWith("--") && hash == null) hash = arg;
    else return { stderr: RESTORE_USAGE, code: 1 };
  }
  if (list) {
    if (hash != null || pattern != null || range != null) return { stderr: RESTORE_USAGE, code: 1 };
    const project = allProjects ? null : projectRoot(cwd);
    const entries = (await listContentCache()).filter((e) => project == null || e.project === project);
    return { stdout: renderList(entries), code: 0 };
  }
  const re = pattern != null ? compilePattern(pattern) : null;
  if (pattern != null && !re) return { stderr: `tkr restore: invalid pattern ${pattern}\n`, code: 1 };
  if (hash == null) {
    if (re && range == null) return grepAll(re, pattern!, allProjects ? null : projectRoot(cwd));
    return { stderr: RESTORE_USAGE, code: 1 };
  }
  if (allProjects) return { stderr: RESTORE_USAGE, code: 1 };
  const resolved = await resolveHash(hash);
  if ("error" in resolved) return { stderr: resolved.error, code: 1, restoredTokens: 0 };
  const content = await readContentCache(resolved.hash);
  if (content == null) return { stderr: `tkr restore: no cached content for ${hash}\n`, code: 1, restoredTokens: 0 };
  const meta = await readMeta(resolved.hash);
  const note = meta?.partial
    ? "tkr restore: partial entry, it holds only the part left out of the shortened output (the full output was over the per-entry limit)\n"
    : "";
  let stdout = content;
  if (range != null || re) {
    const all = splitLines(content);
    const span = range != null ? parseRange(range, all.length) : { from: 1, to: all.length };
    if (!span) return { stderr: `tkr restore: invalid --lines ${range}, use a:b, a:, :b or n (1-based)\n`, code: 1 };
    if (span.from > all.length) return { stderr: `${note}tkr restore: entry has ${all.length} lines\n`, code: 1 };
    const picked = all.slice(span.from - 1, span.to);
    const out = re
      ? picked.flatMap((line, i) => (re.test(line) ? [`${span.from + i}:${line}`] : []))
      : picked;
    if (out.length === 0) return { stderr: `${note}tkr restore: no line matches ${pattern}\n`, code: 1 };
    stdout = out.join("\n") + "\n";
  }
  return {
    stdout,
    ...(note ? { stderr: note } : {}),
    code: 0,
    restoredTokens: Math.round(Buffer.byteLength(stdout, "utf8") / 4)
  };
}

export async function readContentCache(hash: string): Promise<string | null> {
  if (!HASH_RE.test(hash)) return null;
  try {
    const s = await stat(contentCacheFile(hash));
    if (Date.now() - s.mtimeMs > envInt("TOKMIZER_CCR_MAX_AGE_MS", defaultMaxAgeMs())) return null;
    return await readFile(contentCacheFile(hash), "utf8");
  } catch {
    return null;
  }
}

export async function pruneContentCache(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(contentCacheDir());
  } catch {
    return;
  }
  const maxAge = envInt("TOKMIZER_CCR_MAX_AGE_MS", defaultMaxAgeMs());
  const cap = envInt("TOKMIZER_CCR_DIR_CAP_BYTES", DEFAULT_DIR_CAP_BYTES);
  const now = Date.now();
  const live = new Map<string, { mtimeMs: number; size: number }>();
  for (const entry of entries) {
    const path = join(contentCacheDir(), entry);
    try {
      const s = await stat(path);
      if (now - s.mtimeMs > maxAge) {
        await rm(path);
      } else {
        live.set(entry, { mtimeMs: s.mtimeMs, size: s.size });
      }
    } catch {}
  }
  for (const name of [...live.keys()]) {
    if (!name.endsWith(META_SUFFIX) || live.has(name.slice(0, -META_SUFFIX.length))) continue;
    try {
      await rm(join(contentCacheDir(), name));
    } catch {}
    live.delete(name);
  }
  const order = [...live.entries()].filter(([name]) => !name.endsWith(META_SUFFIX)).sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
  let total = order.reduce((sum, [, f]) => sum + f.size, 0);
  for (const [name, f] of order) {
    if (total <= cap) break;
    try {
      await rm(join(contentCacheDir(), name));
      total -= f.size;
      await rm(join(contentCacheDir(), `${name}${META_SUFFIX}`), { force: true });
    } catch {}
  }
}

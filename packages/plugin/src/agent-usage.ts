import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { claudeConfigDir } from "./claude-config-dir";
import { tokmizerHome } from "./paths";

export type UsageAgent = "claude-code" | "codex";

export type UsageTokens = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; requests: number };

export type UsageRow = UsageTokens & { day: string; agent: UsageAgent; model: string };

type FileState = { size: number; mtimeMs: number; offset: number; agent: UsageAgent; rows: Record<string, UsageTokens>; model?: string; last?: number[]; ids?: string[] };

type UsageCache = { v: 1; tz: string; files: Record<string, FileState> };

export type UsageSource = { agent: UsageAgent; root: string };

export type ScanOptions = { sinceMs?: number; sources?: UsageSource[]; cacheFile?: string; onProgress?: (bytes: number) => void };

const CACHE_VERSION = 1;
const CHUNK = 4 * 1024 * 1024;
const RECENT_IDS = 64;
const MAX_DEPTH = 8;

export function usageCacheFile(): string {
  return join(tokmizerHome(), "agent-usage.json");
}

export function defaultUsageSources(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): UsageSource[] {
  const claudeRoots = [join(claudeConfigDir(env, home), "projects"), join(home, ".claude", "projects")];
  const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
  const seen = new Set<string>();
  const sources: UsageSource[] = [];
  const add = (agent: UsageAgent, root: string): void => {
    if (!existsSync(root)) return;
    let real = root;
    try {
      real = realpathSync(root);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    sources.push({ agent, root: real });
  };
  for (const root of claudeRoots) add("claude-code", root);
  add("codex", join(codexHome, "sessions"));
  add("codex", join(codexHome, "archived_sessions"));
  return sources;
}

function emptyTokens(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, requests: 0 };
}

function addTokens(into: UsageTokens, from: UsageTokens): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.cacheWrite1h += from.cacheWrite1h;
  into.requests += from.requests;
}

export function totalTokens(t: UsageTokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.cacheWrite1h;
}

function localDay(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function record(state: FileState, day: string, model: string, t: UsageTokens): void {
  const key = `${day}|${model}`;
  const row = state.rows[key] ?? (state.rows[key] = emptyTokens());
  addTokens(row, t);
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function claudeLine(state: FileState, line: string): void {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let d: Record<string, unknown> | null;
  try {
    d = obj(JSON.parse(line));
  } catch {
    return;
  }
  if (!d || d.type !== "assistant") return;
  const m = obj(d.message);
  const u = obj(m?.usage);
  if (!m || !u) return;
  const model = typeof m.model === "string" ? m.model : "";
  if (!model || model.startsWith("<")) return;
  const day = localDay(d.timestamp);
  if (!day) return;
  const id = `${typeof m.id === "string" ? m.id : ""}:${typeof d.requestId === "string" ? d.requestId : ""}`;
  if (id !== ":") {
    const ids = state.ids ?? (state.ids = []);
    if (ids.includes(id)) return;
    ids.push(id);
    if (ids.length > RECENT_IDS) ids.shift();
  }
  const split = obj(u.cache_creation);
  const write1h = split ? num(split.ephemeral_1h_input_tokens) : 0;
  const write5m = split ? num(split.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens);
  record(state, day, model, { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: write5m, cacheWrite1h: write1h, requests: 1 });
}

function codexLine(state: FileState, line: string): void {
  const isTurn = line.includes('"turn_context"');
  if (!isTurn && !line.includes('"token_count"')) return;
  let d: Record<string, unknown> | null;
  try {
    d = obj(JSON.parse(line));
  } catch {
    return;
  }
  const p = obj(d?.payload);
  if (!d || !p) return;
  if (d.type === "turn_context") {
    if (typeof p.model === "string" && p.model) state.model = p.model;
    return;
  }
  if (p.type !== "token_count") return;
  const total = obj(obj(p.info)?.total_token_usage);
  if (!total) return;
  const day = localDay(d.timestamp);
  if (!day) return;
  const now = [num(total.input_tokens), num(total.cached_input_tokens), num(total.output_tokens), num(total.cache_write_input_tokens)];
  if (!state.model) {
    state.last = now;
    return;
  }
  const prev = state.last && now[0]! + now[2]! >= state.last[0]! + state.last[2]! ? state.last : [0, 0, 0, 0];
  const delta = now.map((v, i) => Math.max(0, v - (prev[i] ?? 0)));
  state.last = now;
  const [input, cached, output, written] = delta as [number, number, number, number];
  if (input + output === 0) return;
  record(state, day, state.model ?? "unknown", { input: Math.max(0, input - cached - written), output, cacheRead: cached, cacheWrite: written, cacheWrite1h: 0, requests: 1 });
}

function listFiles(root: string, agent: UsageAgent): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl") && (agent === "claude-code" || e.name.startsWith("rollout-"))) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

function readCache(file: string, tz: string): UsageCache {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as UsageCache;
    if (parsed?.v === CACHE_VERSION && parsed.tz === tz && parsed.files && typeof parsed.files === "object") return parsed;
  } catch {
    return { v: CACHE_VERSION, tz, files: {} };
  }
  return { v: CACHE_VERSION, tz, files: {} };
}

function writeCache(file: string, cache: UsageCache): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    return;
  }
}

function scanFile(path: string, state: FileState, size: number, onBytes: (n: number) => void): void {
  const handle = (line: string): void => (state.agent === "claude-code" ? claudeLine(state, line) : codexLine(state, line));
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = state.offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      onBytes(n);
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const lastNl = data.lastIndexOf(10);
      if (lastNl < 0) {
        carry = Buffer.from(data);
        continue;
      }
      for (const line of data.toString("utf8", 0, lastNl).split("\n")) if (line) handle(line);
      carry = Buffer.from(data.subarray(lastNl + 1));
    }
    state.offset = pos - carry.length;
  } finally {
    closeSync(fd);
  }
}

export function scanAgentUsage(opts: ScanOptions = {}): UsageRow[] {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const cacheFile = opts.cacheFile ?? usageCacheFile();
  const cache = readCache(cacheFile, tz);
  const sinceMs = opts.sinceMs ?? 0;
  let dirty = false;
  const live = new Set<string>();
  const rows = new Map<string, UsageRow>();
  const sources = opts.sources ?? defaultUsageSources();
  const wanted = new Set(sources.map((s) => s.agent));
  for (const source of sources) {
    for (const path of listFiles(source.root, source.agent)) {
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      live.add(path);
      let state: FileState | undefined = cache.files[path];
      if (st.mtimeMs < sinceMs && !state) continue;
      if (!state || state.agent !== source.agent || st.size < state.offset) {
        state = { size: 0, mtimeMs: 0, offset: 0, agent: source.agent, rows: {} };
        cache.files[path] = state;
      }
      if (st.size !== state.size || st.mtimeMs !== state.mtimeMs) {
        scanFile(path, state, st.size, (n) => opts.onProgress?.(n));
        state.size = st.size;
        state.mtimeMs = st.mtimeMs;
        dirty = true;
      }
    }
  }
  for (const [path, state] of Object.entries(cache.files)) {
    if (!live.has(path) && (state.ids || state.last)) {
      delete state.ids;
      delete state.last;
      dirty = true;
    }
    if (!wanted.has(state.agent)) continue;
    for (const [key, t] of Object.entries(state.rows)) {
      const cut = key.indexOf("|");
      const day = key.slice(0, cut);
      const model = key.slice(cut + 1);
      const rowKey = `${day}|${state.agent}|${model}`;
      const row = rows.get(rowKey) ?? { day, agent: state.agent, model, ...emptyTokens() };
      addTokens(row, t);
      rows.set(rowKey, row);
    }
  }
  if (dirty) writeCache(cacheFile, cache);
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));
}

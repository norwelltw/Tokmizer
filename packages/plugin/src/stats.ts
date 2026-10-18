import { readFile, rm } from "node:fs/promises";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Plan } from "./contracts";
import { tokmizerHome } from "./paths";
import { providerForHost, type Provider } from "./pricing";

const STATS_FILE = "stats.jsonl";
const LEDGER_FILE = "stats-ledger.json";
const ROTATE_BYTES = 2 * 1024 * 1024;
const LOCK_STALE_MS = 30_000;
export const OVERSIZED_SHELL_BYTES = 30_000;

type StatRecord = { t: number; r: number; f: number; m: boolean; h?: string; k?: string; c?: string; p?: string; s?: string; o?: string };

export type StatOutcome = { s?: string; o?: "n" | "g" | "e" };

const FALLBACK_CODES = new Set(["n", "g", "e"]);

const PROJECT_MAX_CHARS = 256;

type CmdAcc = { n: number; nc: number; r: number; f: number; rr?: number; rf?: number; tn?: number; tr?: number; tf?: number; sh: boolean };

type Acc = {
  n: number;
  nc: number;
  r: number;
  f: number;
  or: number;
  of: number;
  x: number;
  sn: number;
  sr: number;
  sf: number;
  mr: number;
  mf: number;
  rn: number;
  rb: number;
  tn: number;
  tr: number;
  tf: number;
  ox: number;
  t0: number | null;
  t1: number | null;
  cmds: Record<string, CmdAcc>;
  prov: Record<string, { r: number; f: number }>;
  rl: Record<string, { n: number; nc: number; r: number; f: number }>;
  fb: Record<string, { n: number; r: number }>;
};

function emptyAcc(): Acc {
  return { n: 0, nc: 0, r: 0, f: 0, or: 0, of: 0, x: 0, sn: 0, sr: 0, sf: 0, mr: 0, mf: 0, rn: 0, rb: 0, tn: 0, tr: 0, tf: 0, ox: 0, t0: null, t1: null, cmds: {}, prov: {}, rl: {}, fb: {} };
}

function parseRecord(line: string): StatRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const rec = JSON.parse(trimmed) as { t?: unknown; r?: unknown; f?: unknown; m?: unknown; h?: unknown; k?: unknown; c?: unknown; p?: unknown; s?: unknown; o?: unknown };
    if (typeof rec.t !== "number" || !Number.isFinite(rec.t) || rec.t < 0 || rec.t > 8640000000000 ||
        typeof rec.r !== "number" || !Number.isSafeInteger(rec.r) || rec.r < 0 ||
        typeof rec.f !== "number" || !Number.isSafeInteger(rec.f) || rec.f < 0 || rec.r + rec.f === 0) {
      return null;
    }
    return {
      t: rec.t, r: rec.r, f: rec.f, m: rec.m === 1,
      ...(typeof rec.h === "string" ? { h: rec.h } : {}),
      ...(typeof rec.k === "string" ? { k: rec.k } : {}),
      ...(typeof rec.c === "string" && rec.c ? { c: rec.c } : {}),
      ...(typeof rec.p === "string" && rec.p ? { p: rec.p } : {}),
      ...(typeof rec.s === "string" && rec.s ? { s: rec.s } : {}),
      ...(typeof rec.o === "string" && FALLBACK_CODES.has(rec.o) ? { o: rec.o } : {})
    };
  } catch {
    return null;
  }
}

function addCommand(acc: Acc, rec: StatRecord): void {
  if (!rec.c) return;
  const row = acc.cmds[rec.c] ?? { n: 0, nc: 0, r: 0, f: 0, sh: false };
  row.n += 1;
  if (rec.f < rec.r) {
    row.nc += 1;
    row.rr = (row.rr ?? 0) + rec.r;
    row.rf = (row.rf ?? 0) + rec.f;
  }
  if (rec.k === "sh" || rec.k === "restore") row.sh = true;
  if (rec.h === "shell" && rec.k !== "restore") {
    row.tn = (row.tn ?? 0) + 1;
    row.tr = (row.tr ?? 0) + rec.r;
    row.tf = (row.tf ?? 0) + rec.f;
  }
  row.r += rec.r;
  row.f += rec.f;
  acc.cmds[rec.c] = row;
}

function ruleKey(rec: StatRecord): string {
  if (rec.s === "b") return `b:${(rec.c ?? "").split(" ")[0] || "other"}`;
  if (rec.s?.startsWith("u:")) return rec.s;
  return rec.o === "n" ? "n" : "?";
}

function addAttribution(acc: Acc, rec: StatRecord): void {
  const key = ruleKey(rec);
  const row = acc.rl[key] ?? { n: 0, nc: 0, r: 0, f: 0 };
  row.n += 1;
  row.r += rec.r;
  row.f += rec.f;
  if (rec.f < rec.r) row.nc += 1;
  acc.rl[key] = row;
  if (rec.f >= rec.r && rec.o) {
    const fkey = `${rec.o}\t${rec.c ?? ""}`;
    const fb = acc.fb[fkey] ?? { n: 0, r: 0 };
    fb.n += 1;
    fb.r += rec.r;
    acc.fb[fkey] = fb;
  }
}

function addRecord(acc: Acc, rec: StatRecord): void {
  if (rec.m) {
    acc.mr += rec.r;
    acc.mf += rec.f;
    return;
  }
  acc.t0 = acc.t0 == null ? rec.t : Math.min(acc.t0, rec.t);
  acc.t1 = acc.t1 == null ? rec.t : Math.max(acc.t1, rec.t);
  if (rec.k === "sh" && rec.r > OVERSIZED_SHELL_BYTES) {
    acc.ox += 1;
    return;
  }
  addCommand(acc, rec);
  if (rec.k === "restore") {
    acc.rn += 1;
    acc.rb += rec.f;
  } else {
    addAttribution(acc, rec);
  }
  acc.n += 1;
  acc.or += rec.r;
  acc.of += rec.f;
  if (rec.f > rec.r) acc.x += 1;
  if (rec.h === "shell" && rec.k !== "restore") {
    acc.tn += 1;
    acc.tr += rec.r;
    acc.tf += rec.f;
  }
  if (rec.f < rec.r) {
    acc.nc += 1;
    acc.r += rec.r;
    acc.f += rec.f;
    if (rec.k === "sh") {
      acc.sn += 1;
      acc.sr += rec.r;
      acc.sf += rec.f;
    }
    const prov = providerForHost(rec.h);
    const pb = acc.prov[prov] ?? { r: 0, f: 0 };
    pb.r += rec.r;
    pb.f += rec.f;
    acc.prov[prov] = pb;
  }
}

function mergeAcc(into: Acc, from: Acc): void {
  for (const key of ["n", "nc", "r", "f", "or", "of", "x", "sn", "sr", "sf", "mr", "mf", "rn", "rb", "tn", "tr", "tf", "ox"] as const) {
    into[key] += from[key];
  }
  if (from.t0 != null) into.t0 = into.t0 == null ? from.t0 : Math.min(into.t0, from.t0);
  if (from.t1 != null) into.t1 = into.t1 == null ? from.t1 : Math.max(into.t1, from.t1);
  for (const [cmd, c] of Object.entries(from.cmds)) {
    const row = into.cmds[cmd] ?? { n: 0, nc: 0, r: 0, f: 0, sh: false };
    row.n += c.n;
    row.nc += c.nc;
    row.r += c.r;
    row.f += c.f;
    row.rr = (row.rr ?? 0) + (c.rr ?? 0);
    row.rf = (row.rf ?? 0) + (c.rf ?? 0);
    row.tn = (row.tn ?? 0) + (c.tn ?? 0);
    row.tr = (row.tr ?? 0) + (c.tr ?? 0);
    row.tf = (row.tf ?? 0) + (c.tf ?? 0);
    row.sh = row.sh || c.sh;
    into.cmds[cmd] = row;
  }
  for (const [prov, p] of Object.entries(from.prov)) {
    const pb = into.prov[prov] ?? { r: 0, f: 0 };
    pb.r += p.r;
    pb.f += p.f;
    into.prov[prov] = pb;
  }
  for (const [key, v] of Object.entries(from.rl ?? {})) {
    const row = into.rl[key] ?? { n: 0, nc: 0, r: 0, f: 0 };
    row.n += v.n;
    row.nc += v.nc;
    row.r += v.r;
    row.f += v.f;
    into.rl[key] = row;
  }
  for (const [key, v] of Object.entries(from.fb ?? {})) {
    const row = into.fb[key] ?? { n: 0, r: 0 };
    row.n += v.n;
    row.r += v.r;
    into.fb[key] = row;
  }
}

function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ledgerPath(file: string): string {
  return join(dirname(file), LEDGER_FILE);
}

function readLedger(file: string): Record<string, Acc> {
  const path = ledgerPath(file);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { days?: unknown };
    if (!parsed.days || typeof parsed.days !== "object") throw new Error("invalid ledger");
    const days: Record<string, Acc> = {};
    for (const [day, value] of Object.entries(parsed.days as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== "object") continue;
      days[day] = { ...emptyAcc(), ...(value as Partial<Acc>) };
    }
    return days;
  } catch {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {}
    return {};
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function acquireLock(lock: string): boolean {
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {}
  try {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
    rmSync(lock, { force: true });
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function rotateStats(file: string, triggerBytes = ROTATE_BYTES, keepBytes = ROTATE_BYTES / 2): void {
  try {
    if (statSync(file).size <= triggerBytes) return;
  } catch {
    return;
  }
  const lock = `${file}.lock`;
  if (!acquireLock(lock)) return;
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
    let cut = lines.length;
    let size = 0;
    while (cut > 0) {
      const n = Buffer.byteLength(lines[cut - 1]!) + 1;
      if (size + n > keepBytes) break;
      size += n;
      cut -= 1;
    }
    const days = readLedger(file);
    for (const line of lines.slice(0, cut)) {
      const rec = parseRecord(line);
      if (!rec) continue;
      const key = dayKey(rec.t);
      const acc = days[key] ?? emptyAcc();
      addRecord(acc, rec);
      days[key] = acc;
    }
    const kept = lines.slice(cut);
    writeAtomic(file, kept.length ? `${kept.join("\n")}\n` : "");
    writeAtomic(ledgerPath(file), JSON.stringify({ v: 1, days }));
  } catch {
    return;
  } finally {
    rmSync(lock, { force: true });
  }
}

export function normalizeProject(path: string): string {
  const abs = resolve(path);
  let head = abs;
  let tail = "";
  for (;;) {
    try {
      return join(realpathSync(head), tail);
    } catch {}
    const parent = dirname(head);
    if (parent === head) return abs;
    tail = tail ? join(basename(head), tail) : basename(head);
    head = parent;
  }
}

function inProject(rec: StatRecord, project: string): boolean {
  return rec.p != null && (rec.p === project || rec.p.startsWith(project + sep));
}

async function readJournal(file: string, sinceTs: number, project?: string): Promise<StatRecord[]> {
  let raw = "";
  try {
    raw = await readFile(file, "utf8");
  } catch {}
  const out: StatRecord[] = [];
  for (const line of raw.split("\n")) {
    const rec = parseRecord(line);
    if (!rec || rec.t < sinceTs) continue;
    if (project != null && !inProject(rec, project)) continue;
    out.push(rec);
  }
  return out;
}

async function loadDays(file: string, sinceTs: number, project?: string): Promise<Map<string, Acc>> {
  const sinceDay = sinceTs > 0 ? dayKey(sinceTs) : "";
  const days = new Map<string, Acc>();
  if (project == null) {
    for (const [day, acc] of Object.entries(readLedger(file))) {
      if (day >= sinceDay) days.set(day, acc);
    }
  }
  for (const rec of await readJournal(file, sinceTs, project)) {
    const key = dayKey(rec.t);
    const acc = days.get(key) ?? emptyAcc();
    addRecord(acc, rec);
    days.set(key, acc);
  }
  return days;
}

export type GainAgg = {
  count: number;
  compressedCount: number;
  rawTokens: number;
  filteredTokens: number;
  savedTokens: number;
  modeledSavedTokens: number;
  savedPct: number;
  sinceDays: number;
  savedByProvider: Partial<Record<Provider, number>>;
  shellCompressedCount?: number;
  shellSavedPct?: number;
  byCommand?: CommandRow[];
  observed?: {
    count: number;
    rawTokens: number;
    filteredTokens: number;
    savedTokens: number;
    savedPct: number | null;
    expandedCount: number;
  };
  agent?: { count: number; rawTokens: number; filteredTokens: number; savedPct: number | null };
  terminal?: { count: number; rawTokens: number; savedTokens: number };
  oversizedExcluded?: number;
  restoration?: { count: number; tokens: number };
  byRule?: RuleRow[];
  fallbacks?: FallbackRow[];
  window?: { firstAt: number | null; lastAt: number | null };
  measurement?: { scope: "tool-output"; legacyScope: "reduced-outputs"; tokenMethod: "bytes/4"; tokenCounts: "estimated"; billing: "not-measured" };
};

export type RuleRow = { rule: string; kind: "built-in" | "user" | "none" | "unattributed"; count: number; compressedCount: number; rawTokens: number; savedTokens: number; avgPct: number };

export type FallbackRow = { cmd: string; reason: "no-rule" | "no-gain" | "failed-run"; count: number; tokens: number };

export type CommandRow = { cmd: string; count: number; compressedCount: number; savedTokens: number; avgPct: number; reducedPct?: number; native: boolean };

const WRAPPER_HEADS = new Set(["sudo", "command", "time", "nice", "nohup", "env", "stdbuf", "timeout"]);
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-n", "-s", "-k"]);
const SUBCOMMAND_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const SUBCOMMAND_BINS = new Set([
  "git", "npm", "pnpm", "yarn", "npx", "docker", "kubectl", "helm", "cargo", "go",
  "brew", "gh", "pip", "pip3", "apt", "apt-get", "systemctl", "terraform", "aws",
  "gcloud", "az", "bundle", "rake", "rails", "prisma", "poetry", "uv", "gem", "composer"
]);

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function isSetupOnly(words: string[]): boolean {
  return words.length === 0 || words[0] === "cd" || words.every((w) => ASSIGNMENT_RE.test(w));
}

function firstCommandWords(cmdLine: string): string[] {
  let words: string[] = [];
  let cur = "";
  let started = false;
  let quote: string | null = null;
  const flush = (): void => {
    if (started) words.push(cur);
    cur = "";
    started = false;
  };
  for (const ch of cmdLine) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    if ("|;&<>\n".includes(ch)) {
      flush();
      if (isSetupOnly(words)) {
        words = [];
        continue;
      }
      return words;
    }
    cur += ch;
    started = true;
  }
  flush();
  return isSetupOnly(words) ? [] : words;
}

export function statCmdLabel(cmdLine: string): string {
  const tokens = firstCommandWords(cmdLine).map((t) => t.replace(/^[({]+/, "")).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (ASSIGNMENT_RE.test(t)) {
      i += 1;
      continue;
    }
    if (WRAPPER_HEADS.has(t)) {
      i += 1;
      while (i < tokens.length) {
        const a = tokens[i]!;
        if (a.startsWith("-")) {
          i += WRAPPER_VALUE_FLAGS.has(a) ? 2 : 1;
          continue;
        }
        if (/^\d+(?:\.\d+)?[smhd]?$/.test(a)) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  if (i >= tokens.length) return "";
  const rawHead = tokens[i]!;
  const head = rawHead.includes("/") ? rawHead.slice(rawHead.lastIndexOf("/") + 1) : rawHead;
  const sub = tokens[i + 1];
  const label = sub && !sub.startsWith("-") && SUBCOMMAND_RE.test(sub) && SUBCOMMAND_BINS.has(head.toLowerCase())
    ? `${head} ${sub}`
    : head;
  return label.slice(0, 24);
}

function statsPath(): string {
  return join(tokmizerHome(), STATS_FILE);
}

export async function clearStats(file = statsPath()): Promise<number> {
  try {
    const raw = await readFile(file, "utf8");
    const n = raw.split("\n").filter((l) => l.trim() !== "").length;
    await rm(file, { force: true });
    await rm(ledgerPath(file), { force: true });
    return n;
  } catch {
    return 0;
  }
}

export function recordStat(
  rawBytes: number,
  filteredBytes: number,
  file = statsPath(),
  modeled = false,
  host?: string,
  kind?: "sh" | "restore",
  cmd?: string,
  project?: string,
  outcome: StatOutcome = {}
): void {
  if (!Number.isSafeInteger(rawBytes) || !Number.isSafeInteger(filteredBytes) || rawBytes < 0 || filteredBytes < 0 || rawBytes + filteredBytes === 0) return;
  const hostPart = host ? `,"h":${JSON.stringify(host)}` : "";
  const kindPart = kind ? `,"k":${JSON.stringify(kind)}` : "";
  const cmdPart = cmd ? `,"c":${JSON.stringify(cmd.slice(0, 24))}` : "";
  const projectDir = project ? normalizeProject(project) : "";
  const projectPart = projectDir && projectDir.length <= PROJECT_MAX_CHARS ? `,"p":${JSON.stringify(projectDir)}` : "";
  const sourcePart = outcome.s ? `,"s":${JSON.stringify(outcome.s.slice(0, 66))}` : "";
  const fallbackPart = outcome.o ? `,"o":${JSON.stringify(outcome.o)}` : "";
  const line = `{"t":${Math.floor(Date.now() / 1000)},"r":${rawBytes},"f":${filteredBytes}${modeled ? ',"m":1' : ""}${hostPart}${kindPart}${cmdPart}${projectPart}${sourcePart}${fallbackPart}}\n`;
  try {
    mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
    appendFileSync(file, line, { mode: 0o600 });
    chmodSync(file, 0o600);
    rotateStats(file);
  } catch {
    return;
  }
}

export function statOutcome(result: { filterId: string | null; rawBytes: number; filteredBytes: number; debugBypass: boolean }): StatOutcome {
  const s = result.filterId == null ? undefined : result.filterId.startsWith("user/") ? `u:${result.filterId.slice(5)}` : "b";
  const o = result.filteredBytes < result.rawBytes ? undefined : result.filterId == null ? "n" : result.debugBypass ? "e" : "g";
  return { ...(s ? { s } : {}), ...(o ? { o } : {}) };
}

export function countedSaving(
  rawBytes: number,
  filteredBytes: number,
  capBytes: number | null
): { raw: number; filtered: number } {
  const raw = capBytes != null ? Math.min(rawBytes, capBytes) : rawBytes;
  const filtered = capBytes != null ? Math.min(filteredBytes, capBytes) : filteredBytes;
  return { raw, filtered };
}

export function resolveSinceDays(installedAtSec: number | undefined, nowSec: number, fallbackDays: number): number {
  if (typeof installedAtSec === "number" && installedAtSec > 0) {
    return Math.max(1, Math.ceil((nowSec - installedAtSec) / 86400));
  }
  return Math.max(1, fallbackDays);
}

export function withInstallAge(agg: GainAgg, installedAtSec: number | undefined, nowSec: number): GainAgg {
  return { ...agg, sinceDays: resolveSinceDays(installedAtSec, nowSec, agg.sinceDays) };
}

export function monthlyProjectionUsd(savedTokens: number, sinceDays: number, pricePerMtok: number): number {
  if (savedTokens <= 0 || sinceDays <= 0 || pricePerMtok <= 0) return 0;
  return ((savedTokens / sinceDays) * 30) / 1e6 * pricePerMtok;
}

export type PaybackTarget = { priceUsd: number; label: string; upsell: boolean };

const ENTRY_PLAN_PRICE_USD = 4.99;
const PRO_PLAN_PRICE_USD = 9.99;

export function paybackTarget(plan: Plan): PaybackTarget {
  if (plan === "pro") return { priceUsd: PRO_PLAN_PRICE_USD, label: "Pro plan", upsell: false };
  if (plan === "smart") return { priceUsd: ENTRY_PLAN_PRICE_USD, label: "Smart plan", upsell: false };
  return { priceUsd: ENTRY_PLAN_PRICE_USD, label: "Smart plan", upsell: true };
}

function bytesToTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export function coverageSummary(agg: GainAgg): string | null {
  if (!agg.count) return null;
  const pct = Math.round((agg.compressedCount / agg.count) * 100);
  const uncovered = (agg.byCommand ?? [])
    .filter((r) => !r.native && r.compressedCount === 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((r) => r.cmd);
  const tail = uncovered.length ? ` · top unchanged: ${uncovered.join(", ")}` : "";
  return `${pct}% of recorded outputs reduced (${agg.compressedCount}/${agg.count})${tail}`;
}

function ruleRows(acc: Acc): RuleRow[] {
  const attributed = Object.values(acc.rl).reduce((sum, v) => sum + v.n, 0);
  const gap = acc.n - acc.rn - attributed;
  const rl = gap > 0 ? { ...acc.rl, "?": { ...(acc.rl["?"] ?? { n: 0, nc: 0, r: 0, f: 0 }), n: (acc.rl["?"]?.n ?? 0) + gap } } : acc.rl;
  return Object.entries(rl)
    .map(([key, v]) => {
      const rawT = bytesToTokens(v.r);
      const savedT = rawT - bytesToTokens(v.f);
      const kind: RuleRow["kind"] = key.startsWith("b:") ? "built-in" : key.startsWith("u:") ? "user" : key === "n" ? "none" : "unattributed";
      const rule = kind === "built-in" || kind === "user" ? key.slice(2) : kind;
      return { rule, kind, count: v.n, compressedCount: v.nc, rawTokens: rawT, savedTokens: savedT, avgPct: rawT ? Math.round((savedT / rawT) * 100) : 0 };
    })
    .sort((a, b) => b.savedTokens - a.savedTokens || b.count - a.count);
}

const FALLBACK_REASONS: Record<string, FallbackRow["reason"]> = { n: "no-rule", g: "no-gain", e: "failed-run" };

function fallbackRows(acc: Acc): FallbackRow[] {
  return Object.entries(acc.fb)
    .map(([key, v]) => {
      const [code, cmd] = key.split("\t") as [string, string];
      return { cmd: cmd || "other", reason: FALLBACK_REASONS[code] ?? "no-rule", count: v.n, tokens: bytesToTokens(v.r) };
    })
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count);
}

export async function readGain(file = statsPath(), sinceTs = 0, project?: string): Promise<GainAgg> {
  const acc = emptyAcc();
  for (const day of (await loadDays(file, sinceTs, project)).values()) mergeAcc(acc, day);

  const rawTokens = bytesToTokens(acc.r);
  const filteredTokens = bytesToTokens(acc.f);
  const savedTokens = Math.max(0, rawTokens - filteredTokens);
  const savedPct = rawTokens ? Math.round((savedTokens / rawTokens) * 100) : 0;
  const now = Math.floor(Date.now() / 1000);
  const sinceDays = acc.t0 != null
    ? Math.max(1, Math.ceil((now - acc.t0) / 86400))
    : 1;

  const modeledSavedTokens = Math.max(0, bytesToTokens(acc.mr) - bytesToTokens(acc.mf));

  const savedByProvider: Partial<Record<Provider, number>> = {};
  for (const [prov, b] of Object.entries(acc.prov)) {
    savedByProvider[prov as Provider] = Math.max(0, bytesToTokens(b.r) - bytesToTokens(b.f));
  }

  const byCommand: CommandRow[] = Object.entries(acc.cmds)
    .filter(([, v]) => v.n - (v.tn ?? 0) > 0)
    .map(([cmd, v]) => {
      const rawT = bytesToTokens(v.r - (v.tr ?? 0));
      const savedT = rawT - bytesToTokens(v.f - (v.tf ?? 0));
      const reducedRawT = bytesToTokens(v.rr ?? 0);
      const reducedPct = reducedRawT ? Math.round(((reducedRawT - bytesToTokens(v.rf ?? 0)) / reducedRawT) * 100) : 0;
      return { cmd, count: v.n - (v.tn ?? 0), compressedCount: v.nc, savedTokens: savedT, avgPct: rawT ? Math.round((savedT / rawT) * 100) : 0, reducedPct, native: !v.sh };
    })
    .sort((a, b) => b.savedTokens - a.savedTokens)
    .slice(0, 10);

  const shellRawTokens = bytesToTokens(acc.sr);
  const shellSavedPct = shellRawTokens
    ? Math.round(((shellRawTokens - bytesToTokens(acc.sf)) / shellRawTokens) * 100)
    : 0;

  const observedRawTokens = bytesToTokens(acc.or);
  const observedFilteredTokens = bytesToTokens(acc.of);
  return {
    count: acc.n, compressedCount: acc.nc, rawTokens, filteredTokens, savedTokens, modeledSavedTokens, savedPct, sinceDays, savedByProvider, shellCompressedCount: acc.sn, shellSavedPct, byCommand,
    observed: {
      count: acc.n, rawTokens: observedRawTokens, filteredTokens: observedFilteredTokens,
      savedTokens: observedRawTokens - observedFilteredTokens,
      savedPct: acc.or ? Math.round((acc.or - acc.of) / acc.or * 10000) / 100 : null,
      expandedCount: acc.x
    },
    agent: {
      count: acc.n - acc.tn,
      rawTokens: bytesToTokens(acc.or - acc.tr),
      filteredTokens: bytesToTokens(acc.of - acc.tf),
      savedPct: acc.or - acc.tr ? Math.round(((acc.or - acc.tr) - (acc.of - acc.tf)) / (acc.or - acc.tr) * 10000) / 100 : null
    },
    terminal: { count: acc.tn, rawTokens: bytesToTokens(acc.tr), savedTokens: bytesToTokens(acc.tr) - bytesToTokens(acc.tf) },
    restoration: { count: acc.rn, tokens: bytesToTokens(acc.rb) },
    byRule: ruleRows(acc),
    fallbacks: fallbackRows(acc),
    oversizedExcluded: acc.ox,
    window: { firstAt: acc.t0, lastAt: acc.t1 },
    measurement: { scope: "tool-output", legacyScope: "reduced-outputs", tokenMethod: "bytes/4", tokenCounts: "estimated", billing: "not-measured" }
  };
}

export function formatTokens(n: number): string {
  if (n < 0) return `-${formatTokens(-n)}`;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function formatDollars(d: number): string {
  if (d < 0) return `-${formatDollars(-d)}`;
  if (d > 0 && d < 0.01) return "<$0.01";
  return `$${d.toFixed(2)}`;
}

function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const AMBER = "\x1b[38;2;245;176;65m";
const RESET = "\x1b[0m";

function bar(blocks: number, color: boolean): string {
  const run = "█".repeat(blocks);
  return color ? `${AMBER}${run}${RESET}` : run;
}

export type PeriodRow = { label: string; savedTokens: number; count: number };

export type RestoreCacheLine = { entries: number; bytes: number; kept: string };

export function renderGain(agg: GainAgg, opts: { color: boolean; pricePerMtok: number; subtitle?: string | undefined; plan?: PaybackTarget | undefined; periods?: PeriodRow[] | undefined; restoreCache?: RestoreCacheLine | undefined }): string {
  if (agg.count === 0 && !agg.oversizedExcluded) {
    return "  No data yet. Run a few commands to measure your output savings.\n  Watch this session live: tkr session";
  }

  const scope = agg.agent ?? { count: agg.count, rawTokens: agg.observed?.rawTokens ?? agg.rawTokens, filteredTokens: agg.observed?.filteredTokens ?? agg.filteredTokens, savedPct: agg.observed?.savedPct ?? agg.savedPct };
  const saved = scope.rawTokens - scope.filteredTokens;
  const pct = scope.rawTokens ? Math.round((saved / scope.rawTokens) * 1000) / 10 : 0;
  const date = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
  const since = agg.window?.firstAt != null ? ` (since ${date(agg.window.firstAt)})` : "";
  const label = (text: string): string => `  ${text.padEnd(16)}`;
  const meterBlocks = Math.max(0, Math.min(24, Math.round((Math.max(0, pct) / 100) * 24)));
  const meter = bar(meterBlocks, opts.color) + "░".repeat(24 - meterBlocks);
  const dollars = formatDollars((saved / 1e6) * opts.pricePerMtok);
  const terminal = agg.terminal?.count ?? 0;

  return [
    `  Tokmizer savings · ${opts.subtitle ?? "all time"}${since}`,
    "  " + "═".repeat(60),
    "",
    `${label("Commands")}${formatCount(scope.count)} · ${formatCount(agg.compressedCount)} reduced`,
    `${label("Tokens in")}${formatTokens(scope.rawTokens)}`,
    `${label("Tokens out")}${formatTokens(scope.filteredTokens)}`,
    `${label(saved >= 0 ? "Tokens saved" : "Tokens added")}${formatTokens(Math.abs(saved))} (${Math.abs(pct)} %)`,
    `${label("Efficiency")}${meter} ${Math.max(0, pct)} %`,
    ...(opts.periods?.length ? [
      "",
      ...opts.periods.map((p) => `${label(p.label)}${savedOrAdded(p.savedTokens)} · ${formatCount(p.count)} commands`)
    ] : []),
    `${label("API value")}${dollars} at $${opts.pricePerMtok.toFixed(2)}/M input tokens`,
    ...(agg.restoration?.count ? [`${label("Restored")}${formatTokens(agg.restoration.tokens)} tokens, deducted · ${formatCount(agg.restoration.count)} restore${agg.restoration.count === 1 ? "" : "s"}`] : []),
    ...(opts.restoreCache?.entries ? [`${label("Restore cache")}${formatCount(opts.restoreCache.entries)} entr${opts.restoreCache.entries === 1 ? "y" : "ies"} · ${formatMegabytes(opts.restoreCache.bytes)} · kept ${opts.restoreCache.kept}`] : []),
    ...(agg.modeledSavedTokens > 0 ? [`${label("Reducer (est.)")}${formatTokens(agg.modeledSavedTokens)} tokens, not included`] : []),
    ...renderByCommand(agg.byCommand, opts.color),
    "",
    "  Estimates from output size (bytes ÷ 4), not provider-counted tokens.",
    ...(terminal ? [`  ${formatCount(terminal)} terminal commands with no agent are not counted.`] : []),
    ...(agg.oversizedExcluded ? [`  ${formatCount(agg.oversizedExcluded)} Bash outputs over ${formatCount(OVERSIZED_SHELL_BYTES)} characters are not counted: Claude Code shows at most that much.`] : []),
    ""
  ].join("\n");
}

export type DayRow = { day: string; count: number; savedTokens: number };

export async function readDaily(file = statsPath(), sinceTs = 0, project?: string): Promise<DayRow[]> {
  return [...(await loadDays(file, sinceTs, project)).entries()]
    .filter(([, acc]) => acc.n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, acc]) => ({
      day,
      count: acc.n,
      savedTokens: bytesToTokens(acc.or) - bytesToTokens(acc.of)
    }));
}

function renderByCommand(rows: CommandRow[] | undefined, color: boolean): string[] {
  const usable = (rows ?? []).filter((r) => r.savedTokens > 0).slice(0, 10);
  if (usable.length === 0) return [];
  const top = usable[0]!.savedTokens;
  const rule = "  " + "─".repeat(60);
  const lines = ["", "  By command", rule, `  ${" #".padEnd(4)}${"Command".padEnd(20)}${"Runs".padStart(7)}${"Saved".padStart(9)}${"Avg%".padStart(7)}  Impact`, rule];
  usable.forEach((r, i) => {
    const impactBlocks = Math.max(1, Math.round((r.savedTokens / top) * 10));
    const impact = bar(impactBlocks, color) + "░".repeat(10 - impactBlocks);
    const name = (r.native ? `${r.cmd} (tool)` : r.cmd).slice(0, 19);
    lines.push(`  ${(String(i + 1) + ".").padStart(3)} ${name.padEnd(20)}${formatCount(r.count).padStart(7)}${formatTokens(r.savedTokens).padStart(9)}${(String(r.avgPct) + " %").padStart(7)}  ${impact}`);
  });
  lines.push(rule);
  return lines;
}

function formatMegabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function header(title: string, subtitle: string | undefined): string[] {
  return [`  ${title} · ${subtitle ?? "all time"}`, "  " + "═".repeat(60), ""];
}

export function renderByRule(agg: GainAgg, opts: { color: boolean; subtitle?: string | undefined }): string {
  const rows = agg.byRule ?? [];
  const rules = rows.filter((r) => r.kind === "built-in" || r.kind === "user").slice(0, 15);
  const none = rows.find((r) => r.kind === "none");
  const older = rows.find((r) => r.kind === "unattributed");
  const lines = header("Tokmizer savings by rule", opts.subtitle);
  if (rules.length === 0 && !none) {
    lines.push("  No run with rule details in this scope yet.");
  } else {
    const rule = "  " + "─".repeat(60);
    const top = Math.max(1, ...rules.map((r) => r.savedTokens));
    lines.push(`  ${" #".padEnd(4)}${"Rule".padEnd(26)}${"Runs".padStart(6)}${"Saved".padStart(8)}${"Avg%".padStart(7)}  Impact`, rule);
    rules.forEach((r, i) => {
      const blocks = r.savedTokens > 0 ? Math.max(1, Math.round((r.savedTokens / top) * 10)) : 0;
      const name = `${r.kind === "user" ? "your filter" : "built-in"} · ${r.rule}`.slice(0, 25);
      lines.push(`  ${(String(i + 1) + ".").padStart(3)} ${name.padEnd(26)}${formatCount(r.count).padStart(6)}${formatTokens(r.savedTokens).padStart(8)}${(String(r.avgPct) + " %").padStart(7)}  ${bar(blocks, opts.color)}${"░".repeat(10 - blocks)}`);
    });
    lines.push(rule);
    if (none) lines.push(`  No rule matched: ${formatCount(none.count)} run${none.count === 1 ? "" : "s"}, ${formatTokens(none.rawTokens)} tokens left unchanged (tkr gain --failures).`);
    lines.push("  Built-in rules are grouped by command.");
  }
  if (older?.count) lines.push(`  ${formatCount(older.count)} older run${older.count === 1 ? "" : "s"} recorded before rule tracking are not attributed.`);
  lines.push("");
  return lines.join("\n");
}

const REASON_TEXT: Record<FallbackRow["reason"], { short: string; note: string }> = {
  "no-rule": { short: "no rule", note: "no rule: neither a built-in nor a custom filter matches this command (see tkr doctor)." },
  "no-gain": { short: "nothing to cut", note: "nothing to cut: a rule matched, but the output was short or would not shrink." },
  "failed-run": { short: "failed run, in full", note: "failed run, in full: error output is kept whole so the agent can debug." }
};

export function renderFallbacks(agg: GainAgg, opts: { subtitle?: string | undefined }): string {
  const rows = (agg.fallbacks ?? []).slice(0, 15);
  const older = (agg.byRule ?? []).find((r) => r.kind === "unattributed");
  const lines = header("Commands left unchanged", opts.subtitle);
  if (rows.length === 0) {
    lines.push("  No command was left unchanged in this scope.");
  } else {
    const rule = "  " + "─".repeat(60);
    lines.push(`  ${" #".padEnd(4)}${"Command".padEnd(22)}${"Runs".padStart(6)}${"Tokens".padStart(9)}  Reason`, rule);
    rows.forEach((r, i) => {
      lines.push(`  ${(String(i + 1) + ".").padStart(3)} ${r.cmd.slice(0, 21).padEnd(22)}${formatCount(r.count).padStart(6)}${formatTokens(r.tokens).padStart(9)}  ${REASON_TEXT[r.reason].short}`);
    });
    lines.push(rule);
    for (const reason of ["no-rule", "no-gain", "failed-run"] as const) {
      if (rows.some((r) => r.reason === reason)) lines.push(`  ${REASON_TEXT[reason].note}`);
    }
  }
  if (older?.count) lines.push(`  ${formatCount(older.count)} older run${older.count === 1 ? "" : "s"} recorded before this report existed have no details.`);
  lines.push("");
  return lines.join("\n");
}

export const QUOTA_TIERS = {
  pro: { plan: "Claude Pro", multiplier: 1 },
  "5x": { plan: "Claude Max 5x", multiplier: 5 },
  "20x": { plan: "Claude Max 20x", multiplier: 20 }
} as const;

export type QuotaTier = keyof typeof QUOTA_TIERS;

const QUOTA_TOKENS_PER_WINDOW = 44_000;
const QUOTA_WINDOWS_PER_MONTH = 144;

export type QuotaEstimate = {
  tier: QuotaTier;
  plan: string;
  savedTokens: number;
  days: number;
  monthlySavedTokens: number;
  monthlyBudgetTokens: number;
  pct: number;
  basis: "estimate";
  formula: string;
};

export function quotaEstimate(agg: GainAgg, tier: QuotaTier): QuotaEstimate {
  const savedTokens = Math.max(0, agg.agent ? agg.agent.rawTokens - agg.agent.filteredTokens : agg.observed?.savedTokens ?? agg.savedTokens);
  const days = Math.max(1, agg.sinceDays);
  const monthlySavedTokens = Math.round((savedTokens / days) * 30);
  const monthlyBudgetTokens = QUOTA_TOKENS_PER_WINDOW * QUOTA_WINDOWS_PER_MONTH * QUOTA_TIERS[tier].multiplier;
  return {
    tier,
    plan: QUOTA_TIERS[tier].plan,
    savedTokens,
    days,
    monthlySavedTokens,
    monthlyBudgetTokens,
    pct: Math.round((monthlySavedTokens / monthlyBudgetTokens) * 1000) / 10,
    basis: "estimate",
    formula: `savedTokens / days * 30 / (${QUOTA_TOKENS_PER_WINDOW} tokens per 5-hour window * ${QUOTA_WINDOWS_PER_MONTH} windows * ${QUOTA_TIERS[tier].multiplier})`
  };
}

export function renderQuota(q: QuotaEstimate, opts: { color: boolean; subtitle?: string | undefined }): string {
  const label = (text: string): string => `  ${text.padEnd(16)}`;
  const blocks = Math.max(0, Math.min(24, Math.round((Math.min(100, q.pct) / 100) * 24)));
  return [
    ...header("Tokmizer quota estimate", opts.subtitle),
    `${label("Plan (assumed)")}${q.plan}`,
    `${label("Tokens saved")}${formatTokens(q.savedTokens)} over ${q.days} day${q.days === 1 ? "" : "s"}`,
    `${label("Per month")}${formatTokens(q.monthlySavedTokens)}${q.days < 30 ? " (projected)" : ""}`,
    `${label("Plan budget")}${formatTokens(q.monthlyBudgetTokens)} per month (assumed)`,
    `${label("Quota kept")}${bar(blocks, opts.color)}${"░".repeat(24 - blocks)} ${q.pct} %`,
    "",
    "  Estimate, not a plan limit. Formula: tokens saved ÷ days × 30",
    `  ÷ (${formatTokens(QUOTA_TOKENS_PER_WINDOW)} tokens per 5-hour window × ${QUOTA_WINDOWS_PER_MONTH} windows × ${QUOTA_TIERS[q.tier].multiplier}).`,
    "  Anthropic does not publish plan limits in tokens and applies them per",
    "  rolling 5-hour window. Each saved token is counted once.",
    ""
  ].join("\n");
}

function savedOrAdded(tokens: number): string {
  return tokens < 0 ? `${formatTokens(-tokens)} added` : `${formatTokens(tokens)} saved`;
}

export function renderDaily(rows: DayRow[], opts: { color: boolean }): string {
  if (rows.length === 0) return "";
  const fmtRow = (label: string, count: number, saved: number): string =>
    `  ${label.padEnd(11)}${formatCount(count).padStart(4)}${(saved < 0 ? `${formatTokens(-saved)} added` : formatTokens(saved)).padStart(13)}`;
  const head = "  " + "Day".padEnd(11) + "Cmds".padStart(4) + "Saved".padStart(13);
  const rule = "  " + "─".repeat(31);
  const body = rows.map((r) => fmtRow(`${r.day.slice(8, 10)}/${r.day.slice(5, 7)}`, r.count, r.savedTokens));
  const totCount = rows.reduce((a, r) => a + r.count, 0);
  const totSaved = rows.reduce((a, r) => a + r.savedTokens, 0);
  const totalLine = fmtRow("Total", totCount, totSaved);
  return [head, rule, ...body, rule, opts.color ? `${AMBER}${totalLine}${RESET}` : totalLine, ""].join("\n");
}


export type AgentDayRow = { day: string; count: number; rawTokens: number; filteredTokens: number; savedTokens: number; pct: number };

function agentDayRow(day: string, acc: Acc): AgentDayRow {
  const rawTokens = bytesToTokens(acc.or - acc.tr);
  const filteredTokens = bytesToTokens(acc.of - acc.tf);
  const savedTokens = rawTokens - filteredTokens;
  return { day, count: acc.n - acc.tn, rawTokens, filteredTokens, savedTokens, pct: rawTokens ? Math.round((savedTokens / rawTokens) * 1000) / 10 : 0 };
}

export async function readAgentDaily(file = statsPath(), sinceTs = 0, project?: string): Promise<AgentDayRow[]> {
  return [...(await loadDays(file, sinceTs, project)).entries()]
    .filter(([, acc]) => acc.n - acc.tn > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, acc]) => agentDayRow(day, acc));
}

export function renderCsv(rows: AgentDayRow[]): string {
  const lines = ["date,commands,tokens_in,tokens_out,tokens_saved,percent"];
  for (const r of rows) lines.push(`${r.day},${r.count},${r.rawTokens},${r.filteredTokens},${r.savedTokens},${r.pct}`);
  return lines.join("\n") + "\n";
}

function shortDay(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

export function renderGraph(rows: AgentDayRow[], opts: { color: boolean; sinceTs: number; nowTs: number; subtitle: string }): string {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const first = opts.sinceTs > 0 ? dayKey(opts.sinceTs) : rows[0]?.day ?? dayKey(opts.nowTs);
  const days: string[] = [];
  const cursor = new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, Number(first.slice(8, 10)));
  const last = dayKey(opts.nowTs);
  while (days.length < 366) {
    const key = dayKey(Math.floor(cursor.getTime() / 1000));
    if (key > last) break;
    days.push(key);
    cursor.setDate(cursor.getDate() + 1);
  }
  const width = 30;
  const top = Math.max(0, ...rows.map((r) => r.savedTokens));
  const rule = "  " + "─".repeat(width + 18);
  const lines = [`  Tokens saved per day · ${opts.subtitle}`, rule];
  for (const day of days) {
    const saved = byDay.get(day)?.savedTokens ?? 0;
    const blocks = top > 0 && saved > 0 ? Math.max(1, Math.round((saved / top) * width)) : 0;
    const value = saved < 0 ? `${formatTokens(-saved)} added` : formatTokens(saved);
    lines.push(`  ${shortDay(day)}  ${bar(blocks, opts.color)}${"░".repeat(width - blocks)} ${value.padStart(11)}`);
  }
  const total = rows.reduce((a, r) => a + r.savedTokens, 0);
  const totalLine = `  ${"Total".padEnd(5)}  ${"".padEnd(width)} ${savedOrAdded(total).padStart(11)}`;
  lines.push(rule, opts.color ? `${AMBER}${totalLine}${RESET}` : totalLine, "", "  Estimates from output size (bytes ÷ 4), not provider-counted tokens.", "");
  return lines.join("\n");
}

export type HistoryRow = { at: number; cmd: string; rawTokens: number; filteredTokens: number; savedTokens: number };

export async function readHistory(file = statsPath(), sinceTs = 0, project?: string, limit = 20): Promise<HistoryRow[]> {
  return (await readJournal(file, sinceTs, project))
    .filter((rec) => !rec.m && rec.h !== "shell")
    .slice(-limit)
    .map((rec) => {
      const rawTokens = bytesToTokens(rec.r);
      const filteredTokens = bytesToTokens(rec.f);
      return { at: rec.t, cmd: rec.c ?? "(unlabeled)", rawTokens, filteredTokens, savedTokens: rawTokens - filteredTokens };
    });
}

function localStamp(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${dayKey(seconds)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function renderHistory(rows: HistoryRow[], opts: { color: boolean; subtitle: string }): string {
  if (rows.length === 0) return "  No commands recorded in this scope.\n";
  const rule = "  " + "─".repeat(66);
  const lines = [
    `  Last ${rows.length} commands · ${opts.subtitle}`,
    rule,
    `  ${"Time".padEnd(18)}${"Command".padEnd(22)}${"In".padStart(8)}${"Out".padStart(8)}${"Saved".padStart(10)}`,
    rule
  ];
  for (const r of rows) {
    const saved = r.savedTokens < 0 ? `-${formatTokens(-r.savedTokens)}` : formatTokens(r.savedTokens);
    lines.push(`  ${localStamp(r.at).padEnd(18)}${r.cmd.slice(0, 21).padEnd(22)}${formatTokens(r.rawTokens).padStart(8)}${formatTokens(r.filteredTokens).padStart(8)}${saved.padStart(10)}`);
  }
  const total = rows.reduce((a, r) => a + r.savedTokens, 0);
  const totalLine = `  ${"Total".padEnd(40)}${"".padStart(16)}${savedOrAdded(total).padStart(10)}`;
  lines.push(rule, opts.color ? `${AMBER}${totalLine}${RESET}` : totalLine, "");
  return lines.join("\n");
}

export function projectLabel(project: string): string {
  return basename(project) || project;
}

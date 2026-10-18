import { readdir, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { FilterDef } from "./schema";
import type { LoadedFilter } from "./loader";
import { selectFilter } from "./matcher";
import { applyFilter } from "./pipeline";
import type { FilterResolver } from "./index";
import { tokmizerHome } from "../paths";

export const USER_FILTER_PREFIX = "user/";
export const USER_FILTER_SCHEMA_VERSION = 1;

export type UserFilterIssue = { file: string; message: string };

export type UserFilterTest = { name?: string; input: string; expected: string };

export type UserFilters = {
  dir: string;
  filters: Map<string, LoadedFilter>;
  tests: Map<string, { file: string; tests: UserFilterTest[] }>;
  issues: UserFilterIssue[];
};

type TrustStore = { v: 1; files: Record<string, string> };

let cache: Promise<UserFilters> | null = null;
let cacheSignature = "";
let checkedAt = 0;

const RECHECK_MS = 1000;

export function userFiltersDir(): string {
  return join(tokmizerHome(), "filters");
}

export function userFiltersTrustFile(): string {
  return join(tokmizerHome(), "filters-trust.json");
}

export function isUserFilterId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(USER_FILTER_PREFIX);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readTrust(): Promise<TrustStore> {
  try {
    const parsed = JSON.parse(await readFile(userFiltersTrustFile(), "utf8")) as { files?: unknown };
    const files: Record<string, string> = {};
    if (parsed.files && typeof parsed.files === "object") {
      for (const [name, hash] of Object.entries(parsed.files as Record<string, unknown>)) {
        if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) files[name] = hash;
      }
    }
    return { v: 1, files };
  } catch {
    return { v: 1, files: {} };
  }
}

async function writeTrust(store: TrustStore): Promise<void> {
  const path = userFiltersTrustFile();
  await mkdir(tokmizerHome(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

function parseTests(name: string, raw: unknown): { tests: UserFilterTest[] } | { message: string } {
  if (raw === undefined) return { tests: [] };
  const bad = { message: `${name}: tests: each [[filters.${name}.tests]] needs input and expected strings` };
  if (!Array.isArray(raw)) return bad;
  const tests: UserFilterTest[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return bad;
    const { input, expected, name: label } = item as Record<string, unknown>;
    if (typeof input !== "string" || typeof expected !== "string") return bad;
    tests.push({ ...(typeof label === "string" && label ? { name: label } : {}), input, expected });
  }
  return { tests };
}

function compileRule(name: string, body: unknown): { filter: LoadedFilter; tests: UserFilterTest[] } | { message: string } {
  const source = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const { tests: rawTests, ...rule } = source;
  const tests = parseTests(name, rawTests);
  if ("message" in tests) return tests;
  const parsed = FilterDef.safeParse({ ...rule, slug: name });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "rule"}: ${i.message}`).join("; ");
    return { message: `${name}: ${detail}` };
  }
  let matchRegex: RegExp;
  try {
    matchRegex = new RegExp(parsed.data.match_command);
  } catch {
    return { message: `${name}: match_command is not a valid regular expression` };
  }
  for (const pattern of parsed.data.strip_lines_matching) {
    try {
      new RegExp(pattern);
    } catch {
      return { message: `${name}: strip_lines_matching has an invalid regular expression` };
    }
  }
  return { filter: { ...parsed.data, slug: `${USER_FILTER_PREFIX}${parsed.data.slug}`, matchRegex }, tests: tests.tests };
}

function schemaIssue(version: unknown): string | null {
  if (version === undefined || version === USER_FILTER_SCHEMA_VERSION) return null;
  if (typeof version === "number" && Number.isInteger(version)) {
    return `schema_version ${version} is not supported: this tkr reads schema_version = ${USER_FILTER_SCHEMA_VERSION}. Update tkr, or write the file for version ${USER_FILTER_SCHEMA_VERSION}`;
  }
  return `schema_version must be the number ${USER_FILTER_SCHEMA_VERSION}`;
}

async function listFilterFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".toml")).sort();
  } catch {
    return [];
  }
}

export async function readUserFilters(opts: { requireTrust?: boolean } = {}): Promise<UserFilters> {
  const requireTrust = opts.requireTrust !== false;
  const dir = userFiltersDir();
  const filters = new Map<string, LoadedFilter>();
  const tests = new Map<string, { file: string; tests: UserFilterTest[] }>();
  const issues: UserFilterIssue[] = [];
  const files = await listFilterFiles(dir);
  if (files.length === 0) return { dir, filters, tests, issues };
  const trust = requireTrust ? await readTrust() : null;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(dir, file), "utf8");
    } catch {
      issues.push({ file, message: "could not be read" });
      continue;
    }
    if (trust) {
      const known = trust.files[file];
      if (!known) {
        issues.push({ file, message: `not trusted yet. Review it, then run: tkr filters trust ${file}` });
        continue;
      }
      if (known !== sha256(text)) {
        issues.push({ file, message: `changed since it was trusted. Review it, then run: tkr filters trust ${file}` });
        continue;
      }
    }
    const parsed = await parseUserFilterText(text, file);
    for (const [slug, filter] of parsed.filters) filters.set(slug, filter);
    for (const [slug, entry] of parsed.tests) tests.set(slug, entry);
    issues.push(...parsed.issues);
  }
  return { dir, filters, tests, issues };
}

export async function parseUserFilterText(text: string, file: string): Promise<Omit<UserFilters, "dir">> {
  const filters = new Map<string, LoadedFilter>();
  const tests = new Map<string, { file: string; tests: UserFilterTest[] }>();
  const issues: UserFilterIssue[] = [];
  const { parse } = await import("smol-toml");
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    issues.push({ file, message: `not valid TOML (${String((err as Error).message).split("\n")[0]})` });
    return { filters, tests, issues };
  }
  const versionProblem = schemaIssue((doc as { schema_version?: unknown }).schema_version);
  if (versionProblem) {
    issues.push({ file, message: versionProblem });
    return { filters, tests, issues };
  }
  const section = (doc as { filters?: unknown }).filters;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    issues.push({ file, message: "no [filters.<name>] table found" });
    return { filters, tests, issues };
  }
  for (const [name, body] of Object.entries(section as Record<string, unknown>)) {
    const result = compileRule(name, body);
    if ("message" in result) {
      issues.push({ file, message: result.message });
      continue;
    }
    filters.set(result.filter.slug, result.filter);
    if (result.tests.length > 0) tests.set(result.filter.slug, { file, tests: result.tests });
  }
  return { filters, tests, issues };
}

function sourceSignature(): string {
  const parts: string[] = [];
  for (const path of [userFiltersTrustFile(), userFiltersDir()]) {
    try {
      const s = statSync(path);
      parts.push(`${s.mtimeMs}:${s.size}`);
    } catch {
      parts.push("-");
    }
  }
  try {
    for (const file of readdirSync(userFiltersDir()).filter((f) => f.endsWith(".toml")).sort()) {
      const s = statSync(join(userFiltersDir(), file));
      parts.push(`${file}:${s.mtimeMs}:${s.size}`);
    }
  } catch {}
  return parts.join("|");
}

export function loadUserFilters(): Promise<UserFilters> {
  const now = Date.now();
  if (!cache || now - checkedAt >= RECHECK_MS) {
    checkedAt = now;
    const signature = sourceSignature();
    if (!cache || signature !== cacheSignature) {
      cacheSignature = signature;
      cache = readUserFilters();
    }
  }
  return cache;
}

export async function selectUserFilter(cmd: string): Promise<LoadedFilter | null> {
  const { filters } = await loadUserFilters();
  if (filters.size === 0) return null;
  return selectFilter(cmd, filters.values(), null, filters);
}

export function withUserFilters(resolver: FilterResolver): FilterResolver {
  return async (cmd, allowed) => (await selectUserFilter(cmd)) ?? resolver(cmd, allowed);
}

export async function trustUserFilters(names: string[] = []): Promise<{ trusted: string[]; missing: string[] }> {
  const dir = userFiltersDir();
  const available = await listFilterFiles(dir);
  const wanted = names.length > 0 ? names.map((n) => basename(n)) : available;
  const store = await readTrust();
  const trusted: string[] = [];
  const missing: string[] = [];
  for (const file of wanted) {
    if (!available.includes(file)) {
      missing.push(file);
      continue;
    }
    store.files[file] = sha256(await readFile(join(dir, file), "utf8"));
    trusted.push(file);
  }
  if (trusted.length > 0) await writeTrust(store);
  cache = null;
  return { trusted, missing };
}

export async function untrustUserFilters(names: string[] = []): Promise<string[]> {
  const store = await readTrust();
  const wanted = names.length > 0 ? names.map((n) => basename(n)) : Object.keys(store.files);
  const removed = wanted.filter((file) => file in store.files);
  for (const file of removed) delete store.files[file];
  if (removed.length > 0) await writeTrust(store);
  cache = null;
  return removed;
}

export type UserFilterTestResult = { rule: string; file: string; index: number; name?: string; pass: boolean; expected: string; actual: string };

export async function runUserFilterTests(rule?: string): Promise<{ results: UserFilterTestResult[]; issues: UserFilterIssue[]; untested: string[] }> {
  return runFilterTests(await readUserFilters({ requireTrust: false }), rule);
}

export function runFilterTests(user: Omit<UserFilters, "dir">, rule?: string): { results: UserFilterTestResult[]; issues: UserFilterIssue[]; untested: string[] } {
  const results: UserFilterTestResult[] = [];
  const untested: string[] = [];
  for (const [slug, filter] of user.filters) {
    const name = slug.slice(USER_FILTER_PREFIX.length);
    if (rule && name !== rule) continue;
    const entry = user.tests.get(slug);
    if (!entry) {
      untested.push(name);
      continue;
    }
    entry.tests.forEach((test, index) => {
      const actual = applyFilter(test.input, filter, { verbosity: "normal" });
      results.push({
        rule: name,
        file: entry.file,
        index: index + 1,
        ...(test.name ? { name: test.name } : {}),
        pass: actual.trimEnd() === test.expected.trimEnd(),
        expected: test.expected,
        actual
      });
    });
  }
  return { results, issues: user.issues, untested };
}

export function __resetUserFilters(): void {
  cache = null;
  cacheSignature = "";
  checkedAt = 0;
}

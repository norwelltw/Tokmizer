import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { parseUserFilterText, runFilterTests, type UserFilterTestResult } from "../engine/user-filters";
import { rtkConfigDirs, rtkTrustStore, type RtkEnv } from "./rtk-paths";

export type RtkFilterSource = { path: string; scope: "global" | "project"; readByRtk: boolean; target: string };

export type SkippedFilter = { name: string; reason: string };

export type ConvertedFilters = {
  source: RtkFilterSource;
  text: string | null;
  imported: string[];
  skipped: SkippedFilter[];
  fileIssue: string | null;
  tests: UserFilterTestResult[];
  untested: string[];
  orphanTests: string[];
  trustedByRtk: boolean;
};

const DIRECT_KEYS = new Set(["description", "match_command", "strip_ansi", "strip_lines_matching", "truncate_lines_at", "max_lines", "on_empty"]);

const NO_EQUIVALENT: Record<string, (v: unknown) => boolean> = {
  replace: (v) => Array.isArray(v) && v.length > 0,
  match_output: (v) => Array.isArray(v) && v.length > 0,
  keep_lines_matching: (v) => Array.isArray(v) && v.length > 0,
  head_lines: (v) => v !== undefined,
  tail_lines: (v) => v !== undefined,
  filter_stderr: (v) => v === true
};

function slugPart(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
}

export function rtkFilterSources(e: RtkEnv): RtkFilterSource[] {
  const sources: RtkFilterSource[] = [];
  for (const { dir, readByRtk } of rtkConfigDirs(e)) {
    sources.push({ path: join(dir, "filters.toml"), scope: "global", readByRtk, target: readByRtk ? "rtk-global.toml" : "rtk-global-unused-dir.toml" });
  }
  sources.push({ path: join(e.cwd, ".rtk", "filters.toml"), scope: "project", readByRtk: true, target: `rtk-project-${slugPart(basename(e.cwd))}.toml` });
  return sources;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function trustedByRtk(e: RtkEnv, path: string, bytes: Buffer): boolean {
  try {
    const store = JSON.parse(readFileSync(rtkTrustStore(e), "utf8")) as { trusted?: Record<string, { sha256?: unknown }> };
    const entry = store.trusted?.[realpathSync(path)];
    return typeof entry?.sha256 === "string" && entry.sha256 === sha256(bytes);
  } catch {
    return false;
  }
}

function topLevelBranches(pattern: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") escaped = true;
    else if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    else if (ch === "(" && !inClass) depth += 1;
    else if (ch === ")" && !inClass) depth = Math.max(0, depth - 1);
    else if (ch === "|" && !inClass && depth === 0) {
      branches.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  branches.push(pattern.slice(start));
  return branches;
}

export function anchoredForRtk(pattern: string): boolean {
  return topLevelBranches(pattern).every((branch) => branch.replace(/^\(\?[imsuxU-]+\)/, "").startsWith("^"));
}

type Candidate = { name: string; rule: Record<string, unknown> };

function convertRule(name: string, raw: unknown): Candidate | SkippedFilter {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { name, reason: "not a table" };
  const body = raw as Record<string, unknown>;
  const blocked: string[] = [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (DIRECT_KEYS.has(key)) continue;
    const check = NO_EQUIVALENT[key];
    if (!check) unknown.push(key);
    else if (check(value)) blocked.push(key);
  }
  if (unknown.length > 0) return { name, reason: `unknown key${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} (rtk rejects them too)` };
  if (blocked.length > 0) return { name, reason: `uses ${blocked.join(", ")}, which Tokmizer filters do not support` };
  if (typeof body.match_command !== "string") return { name, reason: "match_command is missing" };
  if (!anchoredForRtk(body.match_command)) return { name, reason: "match_command is not anchored with ^, so rtk ignored this filter" };
  const rule: Record<string, unknown> = { match_command: body.match_command };
  for (const key of ["description", "strip_ansi", "strip_lines_matching", "truncate_lines_at", "max_lines", "on_empty"]) {
    if (body[key] !== undefined) rule[key] = body[key];
  }
  if (rule.strip_ansi === false) delete rule.strip_ansi;
  if (Array.isArray(rule.strip_lines_matching) && rule.strip_lines_matching.length === 0) delete rule.strip_lines_matching;
  if (rule.max_lines !== undefined) rule.scale_with_level = false;
  return { name, rule };
}

function parseTests(raw: unknown): Map<string, { name?: string; input: string; expected: string }[]> {
  const out = new Map<string, { name?: string; input: string; expected: string }[]>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [filter, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const tests = list.flatMap((t) => {
      if (typeof t !== "object" || t === null) return [];
      const { name, input, expected } = t as Record<string, unknown>;
      if (typeof input !== "string" || typeof expected !== "string") return [];
      return [{ ...(typeof name === "string" && name ? { name } : {}), input, expected }];
    });
    out.set(filter, tests);
  }
  return out;
}

export async function convertRtkFilters(e: RtkEnv, source: RtkFilterSource): Promise<ConvertedFilters | null> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(source.path);
  } catch {
    return null;
  }
  const result: ConvertedFilters = {
    source,
    text: null,
    imported: [],
    skipped: [],
    fileIssue: null,
    tests: [],
    untested: [],
    orphanTests: [],
    trustedByRtk: trustedByRtk(e, source.path, bytes)
  };
  const { parse, stringify } = await import("smol-toml");
  let doc: Record<string, unknown>;
  try {
    doc = parse(bytes.toString("utf8").replace(/^﻿/, "")) as Record<string, unknown>;
  } catch (err) {
    result.fileIssue = `not valid TOML (${String((err as Error).message).split("\n")[0]})`;
    return result;
  }
  if (doc.schema_version !== 1) {
    result.fileIssue = `schema_version ${JSON.stringify(doc.schema_version ?? null)} is not 1, so rtk did not load this file`;
    return result;
  }
  const filters = typeof doc.filters === "object" && doc.filters !== null && !Array.isArray(doc.filters) ? (doc.filters as Record<string, unknown>) : {};
  const tests = parseTests(doc.tests);
  const accepted: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(filters)) {
    const converted = convertRule(name, raw);
    if ("reason" in converted) {
      result.skipped.push(converted);
      continue;
    }
    const rule = { ...converted.rule, ...(tests.get(name)?.length ? { tests: tests.get(name) } : {}) };
    const check = await parseUserFilterText(stringify({ schema_version: 1, filters: { [name]: rule } }), source.target);
    if (check.issues.length > 0) {
      result.skipped.push({ name, reason: check.issues.map((i) => i.message.replace(`${name}: `, "")).join("; ") });
      continue;
    }
    accepted[name] = rule;
    result.imported.push(name);
  }
  result.orphanTests = [...tests.keys()].filter((name) => !(name in filters));
  if (result.imported.length === 0) return result;
  result.text = stringify({ schema_version: 1, filters: accepted });
  const run = runFilterTests(await parseUserFilterText(result.text, source.target));
  result.tests = run.results;
  result.untested = run.untested;
  return result;
}

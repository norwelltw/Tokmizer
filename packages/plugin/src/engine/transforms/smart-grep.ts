import { registerTransform } from "./registry";

const MAX_OUTPUT_LINES = 1000;
const CONTENT_WIDTH = 200;
const INDEX_MIN_LINES = 60;
const INDEX_WIDTH = 190;
const MATCH_RE = /^([^\s:]+):(\d+):(.*)$/;
const CONTEXT_RE = /^([^:]+?)-(\d+)-(.*)$/;
const PLAIN_RE = /^([^\s:]+):(.*)$/;
const TEST_PATH_RE = /(?:^|\/)(?:__tests__|tests?|spec|fixtures?|__mocks__|__snapshots__)\/|\.(?:test|spec)\.[^/]+$/i;

type Hit = { line: string; content: string; context: boolean } | { separator: true };

function clip(s: string, keepIndent = false): string {
  const t = keepIndent ? s.trimEnd() : s.trim();
  return t.length > CONTENT_WIDTH ? `${t.slice(0, CONTENT_WIDTH)}…` : t;
}

function indexLines(entries: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const e of entries) {
    const next = cur ? `${cur}, ${e}` : e;
    if (next.length >= INDEX_WIDTH && cur) {
      out.push(`${cur},`);
      cur = e;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function commonRoot(files: string[]): string {
  let prefix: string[] | null = null;
  for (const f of files) {
    const segs = f.split("/").slice(0, -1);
    if (prefix === null) {
      prefix = segs;
      continue;
    }
    let i = 0;
    while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) return "";
  }
  return prefix ? prefix.join("/") : "";
}

// A grep file prefix must look like a real path. Free text before a colon
// ("ERROR:", "Author:", "12:34:56", "my-app-2-1") is log or pipe content.
function pathShaped(file: string): boolean {
  return file.includes("/") || file.includes("\\") || /\.[A-Za-z][\w-]*$/.test(file);
}

// A bare name (Makefile, LICENSE) is a file when it is numbered, or when most
// other prefixes of the same output are paths.
function looksLikePath(file: string, numbered: boolean, bareOk: boolean): boolean {
  if (/^\d+$/.test(file)) return false;
  if (pathShaped(file)) return true;
  return (numbered || bareOk) && /^[\w.-]+$/.test(file);
}

function mostlyPaths(lines: string[]): boolean {
  let paths = 0;
  let prefixed = 0;
  for (const raw of lines) {
    const file = (MATCH_RE.exec(raw) ?? CONTEXT_RE.exec(raw) ?? PLAIN_RE.exec(raw))?.[1];
    if (!file) continue;
    prefixed += 1;
    if (pathShaped(file)) paths += 1;
  }
  return paths >= 2 && paths * 2 > prefixed;
}

export function smartGrep(lines: string[], opts: { astGrep?: boolean } = {}): string[] {
  const cleaned = lines.filter((l) => l.trim() !== "");
  if (cleaned.length === 0) return lines;

  const bareOk = mostlyPaths(cleaned);
  const byFile = new Map<string, Hit[]>();
  const matchCount = new Map<string, number>();
  let lastFile: string | null = null;
  let matches = 0;
  let entries = 0;
  let lastNum: number | null = null;
  for (const raw of cleaned) {
    if (raw === "--") {
      if (lastFile) byFile.get(lastFile)!.push({ separator: true });
      continue;
    }
    if (/^[A-Za-z]:[\\/]/.test(raw)) return lines;
    const m = MATCH_RE.exec(raw);
    const c = CONTEXT_RE.exec(raw);
    if (m && c) return lines;
    const p = m || c ? null : PLAIN_RE.exec(raw);
    const file = (m ?? c ?? p)?.[1];
    if (!file || !looksLikePath(file, !!m, bareOk)) return lines;
    const hit: Hit = m
      ? { line: m[2]!, content: m[3]!, context: false }
      : c
        ? { line: c[2]!, content: c[3]!, context: true }
        : { line: "", content: p![2]!, context: false };
    const arr = byFile.get(file) ?? [];
    arr.push(hit);
    byFile.set(file, arr);
    // ast-grep prints every source and context line of a match with the same
    // prefix: count one match per run of consecutive line numbers instead.
    const n = hit.line ? Number(hit.line) : NaN;
    const continues = opts.astGrep && file === lastFile && lastNum !== null && n === lastNum + 1;
    if (opts.astGrep ? !continues : !hit.context) {
      matches += 1;
      matchCount.set(file, (matchCount.get(file) ?? 0) + 1);
    }
    lastNum = opts.astGrep && Number.isFinite(n) ? n : null;
    entries += 1;
    lastFile = file;
  }
  if (byFile.size === entries) return lines;

  const files = [...byFile.keys()].sort((a, b) => {
    const ta = TEST_PATH_RE.test(a) ? 1 : 0;
    const tb = TEST_PATH_RE.test(b) ? 1 : 0;
    return ta - tb || (a < b ? -1 : a > b ? 1 : 0);
  });
  const root = files.length > 1 ? commonRoot(files) : "";
  const shown = (f: string): string => (root ? f.slice(root.length + 1) : f);
  const body: string[] = [];
  for (const f of files) {
    body.push(`${shown(f)} (${matchCount.get(f) ?? 0}):`);
    for (const h of byFile.get(f)!) {
      if ("separator" in h) body.push("  --");
      else if (h.line) body.push(`  ${h.line}${h.context ? "-" : ":"} ${clip(h.content, opts.astGrep)}`);
      else body.push(`  ${clip(h.content, opts.astGrep)}`);
    }
  }
  const index = files.length > 1 && body.length > INDEX_MIN_LINES
    ? indexLines(files.map((f) => `${shown(f)} (${matchCount.get(f) ?? 0})`))
    : [];
  const out = [`${matches}m ${files.length}f${root ? ` in ${root}/` : ""}:`, ...index, "", ...body];
  if (out.length > MAX_OUTPUT_LINES) {
    const omitted = out.length - MAX_OUTPUT_LINES;
    return [...out.slice(0, MAX_OUTPUT_LINES), `… ${omitted} more lines omitted`];
  }
  return out;
}

registerTransform("smart-grep", smartGrep);
registerTransform("smart-grep-ast", (lines) => smartGrep(lines, { astGrep: true }));
import "./curl-progress";

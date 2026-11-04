import { FAILURE } from "./fold-passing";

const TIMESTAMP_PREFIX = /^\s*(?:\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*/;
const VERBOSE_LEVEL_PREFIX = /^\s*(?:\[(?:DEBUG|TRACE|INFO|VERBOSE)\]|(?:DEBUG|TRACE|INFO|VERBOSE)(?!\s*:))(?=\s|:|$)(?!\s*[+\-*\/%&|^?]*=)/;
const LOG_FAILURE = new RegExp(FAILURE.source, "i");
const WARNING = /\bWARN(?:ING)?\b/i;

export function dropTimestampPrefix(lines: string[]): string[] {
  return lines.map((l) => l.replace(TIMESTAMP_PREFIX, ""));
}

export function dropVerboseLogs(lines: string[]): string[] {
  const out: string[] = [];
  let dropped = 0;
  const flush = (): void => {
    if (dropped > 0) out.push(`… ${dropped} verbose log line${dropped === 1 ? "" : "s"} dropped …`);
    dropped = 0;
  };
  for (const l of lines) {
    if (VERBOSE_LEVEL_PREFIX.test(l.replace(TIMESTAMP_PREFIX, "")) && !LOG_FAILURE.test(l) && !WARNING.test(l)) {
      dropped += 1;
      continue;
    }
    flush();
    out.push(l);
  }
  flush();
  return out;
}

const PY_LOGGING_PREFIX = /^(?:DEBUG|INFO):[\w.-]+:/;
const EXCEPTION_RE = /Error|Exception|Traceback|panic|fail|FAIL|Fail|SEVERE|CRITICAL/;
const NOISE_RUN_MIN = 8;
const NOISE_KEEP_HEAD = 1;
const NOISE_KEEP_TAIL = 2;

const PROGRESS_LINE = /^(\s*)(?:Downloaded|Downloading|Compiling|Fetching|Fetched|Installing|Installed|Collecting|Using cached|Requirement already satisfied:|Unpacking|Preparing|Pulling fs layer|Pull complete|Already exists|Download complete|Verifying Checksum|Waiting|Extracting|Get:\d+|Hit:\d+|Ign:\d+|Setting up|Selecting previously unselected package|Progress: resolved|cargo:rustc-[a-z-]+=)/;
const LAYER_PROGRESS = /^[0-9a-f]{12}: (?:Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)\b/;
const RESOURCE_DONE = /^\s*[-+~]\s+[├└│ ─]*\S+:\S+\s+\S+\s+(?:created|updated|deleted|replaced|refreshed|read|same)\s\(\d+s\)\s*$/;

function noiseKey(line: string): string | null {
  if (line.trim() === "" || LOG_FAILURE.test(line) || WARNING.test(line) || EXCEPTION_RE.test(line)) return null;
  const progress = PROGRESS_LINE.exec(line);
  if (progress) return `\u0000progress${progress[1]}`;
  if (LAYER_PROGRESS.test(line)) return "\u0000layer";
  if (RESOURCE_DONE.test(line)) return "\u0000resource-done";
  if (/^\s/.test(line)) return null;
  const body = line.replace(TIMESTAMP_PREFIX, "");
  if (VERBOSE_LEVEL_PREFIX.test(body) || PY_LOGGING_PREFIX.test(body)) return "\u0000verbose";
  return line.replace(/\d+/g, "#");
}

export function condenseLogNoise(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const key = noiseKey(lines[i]!);
    let j = i + 1;
    if (key !== null) while (j < lines.length && noiseKey(lines[j]!) === key) j += 1;
    const run = j - i;
    if (key === null || run < NOISE_RUN_MIN) {
      out.push(...lines.slice(i, j));
    } else {
      out.push(...lines.slice(i, i + NOISE_KEEP_HEAD));
      out.push(`… ${run - NOISE_KEEP_HEAD - NOISE_KEEP_TAIL} similar log lines dropped …`);
      out.push(...lines.slice(j - NOISE_KEEP_TAIL, j));
    }
    i = j;
  }
  return out;
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** Unified diffs depend on exact line counts per hunk, so blank/duplicate collapsing must not touch them. */
export function looksLikeUnifiedDiff(lines: string[]): boolean {
  return lines.some((l) => HUNK_HEADER_RE.test(l));
}

export function dedupeAdjacent(lines: string[]): string[] {
  if (lines.length === 0 || looksLikeUnifiedDiff(lines)) return lines;
  const out: string[] = [];
  let run = 1;
  let prev = lines[0]!;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === prev) {
      run += 1;
      continue;
    }
    out.push(run > 1 && prev.trim() ? `${prev} ×${run}` : prev);
    prev = lines[i]!;
    run = 1;
  }
  out.push(run > 1 && prev.trim() ? `${prev} ×${run}` : prev);
  return out;
}

export function collapseBlankRuns(lines: string[]): string[] {
  if (looksLikeUnifiedDiff(lines)) return lines;
  const out: string[] = [];
  let blanks = 0;
  for (const l of lines) {
    if (l.trim() === "") {
      blanks += 1;
      continue;
    }
    if (blanks > 0) out.push("");
    blanks = 0;
    out.push(l);
  }
  return out;
}

import { registerTransform } from "./registry";

const FRAME_RE = /^\s*\d+ \| /;
const CARET_RE = /^\s+\^\s*$/;
const FILE_HEADER_RE = /^(?!\s).*[._](?:test|spec)\.[cm]?[jt]sx?:$/;
const SECTION_END_RE = /^\s*\d+ (?:pass|fail|skip|todo)$|^\d+ tests? (?:failed|skipped|todo)|^Ran \d+ tests?/;

const RECAP_HEAD_RE = /^\d+ tests? (?:failed|skipped|todo):$/;
const RECAP_ENTRY_RE = /^\((?:fail|skip|todo)\) /;

function dropRepeatedRecaps(lines: string[]): string[] {
  const drop = new Set<number>();
  lines.forEach((line, i) => {
    if (!RECAP_HEAD_RE.test(line)) return;
    let end = i + 1;
    while (end < lines.length && RECAP_ENTRY_RE.test(lines[end]!)) end += 1;
    const earlier = new Set(lines.slice(0, i));
    const entries = lines.slice(i + 1, end);
    if (entries.length && entries.every((entry) => earlier.has(entry))) for (let k = i; k < end; k += 1) drop.add(k);
  });
  return drop.size ? lines.filter((_, i) => !drop.has(i)) : lines;
}

function dropEmptyFileHeaders(lines: string[]): string[] {
  return lines.filter((line, i) => {
    if (!FILE_HEADER_RE.test(line)) return true;
    const next = lines[i + 1];
    return next !== undefined && !FILE_HEADER_RE.test(next) && !SECTION_END_RE.test(next);
  });
}

export function bunFrames(lines: string[]): string[] {
  const headed = dropRepeatedRecaps(dropEmptyFileHeaders(lines));
  if (!headed.some((l) => CARET_RE.test(l))) return headed;
  const out: string[] = [];
  for (let i = 0; i < headed.length; i += 1) {
    const line = headed[i]!;
    if (CARET_RE.test(line)) continue;
    if (FRAME_RE.test(line) && !CARET_RE.test(headed[i + 1] ?? "")) continue;
    out.push(line);
  }
  return out;
}

registerTransform("bun-frames", bunFrames);

import { registerTransform } from "./registry";

const FRAME_RE = /^\s*\d+ \| /;
const CARET_RE = /^\s+\^\s*$/;
const FILE_HEADER_RE = /^(?!\s).*[._](?:test|spec)\.[cm]?[jt]sx?:$/;
const SECTION_END_RE = /^\s*\d+ (?:pass|fail|skip|todo)$|^\d+ tests? (?:failed|skipped|todo)|^Ran \d+ tests?/;

function dropEmptyFileHeaders(lines: string[]): string[] {
  return lines.filter((line, i) => {
    if (!FILE_HEADER_RE.test(line)) return true;
    const next = lines[i + 1];
    return next !== undefined && !FILE_HEADER_RE.test(next) && !SECTION_END_RE.test(next);
  });
}

export function bunFrames(lines: string[]): string[] {
  const headed = dropEmptyFileHeaders(lines);
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

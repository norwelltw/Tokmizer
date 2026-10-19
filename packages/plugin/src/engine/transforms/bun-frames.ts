import { registerTransform } from "./registry";
import { FAILURE } from "./fold-passing";

const FRAME_RE = /^\d+ \| /;
const CARET_RE = /^\s+\^\s*$/;
const FAILURE_LIKE = new RegExp(`${FAILURE.source}|\\*\\*\\*|Exception|FAIL|ERROR`);

export function bunFrames(lines: string[]): string[] {
  if (!lines.some((l) => CARET_RE.test(l))) return lines;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (CARET_RE.test(line)) continue;
    if (FRAME_RE.test(line) && !CARET_RE.test(lines[i + 1] ?? "") && !FAILURE_LIKE.test(line)) continue;
    out.push(line);
  }
  return out;
}

registerTransform("bun-frames", bunFrames);

import { registerTransform } from "./registry";
import { FAILURE } from "./fold-passing";

const RESULT_RE = /^\s*\d+\/\d+ Test\s+#\s*\d+: \S+ \.{2,}/;
const SUMMARY_RE = /^\d+% tests passed, \d+ tests? failed out of \d+$/;
const FAILURE_LIKE = new RegExp(`${FAILURE.source}|\\*\\*\\*|Exception|FAIL|ERROR`);
const HEAD_LINES = 3;
const TAIL_LINES = 8;

function squeeze(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let run = 1;
    while (i + run < lines.length && lines[i + run] === lines[i]) run += 1;
    out.push(run > 1 ? `${lines[i]} ×${run}` : lines[i]!);
    i += run - 1;
  }
  return out;
}

function capBlock(block: string[]): string[] {
  if (block.length <= HEAD_LINES + TAIL_LINES + 1) return block;
  const middle = block.slice(HEAD_LINES, -TAIL_LINES);
  const kept = middle.filter((line) => FAILURE_LIKE.test(line));
  const hidden = middle.length - kept.length;
  if (hidden === 0) return block;
  return [...block.slice(0, HEAD_LINES), ...kept, `… ${hidden} more lines omitted`, ...block.slice(-TAIL_LINES)];
}

export function smartCtest(lines: string[]): string[] {
  if (!lines.some((l) => RESULT_RE.test(l))) return lines;
  const out: string[] = [];
  let block: string[] = [];
  const flush = (): void => {
    out.push(...capBlock(squeeze(block)));
    block = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (SUMMARY_RE.test(line)) {
      flush();
      out.push(...lines.slice(i));
      return out;
    }
    if (RESULT_RE.test(line)) {
      flush();
      out.push(line);
      continue;
    }
    block.push(line);
  }
  flush();
  return out;
}

registerTransform("smart-ctest", smartCtest);

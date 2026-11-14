import { registerTransform } from "./registry";
import { FAILURE } from "./fold-passing";

const RESULT_RE = /^\s*\d+\/\d+ Test\s+#\s*\d+: \S+ \.{2,}/;
const RESULT_PARTS_RE = /^\s*\d+\/\d+ Test\s+#\s*(\d+): (\S+) \.{2,}\s*(?:\*{3})?(.*)$/;
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

const LIST_HEAD_RE = /^The following tests (?:FAILED|did not run):$/;
const LIST_ITEM_RE = /^\s*(\d+) - (\S+) \(.+\)$/;
const TOTAL_TIME_RE = /^(Total Test time \(real\) =)\s+/;

function dropListedTwice(tail: string[], shown: Map<string, string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < tail.length; i += 1) {
    const line = tail[i]!;
    if (!LIST_HEAD_RE.test(line)) {
      out.push(line.replace(TOTAL_TIME_RE, "$1 "));
      continue;
    }
    let end = i + 1;
    while (end < tail.length && LIST_ITEM_RE.test(tail[end]!)) end += 1;
    const items = tail.slice(i + 1, end);
    if (items.length === 0 || !items.every((item) => { const m = LIST_ITEM_RE.exec(item)!; return shown.get(m[1]!) === m[2]; })) out.push(...tail.slice(i, end));
    i = end - 1;
  }
  return out;
}

export function compactResult(line: string): string {
  const m = RESULT_PARTS_RE.exec(line);
  if (!m) return line;
  return `#${m[1]} ${m[2]}: ${m[3]!.replace(/\s{2,}/g, " ").trim()}`;
}

export function smartCtest(lines: string[]): string[] {
  if (!lines.some((l) => RESULT_RE.test(l))) return lines;
  const out: string[] = [];
  const shown = new Map<string, string>();
  let block: string[] = [];
  const flush = (): void => {
    out.push(...capBlock(squeeze(block)));
    block = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (SUMMARY_RE.test(line)) {
      flush();
      out.push(...dropListedTwice(lines.slice(i), shown));
      return out;
    }
    if (RESULT_RE.test(line)) {
      flush();
      const parts = RESULT_PARTS_RE.exec(line);
      if (parts) shown.set(parts[1]!, parts[2]!);
      out.push(compactResult(line));
      continue;
    }
    block.push(line);
  }
  flush();
  return out;
}

registerTransform("smart-ctest", smartCtest);

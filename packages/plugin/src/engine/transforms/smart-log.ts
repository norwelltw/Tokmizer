import { registerTransform } from "./registry";

const COMMIT_RE = /^(?:([|\\/ ._-]*\*[|\\/* ._-]* ))?commit [0-9a-f]{7,40}\b/;
const GRAPH_PREFIX_RE = /^[|\\/* ._-]*$/;
const BODY_RE = /^ {4}/;
const KEPT_BODY_LINES = 2;

export function smartLog(lines: string[]): string[] {
  if (!lines.some((l) => COMMIT_RE.test(l))) return lines;
  const out: string[] = [];
  let body = 0;
  let folded = 0;
  let graphWidth = 0;
  let foldedPrefix = "";
  let seenCommit = false;
  let inDiff = false;
  const flush = (): void => {
    if (folded > 0) out.push(`${foldedPrefix}    … ${folded} ${folded === 1 ? "line" : "lines"} folded …`);
    folded = 0;
  };
  for (const line of lines) {
    const prefix = line.slice(0, graphWidth);
    const validPrefix = GRAPH_PREFIX_RE.test(prefix);
    const content = validPrefix ? line.slice(graphWidth) : line;
    const isBody = BODY_RE.test(content);
    const commit = seenCommit && isBody ? null : COMMIT_RE.exec(line);
    if (commit) {
      flush();
      body = 0;
      graphWidth = commit[1]?.length ?? 0;
      seenCommit = true;
      inDiff = false;
      out.push(line);
      continue;
    }
    if (/^diff --(?:git|cc|combined) /.test(content)) inDiff = true;
    if (isBody && !inDiff && !(graphWidth > 0 && content.trim().length === 0)) {
      body += 1;
      if (body <= KEPT_BODY_LINES) out.push(line);
      else {
        folded += 1;
        foldedPrefix = validPrefix ? prefix : "";
      }
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

registerTransform("smart-log", smartLog);

import { registerTransform } from "./registry";

const COMMIT_RE = /^(?:([|\\/ ._-]*\*[|\\/* ._-]* ))?commit [0-9a-f]{7,40}\b/;
const GRAPH_PREFIX_RE = /^[|\\/* ._-]*$/;
const BODY_RE = /^ {4}/;
const TRAILER_RE = /^ {4}(?:Co-[Aa]uthored-[Bb]y|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Reported-by|Fixes|Closes):/;
const KEPT_BODY_LINES = 2;
const KEPT_PLAIN_BODY_LINES = 1;

const PLAIN_COMMIT_RE = /^commit ([0-9a-f]{40})(\s.*)?$/;
const AUTHOR_RE = /^Author:\s+(.+)$/;
const DATE_LINE_RE = /^Date:\s+(?:[A-Z][a-z]{2} )?([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}:\d{2}):\d{2} (\d{4}) ([+-]\d{4})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HASH_CHARS = 12;
const MAX_AUTHOR_LEGEND = 5;

function compactHeaders(lines: string[]): string[] | null {
  const headers: { at: number; hash: string; refs: string; merge: string | null; author: string; date: string; zone: string; end: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const commit = PLAIN_COMMIT_RE.exec(lines[i]!);
    if (!commit) continue;
    let j = i + 1;
    let merge: string | null = null;
    if (lines[j]?.startsWith("Merge: ")) {
      merge = lines[j]!.slice(7);
      j += 1;
    }
    const author = AUTHOR_RE.exec(lines[j] ?? "");
    const date = DATE_LINE_RE.exec(lines[j + 1] ?? "");
    if (!author || !date) return null;
    const month = MONTHS.indexOf(date[1]!) + 1;
    if (month === 0) return null;
    headers.push({
      at: i,
      hash: commit[1]!.slice(0, HASH_CHARS),
      refs: commit[2] ?? "",
      merge,
      author: author[1]!,
      date: `${date[4]}-${String(month).padStart(2, "0")}-${date[2]!.padStart(2, "0")} ${date[3]}`,
      zone: date[5]!,
      end: j + 2
    });
  }
  if (headers.length === 0) return null;
  const authors = [...new Set(headers.map((h) => h.author))];
  const shared = authors.length === 1 && headers.length > 1 ? authors[0]! : null;
  const legend = authors.length > 1 && authors.length <= MAX_AUTHOR_LEGEND && headers.length > authors.length;
  const zone = headers.length > 1 && headers.every((h) => h.zone === headers[0]!.zone) ? headers[0]!.zone : null;
  const out: string[] = shared ? [`author: ${shared}`] : legend ? [`authors: ${authors.map((a, i) => `[${i + 1}] ${a}`).join("; ")}`] : [];
  if (zone) out.push(`dates: UTC${zone}`);
  let next = 0;
  for (const h of headers) {
    out.push(...lines.slice(next, h.at));
    const who = shared ? "" : legend ? ` [${authors.indexOf(h.author) + 1}]` : ` ${h.author}`;
    out.push(`${h.hash} ${h.date}${zone ? "" : ` ${h.zone}`}${who}${h.merge ? ` merge ${h.merge}` : ""}${h.refs}`);
    next = h.end;
  }
  out.push(...lines.slice(next));
  return out;
}

export function smartLog(lines: string[]): string[] {
  if (!lines.some((l) => COMMIT_RE.test(l))) return lines;
  const plain = lines.some((l) => PLAIN_COMMIT_RE.test(l)) && !lines.some((l) => /^[|\\/*]/.test(l));
  const folded = foldBodies(lines, plain ? KEPT_PLAIN_BODY_LINES : KEPT_BODY_LINES);
  return compactHeaders(folded) ?? folded;
}

function foldBodies(lines: string[], kept: number): string[] {
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
      if (TRAILER_RE.test(content)) {
        out.push(line);
        continue;
      }
      body += 1;
      if (body <= kept) out.push(line);
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

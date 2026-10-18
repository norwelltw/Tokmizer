const FUNCTION_RE = /^(\s*)(?:export\s+)?(?:async\s+)?(?:function|interface|type|const|let|var|def|fn|impl|trait|struct|enum)\s+[\w$]+/;
const BRACE_OPEN = /\{\s*$/;
const MAX_FOLD_LINES = 200;

const METHOD_RE = /^\s*(?:(?:public|private|protected|static|async|get|set|readonly|override)\s+)*([\w$]+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{\s*$/;
const NOT_A_METHOD = new Set([
  "if", "for", "while", "switch", "catch", "do", "with", "return", "else", "function", "await", "yield"
]);

function isMethodDecl(line: string): boolean {
  const m = METHOD_RE.exec(line);
  if (!m) return false;
  if (NOT_A_METHOD.has(m[1]!)) return false;
  return !/=>|\bfunction\b/.test(m[2]!);
}

const CONTROL_RE = /^\s*(?:if|for|while|switch|try|do)\b[^{}]*\{\s*$/;

type ScanState = { inBlockComment: boolean; inTemplate: boolean };

function hasClosingQuote(line: string, from: number, q: string): boolean {
  let i = from;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === q) return true;
    i += 1;
  }
  return false;
}

function countDepth(line: string, st: ScanState): number {
  let depth = 0;
  let quote: string | null = null;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (st.inBlockComment) {
      if (c === "*" && line[i + 1] === "/") {
        st.inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (st.inTemplate) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") st.inTemplate = false;
      i += 1;
      continue;
    }
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") break;
    if (c === "/" && line[i + 1] === "*") {
      st.inBlockComment = true;
      i += 2;
      continue;
    }
    if (c === "`") {
      st.inTemplate = true;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const prev = i > 0 ? line[i - 1] : "";
      const lifetimeLike = c === "'" && (prev === "<" || prev === "&");
      if (!lifetimeLike && hasClosingQuote(line, i + 1, c)) {
        quote = c;
      }
      i += 1;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") depth -= 1;
    i += 1;
  }
  return depth;
}

export const FOLD_MARKER_RE = /^\s*… \d+ lines? folded(?: \(\d+-\d+\): Read offset=\d+ limit=\d+ before editing)? …$/;

const FOLD_COUNT_RE = /^\s*… (\d+) lines? folded(?: \(\d+-\d+\): Read offset=\d+ limit=\d+ before editing)? …$/;

function foldMarker(indent: string, inner: number, firstLine: number | null): string {
  const range = firstLine == null
    ? ""
    : ` (${firstLine}-${firstLine + inner - 1}): Read offset=${firstLine} limit=${inner} before editing`;
  return `${indent}… ${inner} ${inner === 1 ? "line" : "lines"} folded${range} …`;
}

export function foldPaddingMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    const m = FOLD_COUNT_RE.exec(lines[i]!);
    if (!m) continue;
    let pad = Number(m[1]) - 1;
    let j = i + 1;
    while (pad > 0 && j < lines.length && lines[j] === "") {
      mask[j] = true;
      pad -= 1;
      j += 1;
    }
    i = j - 1;
  }
  return mask;
}

export function smartCodeCollapse(lines: string[], minimumSpan = 3, numbered = false): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if ((FUNCTION_RE.test(line) && BRACE_OPEN.test(line)) || isMethodDecl(line) || CONTROL_RE.test(line)) {
      const st: ScanState = { inBlockComment: false, inTemplate: false };
      let depth = 0;
      let j = i;
      let closed = false;
      while (j < lines.length && j - i < MAX_FOLD_LINES) {
        depth += countDepth(lines[j]!, st);
        j += 1;
        if (depth <= 0 && !st.inTemplate && !st.inBlockComment) {
          closed = true;
          break;
        }
      }
      const span = j - i;
      if (closed && span < minimumSpan) {
        out.push(...lines.slice(i, j));
        i = j;
        continue;
      }
      if (closed && span >= 3) {
        const inner = span - 2;
        const indent = /^\s*/.exec(lines[i + 1] ?? "")?.[0] ?? "  ";
        out.push(line);
        out.push(foldMarker(indent, inner, numbered ? i + 2 : null));
        for (let k = 0; k < inner - 1; k++) out.push("");
        out.push(lines[j - 1]!);
        i = j;
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return out;
}

const CODE_HINT_RE = /\b(?:function|class|interface|import\s+|export\s+|def\s+|fn\s+|impl\s+|package\s+|namespace\s+|using\s+|#include|=>\s*\{|=\s*function)/;

export function looksLikeCode(text: string): boolean {
  const head = text.slice(0, 4096);
  if (!CODE_HINT_RE.test(head)) return false;
  const lines = head.split("\n");
  if (lines.length < 6) return false;
  return true;
}

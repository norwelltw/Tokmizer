import { looksLikeCode } from "./transforms/smart-code";

const LOG_PREFIX = /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s+)?(?:\[(?:DEBUG|TRACE|INFO|WARN|WARNING|ERROR|FATAL)\]|DEBUG|TRACE|INFO|WARN|WARNING|ERROR|FATAL)(?::|\s|$)/;
const REPEAT_MARKER = /^\[tkr: previous log line repeated \d+ additional times\]$/m;

export function compactRepeatedDiagnostics(text: string): string {
  if (Buffer.byteLength(text) < 2048 || looksLikeCode(text) || REPEAT_MARKER.test(text)) return text;
  const lines = text.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    let end = index + 1;
    if (LOG_PREFIX.test(line)) {
      while (end < lines.length && lines[end] === line) end += 1;
    }
    const count = end - index;
    const marker = `[tkr: previous log line repeated ${count - 1} additional times]`;
    if (count >= 3 && Buffer.byteLength(marker) + 1 < (count - 1) * (Buffer.byteLength(line) + 1)) {
      output.push(line, marker);
    } else {
      for (let cursor = index; cursor < end; cursor += 1) output.push(line);
    }
    index = end;
  }
  return output.join("\n");
}

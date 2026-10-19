import { registerTransform } from "./registry";

const METER_HEADER_RE = /^\s*% Total\s+% Received\s+% Xferd\s+Average Speed/;
const METER_SUBHEADER_RE = /^\s+Dload\s+Upload\s+Total\s+Spent\s+Left\s+Speed/;
// Rows are digits/size units/time fields only, e.g. "100  1256  100  1256    0     0   5321      0 --:--:-- --:--:-- --:--:--  5340"
const METER_ROW_RE = /^\s*\d+\s+[\d.]+[kMGTP]?\s+\d+\s+[\d.]+[kMGTP]?\s+\d+\s+[\d.]+[kMGTP]?\s+[\d.]+[kMGTP]?\s+[\d.]+[kMGTP]?\s+[-\d:]+\s+[-\d:]+\s+[-\d:]+\s+[\d.]+[kMGTP]?\s*$/;
const VERBOSE_MARKER_RE = /^\* (?:Trying |Connected to |Host .* was resolved|Connection #\d+|IPv[46]:|Uses proxy)|^> [A-Z]+ \S+ HTTP\/[\d.]+\s*$|^< HTTP\/[\d.]+ \d{3}/;
const VERBOSE_LINE_RE = /^(?:\* |[<>] (?:[A-Za-z][\w-]*: .*|[A-Z]+ \S+ HTTP\/[\d.]+|HTTP\/[\d.]+ .*)$|[<>]\s?$|[{}] \[\d+ bytes data\])/;

// curl redraws its meter on one line, separating each update with \r.
function isMeterRow(line: string): boolean {
  const parts = line.split("\r").filter((part) => part.trim() !== "");
  return parts.length > 0 && parts.every((part) => METER_ROW_RE.test(part));
}

// curl progress and -v trace go to stderr, so they only show up interleaved
// with the body. Drop only blocks that are unambiguously curl's own output.
export function curlProgress(lines: string[]): string[] {
  const verbose = lines.some((l) => VERBOSE_MARKER_RE.test(l));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (METER_HEADER_RE.test(l)) {
      let j = i + 1;
      if (METER_SUBHEADER_RE.test(lines[j] ?? "")) j += 1;
      while (isMeterRow(lines[j] ?? "")) j += 1;
      i = j - 1;
      continue;
    }
    if (verbose && VERBOSE_LINE_RE.test(l)) continue;
    out.push(l);
  }
  return out;
}

registerTransform("curl-progress", curlProgress);

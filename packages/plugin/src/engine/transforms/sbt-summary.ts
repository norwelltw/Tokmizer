import { registerTransform } from "./registry";

const ALL_PASSED_RE = /^\[info\] Tests: succeeded \d+, failed 0,/;
const FAILED_RE = /\*\*\* .*FAILED|^\[error\]/;
const SUMMARY_RE = /^\[info\] (?:Tests: |No tests|Passed: )/;

export function sbtSummary(lines: string[]): string[] {
  if (!lines.some((l) => ALL_PASSED_RE.test(l)) || lines.some((l) => FAILED_RE.test(l))) return lines;
  return lines.filter((l) => !l.startsWith("[info] ") || SUMMARY_RE.test(l)).map((l) => (l.startsWith("[info] ") ? l.slice(7) : l));
}

registerTransform("sbt-summary", sbtSummary);

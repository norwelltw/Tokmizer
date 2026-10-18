import { stripAnsi } from "./transforms/strip-ansi";

const ERROR_MARKERS = [
  /\bERROR\b/,
  /\bFAIL\b/,
  /\bFAILED\b/,
  /\bFATAL\b/,
  /^Traceback /m,
  /^Error: /m,
  /^\s+at .*\(.*:\d+:\d+\)/m,
  /panic:/,
  /SyntaxError:/,
  /TypeError:/,
  /ReferenceError:/,
  /AssertionError:/,
  /^\s*(?:error|fatal):/i,
  /thread '.*' panicked/,
  /\b[1-9]\d* (?:failed|errors?)\b/
];

export function looksLikeFailure(output: string): boolean {
  if (!output) return false;
  for (const line of stripAnsi(output).split("\n")) {
    if (/^\s*[✓✔√]\s/.test(line)) continue;
    if (ERROR_MARKERS.some((re) => re.test(line))) return true;
  }
  return false;
}

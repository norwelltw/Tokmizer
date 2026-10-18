export const ALLOWED_COMMAND_NAMES: readonly string[] = Object.freeze([
  "power", "tkr-reducer",
  "tkr", "tkr-gain", "tkr-status", "tkr-link", "tkr-unlink",
  "tkr-compression", "tkr-telemetry", "tkr-update", "tkr-yolo"
]);

export const ALLOWED_SKILL_SLUGS: readonly string[] = Object.freeze([
  "power", "reducer-light", "reducer-balanced", "reducer-max"
]);

const UNSAFE_PATTERNS: readonly [RegExp, string][] = [
  [/allowed[-_]tools/i, "allowed-tools"],
  [/^[ \t]*["']?hooks["']?[ \t]*:/im, "hooks"],
  [/!`/, "shell execution"],
  [/^[ \t]*(`{3,}|~{3,})[ \t]*!/m, "shell execution"],
  [/(?<!\w)@[^\s@]/, "file reference"]
];

export function unsafeBundleContent(body: string): string | null {
  for (const [pattern, reason] of UNSAFE_PATTERNS) {
    if (pattern.test(body)) return reason;
  }
  return null;
}

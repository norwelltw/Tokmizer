import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tokmizerHome } from "../paths";

export const FALLBACK_HINT = "tokmizer: shim target missing, running command directly; run `tkr doctor --fix`";

export function shimsDir(): string {
  return join(tokmizerHome(), "shims");
}

export function failOpenFile(): string {
  return join(tokmizerHome(), "fail-open");
}

export const FAIL_OPEN_TTL_MS = 24 * 3600_000;

export function failOpenActive(now: number = Date.now()): boolean {
  try {
    if (now - statSync(failOpenFile()).mtimeMs < FAIL_OPEN_TTL_MS) return true;
    rmSync(failOpenFile(), { force: true });
  } catch {}
  return false;
}

export function failOpenShellTest(): string {
  return `[ -f ${shQuote(failOpenFile())} ]`;
}

export function shimFallbackFile(): string {
  return join(tokmizerHome(), "shim-fallbacks");
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function shUnquote(s: string): string | null {
  if (!s.startsWith("'") || !s.endsWith("'") || s.length < 2) return null;
  const inner = s.slice(1, -1);
  const parts = inner.split("'\\''");
  return parts.some((p) => p.includes("'")) ? null : parts.join("'");
}

export function passthroughLines(indent: string): string[] {
  return [
    "set -f",
    `_tk_d=${shQuote(shimsDir())}`,
    "_tk_o=$IFS; IFS=:; _tk_p=; _tk_x=",
    "for _tk_e in $PATH; do",
    '  [ -n "$_tk_e" ] || continue',
    '  [ "$_tk_e" -ef "$_tk_d" ] && continue',
    "  _tk_p=${_tk_p:+$_tk_p:}$_tk_e",
    '  [ -z "$_tk_x" ] && [ -f "$_tk_e/$_tk_c" ] && [ -x "$_tk_e/$_tk_c" ] && _tk_x=$_tk_e/$_tk_c',
    "done",
    "IFS=$_tk_o; PATH=$_tk_p; export PATH; set +f",
    '[ -n "$_tk_x" ] || { echo "$_tk_c: command not found" >&2; exit 127; }',
    'exec "$_tk_x" "$@"'
  ].map((line) => `${indent}${line}`);
}

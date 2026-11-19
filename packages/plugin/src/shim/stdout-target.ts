import { spawnSync } from "node:child_process";
import { fstatSync, type Stats } from "node:fs";
import { isUtf8 } from "node:buffer";
import { basename } from "node:path";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);
// A pipe, a redirect or a substitution in the script: this command's output may feed a program.
const OUTPUT_ROUTED_RE = /[|<>`]|\$\(/;

/** The `-c` script of a shell, from its `ps` argument line; null when the line is not a shell run with -c. */
export function shellScript(args: string | null): string | null {
  const words = (args ?? "").trim().split(/\s+/);
  if (!SHELLS.has(basename(words[0] ?? "").replace(/^-/, ""))) return null;
  const flag = words.findIndex((word, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
  return flag < 0 ? null : words.slice(flag + 1).join(" ");
}

function parentArgs(): string | null {
  if (process.platform === "win32" || !Number.isInteger(process.ppid) || process.ppid <= 1) return null;
  try {
    const ps = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(process.ppid)], { encoding: "utf8", timeout: 2000 });
    return ps.status === 0 && ps.stdout.trim() ? ps.stdout : null;
  } catch {
    return null;
  }
}

/**
 * True when what a shimmed command prints is not what the agent reads, so it must be written as is:
 * a file, or a pipe inside a shell script that routes output (`git diff > p.patch`, `find | wc -l`,
 * `x=$(git ls-files)`, `curl … | sh`). A shortened text there corrupts the data.
 */
export function stdoutGoesElsewhere(
  host: string,
  isTTY: boolean = Boolean(process.stdout.isTTY),
  stat: (fd: number) => Pick<Stats, "isFile" | "isFIFO"> = fstatSync,
  parent: () => string | null = parentArgs
): boolean {
  if (isTTY) return false;
  if (host === "shell") return true;
  try {
    const out = stat(1);
    if (out.isFile()) return true;
    if (!out.isFIFO()) return false;
  } catch {
    return false;
  }
  const script = shellScript(parent());
  return script !== null && OUTPUT_ROUTED_RE.test(script);
}

/** False for bytes that are not text (a NUL early on, or not valid UTF-8): filtering would rewrite them. */
export function isTextOutput(bytes: Buffer): boolean {
  return !bytes.subarray(0, 8192).includes(0) && isUtf8(bytes);
}

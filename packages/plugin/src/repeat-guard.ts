import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tokmizerHome } from "./paths";
import { redactTarget } from "./session-log";

const MAX_FILE_BYTES = 256 * 1024;
const CMD_MAX = 80;

function seenFile(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.\./g, "-").slice(0, 80) || "default";
  return join(tokmizerHome(), "sessions", `${safe}.seen`);
}

function clean(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ").trim().slice(0, CMD_MAX);
}

export function rememberOutput(
  sessionId: string,
  agentKey: string,
  output: string,
  cmd: string
): { cmd: string } | null {
  try {
    const file = seenFile(sessionId);
    const agent = clean(agentKey);
    const hash = createHash("sha256").update(output).digest("hex").slice(0, 32);
    let existing = "";
    try {
      existing = readFileSync(file, "utf8");
    } catch {}
    for (const line of existing.split("\n")) {
      const [a, h, c] = line.split("\t");
      if (a === agent && h === hash) return { cmd: c ?? "" };
    }
    mkdirSync(join(tokmizerHome(), "sessions"), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${agent}\t${hash}\t${clean(redactTarget(cmd))}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    if (statSync(file).size > MAX_FILE_BYTES) rmSync(file, { force: true });
  } catch {}
  return null;
}

export function forgetSession(sessionId: string): void {
  try {
    rmSync(seenFile(sessionId), { force: true });
  } catch {}
}

export function repeatNotice(earlierCmd: string, bytes: number): string {
  return `[same output as \`${clean(earlierCmd)}\` earlier in this session, unchanged, ~${Math.round(bytes / 4)} tokens]`;
}

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tokmizerHome } from "../paths";

// A file the agent comes back to (a second full read, or a read by line range after an outline)
// is a file it works on: from then on, this session gets it whole instead of paying a restore turn.
const MAX_PATHS = 500;
const RETENTION_MS = 2 * 24 * 3600 * 1000;

function dir(): string {
  return join(tokmizerHome(), "read-memory");
}

function file(sessionId: string): string {
  return join(dir(), `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`);
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 24);
}

function load(sessionId: string): string[] {
  try {
    const list = JSON.parse(readFileSync(file(sessionId), "utf8"));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Notes that this session has read `path`; returns true when it had already read it before. */
export function seenBefore(sessionId: string | undefined, path: string | undefined): boolean {
  if (!sessionId || !path) return false;
  const key = hashPath(path);
  const list = load(sessionId);
  if (list.includes(key)) return true;
  try {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    writeFileSync(file(sessionId), JSON.stringify([...list, key].slice(-MAX_PATHS)), { mode: 0o600 });
    prune();
  } catch {}
  return false;
}

let pruned = false;
function prune(): void {
  if (pruned) return;
  pruned = true;
  try {
    const now = Date.now();
    for (const name of readdirSync(dir())) {
      const p = join(dir(), name);
      if (now - statSync(p).mtimeMs > RETENTION_MS) rmSync(p, { force: true });
    }
  } catch {}
}

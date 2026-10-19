import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  readdirSync,
  rmSync,
  chmodSync
} from "node:fs";
import { join } from "node:path";
import { tokmizerHome } from "./paths";
import { maskSecrets, redactCommand } from "./learn/redact";

export type SessionEvent = { t?: number; tool: string; target: string; fail?: 1 };

const MAX_FILE_BYTES = 96 * 1024;
const KEPT_LINES = 500;
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const TARGET_MAX = 120;

function sessionsDir(): string {
  return join(tokmizerHome(), "sessions");
}

export function sessionFile(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.\./g, "-").slice(0, 80) || "default";
  return join(sessionsDir(), `${safe}.jsonl`);
}

/** Redact secrets (tokens, passwords, bearer headers, attached `-pSECRET`) before truncating, so a cut can't leave a token prefix. */
export function redactTarget(target: string): string {
  const attachedPassword = redactCommand(target).replace(/(^|\s)(-p)(?=\S)\S+/g, "$1$2[REDACTED]");
  return maskSecrets(attachedPassword).slice(0, TARGET_MAX);
}

export function recordSessionEvent(sessionId: string, ev: SessionEvent): void {
  try {
    const file = sessionFile(sessionId);
    mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      t: ev.t ?? Math.floor(Date.now() / 1000),
      tool: ev.tool,
      target: redactTarget(ev.target),
      ...(ev.fail ? { fail: 1 } : {})
    });
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    if (statSync(file).size > MAX_FILE_BYTES) {
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
      const kept = lines.slice(lines.length - KEPT_LINES);
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${kept.join("\n")}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    }
  } catch {}
}

export function readSessionEvents(sessionId: string): SessionEvent[] {
  try {
    const raw = readFileSync(sessionFile(sessionId), "utf8");
    const out: SessionEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as SessionEvent;
        if (typeof ev.tool === "string" && typeof ev.target === "string") out.push(ev);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export function pruneSessions(): void {
  try {
    const dir = sessionsDir();
    const now = Date.now();
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      try {
        if (now - statSync(path).mtimeMs > RETENTION_MS) rmSync(path, { force: true });
      } catch {}
    }
  } catch {}
}

export function buildSessionRecap(events: SessionEvent[]): string {
  if (events.length === 0) return "";

  const fileCounts = new Map<string, number>();
  const searches: string[] = [];
  const commands: { target: string; fail: boolean }[] = [];

  for (const ev of events) {
    if (ev.tool === "Read") {
      fileCounts.set(ev.target, (fileCounts.get(ev.target) ?? 0) + 1);
    } else if (ev.tool === "Grep" || ev.tool === "Glob") {
      if (!searches.includes(ev.target)) searches.push(ev.target);
    } else if (ev.tool === "Bash") {
      commands.push({ target: ev.target, fail: ev.fail === 1 });
    }
  }

  const lines: string[] = ["Tokmizer session recap (this session before context trimming):"];

  const files = [...fileCounts.entries()].slice(-12);
  if (files.length > 0) {
    lines.push("Files read:");
    for (const [path, n] of files) {
      lines.push(n > 1 ? `  ${path} ×${n}` : `  ${path}`);
    }
  }

  if (searches.length > 0) {
    lines.push(`Searches: ${searches.slice(-5).join(", ")}`);
  }

  const seen = new Set<string>();
  const recent: { target: string; fail: boolean }[] = [];
  for (let i = commands.length - 1; i >= 0 && recent.length < 8; i--) {
    const c = commands[i]!;
    if (seen.has(c.target)) continue;
    seen.add(c.target);
    recent.unshift(c);
  }
  if (recent.length > 0) {
    lines.push("Recent commands:");
    for (const c of recent) {
      lines.push(c.fail ? `  ${c.target} ✗ failed` : `  ${c.target}`);
    }
  }

  lines.push("Originals of trimmed outputs stay recoverable: tkr restore <hash>.");
  return lines.slice(0, 30).join("\n");
}

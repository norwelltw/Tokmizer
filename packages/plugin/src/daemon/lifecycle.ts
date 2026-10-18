import os from "node:os";
import { join } from "node:path";
import { existsSync, statSync, lstatSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tokmizerHome } from "../paths";

export type SocketPath = { path: string; isPipe: boolean };

const MAX_SUN_PATH = 100;

function shortSocketPath(uid: number): string {
  const tag = createHash("sha256").update(tokmizerHome()).digest("hex").slice(0, 8);
  const dir = join(os.tmpdir(), `tkr-${uid}-${tag}`);
  const path = join(dir, "d.sock");
  if (Buffer.byteLength(path) > MAX_SUN_PATH) throw new Error("Temporary directory path is too long for IPC");
  ensurePrivateDirectory(dir, uid);
  return path;
}

function isPrivateDirectory(path: string, uid: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(path: string, uid: number): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== uid) throw new Error("Unsafe IPC directory");
  chmodSync(path, 0o700);
}

export function socketPath(): SocketPath {
  if (process.platform === "win32") {
    const user = process.env.USERNAME ?? "tokmizer";
    return { path: `\\\\.\\pipe\\tokmizer-${user}`, isPipe: true };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && isPrivateDirectory(xdg, uid)) {
    const p = join(xdg, `tokmizer-${uid}.sock`);
    if (Buffer.byteLength(p) <= MAX_SUN_PATH) return { path: p, isPipe: false };
  }
  const runDir = join(tokmizerHome(), "run");
  const runPath = join(runDir, "daemon.sock");
  if (Buffer.byteLength(runPath) > MAX_SUN_PATH) {
    return { path: shortSocketPath(uid), isPipe: false };
  }
  ensurePrivateDirectory(runDir, uid);
  return { path: runPath, isPipe: false };
}

export async function cleanupStaleSocket(): Promise<void> {
  const { path, isPipe } = socketPath();
  if (isPipe) return;
  if (!existsSync(path)) return;
  try {
    const stat = statSync(path);
    if (!stat.isSocket()) return;
  } catch {
    return;
  }
  const net = await import("node:net");
  const alive = await new Promise<boolean>((resolve) => {
    const sock = net.createConnection(path);
    const done = (v: boolean): void => {
      sock.removeAllListeners();
      try {
        sock.destroy();
      } catch {}
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      done(code !== "ECONNREFUSED" && code !== "ENOENT");
    });
    setTimeout(() => done(true), 250);
  });
  if (!alive) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

export const PARENT_WATCH_INTERVAL_MS = 30_000;
export const IDLE_TIMEOUT_MS = 5 * 60_000;

export function isParentAlive(): boolean {
  const ppid = process.ppid;
  if (!ppid || ppid === 1) return false;
  try {
    process.kill(ppid, 0);
    return true;
  } catch {
    return false;
  }
}

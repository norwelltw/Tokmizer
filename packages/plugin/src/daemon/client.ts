import { createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import {
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  rmSync,
  statSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReqMessage,
  FilterResData,
  encodeFrame,
  decodeFrames,
  FRAME_DELIM,
  nextRequestId,
  type ResMessage
} from "./protocol";
import { socketPath, cleanupStaleSocket } from "./lifecycle";
import { tokmizerHome } from "../paths";
import { selfInvocation, singleBinary } from "../self-command";
import { ensureInstallId } from "../fingerprint";
import { PLUGIN_VERSION, isOlderVersion } from "../version";
import type { FilterDef } from "../engine/schema";

const CONNECT_TIMEOUT_MS = 500;
const REQUEST_TIMEOUT_MS = 3000;
const MAX_SPAWN_ATTEMPTS = 1;
const SPAWN_FAIL_COOLDOWN_MS = 60_000;
const DAEMON_LOG_MAX_BYTES = 256 * 1024;

function spawnFailFile(): string {
  return join(tokmizerHome(), "daemon.spawn.fail");
}

function daemonLogFile(): string {
  return join(tokmizerHome(), "daemon.log");
}

function spawnRecentlyFailed(): boolean {
  try {
    const at = Number(readFileSync(spawnFailFile(), "utf8"));
    return Number.isFinite(at) && Date.now() - at < SPAWN_FAIL_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function logDaemon(message: string): void {
  try {
    mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
    const file = daemonLogFile();
    try {
      if (statSync(file).size > DAEMON_LOG_MAX_BYTES) unlinkSync(file);
    } catch {}
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {}
}

function noteSpawnFailure(err: unknown): void {
  try {
    mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
    writeFileSync(spawnFailFile(), String(Date.now()), { mode: 0o600 });
  } catch {}
  logDaemon(`spawn failed: ${(err as Error).message}`);
}

function clearSpawnFailure(): void {
  try {
    rmSync(spawnFailFile(), { force: true });
  } catch {}
}

export type DaemonClient = {
  filter: (
    cmd: string,
    plan: "trial" | "smart" | "pro",
    allowed?: string[]
  ) => Promise<FilterDef | null>;
  ping: () => Promise<{ pid: number; uptimeMs: number; ruleCount: number; bundleVersion: number; version?: string }>;
  reload: () => Promise<{ ruleCount: number; bundleVersion: number }>;
  close: () => void;
};

async function connectOnce(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const sock = createConnection(path);
    const done = (err: Error | null): void => {
      sock.removeAllListeners("connect");
      sock.removeAllListeners("error");
      clearTimeout(timer);
      if (err) {
        try {
          sock.destroy();
        } catch {}
        reject(err);
      } else {
        resolve(sock);
      }
    };
    const timer = setTimeout(() => done(new Error("connect timeout")), timeoutMs);
    sock.once("connect", () => done(null));
    sock.once("error", (err) => done(err));
  });
}

function resolveDaemonBin(): string {
  if (process.env.TOKMIZER_DAEMON_BIN) return process.env.TOKMIZER_DAEMON_BIN;
  return fileURLToPath(new URL("../bin/tkr-daemon.js", import.meta.url));
}

async function waitForSocket(path: string, timeoutMs = 3000): Promise<boolean> {
  const steps = Math.ceil(timeoutMs / 75);
  // Windows named pipes (\\.\pipe\...) are not filesystem entries, so
  // existsSync never sees them and the daemon would look like it never bound.
  // Probe readiness by attempting a connection instead; on Unix keep the
  // cheap existsSync check on the .sock file.
  const probeByConnect = process.platform === "win32";
  for (let i = 0; i < steps; i++) {
    if (probeByConnect) {
      try {
        const sock = await connectOnce(path, 75);
        sock.destroy();
        return true;
      } catch {
        // pipe not listening yet — keep polling
      }
    } else if (existsSync(path)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 75));
  }
  return false;
}

export function spawnLockAbandoned(lockPath: string, now: number = Date.now()): boolean {
  try {
    const age = now - statSync(lockPath).mtimeMs;
    if (age > 10_000) return true;
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

async function spawnDaemon(installId: string): Promise<void> {
  const bin = resolveDaemonBin();
  if (!singleBinary() && !existsSync(bin)) {
    throw new Error(`tkr-daemon binary not found at ${bin}`);
  }
  const { path: sockPath } = socketPath();

  // On Windows the socket is a named pipe (\\.\pipe\...) whose dirname() points
  // into the pipe namespace, not a real directory — a lock file cannot be
  // created there (ENOENT). Use the real home dir for the spawn lock on Windows.
  const lockDir = process.platform === "win32" ? tokmizerHome() : dirname(sockPath);
  try {
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  } catch {}
  const lockPath = join(lockDir, "daemon.spawn.lock");
  let lockFd: number | null = null;
  try {
    lockFd = openSync(lockPath, "wx");
    writeFileSync(lockFd, String(process.pid));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const ok = !spawnLockAbandoned(lockPath) && (await waitForSocket(sockPath, 5000));
      if (ok) return;
      try {
        unlinkSync(lockPath);
      } catch {}
      try {
        lockFd = openSync(lockPath, "wx");
        writeFileSync(lockFd, String(process.pid));
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code === "EEXIST") {
          await waitForSocket(sockPath, 5000);
          return;
        }
        throw err2;
      }
    } else {
      throw err;
    }
  }

  try {
    let errFd: number | null = null;
    try {
      errFd = openSync(daemonLogFile(), "a", 0o600);
    } catch {}
    const [command, ...args] = selfInvocation(bin);
    const child = spawn(command!, args, {
      detached: true,
      stdio: ["ignore", "ignore", errFd ?? "ignore"],
      env: { ...process.env, TOKMIZER_DAEMON_INSTALL_ID: installId }
    });
    child.unref();
    if (errFd !== null) {
      try {
        closeSync(errFd);
      } catch {}
    }
    const bound = await waitForSocket(sockPath, 3000);
    if (!bound) {
      throw new Error("tkr-daemon failed to bind socket within 3s");
    }
  } finally {
    if (lockFd !== null) {
      try {
        closeSync(lockFd);
      } catch {}
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}

type Pending = {
  resolve: (res: ResMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export async function shutdownDaemon(opts: { socketPath?: string } = {}): Promise<boolean> {
  const { path } = opts.socketPath ? { path: opts.socketPath } : socketPath();
  const installId = await ensureInstallId();
  try {
    const sock = await connectOnce(path, CONNECT_TIMEOUT_MS);
    sock.write(encodeFrame({ id: nextRequestId(), op: "shutdown", installId }));
    await new Promise((r) => setTimeout(r, 150));
    try {
      sock.destroy();
    } catch {}
    return true;
  } catch {
    return false;
  }
}

async function waitForSocketDeath(path: string, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const probe = await connectOnce(path, 250);
      probe.destroy();
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export async function connectDaemon(opts: { socketPath?: string; skipVersionCheck?: boolean } = {}): Promise<DaemonClient> {
  const { path } = opts.socketPath ? { path: opts.socketPath } : socketPath();
  const installId = await ensureInstallId();

  let sock: Socket | null = null;
  let attempts = 0;
  let spawnedFresh = false;
  while (attempts <= MAX_SPAWN_ATTEMPTS) {
    try {
      sock = await connectOnce(path, CONNECT_TIMEOUT_MS);
      clearSpawnFailure();
      break;
    } catch {
      attempts += 1;
      if (attempts > MAX_SPAWN_ATTEMPTS) {
        throw new Error(`tkr-daemon unreachable at ${path}`);
      }
      if (spawnRecentlyFailed()) {
        throw new Error(`tkr-daemon spawn on cooldown (see ${daemonLogFile()})`);
      }
      await cleanupStaleSocket();
      try {
        await spawnDaemon(installId);
        spawnedFresh = true;
      } catch (err) {
        noteSpawnFailure(err);
        throw err;
      }
    }
  }

  if (!sock) throw new Error("tkr-daemon: socket setup failed");

  const pending = new Map<string, Pending>();
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let lastIdx = -1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === FRAME_DELIM) lastIdx = i;
    }
    if (lastIdx < 0) return;
    const frames: string[] = [];
    for (const f of decodeFrames(buf.slice(0, lastIdx + 1))) frames.push(f);
    buf = buf.slice(lastIdx + 1);
    for (const frame of frames) {
      if (!frame) continue;
      try {
        const res = JSON.parse(frame) as ResMessage;
        const p = pending.get(res.id);
        if (!p) continue;
        clearTimeout(p.timer);
        pending.delete(res.id);
        p.resolve(res);
      } catch {}
    }
  });
  sock.on("close", () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("daemon socket closed"));
    }
    pending.clear();
  });
  sock.on("error", () => {});

  function send(msg: ReqMessage): Promise<ResMessage> {
    return new Promise<ResMessage>((resolve, reject) => {
      if (sock!.destroyed || !sock!.writable) {
        reject(new Error("daemon socket closed"));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(msg.id);
        reject(new Error(`daemon request timeout (${msg.op})`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(msg.id, { resolve, reject, timer });
      sock!.write(encodeFrame(msg));
    });
  }

  const client: DaemonClient = {
    filter: async (cmd, plan, allowed) => {
      const res = await send({
        id: nextRequestId(),
        op: "filter",
        cmd: cmd.slice(0, 2048),
        plan,
        ...(allowed && allowed.length > 0 ? { allowed: allowed.slice(0, 512) } : {}),
        installId
      });
      if (!res.ok) throw new Error(res.err);
      const parsed = FilterResData.safeParse(res.data);
      if (!parsed.success) return null;
      return parsed.data.filter;
    },
    ping: async () => {
      const res = await send({ id: nextRequestId(), op: "ping" });
      if (!res.ok) throw new Error(res.err);
      return res.data as { pid: number; uptimeMs: number; ruleCount: number; bundleVersion: number; version?: string };
    },
    reload: async () => {
      const res = await send({ id: nextRequestId(), op: "reload", installId });
      if (!res.ok) throw new Error(res.err);
      return res.data as { ruleCount: number; bundleVersion: number };
    },
    close: () => {
      try {
        sock!.destroy();
      } catch {}
    }
  };

  if (!opts.skipVersionCheck && !spawnedFresh) {
    let stale = false;
    try {
      const info = await client.ping();
      if (info.version && isOlderVersion(PLUGIN_VERSION, info.version)) {
        throw new Error(`newer daemon ${info.version} already running`);
      }
      stale = info.version !== PLUGIN_VERSION;
    } catch (err) {
      client.close();
      throw err;
    }
    if (stale) {
      try {
        await shutdownDaemon(opts.socketPath ? { socketPath: opts.socketPath } : {});
      } catch {}
      client.close();
      const died = await waitForSocketDeath(path, 2000);
      await cleanupStaleSocket();
      if (!died) throw new Error("stale daemon still running after shutdown request");
      return connectDaemon({ ...opts, skipVersionCheck: true });
    }
  }

  return client;
}

import { createServer, Socket, type Server } from "node:net";
import { chmodSync } from "node:fs";
import {
  ReqMessage,
  encodeFrame,
  decodeFrames,
  FRAME_DELIM,
  MAX_FRAME_BYTES,
  type ResMessage
} from "./protocol";
import {
  socketPath,
  cleanupStaleSocket,
  isParentAlive,
  PARENT_WATCH_INTERVAL_MS,
  IDLE_TIMEOUT_MS
} from "./lifecycle";
import { bundleExpired, type DaemonRuntime } from "./runtime";
import { PLUGIN_VERSION } from "../version";

export type DaemonHandle = {
  server: Server;
  close: () => Promise<void>;
  touch: () => void;
};

const FIRST_WARM_WAIT_MS = 300;

export async function startServer(
  runtime: DaemonRuntime | null,
  opts: {
    socketPath?: string;
    onShutdown?: () => void;
    onWarming?: () => Promise<DaemonRuntime>;
    idleTimeoutMs?: number;
    isActive?: () => boolean;
  } = {}
): Promise<DaemonHandle> {
  await cleanupStaleSocket();
  const { path, isPipe } = opts.socketPath
    ? { path: opts.socketPath, isPipe: process.platform === "win32" }
    : socketPath();

  let current: DaemonRuntime | null = runtime;
  let warmingPromise: Promise<DaemonRuntime> | null = null;

  let lastActivity = Date.now();
  const idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const installIdAuth = process.env.TOKMIZER_DAEMON_INSTALL_ID ?? "";

  const handleMessage = async (raw: ReqMessage): Promise<ResMessage> => {
    lastActivity = Date.now();
    if (raw.op === "ping") {
      return {
        id: raw.id,
        ok: true,
        data: {
          pid: process.pid,
          uptimeMs: current ? Date.now() - current.startedAt : 0,
          ruleCount: current?.ruleCount ?? 0,
          bundleVersion: current?.bundleVersion ?? 0,
          version: PLUGIN_VERSION
        }
      };
    }
    if (raw.op === "shutdown") {
      if (!installIdAuth || raw.installId !== installIdAuth) {
        return { id: raw.id, ok: false, err: "forbidden" };
      }
      setTimeout(() => opts.onShutdown?.(), 10);
      return { id: raw.id, ok: true, data: { stopping: true } };
    }
    if (raw.op === "reload") {
      if (!installIdAuth || raw.installId !== installIdAuth) {
        return { id: raw.id, ok: false, err: "forbidden" };
      }
      if (!opts.onWarming) {
        return { id: raw.id, ok: false, err: "no_warming_handler" };
      }
      try {
        current = await opts.onWarming();
        return {
          id: raw.id,
          ok: true,
          data: { ruleCount: current.ruleCount, bundleVersion: current.bundleVersion }
        };
      } catch (err) {
        return {
          id: raw.id,
          ok: false,
          err: (err as Error).message,
          retryAfterMs: 1000
        };
      }
    }
    if (raw.op === "filter") {
      if (installIdAuth && raw.installId !== installIdAuth) {
        return { id: raw.id, ok: false, err: "forbidden" };
      }
      if (current && bundleExpired(current)) {
        if (opts.onWarming) {
          if (!warmingPromise) {
            warmingPromise = opts.onWarming();
            warmingPromise
              .then((next) => {
                current = next;
              })
              .catch(() => {})
              .finally(() => {
                warmingPromise = null;
              });
          }
        } else {
          return { id: raw.id, ok: true, data: { filter: null, cacheHit: true } };
        }
      }
      if (!current) {
        if (opts.onWarming) {
          if (!warmingPromise) {
            const started = opts.onWarming();
            warmingPromise = started;
            started
              .then((next) => {
                current = next;
              })
              .catch(() => {})
              .finally(() => {
                if (warmingPromise === started) warmingPromise = null;
              });
          }
          const ready = await Promise.race([
            warmingPromise.catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
            new Promise<null>((resolve) => setTimeout(resolve, FIRST_WARM_WAIT_MS, null).unref?.())
          ]);
          if (ready === null) return { id: raw.id, ok: false, err: "warming", retryAfterMs: 250 };
          if (ready instanceof Error) {
            return {
              id: raw.id,
              ok: false,
              err: ready.message,
              retryAfterMs: 1000
            };
          }
          current = ready;
        } else {
          return { id: raw.id, ok: false, err: "warming", retryAfterMs: 250 };
        }
      }
      const filter = current.selectFor(raw.cmd, raw.plan, raw.allowed);
      return {
        id: raw.id,
        ok: true,
        data: { filter: filter ?? null, cacheHit: true }
      };
    }
    return { id: (raw as { id: string }).id, ok: false, err: "unknown_op" };
  };

  const server = createServer((sock: Socket) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (Buffer.byteLength(buf, "utf8") > MAX_FRAME_BYTES) {
        sock.write(
          encodeFrame({
            id: "?",
            ok: false,
            err: "frame_too_large"
          })
        );
        buf = "";
        return;
      }
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
        let rawId = "?";
        try {
          const parsed = JSON.parse(frame) as { id?: unknown };
          if (typeof parsed.id === "string" && parsed.id.length <= 64) rawId = parsed.id;
          const req = ReqMessage.parse(parsed);
          handleMessage(req)
            .then((res) => {
              sock.write(encodeFrame(res));
            })
            .catch((err: unknown) => {
              sock.write(
                encodeFrame({
                  id: req.id,
                  ok: false,
                  err: `internal:${(err as Error).message?.slice(0, 80) ?? "error"}`
                })
              );
            });
        } catch (err) {
          sock.write(
            encodeFrame({
              id: rawId,
              ok: false,
              err: `bad_request:${(err as Error).message.slice(0, 80)}`
            })
          );
        }
      }
    });
    sock.on("error", () => {
      try {
        sock.destroy();
      } catch {}
    });
  });

  let shuttingDown = false;
  const watcher = setInterval(() => {
    if (shuttingDown) return;
    if (opts.isActive?.()) {
      lastActivity = Date.now();
      return;
    }
    const idle = Date.now() - lastActivity;
    if ((!isParentAlive() && idle > idleTimeoutMs) || idle > idleTimeoutMs * 2) {
      shuttingDown = true;
      opts.onShutdown?.();
    }
  }, PARENT_WATCH_INTERVAL_MS);
  watcher.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      if (!isPipe) {
        try {
          chmodSync(path, 0o600);
        } catch {}
      }
      resolve();
    });
  });

  const close = async (): Promise<void> => {
    clearInterval(watcher);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, close, touch: () => { lastActivity = Date.now(); } };
}

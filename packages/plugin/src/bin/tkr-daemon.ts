#!/usr/bin/env node
import { startServer } from "../daemon/server";
import { fetchBundle, healOn401, runtimeFromCache, type DaemonRuntime } from "../daemon/runtime";
import { withBackoff } from "../daemon/fetch-with-backoff";
import { baseUrlFromEnv, heartbeat, jwtExpired } from "../license";
import { loadState } from "../state";
import { createSpoolSync } from "../daemon/spool-sync";
import { startProcessingEndpoint } from "../exec/processing-endpoint";
import { defaultRulesRuntime } from "../default-rules";
import { networkEnabled, NetworkDisabledError } from "../network";

const BASE_URL = baseUrlFromEnv();

const AUTO_HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SPOOL_UPLOAD_INTERVAL_MS = 60_000;

function startSpoolUpload(): void {
  const sync = createSpoolSync(BASE_URL);
  const run = (): void => {
    sync().catch(() => {});
  };
  const initial = setTimeout(run, 5_000);
  initial.unref?.();
  const loop = setInterval(run, SPOOL_UPLOAD_INTERVAL_MS);
  loop.unref?.();
}

function startAutoHeartbeat(): void {
  const run = (): void => {
    heartbeat(BASE_URL).catch(() => {});
  };
  const initial = setTimeout(run, 60_000 + Math.floor(Math.random() * 60_000));
  initial.unref?.();
  const loop = setInterval(run, AUTO_HEARTBEAT_INTERVAL_MS);
  loop.unref?.();
}

function refuseInspect(): void {
  if (process.env.TOKMIZER_ALLOW_INSPECT === "1") return;
  const argv = process.execArgv ?? [];
  const inspectArg = argv.find(
    (a) => a.startsWith("--inspect") || a === "--inspect-brk" || a.startsWith("--inspect-port")
  );
  if (inspectArg) {
    process.stderr.write(
      "tkr-daemon: refusing to start with " +
        inspectArg +
        " (set TOKMIZER_ALLOW_INSPECT=1 to override for development).\n"
    );
    process.exit(2);
  }
  if (process.env.NODE_OPTIONS && /--inspect/.test(process.env.NODE_OPTIONS)) {
    process.stderr.write(
      "tkr-daemon: refusing to start with --inspect in NODE_OPTIONS.\n"
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  refuseInspect();
  process.title = "tkr-daemon";

  const fetchWithCooldown = withBackoff(() => fetchBundle(BASE_URL));
  const localRuntime = async (err: unknown, reason: string): Promise<Awaited<ReturnType<typeof fetchBundle>>> => {
    const cached = await runtimeFromCache();
    if (cached) {
      process.stderr.write(`tkr-daemon: serving cached rules ${reason}\n`);
      return cached;
    }
    const builtin = defaultRulesRuntime();
    if (builtin) {
      process.stderr.write(`tkr-daemon: serving built-in rules ${reason}\n`);
      return builtin;
    }
    throw err;
  };
  const fetchOrHeal = async (): Promise<Awaited<ReturnType<typeof fetchBundle>>> => {
    if (!networkEnabled()) return localRuntime(new NetworkDisabledError(), "because network is off");
    try {
      return await fetchWithCooldown();
    } catch (err) {
      const healed = await healOn401(err, BASE_URL, {
        heartbeat,
        fetchBundle,
        log: (message) => process.stderr.write(`tkr-daemon: ${message}\n`)
      });
      if (healed) return healed;
      return localRuntime(err, "while the server is unreachable");
    }
  };

  const WARM_MEMO_MS = 30_000;
  let processingRuntime: DaemonRuntime | null = null;
  let warmMemo: { p: Promise<Awaited<ReturnType<typeof fetchBundle>>>; at: number } | null = null;
  const onWarming = (): Promise<Awaited<ReturnType<typeof fetchBundle>>> => {
    if (warmMemo && Date.now() - warmMemo.at < WARM_MEMO_MS) return warmMemo.p;
    const p = fetchOrHeal().then((runtime) => {
      processingRuntime = runtime;
      return runtime;
    });
    warmMemo = { p, at: Date.now() };
    p.catch(() => {
      if (warmMemo?.p === p) warmMemo = null;
    });
    return p;
  };

  let handle: Awaited<ReturnType<typeof startServer>> | null = null;
  let processing: Awaited<ReturnType<typeof startProcessingEndpoint>> = null;
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    Promise.allSettled([processing?.close(), handle?.close()]).finally(() => process.exit(0));
  };
  handle = await startServer(null, {
    onWarming,
    isActive: () => (processing?.activeConnections() ?? 0) > 0,
    onShutdown: shutdown
  });

  try {
    processing = await startProcessingEndpoint(() => processingRuntime, handle.touch);
  } catch {
    process.stderr.write("tkr-daemon: native processing unavailable\n");
  }
  void runtimeFromCache().then((runtime) => {
    if (!processingRuntime) processingRuntime = runtime ?? defaultRulesRuntime();
  }).catch(() => {});

  void (async () => {
    try {
      const state = await loadState();
      if (state && jwtExpired(state.jwt, 60_000)) {
        await heartbeat(BASE_URL);
      }
    } catch {}
    try {
      await onWarming();
    } catch {}
  })();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  startAutoHeartbeat();
  startSpoolUpload();
}

main().catch((err) => {
  process.stderr.write(`tkr-daemon: ${(err as Error).message}\n`);
  process.exit(1);
});

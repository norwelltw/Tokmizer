#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeFromCache, type DaemonRuntime } from "../daemon/runtime";
import { processOutput } from "../engine";
import { defaultRulesRuntime } from "../default-rules";
import { processorDescriptorName, startProcessingEndpoint } from "../exec/processing-endpoint";
import { processorRuntime } from "../exec/processor-runtime";
import { tokmizerHome } from "../paths";
import { PLUGIN_VERSION } from "../version";

const RELOAD_INTERVAL_MS = 60_000;
const BUILTIN_RECHECK_MS = 5_000;
const DEFAULT_IDLE_MS = 30 * 60_000;

function idleLimitMs(): number {
  const value = Number(process.env.TOKMIZER_PROCESSOR_IDLE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_IDLE_MS;
}

async function warmUp(runtime: DaemonRuntime | null): Promise<void> {
  if (!runtime) return;
  const sample = Array.from({ length: 200 }, (_, i) => `-rw-r--r--  1 user  staff  ${i * 97} Jan  1 00:00 file-${i}.txt`).join("\n");
  const resolver = async (cmd: string, allowed: Set<string> | null) => runtime.selectFor(cmd, "pro", allowed ? [...allowed] : undefined);
  for (const cmd of ["ls -la", "git status", "grep -rn x ."]) {
    await processOutput(cmd, sample, null, { resolver }).catch(() => null);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(path, "utf8"));
      } catch {}
      if (Number.isInteger(owner) && owner > 0 && alive(owner)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

function ownedBy(path: string, read: (contents: string) => boolean): boolean {
  try {
    return read(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const run = join(realpathSync(tokmizerHome()), "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const lock = join(run, `processor-${PLUGIN_VERSION}.pid`);
  if (!acquireLock(lock)) return;

  const rules = processorRuntime(runtimeFromCache, defaultRulesRuntime, BUILTIN_RECHECK_MS);

  let lastActivity = Date.now();
  const touch = (): void => {
    lastActivity = Date.now();
  };
  const descriptor = join(run, processorDescriptorName());
  let socketPath: string | null = null;
  let server: Awaited<ReturnType<typeof startProcessingEndpoint>> = null;
  let stopping = false;

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void (server?.close() ?? Promise.resolve()).finally(() => {
      if (socketPath && ownedBy(descriptor, (text) => JSON.parse(text).path === socketPath)) {
        rmSync(descriptor, { force: true });
      }
      if (ownedBy(lock, (text) => Number(text) === process.pid)) rmSync(lock, { force: true });
      process.exit(0);
    });
  };

  await rules.reload();
  try {
    server = await startProcessingEndpoint(rules.current, touch, processorDescriptorName());
  } catch {
    rmSync(lock, { force: true });
    return;
  }
  socketPath = ownedBy(descriptor, () => true) ? (JSON.parse(readFileSync(descriptor, "utf8")) as { path: string }).path : null;

  const reloadTimer = setInterval(() => void rules.reload(), RELOAD_INTERVAL_MS);
  reloadTimer.unref();
  const idleTimer = setInterval(() => {
    if ((server?.activeConnections() ?? 0) === 0 && Date.now() - lastActivity > idleLimitMs()) shutdown();
  }, Math.min(60_000, idleLimitMs()));
  idleTimer.unref();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  setImmediate(() => void warmUp(rules.current()));
  setTimeout(() => {
    process.title = "tkr-processor";
  }, 1000).unref();
}

main().catch(() => process.exit(0));

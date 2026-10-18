import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProcessingServer } from "../exec/processing-server";
import { startProcessingEndpoint } from "../exec/processing-endpoint";
import { Settings } from "../contracts";
import { FrameReader, encodeProcessingFrame } from "../exec/processing-protocol";

vi.mock("../state", () => ({ loadState: vi.fn().mockResolvedValue({ token: "fixture", plan: "pro", allowedFilters: [] }) }));
vi.mock("../settings-cache", () => ({ loadSettingsCache: vi.fn(async () => Settings.parse({ telemetryOptIn: false })) }));
vi.mock("../learn/recorder", () => ({ recordEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../learn/telemetry", () => ({ recordTelemetry: vi.fn().mockResolvedValue(undefined) }));

const binary = process.env.TOKMIZER_NATIVE_TEST_BIN;
let home: string;
let server: Awaited<ReturnType<typeof startProcessingServer>> | undefined;
let env: NodeJS.ProcessEnv;
let endpointPath: string;
const children: ReturnType<typeof spawn>[] = [];

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tkr-native-")));
  vi.stubEnv("TOKMIZER_HOME", home);
  server = (await startProcessingEndpoint(() => ({
    signedAt: Date.now(), fetchedAt: Date.now(), startedAt: Date.now(), bundleVersion: 1, ruleCount: 1, selectFor: () => null
  })))!;
  endpointPath = JSON.parse(readFileSync(join(home, "run", "processing.json"), "utf8")).path;
  const fallback = join(home, "fallback.cjs");
  writeFileSync(fallback, `const fs=require('node:fs');const cp=require('node:child_process');fs.appendFileSync(${JSON.stringify(join(home, "fallback-count"))},'1');const r=cp.spawnSync(process.argv[2],process.argv.slice(3),{stdio:'inherit'});process.exit(r.status??127);`);
  env = { ...process.env, TOKMIZER_HOME: home, TOKMIZER_EXEC_JS: fallback, TOKMIZER_PROCESSOR_JS: join(home, "no-processor.js"), TOKMIZER_NODE_BIN: process.execPath, PATH: "/usr/local/bin:/usr/bin:/bin" };
  for (const key of ["TOKMIZER_DEV", "TOKMIZER_FILTERS_DIR", "TOKMIZER_BASE_URL", "TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM", "TOKMIZER_MAX_BUNDLE_AGE_MS", "TOKMIZER_EXEC_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"]) delete env[key];
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await server?.close();
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function launch(args: string[], overrides: NodeJS.ProcessEnv = {}, input?: string) {
  const child = spawn(binary!, args, { env: { ...env, ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  const result = new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), code }));
  });
  child.stdin.end(input);
  return { child, result };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("child readiness timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe.skipIf(process.platform === "win32" || !binary)("native launcher real processes", () => {
  it("uses authenticated processing and preserves streams, arguments and failure status", async () => {
    const result = await launch(["/bin/sh", "-c", "printf '%s' \"$1\"; printf 'diagnostic' >&2; exit 7", "sh", "é😀 a b"]).result;
    expect(result).toEqual({ stdout: "é😀 a b", stderr: "diagnostic", code: 7 });
    expect(existsSync(join(home, "fallback-count"))).toBe(false);
    expect(readFileSync(join(home, "stats.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("preserves stdin", async () => {
    expect(await launch(["/bin/cat"], {}, "stdin é😀\n").result).toEqual({ stdout: "stdin é😀\n", stderr: "", code: 0 });
    expect(existsSync(join(home, "fallback-count"))).toBe(false);
  });

  it("falls back before execution when no service is available", async () => {
    await server!.close();
    server = undefined;
    const counter = join(home, "executions");
    const result = await launch(["/bin/sh", "-c", `printf 1 >> '${counter}'; printf fallback-ok; exit 17`]).result;
    expect(result).toEqual({ stdout: "fallback-ok", stderr: "", code: 17 });
    expect(readFileSync(counter, "utf8")).toBe("1");
    expect(readFileSync(join(home, "fallback-count"), "utf8")).toBe("1");
  });

  it("rejects a descriptor readable by other users before executing", async () => {
    chmodSync(join(home, "run", "processing.json"), 0o644);
    expect((await launch(["/bin/echo", "safe"]).result).stdout).toBe("safe\n");
    expect(readFileSync(join(home, "fallback-count"), "utf8")).toBe("1");
    expect(existsSync(join(home, "stats.jsonl"))).toBe(false);
  });

  it("returns captured streams without rerunning after a service disconnect", async () => {
    const counter = join(home, "executions");
    const running = launch([process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(counter)},'1');setTimeout(()=>{process.stdout.write('captured');process.stderr.write('error');process.exitCode=23},100)`]);
    await waitForFile(counter);
    await server!.close();
    server = undefined;
    expect(await running.result).toEqual({ stdout: "captured", stderr: "error", code: 23 });
    expect(readFileSync(counter, "utf8")).toBe("1");
    expect(existsSync(join(home, "fallback-count"))).toBe(false);
  });

  it("forwards SIGINT and preserves the command's handled exit status", async () => {
    const ready = join(home, "ready");
    const running = launch([process.execPath, "-e", `process.on('SIGINT',()=>{process.stdout.write('interrupted');process.exit(23)});require('fs').writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},1000)`]);
    await waitForFile(ready);
    running.child.kill("SIGINT");
    expect(await running.result).toEqual({ stdout: "interrupted", stderr: "", code: 23 });
    expect(existsSync(join(home, "fallback-count"))).toBe(false);
  });

  it("does not wait for forced termination after cooperative timeout exit", async () => {
    const start = Date.now();
    const result = await launch([process.execPath, "-e", "process.on('SIGTERM',()=>{process.stderr.write('timed out');process.exit(23)});setInterval(()=>{},1000)"], { TOKMIZER_EXEC_TIMEOUT_MS: "200" }).result;
    expect(result).toEqual({ stdout: "", stderr: "timed out", code: 23 });
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("forces termination after the same two-second grace period", async () => {
    const start = Date.now();
    const result = await launch([process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { TOKMIZER_EXEC_TIMEOUT_MS: "200" }).result;
    expect(result.code).toBe(137);
    expect(Date.now() - start).toBeGreaterThanOrEqual(2150);
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it("caps both streams and preserves the UTF-8 boundary", async () => {
    const code = "const n=10*1024*1024;process.stdout.write(Buffer.concat([Buffer.alloc(n-2,120),Buffer.from('😀tail')]));process.stderr.write(Buffer.alloc(n+1,121));";
    const result = await launch([process.execPath, "-e", code]).result;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("x".repeat(10 * 1024 * 1024 - 2) + "\n… (output truncated at 10MB)");
    expect(result.stderr).toBe("y".repeat(10 * 1024 * 1024) + "\n… (stderr truncated at 10MB)");
    expect(existsSync(join(home, "fallback-count"))).toBe(false);
  });

  it("does not replay output or execution when accounting confirmation is lost", async () => {
    await server!.close();
    server = undefined;
    let receipts = 0;
    const fake = createServer((socket) => {
      let phase = 0;
      const reader = new FrameReader(() => 21 * 1024 * 1024, () => {
        if (phase++ === 0) socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify({ ok: true, protocol: 2, yolo: false }))));
        else if (phase === 2) {
          const out = Buffer.from("delivered");
          const header = Buffer.alloc(8);
          header.writeUInt32BE(out.length);
          socket.write(encodeProcessingFrame(Buffer.concat([header, out])));
        } else {
          receipts++;
          socket.end();
        }
      });
      socket.on("data", (data: Buffer) => reader.push(data));
      socket.on("error", () => socket.destroy());
    });
    const path = endpointPath;
    await new Promise<void>((resolve) => fake.listen(path, resolve));
    chmodSync(path, 0o600);
    try {
      const counter = join(home, "executions");
      const result = await launch(["/bin/sh", "-c", `printf 1 >> '${counter}'; printf original; exit 17`]).result;
      expect(result).toEqual({ stdout: "delivered", stderr: "", code: 17 });
      expect(receipts).toBe(1);
      expect(readFileSync(counter, "utf8")).toBe("1");
      expect(existsSync(join(home, "fallback-count"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, type Socket } from "node:net";
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { startProcessingServer } from "../exec/processing-server";
import { FrameReader, encodeProcessingFrame, encodeCapturedFrame } from "../exec/processing-protocol";
import { kickBackgroundEnroll, processCapturedOutput } from "../exec/wrapper";
import { setYoloMode } from "../yolo-mode";
import type { DaemonRuntime } from "../daemon/runtime";

vi.mock("../exec/wrapper", () => ({ processCapturedOutput: vi.fn(), kickBackgroundEnroll: vi.fn() }));

let home: string;
let socketPath: string;
let server: Awaited<ReturnType<typeof startProcessingServer>> | undefined;
let runtime: DaemonRuntime;
const sockets: Socket[] = [];
const token = "a".repeat(64);
const input = { stdout: "hello é😀", stderr: "error\n", exitCode: 23, truncated: false, stderrTruncated: true };

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tkr-ipc-")));
  socketPath = join(home, "p.sock");
  vi.stubEnv("TOKMIZER_HOME", home);
  runtime = { signedAt: Date.now(), fetchedAt: Date.now(), startedAt: Date.now(), bundleVersion: 1, ruleCount: 1, selectFor: () => null };
  vi.mocked(processCapturedOutput).mockReset().mockImplementation(async (captured) => ({
    stdout: captured.stdout,
    stderr: captured.stderr,
    code: captured.exitCode,
    filterId: null,
    rawBytes: 0,
    filteredBytes: 0,
    truncated: captured.truncated
  }));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await server?.close();
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function start(extra = {}) {
  server = await startProcessingServer({ path: socketPath, token, version: "test", getRuntime: () => runtime, ...extra });
}

function prepare(extra = {}) {
  return encodeProcessingFrame(Buffer.from(JSON.stringify({ protocol: 2, version: "test", token, home, argv: ["demo", "a b"], host: "codex", restoreDisabled: false, timeoutMs: 1000, ...extra })));
}

async function client() {
  const socket = createConnection(socketPath);
  sockets.push(socket);
  socket.on("error", () => {});
  await once(socket, "connect");
  return socket;
}

function frameFrom(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const finish = (frame: Buffer): void => { cleanup(); resolve(frame); };
    const reader = new FrameReader(() => 21 * 1024 * 1024, finish);
    const data = (chunk: Buffer): void => { try { reader.push(chunk); } catch (error) { cleanup(); reject(error); } };
    const close = (): void => { cleanup(); reject(new Error("closed before response")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("response timeout")); }, 2000);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", data);
      socket.off("close", close);
    };
    socket.on("data", data);
    socket.once("close", close);
  });
}

describe.skipIf(process.platform === "win32")("authenticated processing service", () => {
  it("preserves streams and caller context after authenticated admission", async () => {
    await start();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const socket = await client();
    const ready = frameFrom(socket);
    socket.write(prepare({ sessionId: "session-a", restoreDisabled: true, restoreMaxBytes: 100 }));
    expect(JSON.parse((await ready).toString())).toEqual({ ok: true, protocol: 2, yolo: false });
    const delivered = frameFrom(socket);
    socket.write(encodeProcessingFrame(encodeCapturedFrame(input)));
    const response = await delivered;
    const stdoutBytes = response.readUInt32BE(0);
    expect(response.subarray(8, 8 + stdoutBytes).toString()).toBe(input.stdout);
    expect(response.subarray(8 + stdoutBytes).toString()).toBe(input.stderr);
    expect(processCapturedOutput).toHaveBeenCalledExactlyOnceWith({ ...input, argv: ["demo", "a b"] }, expect.objectContaining({
      yolo: false,
      onMissingState: kickBackgroundEnroll,
      env: { CODEX_CLI: "1", CLAUDE_CODE_SESSION_ID: "session-a", TOKMIZER_CCR_DISABLED: "1", TOKMIZER_CCR_ENTRY_MAX_BYTES: "100" }
    }));
  });

  it.each([
    ["qwen-code", { QWEN_CODE: "1" }],
    ["crush", { CRUSH: "1" }],
    ["droid", { TOKMIZER_HOST: "droid" }],
    ["trae", { TOKMIZER_HOST: "trae" }],
    ["junie", { TOKMIZER_HOST: "junie" }],
    ["shell", {}]
  ])("labels a %s run for the processed output", async (host, hostEnv) => {
    await start();
    const socket = await client();
    const ready = frameFrom(socket);
    socket.write(prepare({ host }));
    expect(JSON.parse((await ready).toString())).toMatchObject({ ok: true });
    const delivered = frameFrom(socket);
    socket.write(encodeProcessingFrame(encodeCapturedFrame(input)));
    await delivered;
    expect(processCapturedOutput).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      env: { ...hostEnv, TOKMIZER_CCR_DISABLED: "0" }
    }));
  });

  it.each([{ token: "b".repeat(64) }, { home: "/wrong-home" }, { version: "other" }, { protocol: 1 }, { unexpected: "value" }])("rejects incompatible or unauthenticated admission %j", async (override) => {
    await start();
    const socket = await client();
    const closed = once(socket, "close");
    socket.write(prepare(override));
    await closed;
    expect(processCapturedOutput).not.toHaveBeenCalled();
  });

  it("rejects stale signed rules even when they were fetched just now", async () => {
    runtime.signedAt = Date.now() - 8 * 86_400_000;
    await start();
    const socket = await client();
    const closed = once(socket, "close");
    socket.write(prepare());
    await closed;
    expect(processCapturedOutput).not.toHaveBeenCalled();
  });

  it("rechecks signed age after the command finishes", async () => {
    await start();
    const socket = await client();
    const ready = frameFrom(socket);
    socket.write(prepare());
    await ready;
    runtime.signedAt = Date.now() - 8 * 86_400_000;
    const closed = once(socket, "close");
    socket.write(encodeProcessingFrame(encodeCapturedFrame(input)));
    await closed;
    expect(processCapturedOutput).not.toHaveBeenCalled();
  });

  it("retains initial YOLO when the setting changes during execution", async () => {
    await setYoloMode(true);
    await start();
    const socket = await client();
    const ready = frameFrom(socket);
    socket.write(prepare());
    expect(JSON.parse((await ready).toString()).yolo).toBe(true);
    await setYoloMode(false);
    const delivered = frameFrom(socket);
    socket.write(encodeProcessingFrame(encodeCapturedFrame(input)));
    await delivered;
    expect(processCapturedOutput).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ yolo: true }));
  });

  it("never processes a second captured frame on the same connection", async () => {
    await start();
    const socket = await client();
    const ready = frameFrom(socket);
    socket.write(prepare());
    await ready;
    const frame = encodeProcessingFrame(encodeCapturedFrame(input));
    const closed = once(socket, "close");
    socket.write(Buffer.concat([frame, frame]));
    await closed;
    expect(processCapturedOutput).toHaveBeenCalledTimes(1);
  });

  it("rejects a buffered payload exceeding the aggregate budget before processing", async () => {
    await start({ maxBufferedBytes: 1024 });
    const socket = await client();
    const ready = frameFrom(socket);
    socket.write(prepare());
    await ready;
    const header = Buffer.alloc(4);
    header.writeUInt32BE(2048);
    const closed = once(socket, "close");
    socket.write(header);
    await closed;
    expect(processCapturedOutput).not.toHaveBeenCalled();
  });

  it("closes an idle unauthenticated connection within its deadline", async () => {
    await start({ prepareTimeoutMs: 20 });
    const socket = await client();
    await once(socket, "close");
    expect(processCapturedOutput).not.toHaveBeenCalled();
  });

  it("keeps admission reserved for processing after its caller disconnects", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const original = vi.mocked(processCapturedOutput).getMockImplementation()!;
    vi.mocked(processCapturedOutput).mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    await start({ maxConnections: 1 });
    try {
      const first = await client();
      const ready = frameFrom(first);
      first.write(prepare());
      await ready;
      first.write(encodeProcessingFrame(encodeCapturedFrame(input)));
      await started;
      const firstClosed = once(first, "close");
      first.destroy();
      await firstClosed;
      const second = await client();
      const closed = once(second, "close");
      await closed;
      expect(processCapturedOutput).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });

  it("closes a stalled processing response without processing it again", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = vi.mocked(processCapturedOutput).getMockImplementation()!;
    vi.mocked(processCapturedOutput).mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    await start({ processingTimeoutMs: 20 });
    try {
      const socket = await client();
      const ready = frameFrom(socket);
      socket.write(prepare());
      await ready;
      const closed = once(socket, "close");
      socket.write(encodeProcessingFrame(encodeCapturedFrame(input)));
      await closed;
      expect(processCapturedOutput).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });

  it("refuses a directory accessible to other users", async () => {
    chmodSync(home, 0o755);
    await expect(start()).rejects.toThrow("unsafe processing directory");
  });

  it.each([false, true])("accounts only when delivery is confirmed: %s", async (acknowledge) => {
    const account = vi.fn(async () => {});
    const original = vi.mocked(processCapturedOutput).getMockImplementation()!;
    vi.mocked(processCapturedOutput).mockImplementation(async (captured, context) => {
      context.deferAccounting?.(account);
      return original(captured, context);
    });
    await start();
    const socket = await client();
    const ready = frameFrom(socket);
    socket.write(prepare());
    await ready;
    const delivered = frameFrom(socket);
    socket.write(encodeProcessingFrame(encodeCapturedFrame(input)));
    await delivered;
    expect(account).not.toHaveBeenCalled();
    if (acknowledge) {
      const confirmed = frameFrom(socket);
      socket.write(encodeProcessingFrame(Buffer.from([1])));
      expect(await confirmed).toEqual(Buffer.from([1]));
      expect(account).toHaveBeenCalledTimes(1);
    } else {
      const closed = once(socket, "close");
      socket.destroy();
      await closed;
      expect(account).not.toHaveBeenCalled();
    }
  });

  it("does not count an invalid receipt", async () => {
    const account = vi.fn(async () => {});
    const original = vi.mocked(processCapturedOutput).getMockImplementation()!;
    vi.mocked(processCapturedOutput).mockImplementation(async (captured, context) => {
      context.deferAccounting?.(account);
      return original(captured, context);
    });
    await start();
    const socket = await client();
    const ready = frameFrom(socket);
    socket.write(prepare());
    await ready;
    const delivered = frameFrom(socket);
    socket.write(encodeProcessingFrame(encodeCapturedFrame(input)));
    await delivered;
    const closed = once(socket, "close");
    socket.write(encodeProcessingFrame(Buffer.from([0])));
    await closed;
    expect(account).not.toHaveBeenCalled();
  });
});

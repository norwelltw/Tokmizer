import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { startProcessingServer } from "../exec/processing-server";
import { FrameReader, encodeProcessingFrame } from "../exec/processing-protocol";
import { postToolUseResponse } from "../hooks-host/post-tool-process";
import type { DaemonRuntime } from "../daemon/runtime";

vi.mock("../hooks-host/post-tool-process", () => ({ postToolUseResponse: vi.fn() }));

let home: string;
let socketPath: string;
let server: Awaited<ReturnType<typeof startProcessingServer>> | undefined;
let runtime: DaemonRuntime;
const sockets: Socket[] = [];
const token = "b".repeat(64);
const payload = { tool_name: "Read", tool_input: { file_path: "/x.ts" }, tool_response: { file: { content: "x".repeat(5000) } } };

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tkr-post-ipc-")));
  socketPath = join(home, "p.sock");
  vi.stubEnv("TOKMIZER_HOME", home);
  runtime = { signedAt: Date.now(), fetchedAt: Date.now(), startedAt: Date.now(), bundleVersion: 1, ruleCount: 1, selectFor: () => null };
  vi.mocked(postToolUseResponse).mockReset().mockResolvedValue("ENVELOPE");
  server = await startProcessingServer({ path: socketPath, token, version: "test", getRuntime: () => runtime });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await server?.close();
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function client(): Promise<{ socket: Socket; next: () => Promise<Buffer | null> }> {
  const socket = createConnection(socketPath);
  sockets.push(socket);
  socket.on("error", () => {});
  await once(socket, "connect");
  const frames: Buffer[] = [];
  const waiters: Array<(frame: Buffer | null) => void> = [];
  const reader = new FrameReader(() => 32 * 1024 * 1024, (frame) => {
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.on("close", () => {
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  const next = (): Promise<Buffer | null> => {
    const ready = frames.shift();
    if (ready) return Promise.resolve(ready);
    if (socket.destroyed) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };
  return { socket, next };
}

function prepare(extra = {}): Buffer {
  return encodeProcessingFrame(Buffer.from(JSON.stringify({ kind: "post-tool-use", protocol: 2, version: "test", token, home, host: "claude-code", ...extra })));
}

describe("post-tool-use processing", () => {
  it("processes the payload frame with the runtime rules and confirms delivery", async () => {
    const { socket, next } = await client();
    socket.write(prepare());
    expect(JSON.parse(String(await next()))).toEqual({ ok: true, protocol: 2 });
    socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify(payload))));
    expect(JSON.parse(String(await next()))).toEqual({ ok: true, protocol: 2, output: "ENVELOPE" });
    expect(vi.mocked(postToolUseResponse).mock.calls[0]![0]).toEqual(payload);
    const resolver = vi.mocked(postToolUseResponse).mock.calls[0]![1]!.resolver!;
    await expect(resolver("read-tool: x", null)).resolves.toBeNull();
    socket.write(encodeProcessingFrame(Buffer.from([1])));
    expect([...(await next())!]).toEqual([1]);
  });

  it("accepts payloads larger than the metadata limit", async () => {
    const big = { ...payload, tool_response: { file: { content: "y".repeat(3 * 1024 * 1024) } } };
    const { socket, next } = await client();
    socket.write(prepare());
    await next();
    socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify(big))));
    expect(JSON.parse(String(await next()))).toMatchObject({ ok: true, output: "ENVELOPE" });
  });

  it.each([
    ["a wrong token", { token: "c".repeat(64) }],
    ["a wrong version", { version: "other" }],
    ["a wrong home", { home: "/elsewhere" }],
    ["an unsupported host", { host: "codex" }]
  ])("closes the connection for %s", async (_label, extra) => {
    const { socket, next } = await client();
    socket.write(prepare(extra));
    expect(await next()).toBeNull();
    expect(postToolUseResponse).not.toHaveBeenCalled();
  });

  it("closes the connection when the rules have expired", async () => {
    runtime = { ...runtime, signedAt: Date.now() - 365 * 86_400_000 };
    const { socket, next } = await client();
    socket.write(prepare());
    expect(await next()).toBeNull();
  });

  it("closes the connection for a payload that is not an object", async () => {
    const { socket, next } = await client();
    socket.write(prepare());
    await next();
    socket.write(encodeProcessingFrame(Buffer.from("[1,2]")));
    expect(await next()).toBeNull();
    expect(postToolUseResponse).not.toHaveBeenCalled();
  });

  it("accounts the processed output only after the client confirms delivery", async () => {
    const commit = vi.fn(async () => {});
    vi.mocked(postToolUseResponse).mockImplementation(async (_payload, options) => {
      options?.deferAccounting?.(commit);
      return "ENVELOPE";
    });
    const { socket, next } = await client();
    socket.write(prepare());
    await next();
    socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify(payload))));
    await next();
    expect(commit).not.toHaveBeenCalled();
    socket.write(encodeProcessingFrame(Buffer.from([1])));
    expect([...(await next())!]).toEqual([1]);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("never accounts a response whose receipt is lost", async () => {
    const commit = vi.fn(async () => {});
    vi.mocked(postToolUseResponse).mockImplementation(async (_payload, options) => {
      options?.deferAccounting?.(commit);
      return "ENVELOPE";
    });
    const { socket, next } = await client();
    socket.write(prepare());
    await next();
    socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify(payload))));
    await next();
    socket.destroy();
    await server!.close();
    server = undefined;
    expect(commit).not.toHaveBeenCalled();
  });

  it("never accounts work that finishes after the processing deadline closed the connection", async () => {
    await server!.close();
    server = await startProcessingServer({ path: socketPath, token, version: "test", getRuntime: () => runtime, processingTimeoutMs: 30 });
    const commit = vi.fn(async () => {});
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    vi.mocked(postToolUseResponse).mockImplementation(async (_payload, options) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      options?.deferAccounting?.(commit);
      finished();
      return "ENVELOPE";
    });
    const { socket, next } = await client();
    socket.write(prepare());
    await next();
    socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify(payload))));
    expect(await next()).toBeNull();
    await done;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(commit).not.toHaveBeenCalled();
  });

  it("gives the client a fresh window for its receipt once the response is sent", async () => {
    await server!.close();
    server = await startProcessingServer({ path: socketPath, token, version: "test", getRuntime: () => runtime, processingTimeoutMs: 200 });
    const commit = vi.fn(async () => {});
    vi.mocked(postToolUseResponse).mockImplementation(async (_payload, options) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      options?.deferAccounting?.(commit);
      return "ENVELOPE";
    });
    const { socket, next } = await client();
    socket.write(prepare());
    await next();
    socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify(payload))));
    await next();
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.write(encodeProcessingFrame(Buffer.from([1])));
    expect([...(await next())!]).toEqual([1]);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

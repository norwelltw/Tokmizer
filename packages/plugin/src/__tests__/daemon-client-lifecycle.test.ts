import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { connectDaemon, type DaemonClient } from "../daemon/client";
import { encodeFrame } from "../daemon/protocol";
import { PLUGIN_VERSION } from "../version";

let dir: string;
let socketPath: string;
let server: Server;
let client: DaemonClient | undefined;
let sockets: Set<Socket>;

type Request = { id: string; op: string; cmd?: string };

async function startDaemon(handle: (socket: Socket, request: Request) => void): Promise<void> {
  server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (frame) handle(socket, JSON.parse(frame) as Request);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function answerPing(socket: Socket, request: Request): void {
  socket.write(encodeFrame({
    id: request.id,
    ok: true,
    data: { pid: 1, uptimeMs: 1, ruleCount: 1, bundleVersion: 1, version: PLUGIN_VERSION }
  }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-client-life-"));
  socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\${dir.split(/[\\/]/).at(-1)}`
    : join(dir, "daemon.sock");
  sockets = new Set();
  vi.stubEnv("TOKMIZER_HOME", dir);
});

afterEach(async () => {
  client?.close();
  client = undefined;
  for (const socket of sockets) socket.destroy();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon version handoff", () => {
  it("leaves a newer daemon running instead of replacing it", async () => {
    let shutdowns = 0;
    await startDaemon((socket, request) => {
      if (request.op === "ping") {
        socket.write(encodeFrame({ id: request.id, ok: true, data: { pid: 1, uptimeMs: 1, ruleCount: 1, bundleVersion: 1, version: "999.0.0" } }));
      } else {
        shutdowns += 1;
        socket.write(encodeFrame({ id: request.id, ok: true, data: {} }));
      }
    });
    await expect(connectDaemon({ socketPath }).then((result) => (client = result)))
      .rejects.toThrow(/newer daemon 999.0.0/);
    expect(shutdowns).toBe(0);
    expect(server.listening).toBe(true);
  });
});

describe("daemon client disconnect handling", () => {
  it("rejects a connection whose version handshake is refused", async () => {
    await startDaemon((socket, request) => {
      socket.write(encodeFrame({ id: request.id, ok: false, err: "unavailable" }));
    });
    await expect(connectDaemon({ socketPath }).then((result) => (client = result)))
      .rejects.toThrow("unavailable");
  });

  it("rejects a connection dropped during its version handshake", async () => {
    await startDaemon((socket) => socket.destroy());
    await expect(connectDaemon({ socketPath }).then((result) => (client = result)))
      .rejects.toThrow(/closed/);
  });

  it("rejects further requests immediately after a remote disconnect", async () => {
    await startDaemon((socket, request) => {
      if (request.op === "ping") answerPing(socket, request);
      else socket.destroy();
    });
    client = await connectDaemon({ socketPath });
    await expect(client.filter("git status", "pro")).rejects.toThrow(/closed/);
    await expect(client.filter("git diff", "pro")).rejects.toThrow(/closed/);
  });

  it("cancels pending requests when closed even if the peer keeps its half open", async () => {
    let received = 0;
    await startDaemon((socket, request) => {
      if (request.op === "ping") answerPing(socket, request);
      else received += 1;
    });
    client = await connectDaemon({ socketPath });
    const results = Promise.allSettled([
      client.filter("git status", "pro"),
      client.filter("git diff", "pro")
    ]);
    await vi.waitFor(() => expect(received).toBe(2));
    client.close();
    const settled = await results;
    for (const result of settled) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toMatch(/closed/);
    }
  });

  it("rejects a silent handshake instead of returning an unusable client", async () => {
    await startDaemon(() => {});
    await expect(connectDaemon({ socketPath }).then((result) => (client = result)))
      .rejects.toThrow(/timeout/);
  });

  it("keeps concurrent responses associated with their requests", async () => {
    const requests: Request[] = [];
    await startDaemon((socket, request) => {
      if (request.op === "ping") return answerPing(socket, request);
      requests.push(request);
      if (requests.length !== 8) return;
      for (const pending of requests.toReversed()) {
        socket.write(encodeFrame({
          id: pending.id,
          ok: true,
          data: { filter: {
            slug: pending.cmd,
            match_command: "^git",
            priority: 1,
            strip_ansi: true,
            strip_lines_matching: []
          } }
        }));
      }
    });
    client = await connectDaemon({ socketPath });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => client!.filter(`git-${i}`, "pro")));
    expect(results.map((result) => result?.slug)).toEqual([
      "git-0", "git-1", "git-2", "git-3", "git-4", "git-5", "git-6", "git-7"
    ]);
  });
});

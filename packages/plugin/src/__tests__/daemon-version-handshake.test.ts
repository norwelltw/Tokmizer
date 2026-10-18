import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { startServer, type DaemonHandle } from "../daemon/server";
import { connectDaemon, type DaemonClient } from "../daemon/client";
import { PLUGIN_VERSION } from "../version";

let workDir: string;
let prevHome: string | undefined;
let prevBin: string | undefined;
let daemon: DaemonHandle | null = null;
let client: DaemonClient | null = null;
let fake: Server | null = null;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "tkr-hs-"));
  prevHome = process.env.TOKMIZER_HOME;
  prevBin = process.env.TOKMIZER_DAEMON_BIN;
  process.env.TOKMIZER_HOME = workDir;
  process.env.TOKMIZER_DAEMON_BIN = "/bin/true";
});

afterEach(async () => {
  if (client) {
    client.close();
    client = null;
  }
  if (daemon) {
    await daemon.close();
    daemon = null;
  }
  if (fake) {
    await new Promise<void>((r) => fake!.close(() => r()));
    fake = null;
  }
  rmSync(workDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = prevHome;
  if (prevBin === undefined) delete process.env.TOKMIZER_DAEMON_BIN;
  else process.env.TOKMIZER_DAEMON_BIN = prevBin;
});

describe("daemon version handshake", () => {
  it("ping exposes the daemon's plugin version", async () => {
    const sockPath = join(workDir, "hs.sock");
    daemon = await startServer(null, { socketPath: sockPath, onWarming: async () => { throw new Error("no net"); } });
    client = await connectDaemon({ socketPath: sockPath });
    const info = await client.ping();
    expect(info.version).toBe(PLUGIN_VERSION);
  });

  it("asks a stale daemon to shut down when versions differ", async () => {
    const sockPath = join(workDir, "stale.sock");
    const ops: string[] = [];
    fake = createServer((sock) => {
      sock.unref();
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!frame) continue;
          const msg = JSON.parse(frame) as { id: string; op: string };
          ops.push(msg.op);
          if (msg.op === "ping") {
            sock.write(`${JSON.stringify({ id: msg.id, ok: true, data: { pid: 1, uptimeMs: 1, ruleCount: 0, bundleVersion: 0, version: "0.0.1" } })}\n`);
          } else {
            sock.write(`${JSON.stringify({ id: msg.id, ok: true, data: { stopping: true } })}\n`);
          }
        }
      });
    });
    await new Promise<void>((r) => fake!.listen(sockPath, r));
    client = await connectDaemon({ socketPath: sockPath }).catch(() => null);
    expect(ops).toContain("ping");
    expect(ops).toContain("shutdown");
    if (client) client.close();
    client = null;
  });

  it("never reconnects to a stale daemon that has not died yet", async () => {
    const sockPath = join(workDir, "slow.sock");
    const sockets: import("node:net").Socket[] = [];
    let closedAt = 0;
    let shutdownAt = 0;
    fake = createServer((sock) => {
      sock.unref();
      sockets.push(sock);
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!frame) continue;
          const msg = JSON.parse(frame) as { id: string; op: string };
          if (msg.op === "ping") {
            sock.write(`${JSON.stringify({ id: msg.id, ok: true, data: { pid: 1, uptimeMs: 1, ruleCount: 0, bundleVersion: 0, version: "0.0.1" } })}\n`);
          } else {
            shutdownAt = Date.now();
            sock.write(`${JSON.stringify({ id: msg.id, ok: true, data: { stopping: true } })}\n`);
            setTimeout(() => {
              closedAt = Date.now();
              for (const s of sockets) s.destroy();
              fake!.close();
              fake = null;
            }, 600);
          }
        }
      });
    });
    await new Promise<void>((r) => fake!.listen(sockPath, r));
    client = await connectDaemon({ socketPath: sockPath }).catch(() => null);
    expect(client).toBeNull();
    expect(shutdownAt).toBeGreaterThan(0);
    expect(closedAt).toBeGreaterThan(0);
  }, 15000);

  it("gives up instead of reusing a stale daemon that survives the shutdown deadline", async () => {
    const sockPath = join(workDir, "immortal.sock");
    let pings = 0;
    fake = createServer((sock) => {
      sock.unref();
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!frame) continue;
          const msg = JSON.parse(frame) as { id: string; op: string };
          if (msg.op === "ping") {
            pings += 1;
            sock.write(`${JSON.stringify({ id: msg.id, ok: true, data: { pid: 1, uptimeMs: 1, ruleCount: 0, bundleVersion: 0, version: "0.0.1" } })}\n`);
          } else {
            sock.write(`${JSON.stringify({ id: msg.id, ok: true, data: { stopping: true } })}\n`);
          }
        }
      });
    });
    await new Promise<void>((r) => fake!.listen(sockPath, r));
    client = await connectDaemon({ socketPath: sockPath }).catch(() => null);
    expect(client).toBeNull();
    expect(pings).toBeGreaterThan(0);
  }, 15000);

  it("waits for a concurrent spawner instead of stealing its lock", async () => {
    const { socketPath: sp } = await import("../daemon/lifecycle");
    const { path: sockPath } = sp();
    const { mkdirSync: mkd, writeFileSync: wf, existsSync: ex } = await import("node:fs");
    const { dirname } = await import("node:path");
    const stub = join(workDir, "daemon-stub.js");
    wf(stub, "");
    process.env.TOKMIZER_DAEMON_BIN = stub;
    mkd(dirname(sockPath), { recursive: true });
    wf(join(dirname(sockPath), "daemon.spawn.lock"), "424242");
    setTimeout(() => {
      fake = createServer((sock) => {
        sock.unref();
        let buf = "";
        sock.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!frame) continue;
            const msg = JSON.parse(frame) as { id: string; op: string };
            sock.write(`${JSON.stringify({ id: msg.id, ok: true, data: { pid: 1, uptimeMs: 1, ruleCount: 5, bundleVersion: 1, version: PLUGIN_VERSION } })}\n`);
          }
        });
      });
      fake.listen(sockPath);
    }, 400);
    client = await connectDaemon();
    const info = await client.ping();
    expect(info.version).toBe(PLUGIN_VERSION);
    expect(ex(join(workDir, "daemon.spawn.fail"))).toBe(false);
  }, 15000);
});

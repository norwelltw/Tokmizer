import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { startServer, type DaemonHandle } from "../daemon/server";
import { encodeFrame, decodeFrames, FRAME_DELIM, MAX_FRAME_BYTES } from "../daemon/protocol";
import type { DaemonRuntime } from "../daemon/runtime";

let dir: string;
let socketPath: string;
let handle: DaemonHandle | null = null;

function fakeRuntime(filters: Record<string, { match: string }>): DaemonRuntime {
  return {
    bundleVersion: 42,
    signedAt: Date.now(),
    ruleCount: Object.keys(filters).length,
    startedAt: Date.now(),
    fetchedAt: Date.now(),
    selectFor: (cmd) => {
      for (const [slug, f] of Object.entries(filters)) {
        if (new RegExp(f.match).test(cmd)) {
          return {
            slug,
            match_command: f.match,
            priority: 50,
            strip_ansi: false,
            strip_lines_matching: [],
            matchRegex: new RegExp(f.match)
          };
        }
      }
      return null;
    }
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-daemon-"));
  socketPath = join(dir, "test.sock");
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

function clientRequest(req: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf(FRAME_DELIM);
      if (idx < 0) return;
      const frame = [...decodeFrames(buf.slice(0, idx + 1))][0]!;
      sock.end();
      resolve(JSON.parse(frame));
    });
    sock.on("error", reject);
    sock.write(encodeFrame(req));
  });
}

describe("daemon server", () => {
  it("responds to ping with runtime metadata", async () => {
    const runtime = fakeRuntime({ git: { match: "^git\\b" } });
    handle = await startServer(runtime, { socketPath });
    const res = (await clientRequest({ id: "p1", op: "ping" })) as {
      id: string;
      ok: boolean;
      data: { ruleCount: number; bundleVersion: number };
    };
    expect(res.ok).toBe(true);
    expect(res.data.ruleCount).toBe(1);
    expect(res.data.bundleVersion).toBe(42);
  });

  it("returns matched filter for known command", async () => {
    const runtime = fakeRuntime({ git: { match: "^git\\b" } });
    handle = await startServer(runtime, { socketPath });
    const res = (await clientRequest({
      id: "f1",
      op: "filter",
      cmd: "git status",
      plan: "smart"
    })) as { ok: boolean; data: { filter: { slug: string } | null } };
    expect(res.ok).toBe(true);
    expect(res.data.filter?.slug).toBe("git");
  });

  it("returns null filter when no match", async () => {
    const runtime = fakeRuntime({ git: { match: "^git\\b" } });
    handle = await startServer(runtime, { socketPath });
    const res = (await clientRequest({
      id: "f2",
      op: "filter",
      cmd: "ls -la",
      plan: "smart"
    })) as { data: { filter: unknown } };
    expect(res.data.filter).toBeNull();
  });

  it("forwards the allowed list from the request to selectFor", async () => {
    let seen: string[] | undefined = undefined;
    const runtime = fakeRuntime({ git: { match: "^git\\b" } });
    const orig = runtime.selectFor;
    runtime.selectFor = (cmd, plan, allowed) => {
      seen = allowed;
      return orig(cmd, plan, allowed);
    };
    handle = await startServer(runtime, { socketPath });
    const res = (await clientRequest({
      id: "al1",
      op: "filter",
      cmd: "git log",
      plan: "pro",
      allowed: ["aaaa", "bbbb"]
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(seen).toEqual(["aaaa", "bbbb"]);
  });

  it("returns warming error when runtime not ready and no onWarming", async () => {
    handle = await startServer(null, { socketPath });
    const res = (await clientRequest({
      id: "f3",
      op: "filter",
      cmd: "git",
      plan: "smart"
    })) as { ok: boolean; err: string };
    expect(res.ok).toBe(false);
    expect(res.err).toBe("warming");
  });

  it("answers quickly while the first rules download is slow, then serves them once ready", async () => {
    let release: (rt: DaemonRuntime) => void = () => {};
    handle = await startServer(null, {
      socketPath,
      onWarming: () => new Promise<DaemonRuntime>((resolve) => { release = resolve; })
    });
    const started = Date.now();
    const first = (await clientRequest({ id: "slow1", op: "filter", cmd: "git status", plan: "smart" })) as { ok: boolean; err?: string };
    expect(Date.now() - started).toBeLessThan(1000);
    expect(first).toMatchObject({ ok: false, err: "warming" });
    release(fakeRuntime({ git: { match: "^git\\b" } }));
    await new Promise((r) => setTimeout(r, 20));
    const second = (await clientRequest({ id: "slow2", op: "filter", cmd: "git status", plan: "smart" })) as { ok: boolean; data?: { filter: { slug: string } | null } };
    expect(second.data?.filter?.slug).toBe("git");
  });

  it("keeps serving filters from a stale runtime while a failing warm refresh is in flight", async () => {
    const stale = fakeRuntime({ git: { match: "^git\\b" } });
    stale.fetchedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    handle = await startServer(stale, {
      socketPath,
      onWarming: async () => {
        throw new Error("bundle fetch cooling down");
      }
    });
    const res = (await clientRequest({
      id: "stale1",
      op: "filter",
      cmd: "git status",
      plan: "smart"
    })) as { ok: boolean; data?: { filter: { slug: string } | null } };
    expect(res.ok).toBe(true);
    expect(res.data?.filter?.slug).toBe("git");
  });

  it("rejects malformed request with bad_request error", async () => {
    const runtime = fakeRuntime({});
    handle = await startServer(runtime, { socketPath });
    const res = (await clientRequest({ junk: true })) as { ok: boolean; err: string };
    expect(res.ok).toBe(false);
    expect(res.err).toMatch(/^bad_request/);
  });

  it("reload op calls onWarming and replaces runtime", async () => {
    const r1 = fakeRuntime({ git: { match: "^git\\b" } });
    let warmCount = 0;
    process.env.TOKMIZER_DAEMON_INSTALL_ID = "test-install-id";
    try {
      handle = await startServer(r1, {
        socketPath,
        onWarming: async () => {
          warmCount += 1;
          return fakeRuntime({ git: { match: "^git\\b" }, npm: { match: "^npm\\b" } });
        }
      });
    } finally {
      delete process.env.TOKMIZER_DAEMON_INSTALL_ID;
    }
    const res = (await clientRequest({ id: "r1", op: "reload", installId: "test-install-id" })) as {
      ok: boolean;
      data: { ruleCount: number; bundleVersion: number };
    };
    expect(res.ok).toBe(true);
    expect(res.data.ruleCount).toBe(2);
    expect(warmCount).toBe(1);
    const f = (await clientRequest({
      id: "f1",
      op: "filter",
      cmd: "npm install",
      plan: "smart",
      installId: "test-install-id"
    })) as { data: { filter: { slug: string } | null } };
    expect(f.data.filter?.slug).toBe("npm");
  });

  it("reload returns error when no onWarming handler", async () => {
    process.env.TOKMIZER_DAEMON_INSTALL_ID = "test-install-id";
    try {
      handle = await startServer(fakeRuntime({}), { socketPath });
    } finally {
      delete process.env.TOKMIZER_DAEMON_INSTALL_ID;
    }
    const res = (await clientRequest({ id: "r2", op: "reload", installId: "test-install-id" })) as {
      ok: boolean;
      err: string;
    };
    expect(res.ok).toBe(false);
    expect(res.err).toBe("no_warming_handler");
  });

  it("error-replies frame_too_large for a multibyte payload over the byte budget", async () => {
    const runtime = fakeRuntime({});
    handle = await startServer(runtime, { socketPath });
    const fat = "é".repeat(40 * 1024);
    expect(fat.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(Buffer.byteLength(fat, "utf8")).toBeGreaterThan(MAX_FRAME_BYTES);
    const res = await new Promise<unknown>((resolve, reject) => {
      const sock = createConnection(socketPath);
      let buf = "";
      let replied = false;
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const idx = buf.indexOf(FRAME_DELIM);
        if (idx < 0) return;
        replied = true;
        const frame = [...decodeFrames(buf.slice(0, idx + 1))][0]!;
        sock.end();
        resolve(JSON.parse(frame));
      });
      sock.on("close", () => {
        if (!replied) reject(new Error("connection closed without reply"));
      });
      sock.on("error", reject);
      sock.write(encodeFrame({ id: "big", op: "filter", cmd: fat, plan: "smart" }));
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { err: string }).err).toBe("frame_too_large");
  });

  it("denies reload and shutdown when no install-id auth is configured", async () => {
    delete process.env.TOKMIZER_DAEMON_INSTALL_ID;
    handle = await startServer(fakeRuntime({}), { socketPath });
    const reload = (await clientRequest({ id: "d1", op: "reload", installId: "x" })) as {
      ok: boolean;
      err: string;
    };
    expect(reload.ok).toBe(false);
    expect(reload.err).toBe("forbidden");
    const shutdown = (await clientRequest({ id: "d2", op: "shutdown", installId: "x" })) as {
      ok: boolean;
      err: string;
    };
    expect(shutdown.ok).toBe(false);
    expect(shutdown.err).toBe("forbidden");
  });
});

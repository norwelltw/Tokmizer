import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { startServer, type DaemonHandle } from "../daemon/server";
import { encodeFrame, decodeFrames, FRAME_DELIM } from "../daemon/protocol";
import type { DaemonRuntime } from "../daemon/runtime";

let dir: string;
let socketPath: string;
let handle: DaemonHandle | null = null;

function runtimeWithAge(fetchedAt: number): DaemonRuntime {
  return {
    bundleVersion: 7,
    signedAt: fetchedAt,
    ruleCount: 1,
    startedAt: fetchedAt,
    fetchedAt,
    selectFor: (cmd) =>
      /^git\b/.test(cmd)
        ? {
            slug: "git",
            match_command: "^git\\b",
            priority: 50,
            strip_ansi: false,
            strip_lines_matching: [],
            matchRegex: /^git\b/
          }
        : null
  };
}

beforeEach(() => {
  process.env.TOKMIZER_MAX_BUNDLE_AGE_MS = "1000";
  dir = mkdtempSync(join(tmpdir(), "tok-maxage-"));
  socketPath = join(dir, "test.sock");
});

afterEach(async () => {
  delete process.env.TOKMIZER_MAX_BUNDLE_AGE_MS;
  if (handle) {
    await handle.close();
    handle = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

function filterReq(): Promise<{ data: { filter: { slug: string } | null } }> {
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
    sock.write(encodeFrame({ id: "f", op: "filter", cmd: "git status", plan: "pro" }));
  });
}

describe("daemon bundle hard max-age", () => {
  it("filters normally when fetchedAt is fresh", async () => {
    handle = await startServer(runtimeWithAge(Date.now()), { socketPath });
    const res = await filterReq();
    expect(res.data.filter?.slug).toBe("git");
  });

  it("returns no filter when fetchedAt is older than max age", async () => {
    handle = await startServer(runtimeWithAge(Date.now() - 5000), { socketPath });
    const res = await filterReq();
    expect(res.data.filter).toBeNull();
  });
});

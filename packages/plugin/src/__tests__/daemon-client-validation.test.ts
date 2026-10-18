import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { encodeFrame, decodeFrames, FRAME_DELIM } from "../daemon/protocol";
import { connectDaemon, type DaemonClient } from "../daemon/client";
import { PLUGIN_VERSION } from "../version";

let dir: string;
let socketPath: string;
let server: Server | null = null;
let client: DaemonClient | null = null;

function startStubDaemon(dataFor: (id: string) => unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    server = createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        let idx = buf.indexOf(FRAME_DELIM);
        while (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          for (const f of decodeFrames(frame + FRAME_DELIM)) {
            if (!f) continue;
            const req = JSON.parse(f) as { id: string; op: string };
            const data = req.op === "ping"
              ? { pid: 1, uptimeMs: 1, ruleCount: 1, bundleVersion: 1, version: PLUGIN_VERSION }
              : dataFor(req.id);
            sock.write(encodeFrame({ id: req.id, ok: true, data }));
          }
          idx = buf.indexOf(FRAME_DELIM);
        }
      });
    });
    server.listen(socketPath, () => resolve());
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-client-val-"));
  socketPath = join(dir, "stub.sock");
});

afterEach(async () => {
  if (client) {
    client.close();
    client = null;
  }
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon client response validation", () => {
  it("returns null (safe passthrough) when daemon sends a malformed filter payload", async () => {
    await startStubDaemon(() => ({ filter: { slug: 42, match_command: "" }, junk: true }));
    client = await connectDaemon({ socketPath });

    const result = await client.filter("git status", "smart");
    expect(result).toBeNull();
  });

  it("returns null when daemon data is not an object", async () => {
    await startStubDaemon(() => "not-an-object");
    client = await connectDaemon({ socketPath });

    const result = await client.filter("git status", "smart");
    expect(result).toBeNull();
  });

  it("returns the filter when daemon sends a well-formed payload", async () => {
    await startStubDaemon(() => ({
      filter: {
        slug: "git",
        match_command: "^git\\b",
        priority: 50,
        strip_ansi: true,
        strip_lines_matching: []
      },
      cacheHit: false
    }));
    client = await connectDaemon({ socketPath });

    const result = await client.filter("git status", "smart");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("git");
  });
});

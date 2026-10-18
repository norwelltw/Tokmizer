import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";

const DAEMON_BIN = fileURLToPath(new URL("../../dist/bin/tkr-daemon.js", import.meta.url));

let workDir: string;
let stall: Server;
let child: ChildProcess | null = null;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "tkr-boot-"));
  stall = createServer(() => {});
  await new Promise<void>((res) => stall.listen(0, "127.0.0.1", res));
});

afterEach(() => {
  if (child) {
    try {
      child.kill("SIGKILL");
    } catch {}
    child = null;
  }
  stall.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!existsSync(DAEMON_BIN))("daemon boot order", () => {
  it("binds its socket before waiting on the network", async () => {
    const port = (stall.address() as { port: number }).port;
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, "state.json"),
      JSON.stringify({
        token: "tok_boot",
        signingSecret: "boot-signing-secret-0123456789",
        plan: "smart",
        email: "x@y",
        jwt: "test-jwt",
        jwtExp: Date.now() + 60_000,
        pluginVersion: "0.1.0",
        installId: "11111111-1111-1111-1111-111111111111",
        fingerprint: "f".repeat(64),
        status: "active"
      })
    );
    const sock = join(workDir, "run", "daemon.sock");
    child = spawn(process.execPath, [DAEMON_BIN], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? workDir,
        TOKMIZER_HOME: workDir,
        TOKMIZER_BASE_URL: `http://127.0.0.1:${port}`
      },
      stdio: "ignore"
    });
    const deadline = Date.now() + 2500;
    let bound = false;
    while (Date.now() < deadline) {
      if (existsSync(sock)) {
        bound = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(bound).toBe(true);
  }, 15000);
});

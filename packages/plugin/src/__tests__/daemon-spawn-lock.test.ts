import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLockAbandoned } from "../daemon/client";

let dir: string;
let lock: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-spawn-lock-"));
  lock = join(dir, "daemon.spawn.lock");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
}

describe("daemon spawn lock", () => {
  it("is abandoned when the process that took it is gone", () => {
    writeFileSync(lock, String(deadPid()));
    expect(spawnLockAbandoned(lock)).toBe(true);
  });

  it("is held while its process runs", () => {
    writeFileSync(lock, String(process.pid));
    expect(spawnLockAbandoned(lock)).toBe(false);
  });

  it("is abandoned once it is older than ten seconds, whoever holds it", () => {
    writeFileSync(lock, String(process.pid));
    const old = (Date.now() - 11_000) / 1000;
    utimesSync(lock, old, old);
    expect(spawnLockAbandoned(lock)).toBe(true);
  });

  it("gives a lock being written a moment before judging it", () => {
    writeFileSync(lock, "");
    expect(spawnLockAbandoned(lock)).toBe(false);
  });
});

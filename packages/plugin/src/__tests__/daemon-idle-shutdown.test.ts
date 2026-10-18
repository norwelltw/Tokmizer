import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonHandle } from "../daemon/server";
import type { DaemonRuntime } from "../daemon/runtime";

vi.mock("../daemon/lifecycle", async (importActual) => {
  const actual = await importActual<typeof import("../daemon/lifecycle")>();
  return { ...actual, isParentAlive: () => false };
});

import { startServer } from "../daemon/server";

let dir: string;
let socketPath: string;
let handle: DaemonHandle | null = null;

function fakeRuntime(): DaemonRuntime {
  return {
    bundleVersion: 1,
    signedAt: Date.now(),
    ruleCount: 0,
    startedAt: Date.now(),
    fetchedAt: Date.now(),
    selectFor: () => null
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-idle-"));
  socketPath = join(dir, "test.sock");
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon idle watcher", () => {
  it("keeps a long native command alive and stops after it becomes idle", async () => {
    const onShutdown = vi.fn();
    let active = true;
    vi.useFakeTimers();
    handle = await startServer(fakeRuntime(), { socketPath, onShutdown, idleTimeoutMs: 10, isActive: () => active });
    vi.advanceTimersByTime(90_000);
    expect(onShutdown).not.toHaveBeenCalled();
    active = false;
    vi.advanceTimersByTime(30_000);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("refreshes idle time after a short native request", async () => {
    const onShutdown = vi.fn();
    vi.useFakeTimers();
    handle = await startServer(fakeRuntime(), { socketPath, onShutdown, idleTimeoutMs: 40_000 });
    vi.advanceTimersByTime(30_000);
    handle.touch();
    vi.advanceTimersByTime(30_000);
    expect(onShutdown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("triggers onShutdown at most once even when both idle conditions hold across ticks", async () => {
    const onShutdown = vi.fn();
    vi.useFakeTimers();
    handle = await startServer(fakeRuntime(), { socketPath, onShutdown, idleTimeoutMs: 10 });
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });
});

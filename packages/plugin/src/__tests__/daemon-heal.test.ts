import { describe, it, expect, vi } from "vitest";
import { healOn401, BundleFetchError } from "../daemon/runtime";
import type { DaemonRuntime } from "../daemon/runtime";

const fakeRuntime = { filters: [] } as unknown as DaemonRuntime;

describe("healOn401", () => {
  it("heartbeats then refetches when the bundle 401s (server-invalidated but unexpired jwt)", async () => {
    const heartbeat = vi.fn(async () => ({}));
    const fetchBundle = vi.fn(async () => fakeRuntime);
    const log = vi.fn();
    const out = await healOn401(new BundleFetchError(401), "http://x", { heartbeat, fetchBundle, log });
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(fetchBundle).toHaveBeenCalledOnce();
    expect(out).toBe(fakeRuntime);
  });

  it("also heals on a 403", async () => {
    const heartbeat = vi.fn(async () => ({}));
    const fetchBundle = vi.fn(async () => fakeRuntime);
    const out = await healOn401(new BundleFetchError(403), "http://x", { heartbeat, fetchBundle, log: vi.fn() });
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(out).toBe(fakeRuntime);
  });

  it("does not heartbeat on a non-auth error (network blip stays on the backoff path)", async () => {
    const heartbeat = vi.fn();
    const fetchBundle = vi.fn();
    const out = await healOn401(new Error("network down"), "http://x", { heartbeat, fetchBundle, log: vi.fn() });
    expect(heartbeat).not.toHaveBeenCalled();
    expect(fetchBundle).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it("does not heal a non-auth BundleFetchError (500)", async () => {
    const heartbeat = vi.fn();
    const out = await healOn401(new BundleFetchError(500), "http://x", {
      heartbeat,
      fetchBundle: vi.fn(),
      log: vi.fn()
    });
    expect(heartbeat).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it("returns null when the refetch still fails after the heartbeat", async () => {
    const heartbeat = vi.fn(async () => ({}));
    const fetchBundle = vi.fn(async () => {
      throw new BundleFetchError(401);
    });
    const out = await healOn401(new BundleFetchError(401), "http://x", { heartbeat, fetchBundle, log: vi.fn() });
    expect(out).toBeNull();
  });
});

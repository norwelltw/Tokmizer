import { afterEach, describe, expect, it, vi } from "vitest";
import { processorRuntime } from "../exec/processor-runtime";
import type { DaemonRuntime } from "../daemon/runtime";

function fixture(bundleVersion: number, signedAt = 1): DaemonRuntime {
  return { bundleVersion, signedAt, fetchedAt: signedAt, startedAt: 1, ruleCount: 1, selectFor: () => null };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("processor runtime selection", () => {
  it("serves the server bundle when it is available", async () => {
    const rules = processorRuntime(async () => fixture(7), () => fixture(1), 5000);
    await rules.reload();
    expect(rules.current()?.bundleVersion).toBe(7);
  });

  it("falls back to fresh built-in rules without cache or account state", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const rules = processorRuntime(async () => null, () => fixture(1, 5), 5000);
    await rules.reload();
    expect(rules.current()).toMatchObject({ bundleVersion: 1, signedAt: 1_000_000, fetchedAt: 1_000_000 });
  });

  it("falls back to built-in rules when loading the cache fails", async () => {
    const rules = processorRuntime(async () => { throw new Error("stale"); }, () => fixture(1), 5000);
    await rules.reload();
    expect(rules.current()?.bundleVersion).toBe(1);
  });

  it("switches to the server bundle once it appears while serving built-in rules", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let cached: DaemonRuntime | null = null;
    const load = vi.fn(async () => cached);
    const rules = processorRuntime(load, () => fixture(1), 5000);
    await rules.reload();
    cached = fixture(9);
    expect(rules.current()?.bundleVersion).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_006_000);
    expect(rules.current()?.bundleVersion).toBe(1);
    await vi.waitFor(() => expect(rules.current()?.bundleVersion).toBe(9));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not recheck on requests while serving the server bundle", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const load = vi.fn(async () => fixture(9));
    const rules = processorRuntime(load, () => fixture(1), 5000);
    await rules.reload();
    vi.setSystemTime(2_000_000);
    rules.current();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps no runtime when neither source is available", async () => {
    const rules = processorRuntime(async () => null, () => null, 5000);
    await rules.reload();
    expect(rules.current()).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../state", () => ({ loadState: vi.fn() }));
vi.mock("../license", () => ({
  heartbeat: vi.fn(async () => ({ jwt: "fresh" })),
  jwtExpired: vi.fn((jwt: string) => jwt !== "fresh")
}));
vi.mock("../learn/recorder", () => ({ flush: vi.fn(async () => "ok") }));
vi.mock("../learn/telemetry", () => ({ flushTelemetry: vi.fn(async () => "ok") }));

import { loadState } from "../state";
import { heartbeat, jwtExpired } from "../license";
import { flush } from "../learn/recorder";
import { flushTelemetry } from "../learn/telemetry";
import { createSpoolSync } from "../daemon/spool-sync";

const loadStateMock = vi.mocked(loadState);
const heartbeatMock = vi.mocked(heartbeat);
const jwtExpiredMock = vi.mocked(jwtExpired);
const flushMock = vi.mocked(flush);
const flushTelemetryMock = vi.mocked(flushTelemetry);

beforeEach(() => {
  vi.clearAllMocks();
  loadStateMock.mockResolvedValue({ jwt: "fresh" } as never);
  jwtExpiredMock.mockImplementation((jwt: string) => jwt !== "fresh");
  heartbeatMock.mockResolvedValue({ jwt: "fresh" } as never);
  flushMock.mockResolvedValue("ok");
  flushTelemetryMock.mockResolvedValue("ok");
});

describe("createSpoolSync", () => {
  it("flushes both spools without heartbeat when jwt is valid", async () => {
    const sync = createSpoolSync("https://x.test");
    await sync();
    expect(flushMock).toHaveBeenCalledWith("https://x.test");
    expect(flushTelemetryMock).toHaveBeenCalledWith("https://x.test");
    expect(heartbeatMock).not.toHaveBeenCalled();
  });

  it("renews via heartbeat instead of flushing when jwt is expired", async () => {
    loadStateMock.mockResolvedValue({ jwt: "stale" } as never);
    const sync = createSpoolSync("https://x.test");
    await sync();
    expect(heartbeatMock).toHaveBeenCalledWith("https://x.test");
    expect(flushMock).not.toHaveBeenCalled();
    expect(flushTelemetryMock).not.toHaveBeenCalled();
  });

  it("renews via heartbeat when a flush reports an auth failure", async () => {
    flushTelemetryMock.mockResolvedValue("auth");
    const sync = createSpoolSync("https://x.test");
    await sync();
    expect(heartbeatMock).toHaveBeenCalledTimes(1);
  });

  it("rate-limits renewals within the cooldown window after a successful renewal", async () => {
    loadStateMock.mockResolvedValue({ jwt: "stale" } as never);
    const sync = createSpoolSync("https://x.test");
    await sync();
    await sync();
    expect(heartbeatMock).toHaveBeenCalledTimes(1);
  });

  it("retries renewal next tick when a transient heartbeat fails to advance the jwt", async () => {
    loadStateMock.mockResolvedValue({ jwt: "stale" } as never);
    heartbeatMock.mockResolvedValue({ jwt: "stale" } as never);
    const sync = createSpoolSync("https://x.test");
    await sync();
    await sync();
    expect(heartbeatMock).toHaveBeenCalledTimes(2);
  });

  it("backs off the cooldown when heartbeat throws a hard error", async () => {
    loadStateMock.mockResolvedValue({ jwt: "stale" } as never);
    heartbeatMock.mockRejectedValue(new Error("boom"));
    const sync = createSpoolSync("https://x.test");
    await sync();
    await sync();
    expect(heartbeatMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing without local state", async () => {
    loadStateMock.mockResolvedValue(null);
    const sync = createSpoolSync("https://x.test");
    await sync();
    expect(flushMock).not.toHaveBeenCalled();
    expect(heartbeatMock).not.toHaveBeenCalled();
  });
});

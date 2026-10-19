import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../transport", () => ({ fetchSigned: vi.fn() }));
vi.mock("../state", () => ({ loadState: vi.fn() }));
vi.mock("../fingerprint", () => ({
  buildFingerprint: vi.fn(async () => ({ fingerprint: "fp", installId: "iid" }))
}));

import { fetchSigned } from "../transport";
import { loadState } from "../state";
import { appendSpool, drainSpool, commitSpool, uploadSpool } from "../learn/spool";
import { loadSettingsCache, saveSettingsCache } from "../settings-cache";
import { markTelemetryNoticeShown } from "../telemetry-hint";

const fetchMock = vi.mocked(fetchSigned);
const loadStateMock = vi.mocked(loadState);

let dir: string;
let origHome: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tkr-spool-up-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
  await saveSettingsCache({ ...(await loadSettingsCache()), telemetryOptIn: true });
  markTelemetryNoticeShown();
  vi.clearAllMocks();
  loadStateMock.mockResolvedValue({
    jwt: "jwt",
    signingSecret: "sec",
    plan: "pro"
  } as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
});

describe("uploadSpool", () => {
  it.each(["learn", "telemetry"] as const)("discards queued %s events when consent has been withdrawn", async (name) => {
    appendSpool(name, { cmd: "ls", rawBytes: 100, filteredBytes: 50 });
    await saveSettingsCache({ ...await loadSettingsCache(), telemetryOptIn: false });
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    expect(await uploadSpool(name, `/api/v1/${name}`)).toBe("empty");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(drainSpool(name)).toEqual([]);
  });
  it.each(["learn", "telemetry"] as const)("holds %s events until the usage-stats notice has been shown once", async (name) => {
    rmSync(join(dir, "telemetry-notice-shown"), { force: true });
    appendSpool(name, { cmd: "ls", tokensSaved: 5, optimized: true });
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    expect(await uploadSpool(name, `/api/v1/${name}`)).toBe("fail");
    expect(fetchMock).not.toHaveBeenCalled();
    markTelemetryNoticeShown();
    expect(await uploadSpool(name, `/api/v1/${name}`)).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![2]).toMatchObject({ events: [{ cmd: "ls", tokensSaved: 5, optimized: true }] });
  });

  it("commits events and returns ok on 2xx", async () => {
    appendSpool("telemetry", { cmd: "ls", tokensSaved: 5, optimized: true });
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    const result = await uploadSpool("telemetry", "/api/v1/telemetry", {});
    expect(result).toBe("ok");
    expect(drainSpool("telemetry")).toHaveLength(0);
  });

  it("retains pending events and returns auth on 401", async () => {
    appendSpool("telemetry", { cmd: "ls", tokensSaved: 5, optimized: true });
    fetchMock.mockResolvedValue({ ok: false, status: 401 } as never);
    const result = await uploadSpool("telemetry", "/api/v1/telemetry", {});
    expect(result).toBe("auth");
    expect(drainSpool("telemetry")).toHaveLength(1);
    commitSpool("telemetry");
  });

  it("returns auth on 403 without committing", async () => {
    appendSpool("telemetry", { cmd: "ls", tokensSaved: 1, optimized: false });
    fetchMock.mockResolvedValue({ ok: false, status: 403 } as never);
    expect(await uploadSpool("telemetry", "/api/v1/telemetry", {})).toBe("auth");
    expect(drainSpool("telemetry")).toHaveLength(1);
    commitSpool("telemetry");
  });

  it("retains pending events and returns fail on 5xx", async () => {
    appendSpool("telemetry", { cmd: "ls", tokensSaved: 1, optimized: false });
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as never);
    expect(await uploadSpool("telemetry", "/api/v1/telemetry", {})).toBe("fail");
    expect(drainSpool("telemetry")).toHaveLength(1);
    commitSpool("telemetry");
  });

  it("retains pending events and returns fail on network error", async () => {
    appendSpool("telemetry", { cmd: "ls", tokensSaved: 1, optimized: false });
    fetchMock.mockRejectedValue(new Error("network down"));
    expect(await uploadSpool("telemetry", "/api/v1/telemetry", {})).toBe("fail");
    expect(drainSpool("telemetry")).toHaveLength(1);
    commitSpool("telemetry");
  });

  it("returns empty when spool has no events", async () => {
    expect(await uploadSpool("telemetry", "/api/v1/telemetry", {})).toBe("empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads in chunks of at most 100 events (server contract max)", async () => {
    for (let i = 0; i < 250; i++) appendSpool("telemetry", { cmd: `c${i}`, tokensSaved: 1, optimized: false });
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    expect(await uploadSpool("telemetry", "/api/v1/telemetry", {})).toBe("ok");
    const sizes = fetchMock.mock.calls.map((c) => (c[2] as { events: unknown[] }).events.length);
    expect(sizes).toEqual([100, 100, 50]);
    expect(drainSpool("telemetry")).toHaveLength(0);
  });

  it("never re-uploads chunks the server already accepted", async () => {
    for (let i = 0; i < 150; i++) appendSpool("telemetry", { cmd: `c${i}`, tokensSaved: 1, optimized: false });
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200 } as never)
      .mockResolvedValueOnce({ ok: false, status: 503 } as never);
    expect(await uploadSpool("telemetry", "/api/v1/telemetry", {})).toBe("fail");
    const remaining = drainSpool("telemetry");
    expect(remaining).toHaveLength(50);
    expect((remaining[0] as { cmd: string }).cmd).toBe("c100");
    commitSpool("telemetry");
  });

  it("uploads learn events whatever plan the local state still records", async () => {
    loadStateMock.mockResolvedValue({ jwt: "jwt", signingSecret: "sec", plan: "trial" } as never);
    appendSpool("learn", { cmd: "ls" });
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    expect(await uploadSpool("learn", "/api/v1/learn", {})).toBe("ok");
    expect(drainSpool("learn")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

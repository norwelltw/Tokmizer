import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../transport", () => ({ fetchSigned: vi.fn(), consumeSignedJson: vi.fn() }));
vi.mock("../fingerprint", () => ({
  buildFingerprint: vi.fn(async () => ({
    fingerprint: "f".repeat(64),
    installId: "11111111-1111-1111-1111-111111111111",
    hostname: "host",
    os: "darwin",
    osVersion: "14.5",
    cpuModel: "m",
    cpuCores: 8,
    macHash: "a".repeat(64),
    usernameHash: "b".repeat(64)
  }))
}));

import { fetchSigned } from "../transport";
import { appendSpool } from "../learn/spool";
import { flushTelemetry, recordTelemetry } from "../learn/telemetry";
import { flush as flushLearn } from "../learn/recorder";
import { loadSettingsCache, saveSettingsCache } from "../settings-cache";
import { saveState, type State } from "../state";
import { setNetwork } from "../network";
import { activate } from "../license";
import { markTelemetryNoticeShown, telemetryNoticeMarker } from "../telemetry-hint";

const fetchMock = vi.mocked(fetchSigned);
let dir: string;
let origHome: string | undefined;

const ANON: State = {
  token: "tokmizer_anon_key",
  jwt: "jwt",
  signingSecret: "s".repeat(32),
  plan: "pro",
  status: "active",
  trialEndsAt: null,
  subEndsAt: null,
  jwtVersion: 1,
  installId: "11111111-1111-1111-1111-111111111111",
  fingerprint: "f".repeat(64),
  pluginVersion: "0.9.58",
  email: "",
  timeZone: "Etc/UTC",
  bonusActive: false,
  linked: false,
  lastHeartbeatOkAt: Date.now()
} as State;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tkr-consent-upload-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
  vi.clearAllMocks();
  await saveState(ANON);
  markTelemetryNoticeShown();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
});

describe("usage stats upload from an install without an account", () => {
  it("reports consent with every upload once usage stats are on", async () => {
    await saveSettingsCache({ ...(await loadSettingsCache()), telemetryOptIn: true });
    await recordTelemetry({ cmd: "npm install left-pad", tokensSaved: 10, optimized: true, telemetryOptIn: true });
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    expect(await flushTelemetry("http://localhost:9")).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [method, path, body, opts] = fetchMock.mock.calls[0]!;
    expect([method, path]).toEqual(["POST", "/api/v1/telemetry"]);
    expect(body).toEqual({ events: [{ cmd: "npm install", tokensSaved: 10, optimized: true }], consent: true });
    expect(opts).toMatchObject({ bearer: "jwt" });
  });

  it("sends nothing before the one-time notice has been shown, and keeps the events for later", async () => {
    rmSync(telemetryNoticeMarker(), { force: true });
    await recordTelemetry({ cmd: "npm install left-pad", tokensSaved: 10, optimized: true, telemetryOptIn: true });
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    expect(await flushTelemetry("http://localhost:9")).toBe("fail");
    expect(fetchMock).not.toHaveBeenCalled();
    markTelemetryNoticeShown();
    expect(await flushTelemetry("http://localhost:9")).toBe("ok");
    expect(fetchMock.mock.calls[0]![2]).toEqual({ events: [{ cmd: "npm install", tokensSaved: 10, optimized: true }], consent: true });
  });

  it("reports consent with every learn upload once usage stats are on", async () => {
    await saveSettingsCache({ ...(await loadSettingsCache()), telemetryOptIn: true });
    appendSpool("learn", { cmd: "ls", filterId: null, rawBytes: 100, filteredBytes: 40 });
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    expect(await flushLearn("http://localhost:9")).toBe("ok");
    const [method, path, body] = fetchMock.mock.calls[0]!;
    expect([method, path]).toEqual(["POST", "/api/v1/learn"]);
    expect(body).toEqual({ events: [{ cmd: "ls", filterId: null, rawBytes: 100, filteredBytes: 40 }], consent: true });
  });

  it("sends nothing while usage stats are off", async () => {
    await saveSettingsCache({ ...(await loadSettingsCache()), telemetryOptIn: false });
    appendSpool("telemetry", { cmd: "ls", tokensSaved: 1, optimized: false });
    expect(await flushTelemetry("http://localhost:9")).toBe("empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing while the network is off", async () => {
    await saveSettingsCache({ ...(await loadSettingsCache()), telemetryOptIn: true });
    appendSpool("telemetry", { cmd: "ls", tokensSaved: 1, optimized: false });
    setNetwork(false);
    await recordTelemetry({ cmd: "ls", tokensSaved: 1, optimized: false, telemetryOptIn: true });
    expect(await flushTelemetry("http://localhost:9")).toBe("fail");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("linking an install that sent usage stats without an account", () => {
  it("passes the install's previous key so its history follows the account", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));
    await expect(activate({ token: "tokmizer_account_key", baseUrl: "http://localhost:9" })).rejects.toThrow();
    expect(fetchMock.mock.calls[0]![2]).toMatchObject({ token: "tokmizer_account_key", previousToken: "tokmizer_anon_key" });
  });

  it("sends no previous key when the install is already linked or relinks the same key", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));
    await saveState({ ...ANON, linked: true });
    await expect(activate({ token: "tokmizer_account_key", baseUrl: "http://localhost:9" })).rejects.toThrow();
    expect(fetchMock.mock.calls[0]![2]).not.toHaveProperty("previousToken");
    await saveState(ANON);
    await expect(activate({ token: "tokmizer_anon_key", baseUrl: "http://localhost:9" })).rejects.toThrow();
    expect(fetchMock.mock.calls.at(-1)![2]).not.toHaveProperty("previousToken");
  });
});

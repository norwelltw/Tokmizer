import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, sign } from "node:crypto";

function signedHeaders(text: string): Record<string, string> {
  const pem = (process.env.TOKMIZER_RESP_SIGNING_PRIVATE_KEY_PEM ?? "").replace(/\\n/g, "\n");
  if (!pem.includes("BEGIN PRIVATE KEY")) return {};
  const ts = Date.now();
  const key = createPrivateKey({ key: pem, format: "pem" });
  const sig = sign(null, Buffer.from(`${ts}.${text}`, "utf8"), key).toString("base64url");
  return { "x-tokmizer-resp-sig": sig, "x-tokmizer-resp-ts": String(ts) };
}

let dir: string;
let origHome: string | undefined;

vi.mock("../transport", async (importActual) => {
  const actual = await importActual<typeof import("../transport")>();
  return { ...actual, fetchSigned: vi.fn() };
});
vi.mock("../bundle", () => ({
  fetchAndVerifyBundles: vi.fn().mockResolvedValue([])
}));
vi.mock("../cache", () => ({
  writeSkill: vi.fn().mockResolvedValue(undefined),
  isFresh: vi.fn().mockResolvedValue(true),
  pruneSkills: vi.fn().mockResolvedValue(undefined),
  installCommand: vi.fn().mockResolvedValue(undefined),
  pruneCommands: vi.fn().mockResolvedValue(undefined),
  recordBundleRefresh: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../settings-client", () => ({
  getSettings: vi.fn().mockResolvedValue({ plan: "smart", settings: {} })
}));
vi.mock("../daemon/client", () => ({
  connectDaemon: vi.fn().mockResolvedValue({
    reload: vi.fn().mockResolvedValue({ ruleCount: 0, bundleVersion: 1 }),
    close: vi.fn()
  })
}));
vi.mock("../fingerprint", () => ({
  buildFingerprint: vi.fn().mockResolvedValue({
    fingerprint: "f".repeat(64),
    installId: "11111111-1111-1111-1111-111111111111"
  })
}));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-hb-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
});

function seedState(extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      token: "tok",
      jwt: "j",
      signingSecret: "s",
      plan: "smart",
      status: "active",
      trialEndsAt: null,
      subEndsAt: null,
      jwtVersion: 1,
      installId: "11111111-1111-1111-1111-111111111111",
      email: "x@y",
      lastSettingsRevision: 0,
      ...extra
    })
  );
}

function mockRes(status: number, body: object | null = null): Response {
  const text = body === null ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(body === null ? {} : signedHeaders(text)),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text)
  } as unknown as Response;
}

async function callHeartbeat() {
  const { heartbeat } = await import("../license");
  return heartbeat("http://localhost");
}

describe("license.heartbeat status branches", () => {
  it("retries a failed settings download at the same server revision", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    const { getSettings } = await import("../settings-client");
    vi.mocked(getSettings).mockRejectedValueOnce(new Error("offline"));
    const response = { jwt: "j2", plan: "smart", status: "active", trialEndsAt: null, subEndsAt: null, jwtVersion: 1, settingsRevision: 3 };
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(200, response));
    await callHeartbeat();
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).lastSettingsRevision).toBe(0);
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(200, response));
    await callHeartbeat();
    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).lastSettingsRevision).toBe(3);
  });
  it("returns null on 401", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(401));
    const r = await callHeartbeat();
    expect(r).toBeNull();
  });

  it("423: keeps identity and flags relinkRequired instead of wiping", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(423));
    const r = await callHeartbeat();
    expect(r).toBeNull();
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(st.token).toBe("tok");
    expect(st.relinkRequired).toBe(true);
  });

  it("426: keeps identity and flags updateRequired instead of wiping", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(426));
    const r = await callHeartbeat();
    expect(r).toBeNull();
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(st.token).toBe("tok");
    expect(st.updateRequired).toBe(true);
  });

  it("451: clears state (killswitch stays destructive)", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(451));
    const r = await callHeartbeat();
    expect(r).toBeNull();
    let cleared = false;
    try {
      readFileSync(join(dir, "state.json"), "utf8");
    } catch {
      cleared = true;
    }
    expect(cleared).toBe(true);
  });

  it("451: prunes paid skill bodies (reducer) as well as commands", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    const { pruneSkills, pruneCommands } = await import("../cache");
    vi.mocked(pruneSkills).mockClear();
    vi.mocked(pruneCommands).mockClear();
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(451));
    await callHeartbeat();
    expect(pruneSkills).toHaveBeenCalledWith([]);
    expect(pruneCommands).toHaveBeenCalledWith([]);
  });

  it("400 stale_ts: flags clockSkewDetected and keeps state", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(
      mockRes(400, { error: "bad_request", message: "Invalid plugin headers", code: "stale_ts" })
    );
    const r = await callHeartbeat();
    expect(r).not.toBeNull();
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(st.token).toBe("tok");
    expect(st.clockSkewDetected).toBe(true);
  });

  it("returns cur on 5xx (soft-fail)", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(503));
    const r = await callHeartbeat();
    expect(r).not.toBeNull();
    expect(r?.plan).toBe("smart");
  });

  it("returns cur on transient 400 (soft-fail for non-auth 4xx)", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(400));
    const r = await callHeartbeat();
    expect(r).not.toBeNull();
    expect(r?.plan).toBe("smart");
  });

  it("returns cur on network exception", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await callHeartbeat();
    expect(r).not.toBeNull();
    expect(r?.plan).toBe("smart");
  });

  it("updates state from successful 200 (plan + revision)", async () => {
    seedState({ lastSettingsRevision: 5 });
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(
      mockRes(200, {
        jwt: "new-jwt",
        plan: "pro",
        status: "active",
        trialEndsAt: null,
        subEndsAt: null,
        jwtVersion: 2,
        settingsRevision: 7
      })
    );
    const r = await callHeartbeat();
    expect(r?.plan).toBe("pro");
    expect(r?.jwt).toBe("new-jwt");
    expect(r?.lastSettingsRevision).toBe(7);
  });

  it("returns null when no state present (not activated)", async () => {
    const r = await callHeartbeat();
    expect(r).toBeNull();
  });

  it("stamps lastHeartbeatOkAt on a successful 200", async () => {
    seedState({ lastHeartbeatOkAt: 1 });
    const { fetchSigned } = await import("../transport");
    const before = Date.now();
    vi.mocked(fetchSigned).mockResolvedValueOnce(
      mockRes(200, {
        jwt: "j2",
        plan: "smart",
        status: "active",
        trialEndsAt: null,
        subEndsAt: null,
        jwtVersion: 1,
        settingsRevision: 0
      })
    );
    const r = await callHeartbeat();
    expect(r?.lastHeartbeatOkAt).toBeGreaterThanOrEqual(before);
  });

  it("does NOT refresh lastHeartbeatOkAt on the cached network-error path", async () => {
    seedState({ lastHeartbeatOkAt: 12345 });
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await callHeartbeat();
    expect(r?.lastHeartbeatOkAt).toBe(12345);
  });
});

describe("license.heartbeat auth-fail healing", () => {
  function readStateFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  }

  it("increments heartbeatAuthFails on 401 and keeps state", async () => {
    seedState({ email: "" });
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(401));
    const r = await callHeartbeat();
    expect(r).toBeNull();
    expect(readStateFile().heartbeatAuthFails).toBe(1);
  });

  it("re-enrolls a fresh anonymous identity after 3 consecutive 401s", async () => {
    seedState({ email: "", plan: "pro", linked: false, heartbeatAuthFails: 2 });
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned)
      .mockResolvedValueOnce(mockRes(401))
      .mockResolvedValueOnce(
        mockRes(200, {
          token: "fresh-tok",
          jwt: "fresh-jwt",
          signingSecret: "fresh-sec",
          plan: "trial",
          status: "active",
          trialEndsAt: null,
          subEndsAt: null,
          jwtVersion: 1
        })
      );
    const r = await callHeartbeat();
    expect(r?.token).toBe("fresh-tok");
    const paths = vi.mocked(fetchSigned).mock.calls.map((c) => c[1]);
    expect(paths).toContain("/api/v1/license/enroll");
    expect(readStateFile().token).toBe("fresh-tok");
  });

  it("flags relinkRequired after 3 consecutive 401s on a linked account without re-enrolling", async () => {
    seedState({ email: "x@y", heartbeatAuthFails: 2 });
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(401));
    const r = await callHeartbeat();
    expect(r).toBeNull();
    const st = readStateFile();
    expect(st.relinkRequired).toBe(true);
    expect(st.token).toBe("tok");
    const paths = vi.mocked(fetchSigned).mock.calls.map((c) => c[1]);
    expect(paths).not.toContain("/api/v1/license/enroll");
  });

  it("flags relinkRequired for a linked install without email instead of re-enrolling", async () => {
    seedState({ email: "", plan: "trial", linked: true, heartbeatAuthFails: 2 });
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(401));
    const r = await callHeartbeat();
    expect(r).toBeNull();
    const st = readStateFile();
    expect(st.relinkRequired).toBe(true);
    expect(st.token).toBe("tok");
    const paths = vi.mocked(fetchSigned).mock.calls.map((c) => c[1]);
    expect(paths).not.toContain("/api/v1/license/enroll");
  });

  it("treats a legacy paid state without email or linked flag as linked", async () => {
    seedState({ email: "", plan: "smart", heartbeatAuthFails: 2 });
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(401));
    const r = await callHeartbeat();
    expect(r).toBeNull();
    const st = readStateFile();
    expect(st.relinkRequired).toBe(true);
    expect(st.token).toBe("tok");
    const paths = vi.mocked(fetchSigned).mock.calls.map((c) => c[1]);
    expect(paths).not.toContain("/api/v1/license/enroll");
  });

  it("persists the heartbeat allowed set as opaque keys", async () => {
    seedState();
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(
      mockRes(200, {
        jwt: "j2",
        plan: "pro",
        status: "active",
        trialEndsAt: null,
        subEndsAt: null,
        jwtVersion: 1,
        settingsRevision: 0,
        allowedFilters: ["git", "secret-family"]
      })
    );
    await callHeartbeat();
    const st = readStateFile();
    const stored = st.allowedFilters as string[];
    expect(stored).toHaveLength(2);
    for (const k of stored) expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(stored).not.toContain("secret-family");
  });

  it("clears the fail counter and relink flag on a successful heartbeat", async () => {
    seedState({
      heartbeatAuthFails: 2,
      relinkRequired: true,
      updateRequired: true,
      clockSkewDetected: true
    });
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(
      mockRes(200, {
        jwt: "j2",
        plan: "smart",
        status: "active",
        trialEndsAt: null,
        subEndsAt: null,
        jwtVersion: 1,
        settingsRevision: 0
      })
    );
    const r = await callHeartbeat();
    expect(r).not.toBeNull();
    const st = readStateFile();
    expect(st.heartbeatAuthFails ?? 0).toBe(0);
    expect(Boolean(st.relinkRequired)).toBe(false);
    expect(Boolean(st.updateRequired)).toBe(false);
    expect(Boolean(st.clockSkewDetected)).toBe(false);
  });
});

describe("license.heartbeat upgrade safety signals", () => {
  const ok = { jwt: "j2", plan: "smart", status: "active", trialEndsAt: null, subEndsAt: null, jwtVersion: 1, settingsRevision: 0 };

  it("sends counters only and applies the server kill switch both ways", async () => {
    seedState();
    writeFileSync(join(dir, "shim-fallbacks"), "x\nx\n");
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(200, { ...ok, failOpen: true }));
    await callHeartbeat();
    const body = vi.mocked(fetchSigned).mock.calls[0]![2] as { health?: Record<string, unknown> };
    expect(body.health).toEqual({ shimFallbacks: 2, staleShims: 0, brokenHooks: 0, globalPathLines: 0, healed: 0, failOpen: false });
    expect(Object.values(body.health!).every((v) => typeof v === "number" || typeof v === "boolean")).toBe(true);
    expect(existsSync(join(dir, "fail-open"))).toBe(true);
    expect(existsSync(join(dir, "shim-fallbacks"))).toBe(false);
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(200, ok));
    await callHeartbeat();
    expect((vi.mocked(fetchSigned).mock.calls[1]![2] as { health: { failOpen: boolean } }).health.failOpen).toBe(true);
    expect(existsSync(join(dir, "fail-open"))).toBe(false);
  });

  it("keeps the counters when the server cannot be reached", async () => {
    seedState();
    writeFileSync(join(dir, "shim-fallbacks"), "x\n");
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockRejectedValueOnce(new Error("offline"));
    await callHeartbeat();
    expect(existsSync(join(dir, "shim-fallbacks"))).toBe(true);
  });

  it("sends no health report when usage stats are off", async () => {
    seedState();
    writeFileSync(join(dir, "settings-cache.json"), JSON.stringify({ enabled: true, telemetryOptIn: false }));
    const { fetchSigned } = await import("../transport");
    vi.mocked(fetchSigned).mockResolvedValueOnce(mockRes(200, ok));
    await callHeartbeat();
    expect((vi.mocked(fetchSigned).mock.calls[0]![2] as { health?: unknown }).health).toBeUndefined();
  });
});

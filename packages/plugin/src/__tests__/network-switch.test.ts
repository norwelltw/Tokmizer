import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const spawnSpy = vi.hoisted(() => vi.fn(() => ({ unref: () => {}, on: () => {} })));
vi.mock("cross-spawn", () => ({ default: spawnSpy }));
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnSpy };
});

import {
  NETWORK_NOTICE,
  NetworkDisabledError,
  networkEnabled,
  networkNoticeLine,
  networkOffFile,
  networkStatusLabel,
  setNetwork
} from "../network";
import { fetchSigned } from "../transport";
import { activate, autoEnroll, heartbeat, maybeAutoEnroll } from "../license";
import { getSettings, patchSettings } from "../settings-client";
import { fetchAndVerifyBundles } from "../bundle";
import { appendSpool, uploadSpool } from "../learn/spool";
import { flushTelemetry } from "../learn/telemetry";
import { flush } from "../learn/recorder";
import { createSpoolSync } from "../daemon/spool-sync";
import { fetchBundle } from "../daemon/runtime";
import { maybeSpawnSelfUpdate, selfUpdate, type SelfUpdateDeps } from "../self-update";
import { kickBackgroundEnroll } from "../exec/wrapper";

const STATE = {
  token: "tokmizer_net_test",
  jwt: "net-test-jwt",
  signingSecret: "net-test-secret",
  plan: "pro",
  status: "active",
  trialEndsAt: null,
  subEndsAt: null,
  jwtVersion: 1,
  installId: "11111111-1111-1111-1111-111111111111",
  fingerprint: "f".repeat(64),
  linked: true,
  email: "user@example.com",
  lastHeartbeatOkAt: 1
};

let home: string;
let fetchSpy: ReturnType<typeof vi.fn>;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["TOKMIZER_HOME", "TOKMIZER_NETWORK", "TOKMIZER_BASE_URL", "TOKMIZER_AUTO_UPDATE", "TOKMIZER_TKR_BIN", "CI", "GITHUB_ACTIONS"];

function seedState(): string {
  const raw = JSON.stringify(STATE);
  writeFileSync(join(home, "state.json"), raw);
  return raw;
}

function seedSpool(): string {
  mkdirSync(join(home, "spool"), { recursive: true });
  const line = JSON.stringify({ cmd: "ls", tokensSaved: 10, optimized: true }) + "\n";
  writeFileSync(join(home, "spool", "telemetry.jsonl"), line);
  writeFileSync(join(home, "spool", "learn.jsonl"), line);
  writeFileSync(join(home, "settings-cache.json"), JSON.stringify({ telemetryOptIn: true }));
  writeFileSync(join(home, "telemetry-notice-shown"), "0.0.0 0");
  return line;
}

function deps(): { d: SelfUpdateDeps; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => ({ code: 0, stdout: "" }));
  return {
    run,
    d: {
      latest: "9.9.9",
      run,
      npmVersion: () => "0.0.1",
      writable: () => true,
      codexInstalled: () => false,
      ensureCodexHook: async () => "added"
    }
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), "tkr-network-"));
  process.env.TOKMIZER_HOME = home;
  process.env.TOKMIZER_BASE_URL = "http://127.0.0.1:1";
  process.env.TOKMIZER_TKR_BIN = process.execPath;
  delete process.env.TOKMIZER_NETWORK;
  delete process.env.TOKMIZER_AUTO_UPDATE;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  fetchSpy = vi.fn(async () => new Response("{}", { status: 503 }));
  vi.stubGlobal("fetch", fetchSpy);
  spawnSpy.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("network switch storage", () => {
  it("is on by default, turns off with a local file and back on", () => {
    expect(networkEnabled()).toBe(true);
    expect(networkStatusLabel()).toBe("on");
    setNetwork(false);
    expect(existsSync(networkOffFile())).toBe(true);
    expect(networkEnabled()).toBe(false);
    expect(networkStatusLabel()).toBe("off");
    setNetwork(true);
    expect(existsSync(networkOffFile())).toBe(false);
    expect(networkEnabled()).toBe(true);
  });

  it.each(["0", "off", "false", "no", " OFF "])("TOKMIZER_NETWORK=%s turns it off without any file", (value) => {
    process.env.TOKMIZER_NETWORK = value;
    expect(networkEnabled()).toBe(false);
    expect(networkStatusLabel()).toBe("off (TOKMIZER_NETWORK)");
    expect(existsSync(networkOffFile())).toBe(false);
  });

  it("keeps the local off switch when TOKMIZER_NETWORK=1", () => {
    setNetwork(false);
    process.env.TOKMIZER_NETWORK = "1";
    expect(networkEnabled()).toBe(false);
  });

  it("shows the first-run notice once, and not while network is off", () => {
    setNetwork(false);
    expect(networkNoticeLine()).toBeNull();
    setNetwork(true);
    expect(networkNoticeLine()).toBe(NETWORK_NOTICE);
    expect(networkNoticeLine()).toBeNull();
  });

  it("states what is sent without claiming anonymity", () => {
    expect(NETWORK_NOTICE).toContain("No account or email is needed");
    expect(NETWORK_NOTICE).toContain("random install ID");
    expect(NETWORK_NOTICE).toContain("nothing that describes your machine");
    expect(NETWORK_NOTICE).toContain("tkr network off");
    expect(NETWORK_NOTICE).toContain("tkr telemetry off");
    expect(NETWORK_NOTICE.toLowerCase()).not.toContain("anonym");
  });

  it("ships the same notice in the Claude Code session hook", () => {
    const hook = readFileSync(resolve("packages/plugin/hooks/on-session-start.mjs"), "utf8");
    for (const line of NETWORK_NOTICE.split("\n")) expect(hook).toContain(JSON.stringify(line));
  });
});

describe.each([
  ["local switch", () => setNetwork(false)],
  ["environment variable", () => { process.env.TOKMIZER_NETWORK = "0"; }]
])("with network off (%s)", (_label, turnOff) => {
  beforeEach(() => turnOff());

  it("refuses every signed request before fetch", async () => {
    await expect(fetchSigned("GET", "/api/v1/rules/bundle", undefined, {
      baseUrl: "http://127.0.0.1:1", fingerprint: "f", installId: "i"
    })).rejects.toBeInstanceOf(NetworkDisabledError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never enrolls and creates no identity files", async () => {
    expect(await maybeAutoEnroll()).toBeNull();
    await expect(autoEnroll("http://127.0.0.1:1")).rejects.toBeInstanceOf(NetworkDisabledError);
    await expect(activate({ token: "tokmizer_x", baseUrl: "http://127.0.0.1:1" })).rejects.toBeInstanceOf(NetworkDisabledError);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const file of ["state.json", "install-id", "enroll-cooldown"]) expect(existsSync(join(home, file))).toBe(false);
  });

  it("skips the heartbeat and leaves the saved state untouched", async () => {
    const raw = seedState();
    const result = await heartbeat("http://127.0.0.1:1");
    expect(result?.token).toBe(STATE.token);
    expect(readFileSync(join(home, "state.json"), "utf8")).toBe(raw);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(existsSync(join(home, "install-id"))).toBe(false);
  });

  it("does not download skills or rules bundles", async () => {
    seedState();
    await expect(fetchAndVerifyBundles("http://127.0.0.1:1")).rejects.toBeInstanceOf(NetworkDisabledError);
    await expect(fetchBundle("http://127.0.0.1:1")).rejects.toBeInstanceOf(NetworkDisabledError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps settings local for a linked account and without any account", async () => {
    seedState();
    expect((await patchSettings({ telemetryOptIn: true })).settings.telemetryOptIn).toBe(true);
    expect((await getSettings()).settings.telemetryOptIn).toBe(true);
    rmSync(join(home, "state.json"));
    expect((await patchSettings({ outputVerbosity: "minimal" })).settings.outputVerbosity).toBe("minimal");
    expect((await getSettings()).plan).toBe("free");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("neither uploads nor drains nor grows the usage spools", async () => {
    seedState();
    const line = seedSpool();
    expect(await flushTelemetry("http://127.0.0.1:1")).toBe("fail");
    expect(await flush("http://127.0.0.1:1")).toBe("fail");
    expect(await uploadSpool("telemetry", "/api/v1/telemetry")).toBe("fail");
    await createSpoolSync("http://127.0.0.1:1")();
    appendSpool("telemetry", { cmd: "git", tokensSaved: 1, optimized: true });
    expect(readFileSync(join(home, "spool", "telemetry.jsonl"), "utf8")).toBe(line);
    expect(readFileSync(join(home, "spool", "learn.jsonl"), "utf8")).toBe(line);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips self-update and the background enroll kick", async () => {
    const { d, run } = deps();
    expect(await selfUpdate(d)).toEqual(["network off"]);
    maybeSpawnSelfUpdate();
    kickBackgroundEnroll();
    expect(run).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(readdirSync(home).filter((f) => f === "enroll-kick" || f === "self-update-last")).toEqual([]);
  });
});

describe("with network on", () => {
  it("keeps the previous behaviour: heartbeat, enroll, uploads and self-update reach out", async () => {
    seedState();
    await heartbeat("http://127.0.0.1:1");
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toContain("http://127.0.0.1:1/api/v1/license/heartbeat");
    fetchSpy.mockClear();
    rmSync(join(home, "state.json"));
    expect(await maybeAutoEnroll("http://127.0.0.1:1")).toBeNull();
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(["http://127.0.0.1:1/api/v1/license/enroll"]);
    seedState();
    seedSpool();
    fetchSpy.mockClear();
    await flushTelemetry("http://127.0.0.1:1");
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(["http://127.0.0.1:1/api/v1/telemetry"]);
    const { d, run } = deps();
    await selfUpdate(d);
    expect(run).toHaveBeenCalled();
    writeFileSync(join(home, "network-notice-shown"), String(Date.now()));
    kickBackgroundEnroll();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});

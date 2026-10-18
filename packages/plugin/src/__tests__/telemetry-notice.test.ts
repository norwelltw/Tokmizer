import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TELEMETRY_NOTICE, telemetryNoticeLine, telemetryNoticeMarker } from "../telemetry-hint";
import { sessionStartOutput } from "../hooks-host/session-recap";
import { setNetwork } from "../network";

let dir: string;
let origHome: string | undefined;
let origNetwork: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-telemetry-notice-"));
  origHome = process.env.TOKMIZER_HOME;
  origNetwork = process.env.TOKMIZER_NETWORK;
  process.env.TOKMIZER_HOME = dir;
  delete process.env.TOKMIZER_NETWORK;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
  if (origNetwork === undefined) delete process.env.TOKMIZER_NETWORK;
  else process.env.TOKMIZER_NETWORK = origNetwork;
});

function env(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    TOKMIZER_HOME: dir,
    TOKMIZER_BASE_URL: "http://127.0.0.1:1",
    TOKMIZER_AUTO_UPDATE: "0",
    TOKMIZER_DAEMON_BIN: join(dir, "disabled-daemon.js"),
    TOKMIZER_CLAUDE_COMMANDS_DIR: join(dir, "commands"),
    XDG_RUNTIME_DIR: ""
  };
  delete out.TOKMIZER_NETWORK;
  return out;
}

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", resolve("packages/plugin/src/bin/tkr.ts"), ...args], {
    encoding: "utf8",
    input: "",
    timeout: 15000,
    env: env()
  });
}

function sessionStart(source = "startup") {
  return spawnSync(process.execPath, ["--import", "tsx", resolve("packages/plugin/src/hooks-host/session-recap.ts")], {
    encoding: "utf8",
    input: JSON.stringify({ session_id: "s-notice", source }),
    timeout: 15000,
    env: env()
  });
}

function seedState(pluginVersion: string, overrides: Record<string, unknown> = {}) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    token: "tokmizer_anon",
    jwt: "test-jwt",
    signingSecret: "test-signing-secret",
    plan: "pro",
    status: "active",
    trialEndsAt: null,
    subEndsAt: null,
    jwtVersion: 1,
    installId: "test-install",
    pluginVersion,
    linked: false,
    lastHeartbeatOkAt: Math.floor(Date.now() / 1000),
    ...overrides
  }));
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("telemetry notice wording", () => {
  it("says what is sent, what is never sent and how to turn it off, on one line", () => {
    expect(TELEMETRY_NOTICE).not.toContain("\n");
    expect(TELEMETRY_NOTICE).toContain("command names and tokens saved");
    expect(TELEMETRY_NOTICE).toContain("never content, files or arguments");
    expect(TELEMETRY_NOTICE).toContain("No account or email needed");
    expect(TELEMETRY_NOTICE).toContain("tkr telemetry off");
    expect(TELEMETRY_NOTICE).toContain("tkr network off");
  });
});

describe("telemetryNoticeLine", () => {
  it("shows once on an upgraded install whose usage stats stayed on, and records it", async () => {
    seedState("0.9.57");
    expect(await telemetryNoticeLine()).toBe(TELEMETRY_NOTICE);
    expect(existsSync(telemetryNoticeMarker())).toBe(true);
    expect(await telemetryNoticeLine()).toBeNull();
  });

  it("shows once on a fresh install that has not enrolled yet", async () => {
    expect(await telemetryNoticeLine()).toBe(TELEMETRY_NOTICE);
    expect(existsSync(telemetryNoticeMarker())).toBe(true);
    expect(await telemetryNoticeLine()).toBeNull();
  });

  it("stays silent while usage stats are off", async () => {
    seedState("0.9.58");
    writeFileSync(join(dir, "settings-cache.json"), JSON.stringify({ telemetryOptIn: false }));
    expect(await telemetryNoticeLine()).toBeNull();
    expect(existsSync(telemetryNoticeMarker())).toBe(false);
  });

  it("waits while the network is off, then shows once it is back on", async () => {
    seedState("0.9.57");
    setNetwork(false);
    expect(await telemetryNoticeLine()).toBeNull();
    expect(existsSync(telemetryNoticeMarker())).toBe(false);
    setNetwork(true);
    expect(await telemetryNoticeLine()).toBe(TELEMETRY_NOTICE);
  });

  it("stays silent when TOKMIZER_NETWORK turns the network off", async () => {
    seedState("0.9.57");
    process.env.TOKMIZER_NETWORK = "0";
    expect(await telemetryNoticeLine()).toBeNull();
  });
});

describe("session start channel", () => {
  it("shows the notice to the user without adding it to the agent context", () => {
    expect(JSON.parse(sessionStartOutput(null, TELEMETRY_NOTICE)!)).toEqual({ systemMessage: TELEMETRY_NOTICE });
    expect(JSON.parse(sessionStartOutput("recap", TELEMETRY_NOTICE)!)).toEqual({
      systemMessage: TELEMETRY_NOTICE,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "recap" }
    });
    expect(sessionStartOutput("recap", null)).toBe("recap");
    expect(sessionStartOutput(null, null)).toBeNull();
  });

  it("prints the notice at the first session of a fresh install, before any enrollment, then never again", () => {
    const first = sessionStart();
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ systemMessage: TELEMETRY_NOTICE });
    expect(sessionStart().stdout).toBe("");
  });

  it("prints the notice at the first session after an upgrade, then never again", () => {
    seedState("0.9.57");
    const first = sessionStart();
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ systemMessage: TELEMETRY_NOTICE });
    const second = sessionStart();
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
    const status = run("status");
    expect(status.stdout).not.toContain(TELEMETRY_NOTICE);
  });
});

describe("CLI", () => {
  it("shows the notice on the first tkr status after an upgrade only", () => {
    seedState("0.9.57");
    const first = run("status");
    expect(first.status).toBe(0);
    expect(count(first.stdout, TELEMETRY_NOTICE)).toBe(1);
    expect(readFileSync(telemetryNoticeMarker(), "utf8")).toMatch(/^\d+\.\d+\.\d+ \d+$/);
    expect(run("status").stdout).not.toContain(TELEMETRY_NOTICE);
    expect(run("gain").stdout).not.toContain(TELEMETRY_NOTICE);
  });

  it("does not show it on an install that turned usage stats off", () => {
    seedState("0.9.58");
    writeFileSync(join(dir, "settings-cache.json"), JSON.stringify({ telemetryOptIn: false }));
    expect(run("status").stdout).not.toContain(TELEMETRY_NOTICE);
    expect(existsSync(telemetryNoticeMarker())).toBe(false);
  });

  it("prints it once when usage stats are turned back on without an account", () => {
    seedState("0.9.58");
    writeFileSync(join(dir, "settings-cache.json"), JSON.stringify({ telemetryOptIn: false }));
    const on = run("telemetry", "on");
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("Telemetry on.");
    expect(on.stdout).toContain(TELEMETRY_NOTICE);
    expect(run("status").stdout).not.toContain(TELEMETRY_NOTICE);
  });

  it("explains the state in tkr telemetry status", () => {
    seedState("0.9.57");
    const status = run("telemetry", "status");
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("Telemetry: on");
    expect(status.stdout).toContain("Network: on");
    expect(status.stdout).toContain("Account: none (stats are tied to this install's random key)");
    expect(status.stdout).toContain("Sent: command names, token counts, session ID, agent name and install health counts. Never arguments, output, file contents or paths.");
    expect(status.stdout).toContain("tkr network off");
    expect(run("status").stdout).not.toContain(TELEMETRY_NOTICE);
  });

  it("says nothing is sent while the network is off", () => {
    seedState("0.9.57");
    writeFileSync(join(dir, "network-off"), "1");
    const status = run("telemetry", "status");
    expect(status.stdout).toContain("Network: off");
    expect(status.stdout).toContain("Sent: nothing while network is off.");
    expect(existsSync(telemetryNoticeMarker())).toBe(false);
  });

  it("says nothing is sent once usage stats are off", () => {
    seedState("0.9.58");
    writeFileSync(join(dir, "settings-cache.json"), JSON.stringify({ telemetryOptIn: false }));
    expect(run("telemetry", "status").stdout).toContain("Sent: nothing.");
  });
});

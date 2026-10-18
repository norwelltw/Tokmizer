import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TELEMETRY_NOTICE } from "../telemetry-hint";

type Seen = { method: string; url: string; body: unknown };
type Run = { status: number | null; stdout: string; stderr: string };

const cli = resolve("packages/plugin/src/bin/tkr.ts");
const seen: Seen[] = [];
let server: Server;
let baseUrl: string;
let home: string;

function signedHeaders(text: string): Record<string, string> {
  const pem = (process.env.TOKMIZER_RESP_SIGNING_PRIVATE_KEY_PEM ?? "").replace(/\\n/g, "\n");
  const ts = Date.now();
  const sig = sign(null, Buffer.from(`${ts}.${text}`, "utf8"), createPrivateKey({ key: pem, format: "pem" })).toString("base64url");
  return { "x-tokmizer-resp-sig": sig, "x-tokmizer-resp-ts": String(ts), "content-type": "application/json" };
}

function reply(res: ServerResponse, status: number, body: unknown, signed = true): void {
  const text = JSON.stringify(body);
  res.writeHead(status, signed ? signedHeaders(text) : { "content-type": "application/json" });
  res.end(text);
}

const ENROLLED = { token: "tokmizer_mock_anon", jwt: "mock-jwt", signingSecret: "s".repeat(32), plan: "pro", status: "active", trialEndsAt: null, subEndsAt: null, jwtVersion: 1 };

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";
  if (req.method === "POST" && url === "/api/v1/license/enroll") return reply(res, 200, ENROLLED);
  if (req.method === "POST" && url === "/api/v1/license/heartbeat") {
    return reply(res, 200, { jwt: "mock-jwt", plan: "pro", status: "active", trialEndsAt: null, subEndsAt: null, jwtVersion: 1, settingsRevision: 0, latestPluginVersion: "0.0.1", bonusActive: false });
  }
  if (req.method === "POST" && (url === "/api/v1/telemetry" || url === "/api/v1/learn")) return reply(res, 200, {}, false);
  reply(res, 404, { error: "not found" }, false);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += String(chunk); });
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {}
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      handle(req, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  seen.length = 0;
  home = mkdtempSync(join(tmpdir(), "tkr-fresh-telemetry-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[], extra: Record<string, string> = {}): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
      env: {
        ...process.env,
        CI: "",
        GITHUB_ACTIONS: "",
        TOKMIZER_NETWORK: "",
        TOKMIZER_HOME: home,
        TOKMIZER_BASE_URL: baseUrl,
        TOKMIZER_AUTO_UPDATE: "0",
        TOKMIZER_DAEMON_BIN: join(home, "disabled-daemon.js"),
        TOKMIZER_CLAUDE_COMMANDS_DIR: join(home, "commands"),
        XDG_RUNTIME_DIR: "",
        ...extra
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    const timer = setTimeout(() => child.kill(), 20000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

const requests = (): string[] => seen.map((s) => `${s.method} ${s.url}`);
const telemetryUploads = (): Seen[] => seen.filter((s) => s.url === "/api/v1/telemetry");
const cache = (): Record<string, unknown> => JSON.parse(readFileSync(join(home, "settings-cache.json"), "utf8")) as Record<string, unknown>;

function queueEvent(): void {
  mkdirSync(join(home, "spool"), { recursive: true });
  writeFileSync(join(home, "spool", "telemetry.jsonl"), JSON.stringify({ cmd: "npm install", tokensSaved: 10, optimized: true }) + "\n");
}

function queuedEvents(): number {
  return ["telemetry.jsonl", "telemetry.pending.jsonl"]
    .map((f) => join(home, "spool", f))
    .filter((f) => existsSync(f))
    .flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => l.trim()))
    .length;
}

function seedEnrolled(): void {
  writeFileSync(join(home, "state.json"), JSON.stringify({ ...ENROLLED, installId: "11111111-1111-1111-1111-111111111111", linked: false, pluginVersion: "0.9.60", lastHeartbeatOkAt: Date.now() }));
}

describe("usage stats on a fresh install without an account", () => {
  it("tkr telemetry on enrolls, keeps the choice, shows the notice once and uploads with consent", async () => {
    const on = await run(["telemetry", "on"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("Telemetry on.");
    expect(on.stdout).toContain(TELEMETRY_NOTICE);
    expect(on.stdout).not.toContain("Not activated");
    expect(on.stdout).not.toContain("Could not reach");
    expect(requests()).toContain("POST /api/v1/license/enroll");
    expect(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).token).toBe("tokmizer_mock_anon");
    expect(cache().telemetryOptIn).toBe(true);
    expect(existsSync(join(home, "telemetry-notice-shown"))).toBe(true);

    queueEvent();
    const hb = await run(["heartbeat"]);
    expect(hb.status).toBe(0);
    const uploads = telemetryUploads();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.body).toEqual({ events: [{ cmd: "npm install", tokensSaved: 10, optimized: true }], consent: true });
    expect(queuedEvents()).toBe(0);
  });

  it("is on by default and uploads nothing until the one-time notice has been shown", async () => {
    queueEvent();
    const silent = await run(["heartbeat"]);
    expect(silent.status).toBe(0);
    expect(requests()).toContain("POST /api/v1/license/enroll");
    expect(telemetryUploads()).toHaveLength(0);
    expect(queuedEvents()).toBe(1);

    const status = await run(["status"]);
    expect(status.stdout).toContain(TELEMETRY_NOTICE);
    const hb = await run(["heartbeat"]);
    expect(hb.status).toBe(0);
    expect(telemetryUploads()).toHaveLength(1);
    expect(telemetryUploads()[0]!.body).toMatchObject({ consent: true });
    expect(queuedEvents()).toBe(0);
  });

  it("offline: tkr telemetry on keeps the choice locally and says it activates when online, never Not activated", async () => {
    const on = await run(["telemetry", "on"], { TOKMIZER_BASE_URL: "http://127.0.0.1:1" });
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("Telemetry on.");
    expect(on.stdout).toContain("Could not reach tokmizer.com right now. Usage stats stay on this machine and are sent once Tokmizer is online.");
    expect(on.stdout).toContain(TELEMETRY_NOTICE);
    expect(on.stdout).not.toContain("Not activated");
    expect(existsSync(join(home, "state.json"))).toBe(false);
    expect(cache().telemetryOptIn).toBe(true);
    expect((await run(["telemetry", "status"], { TOKMIZER_BASE_URL: "http://127.0.0.1:1" })).stdout).toContain("Telemetry: on");

    rmSync(join(home, "enroll-cooldown"), { force: true });
    queueEvent();
    const hb = await run(["heartbeat"]);
    expect(hb.status).toBe(0);
    expect(requests()).toContain("POST /api/v1/license/enroll");
    expect(telemetryUploads()).toHaveLength(1);
    expect(telemetryUploads()[0]!.body).toMatchObject({ consent: true });
  });

  it("an explicit opt-out is respected: nothing is uploaded and the queue is dropped", async () => {
    seedEnrolled();
    const off = await run(["telemetry", "off"]);
    expect(off.status).toBe(0);
    expect(off.stdout).toContain("Telemetry off.");
    expect(cache().telemetryOptIn).toBe(false);
    writeFileSync(join(home, "telemetry-notice-shown"), "0.0.0 0");
    queueEvent();
    expect((await run(["heartbeat"])).status).toBe(0);
    expect(telemetryUploads()).toHaveLength(0);
    expect(queuedEvents()).toBe(0);
    expect(cache().telemetryOptIn).toBe(false);
  });

  it("network off wins over everything: no request leaves the machine", async () => {
    seedEnrolled();
    writeFileSync(join(home, "telemetry-notice-shown"), "0.0.0 0");
    queueEvent();
    const hb = await run(["heartbeat"], { TOKMIZER_NETWORK: "0" });
    expect(hb.status).toBe(1);
    expect(seen).toHaveLength(0);
    const status = await run(["telemetry", "status"], { TOKMIZER_NETWORK: "0" });
    expect(status.stdout).toContain("Network: off");
    expect(status.stdout).toContain("Sent: nothing while network is off.");
    expect(queuedEvents()).toBe(1);
  });
});

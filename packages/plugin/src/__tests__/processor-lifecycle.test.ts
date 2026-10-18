import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import { PLUGIN_VERSION } from "../version";
import { buildDefaultRules } from "../default-rules-build";
import { FrameReader, encodeProcessingFrame } from "../exec/processing-protocol";
import { processingPipeName } from "../exec/processing-endpoint";

let home: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tkr-proc-")));
});

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

function start(idleMs = 60_000, extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("packages/plugin/src/bin/tkr-processor.ts")], {
    env: { ...process.env, TOKMIZER_HOME: home, TOKMIZER_PROCESSOR_IDLE_MS: String(idleMs), TOKMIZER_BASE_URL: "http://127.0.0.1:9", TOKMIZER_AUTO_UPDATE: "0", TOKMIZER_TKR_BIN: join(home, "missing-tkr.js"), ...extra },
    stdio: "ignore"
  });
  children.push(child);
  return child;
}

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const descriptor = (): string => join(home, "run", `processing-${PLUGIN_VERSION}.json`);
const lock = (): string => join(home, "run", `processor-${PLUGIN_VERSION}.pid`);
const exited = (child: ChildProcess): Promise<number | null> => child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((r) => child.once("exit", r));

async function admission(): Promise<unknown> {
  const value = JSON.parse(readFileSync(descriptor(), "utf8"));
  const socket = createConnection(value.path);
  socket.on("error", () => {});
  await once(socket, "connect");
  const frame = new Promise<Buffer | null>((done) => {
    const reader = new FrameReader(() => 1024 * 1024, done);
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.once("close", () => done(null));
  });
  socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify({ protocol: 2, version: PLUGIN_VERSION, token: value.token, home, argv: ["ls"], host: "shell", restoreDisabled: true, timeoutMs: 1000 }))));
  const response = await frame;
  socket.destroy();
  return response ? JSON.parse(response.toString()) : null;
}

describe("Windows processing pipe name", () => {
  it("is scoped per user and version with a random suffix inside the tokmizer namespace", () => {
    expect(processingPipeName("alice", "0.9.56", "1a2b3c4d")).toBe("\\\\.\\pipe\\tokmizer-p-alice-0.9.56-1a2b3c4d");
    expect(processingPipeName("DOMAIN\\Jos\u00e9 Smith", "1.0.0", "ffffffff")).toBe("\\\\.\\pipe\\tokmizer-p-DOMAIN_Jos__Smith-1.0.0-ffffffff");
    expect(processingPipeName("", "1.0.0", "00000000")).toBe("\\\\.\\pipe\\tokmizer-p-user-1.0.0-00000000");
    expect(processingPipeName("x".repeat(300), "1.0.0", "00000000").length).toBeLessThan(120);
  });
});

describe.skipIf(process.platform === "win32")("version-scoped processor", () => {
  it("admits commands with the built-in rules on a fresh home without account state", async () => {
    start(60_000, { TOKMIZER_DEFAULT_RULES: await buildDefaultRules() });
    await waitFor(() => existsSync(descriptor()));
    expect(existsSync(join(home, "state.json"))).toBe(false);
    expect(await admission()).toEqual({ ok: true, protocol: 2, yolo: false });
  });

  it("refuses commands when no rules are available at all", async () => {
    start(60_000, { TOKMIZER_DEFAULT_RULES: "" });
    await waitFor(() => existsSync(descriptor()));
    expect(await admission()).toBeNull();
  });

  it("publishes a private descriptor and socket for its own version", async () => {
    start();
    await waitFor(() => existsSync(descriptor()));
    const value = JSON.parse(readFileSync(descriptor(), "utf8"));
    expect(value).toMatchObject({ protocol: 2, version: PLUGIN_VERSION, home });
    expect(lstatSync(value.path).isSocket()).toBe(true);
    expect(lstatSync(descriptor()).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "run", "processing.json"))).toBe(false);
  });

  it("runs a single instance per version", async () => {
    const first = start();
    await waitFor(() => existsSync(descriptor()));
    const second = start();
    expect(await exited(second)).toBe(0);
    expect(first.exitCode).toBeNull();
    expect(Number(readFileSync(lock(), "utf8"))).toBe(first.pid);
  });

  it("replaces a lock left by a dead process", async () => {
    mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
    writeFileSync(lock(), "999999", { mode: 0o600 });
    const child = start();
    await waitFor(() => existsSync(descriptor()));
    expect(Number(readFileSync(lock(), "utf8"))).toBe(child.pid);
  });

  it("exits when idle and removes its descriptor, socket and lock", async () => {
    const child = start(300);
    await waitFor(() => existsSync(descriptor()));
    const socket = JSON.parse(readFileSync(descriptor(), "utf8")).path;
    expect(await exited(child)).toBe(0);
    expect(existsSync(descriptor())).toBe(false);
    expect(existsSync(lock())).toBe(false);
    expect(existsSync(socket)).toBe(false);
  });

  it.skipIf(!existsSync(resolve("packages/plugin/dist/bin/tkr-processor.js")))("keeps the bundled processor running instead of exiting through a hook entry point", async () => {
    const child = spawn(process.execPath, [resolve("packages/plugin/dist/bin/tkr-processor.js")], {
      env: { ...process.env, TOKMIZER_HOME: home, TOKMIZER_BASE_URL: "http://127.0.0.1:9", TOKMIZER_AUTO_UPDATE: "0" },
      stdio: "ignore"
    });
    children.push(child);
    await waitFor(() => existsSync(descriptor()));
    await new Promise((r) => setTimeout(r, 1500));
    expect(child.exitCode).toBeNull();
  });

  it("cleans up on SIGTERM", async () => {
    const child = start();
    await waitFor(() => existsSync(descriptor()));
    child.kill("SIGTERM");
    expect(await exited(child)).toBe(0);
    expect(existsSync(descriptor())).toBe(false);
    expect(existsSync(lock())).toBe(false);
  });
});

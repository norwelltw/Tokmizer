import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { processCapturedOutput, runWrapped } from "../exec/wrapper";
import { setFilterResolver, type FilterResolver } from "../engine";
import { FilterDef } from "../engine/schema";
import { Settings } from "../contracts";
import { loadSettingsCache } from "../settings-cache";
import { recordTelemetry } from "../learn/telemetry";
import { closeDaemonResolver, installDaemonResolver } from "../daemon/resolver";
import { readContentCache } from "../content-cache";
import { setYoloMode } from "../yolo-mode";
import { startProcessingServer } from "../exec/processing-server";
import { FrameReader, encodeProcessingFrame, encodeCapturedFrame } from "../exec/processing-protocol";

vi.mock("../state", () => ({ loadState: vi.fn().mockResolvedValue({ token: "fixture", plan: "pro", allowedFilters: ["captured"] }) }));
vi.mock("../settings-cache", () => ({ loadSettingsCache: vi.fn() }));
vi.mock("../learn/recorder", () => ({ recordEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../learn/telemetry", () => ({ recordTelemetry: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../daemon/resolver", () => ({ installDaemonResolver: vi.fn(), closeDaemonResolver: vi.fn() }));

const stdout = Array.from({ length: 160 }, (_, i) => `record ${i}: preserved details é😀 ${i * 19}`).join("\n");
const stderr = "diagnostic stderr\n";
const definition = FilterDef.parse({ slug: "captured", match_command: ".*", max_lines: 20 });
const resolver: FilterResolver = async () => ({ ...definition, matchRegex: /.*/ });
let home: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tkr-captured-"));
  vi.stubEnv("TOKMIZER_HOME", home);
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  vi.mocked(loadSettingsCache).mockResolvedValue(Settings.parse({ outputVerbosity: "minimal", telemetryOptIn: false }));
  setFilterResolver(resolver);
  await setYoloMode(false);
  vi.clearAllMocks();
});

afterEach(() => {
  setFilterResolver(null);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function captured(exitCode = 0) {
  return { argv: ["demo"], stdout, stderr, exitCode, truncated: false, stderrTruncated: false };
}

describe("shared completed-command processing", () => {
  it.each([
    ["normal", false], ["compact", false], ["minimal", false], ["minimal", true]
  ] as const)("matches the executing wrapper for %s, YOLO=%s", async (outputVerbosity, yolo) => {
    await setYoloMode(yolo);
    vi.mocked(loadSettingsCache).mockResolvedValue(Settings.parse({ outputVerbosity, telemetryOptIn: false }));
    const argv = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)})`];
    const legacy = await runWrapped(argv);
    const shared = await processCapturedOutput({ ...captured(), argv }, { yolo, env: process.env, resolver });
    expect(shared).toEqual(legacy);
    const rows = readFileSync(join(home, "stats.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows.map(({ r, f }) => [r, f])).toEqual(Array(2).fill([
      Buffer.byteLength(stdout + stderr), Buffer.byteLength(shared.stdout + shared.stderr)
    ]));
  });

  it("isolates caller cache limits, consent metadata and host during overlapping requests", async () => {
    const contexts = [
      { CODEX_CLI: "1", CLAUDE_CODE_SESSION_ID: "first", TOKMIZER_CCR_DISABLED: "1" },
      { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "second" }
    ];
    const [first, second] = await Promise.all(contexts.map((env) => processCapturedOutput(captured(), { yolo: false, env, resolver })));
    expect(first.stdout).not.toContain("tkr restore");
    const hash = /\[tkr restore ([0-9a-f]+)\]/.exec(second.stdout)?.[1];
    expect(hash).toBeDefined();
    expect(await readContentCache(hash!)).toContain("record 80:");
    expect(recordTelemetry).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "first", host: "codex", telemetryOptIn: false }));
    expect(recordTelemetry).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "second", host: "claude-code", telemetryOptIn: false }));
    expect(installDaemonResolver).not.toHaveBeenCalled();
    expect(closeDaemonResolver).not.toHaveBeenCalled();
    const limited = await processCapturedOutput(captured(), { yolo: false, env: { TOKMIZER_CCR_ENTRY_MAX_BYTES: "1" }, resolver });
    expect(limited.stdout).not.toContain("tkr restore");
  });

  it("returns the captured failure unchanged if processing fails without executing its argv", async () => {
    const result = await processCapturedOutput({ ...captured(23), argv: ["this-command-must-not-run"] }, {
      yolo: false,
      env: {},
      resolver: async () => { throw new Error("processing unavailable"); }
    });
    expect(result).toEqual({ stdout, stderr, code: 23, filterId: null, rawBytes: Buffer.byteLength(stdout), filteredBytes: Buffer.byteLength(stdout), truncated: false });
    expect(recordTelemetry).not.toHaveBeenCalled();
  });

  it("records deferred accounting only after delivery, at most once", async () => {
    let commit: (() => Promise<void>) | undefined;
    await processCapturedOutput(captured(), {
      yolo: false, env: {}, resolver,
      deferAccounting: (account) => { commit = account; }
    });
    expect(commit).toBeDefined();
    expect(recordTelemetry).not.toHaveBeenCalled();
    await expect(import("node:fs/promises").then((fs) => fs.stat(join(home, "stats.jsonl")))).rejects.toThrow();
    await Promise.all([commit!(), commit!()]);
    expect(readFileSync(join(home, "stats.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(recordTelemetry).toHaveBeenCalledTimes(1);
  });

  it("honors consent withdrawn while delivery is pending", async () => {
    let commit: (() => Promise<void>) | undefined;
    vi.mocked(loadSettingsCache).mockResolvedValue(Settings.parse({ telemetryOptIn: true }));
    await processCapturedOutput(captured(), {
      yolo: false, env: {}, resolver,
      deferAccounting: (account) => { commit = account; }
    });
    vi.mocked(loadSettingsCache).mockResolvedValue(Settings.parse({ telemetryOptIn: false }));
    await commit!();
    expect(recordTelemetry).toHaveBeenCalledWith(expect.objectContaining({ telemetryOptIn: false }));
  });

  it.skipIf(process.platform === "win32").each([
    ["normal", false], ["compact", false], ["minimal", false], ["minimal", true]
  ] as const)("delivers real processing through authenticated IPC for %s, YOLO=%s", async (outputVerbosity, yolo) => {
    await setYoloMode(yolo);
    vi.mocked(loadSettingsCache).mockResolvedValue(Settings.parse({ outputVerbosity, telemetryOptIn: false }));
    const expected = await processCapturedOutput(captured(), { yolo, env: {}, resolver });
    const path = join(home, "p.sock");
    const runtime = { signedAt: Date.now(), fetchedAt: Date.now(), startedAt: Date.now(), bundleVersion: 1, ruleCount: 1, selectFor: () => ({ ...definition, matchRegex: /.*/ }) };
    const server = await startProcessingServer({ path, token: "a".repeat(64), version: "test", getRuntime: () => runtime });
    const socket = createConnection(path);
    socket.on("error", () => {});
    try {
      await once(socket, "connect");
      const received: Buffer[] = [];
      const completed = new Promise<void>((resolve, reject) => {
        const reader = new FrameReader(() => 21 * 1024 * 1024, (frame) => {
          received.push(frame);
          if (received.length === 1) socket.write(encodeProcessingFrame(encodeCapturedFrame(captured())));
          else if (received.length === 2) socket.write(encodeProcessingFrame(Buffer.from([1])));
          else resolve();
        });
        socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch (error) { reject(error); } });
        socket.once("close", () => { if (received.length < 3) reject(new Error("incomplete delivery")); });
      });
      socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify({ protocol: 2, version: "test", token: "a".repeat(64), home: realpathSync(home), argv: ["demo"], host: "shell", restoreDisabled: false, timeoutMs: 1000 }))));
      await completed;
      expect(JSON.parse(received[0]!.toString()).yolo).toBe(yolo);
      const response = received[1]!;
      const length = response.readUInt32BE(0);
      expect(response.subarray(8, 8 + length).toString()).toBe(expected.stdout);
      expect(response.subarray(8 + length).toString()).toBe(expected.stderr);
      const rows = readFileSync(join(home, "stats.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toHaveLength(2);
      expect(rows[1].r).toBe(rows[0].r);
      expect(rows[1].f).toBe(rows[0].f);
    } finally {
      socket.destroy();
      await server.close();
    }
  });
});

describe("stderr of a command whose exit code is unknown", () => {
  it("is shortened like the stderr of a successful command", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `   Compiling crate-${i} v0.1.${i}`).join("\n") + "\n";
    const run = (exitCode: number | null) => processCapturedOutput({ argv: ["demo"], stdout: "", stderr: long, exitCode, truncated: false, stderrTruncated: false }, { yolo: false, env: process.env, resolver });
    const known = await run(0);
    const unknown = await run(null);
    expect(known.stderr.length).toBeLessThan(long.length);
    expect(unknown.stderr.length).toBe(known.stderr.length);
  });
});

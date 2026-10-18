import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processorDescriptorName, startProcessingEndpoint } from "../exec/processing-endpoint";
import { postToolUseResponse } from "../hooks-host/post-tool-process";
import type { DaemonRuntime } from "../daemon/runtime";

vi.mock("../hooks-host/post-tool-process", () => ({ postToolUseResponse: vi.fn() }));

const binary = process.env.TOKMIZER_NATIVE_TEST_BIN;
let home: string;
let server: Awaited<ReturnType<typeof startProcessingEndpoint>>;
let env: NodeJS.ProcessEnv;
let activity: number;
const runtime: DaemonRuntime = { signedAt: Date.now(), fetchedAt: Date.now(), startedAt: Date.now(), bundleVersion: 1, ruleCount: 1, selectFor: () => null };

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tkr-native-post-")));
  vi.stubEnv("TOKMIZER_HOME", home);
  activity = 0;
  vi.mocked(postToolUseResponse).mockReset().mockResolvedValue("ENVELOPE");
  server = await startProcessingEndpoint(() => runtime, () => { activity += 1; });
  const fallback = join(home, "fallback.mjs");
  writeFileSync(fallback, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(home, "fallback-ran"))}, "1");\nfor await (const chunk of process.stdin) process.stdout.write(chunk);`);
  const processor = join(home, "processor.mjs");
  writeFileSync(processor, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(home, "processor-spawned"))}, "1");`);
  env = { ...process.env, TOKMIZER_HOME: home, TOKMIZER_POST_TOOL_JS: fallback, TOKMIZER_PROCESSOR_JS: processor, TOKMIZER_NODE_BIN: process.execPath };
  for (const name of ["TOKMIZER_DEV", "TOKMIZER_BASE_URL", "TOKMIZER_FILTERS_DIR", "TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM", "TOKMIZER_MAX_BUNDLE_AGE_MS"]) delete env[name];
});

afterEach(async () => {
  await server?.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function run(input: string | Buffer, args = ["--post-tool-use"]) {
  return new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve) => {
    setImmediate(() => {
      const result = spawnSync(binary!, args, { env, input, timeout: 10000 });
      resolve({ stdout: result.stdout.toString(), stderr: result.stderr.toString(), status: result.status });
    });
  });
}

async function runAsync(input: string, args = ["--post-tool-use"]) {
  const { spawn } = await import("node:child_process");
  const child = spawn(binary!, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  const done = new Promise<{ stdout: string; status: number | null }>((resolve) => child.once("close", (status) => resolve({ stdout: Buffer.concat(out).toString(), status })));
  child.stdin.end(input);
  return done;
}

const read = { tool_name: "Read", tool_input: { file_path: "/x.ts" }, tool_response: { file: { content: "z".repeat(4000) } } };

describe.skipIf(!binary || process.platform === "win32")("native post-tool-use hook", () => {
  it("returns immediately for an already wrapped command without the service or Node", async () => {
    const wrapped = { tool_name: "Bash", tool_input: { command: "'/p/dist/bin/tkr-exec' cat big.log" }, tool_response: { stdout: "x".repeat(5000), stderr: "" } };
    expect(await run(JSON.stringify(wrapped))).toEqual({ stdout: "", stderr: "", status: 0 });
    expect(activity).toBe(0);
    expect(existsSync(join(home, "fallback-ran"))).toBe(false);
  });

  it.each(["tkr restore 0123abcd", "node /p/tkr.js restore 0123abcd"])("returns immediately for %s", async (command) => {
    expect(await run(JSON.stringify({ tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "x".repeat(5000) } }))).toEqual({ stdout: "", stderr: "", status: 0 });
    expect(activity).toBe(0);
  });

  it("returns immediately for a Codex payload, which cannot take a Claude Code output", async () => {
    const codex = { ...read, hook_event_name: "PostToolUse", turn_id: "t1", model: "gpt-5.5" };
    for (const args of [undefined, []] as const) expect(await run(JSON.stringify(codex), args as never)).toEqual({ stdout: "", stderr: "", status: 0 });
    expect(activity).toBe(0);
    expect(existsSync(join(home, "fallback-ran"))).toBe(false);
  });

  it("ignores tools the hook does not cover and malformed input, like the JavaScript hook", async () => {
    for (const input of [JSON.stringify({ tool_name: "Edit", tool_input: {} }), "not json", "[1]"]) {
      expect(await run(input)).toEqual({ stdout: "", stderr: "", status: 0 });
    }
    expect(activity).toBe(0);
  });

  it("delivers the service response for a native tool output", async () => {
    expect(await runAsync(JSON.stringify(read))).toEqual({ stdout: "ENVELOPE", status: 0 });
    expect(vi.mocked(postToolUseResponse).mock.calls[0]![0]).toEqual(read);
    expect(existsSync(join(home, "fallback-ran"))).toBe(false);
  });

  it("routes an untagged PostToolUse payload exactly like --post-tool-use", async () => {
    const tagged = { hook_event_name: "PostToolUse", ...read };
    expect(await runAsync(JSON.stringify(tagged), [])).toEqual(await runAsync(JSON.stringify(tagged)));
    expect(await runAsync(JSON.stringify(tagged), [])).toEqual({ stdout: "ENVELOPE", status: 0 });
    expect(vi.mocked(postToolUseResponse).mock.calls[0]![0]).toEqual(tagged);
    const wrapped = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "'/p/dist/bin/tkr-exec' cat big.log" }, tool_response: { stdout: "x" } };
    expect(await run(JSON.stringify(wrapped), [])).toEqual({ stdout: "", stderr: "", status: 0 });
    await server!.close();
    server = null;
    expect(await run(JSON.stringify(tagged), [])).toEqual({ stdout: JSON.stringify(tagged), stderr: "", status: 0 });
  });

  it("exits silently without arguments for garbage input", async () => {
    for (const input of ["", "garbage", Buffer.from([0xff, 0, 0xfe])]) {
      expect(await run(input, [])).toEqual({ stdout: "", stderr: "", status: 0 });
    }
    expect(existsSync(join(home, "fallback-ran"))).toBe(false);
  });

  it("prints nothing when the service has nothing to change", async () => {
    vi.mocked(postToolUseResponse).mockResolvedValue("");
    expect(await runAsync(JSON.stringify(read))).toEqual({ stdout: "", status: 0 });
  });

  it("falls back to the JavaScript hook with the exact input and starts this version's processor once", async () => {
    await server!.close();
    server = null;
    const input = JSON.stringify(read);
    expect(await run(input)).toEqual({ stdout: input, stderr: "", status: 0 });
    expect(await run(input)).toEqual({ stdout: input, stderr: "", status: 0 });
    for (let i = 0; i < 50 && !existsSync(join(home, "processor-spawned")); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(join(home, "processor-spawned"), "utf8")).toBe("1");
  });

  it("starts the processor on a fresh install whose run directory does not exist yet", async () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), "tkr-native-fresh-")));
    try {
      const marker = join(fresh, "spawned");
      const processor = join(fresh, "processor.mjs");
      writeFileSync(processor, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "1");`);
      const result = spawnSync(binary!, ["--post-tool-use"], { env: { ...env, TOKMIZER_HOME: fresh, TOKMIZER_PROCESSOR_JS: processor }, input: JSON.stringify(read), timeout: 10000 });
      expect(result.status).toBe(0);
      for (let i = 0; i < 100 && !existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(marker)).toBe(true);
      expect(lstatSync(join(fresh, "run")).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("prefers this version's processor over the shared daemon endpoint", async () => {
    let processorActivity = 0;
    const processor = await startProcessingEndpoint(() => runtime, () => { processorActivity += 1; }, processorDescriptorName());
    try {
      expect(await runAsync(JSON.stringify(read))).toEqual({ stdout: "ENVELOPE", status: 0 });
      expect(processorActivity).toBeGreaterThan(0);
      expect(activity).toBe(0);
    } finally {
      await processor?.close();
    }
  });

  it("uses the shared endpoint when this version's processor descriptor is stale", async () => {
    const shared = JSON.parse(readFileSync(join(home, "run", "processing.json"), "utf8"));
    writeFileSync(join(home, "run", processorDescriptorName()), JSON.stringify({ ...shared, path: join(home, "run", "missing.sock") }), { mode: 0o600 });
    expect(await runAsync(JSON.stringify(read))).toEqual({ stdout: "ENVELOPE", status: 0 });
    expect(activity).toBeGreaterThan(0);
  });
});

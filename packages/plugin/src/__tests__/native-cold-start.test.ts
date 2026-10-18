import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProcessingEndpoint } from "../exec/processing-endpoint";
import { Settings } from "../contracts";

vi.mock("../state", () => ({ loadState: vi.fn().mockResolvedValue(null) }));
vi.mock("../settings-cache", () => ({ loadSettingsCache: vi.fn(async () => Settings.parse({ telemetryOptIn: false })) }));
vi.mock("../learn/recorder", () => ({ recordEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../learn/telemetry", () => ({ recordTelemetry: vi.fn().mockResolvedValue(undefined) }));

const binary = process.env.TOKMIZER_NATIVE_TEST_BIN;
let root: string;
let home: string;
let env: NodeJS.ProcessEnv;
let server: Awaited<ReturnType<typeof startProcessingEndpoint>> | undefined;
let tools: string;
let node: string;

beforeAll(() => {
  tools = realpathSync(mkdtempSync(join(tmpdir(), "tkr-cold-tools-")));
  node = join(tools, "node.sh");
  writeFileSync(node, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "${TOKMIZER_HOME%/*}/node-args"\ncase "$1" in --max-semi-space-size=*) shift;; esac\nexec /bin/sh "$@"\n', { mode: 0o755 });
  spawnSync(node, ["-c", "true"], { env: { TOKMIZER_HOME: join(tools, "home") } });
});

afterAll(() => {
  rmSync(tools, { recursive: true, force: true });
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-cold-")));
  home = join(root, "home");
  vi.stubEnv("TOKMIZER_HOME", home);
  vi.stubEnv("TOKMIZER_TKR_BIN", join(root, "missing-tkr.js"));
  const processor = join(root, "processor.sh");
  writeFileSync(processor, 'printf 1 >> "$TOKMIZER_HOME/spawned"\n');
  const fallback = join(root, "fallback.sh");
  writeFileSync(fallback, `printf 1 >> '${join(root, "fallback-count")}'\nexec "$@"\n`);
  const postFallback = join(root, "post-fallback.sh");
  writeFileSync(postFallback, `printf 1 >> '${join(root, "fallback-count")}'\n`);
  env = { ...process.env, TOKMIZER_HOME: home, TOKMIZER_EXEC_JS: fallback, TOKMIZER_POST_TOOL_JS: postFallback, TOKMIZER_PRE_TOOL_JS: postFallback, TOKMIZER_PROCESSOR_JS: processor, TOKMIZER_NODE_BIN: node, PATH: "/usr/local/bin:/usr/bin:/bin" };
  for (const key of ["TOKMIZER_DEV", "TOKMIZER_FILTERS_DIR", "TOKMIZER_BASE_URL", "TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM", "TOKMIZER_MAX_BUNDLE_AGE_MS", "TOKMIZER_EXEC_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"]) delete env[key];
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function launch(args: string[], input = "") {
  const started = Date.now();
  const child = spawn(binary!, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", () => {});
  child.stdin.end(input);
  return new Promise<{ stdout: string; code: number | null; elapsed: number }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout: Buffer.concat(out).toString(), code, elapsed: Date.now() - started }));
  });
}

async function serveOnceSpawned(): Promise<() => Promise<void>> {
  server = (await startProcessingEndpoint(() => ({
    signedAt: Date.now(), fetchedAt: Date.now(), startedAt: Date.now(), bundleVersion: 1, ruleCount: 1, selectFor: () => null
  })))!;
  const descriptor = join(home, "run", "processing.json");
  renameSync(descriptor, `${descriptor}.hidden`);
  return async () => {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(home, "spawned"))) {
      if (Date.now() > deadline) throw new Error("processor was not spawned");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    renameSync(`${descriptor}.hidden`, descriptor);
  };
}

const spawned = (): string => readFileSync(join(home, "spawned"), "utf8");

describe.skipIf(process.platform === "win32" || !binary)("native cold start", () => {
  it("warms the processor at session start, creating a private home, without output", async () => {
    const result = await launch(["--session-start"], JSON.stringify({ hook_event_name: "SessionStart" }));
    expect(result).toMatchObject({ stdout: "", code: 0 });
    expect(lstatSync(home).mode & 0o777).toBe(0o700);
    for (let i = 0; i < 100 && !existsSync(join(home, "spawned")); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(spawned()).toBe("1");
    expect(readFileSync(join(root, "node-args"), "utf8")).toBe(`--max-semi-space-size=1 ${join(root, "processor.sh")}\n`);
  });

  it("warms the processor when a SessionStart payload arrives without arguments", async () => {
    const result = await launch([], JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }));
    expect(result).toMatchObject({ stdout: "", code: 0 });
    for (let i = 0; i < 100 && !existsSync(join(home, "spawned")); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(spawned()).toBe("1");
  });

  it("does not spawn at session start when a processor already answers", async () => {
    mkdirSync(home, { mode: 0o700 });
    server = (await startProcessingEndpoint(() => null))!;
    expect((await launch(["--session-start"])).code).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(join(home, "spawned"))).toBe(false);
  });

  it("waits briefly for a processor it just spawned instead of falling back", async () => {
    mkdirSync(home, { mode: 0o700 });
    const ready = (await serveOnceSpawned())();
    const result = await launch(["/bin/sh", "-c", "printf processed"]);
    await ready;
    expect(result).toMatchObject({ stdout: "processed", code: 0 });
    expect(existsSync(join(root, "fallback-count"))).toBe(false);
    expect(spawned()).toBe("1");
  });

  it("serves a cold tool output hook through the processor it just spawned", async () => {
    mkdirSync(home, { mode: 0o700 });
    const ready = (await serveOnceSpawned())();
    const payload = { session_id: "cold", tool_name: "Grep", tool_input: { pattern: "x" }, tool_response: { content: "match\n".repeat(400) } };
    const result = await launch(["--post-tool-use"], JSON.stringify(payload));
    await ready;
    expect(result.code).toBe(0);
    expect(existsSync(join(root, "fallback-count"))).toBe(false);
  });

  it("does not delay a cold command rewrite hook, which only warms the processor", async () => {
    mkdirSync(home, { mode: 0o700 });
    const ready = (await serveOnceSpawned())();
    const payload = { session_id: "cold", tool_name: "Bash", tool_input: { command: "ls" }, hook_event_name: "PreToolUse" };
    const result = await launch(["--pre-tool-use"], JSON.stringify(payload));
    await ready;
    expect(result.code).toBe(0);
    expect(readFileSync(join(root, "fallback-count"), "utf8")).toBe("1");
    expect(spawned()).toBe("1");
  });

  it("falls back after a bounded wait when the spawned processor never answers", async () => {
    mkdirSync(home, { mode: 0o700 });
    const result = await launch(["/bin/sh", "-c", "printf fallback-ok"]);
    expect(result).toMatchObject({ stdout: "fallback-ok", code: 0 });
    expect(readFileSync(join(root, "fallback-count"), "utf8")).toBe("1");
    expect(result.elapsed).toBeLessThan(1500);
  });
});

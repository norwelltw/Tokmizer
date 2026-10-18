import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProcessingEndpoint } from "../exec/processing-endpoint";
import { buildPreToolUseOutput } from "../hooks-host/pre-tool-rewrite";
import { encodeProcessingFrame, FrameReader } from "../exec/processing-protocol";

vi.mock("../hooks-host/pre-tool-rewrite", async (original) => ({
  ...await original<typeof import("../hooks-host/pre-tool-rewrite")>(),
  execInvocation: () => "'/fixture package/bin/tkr-exec'"
}));

const binary = process.env.TOKMIZER_NATIVE_TEST_BIN;
let home: string;
let server: Awaited<ReturnType<typeof startProcessingEndpoint>>;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tkr-native-hook-")));
  vi.stubEnv("TOKMIZER_HOME", home);
  server = await startProcessingEndpoint(() => null);
  const fallback = join(home, "fallback.mjs");
  writeFileSync(fallback, "for await (const chunk of process.stdin) process.stdout.write(chunk);");
  env = { ...process.env, TOKMIZER_HOME: home, TOKMIZER_PRE_TOOL_JS: fallback, TOKMIZER_PROCESSOR_JS: join(home, "no-processor.js"), TOKMIZER_NODE_BIN: process.execPath };
  for (const name of ["TOKMIZER_DEV", "TOKMIZER_BASE_URL", "TOKMIZER_FILTERS_DIR", "TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM", "TOKMIZER_MAX_BUNDLE_AGE_MS"]) delete env[name];
});

afterEach(async () => {
  await server?.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function run(input: string, args = ["--pre-tool-use"]) {
  const child = spawn(binary!, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  const result = new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), code }));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return result;
}

describe.skipIf(!binary || process.platform === "win32")("native hook transport", () => {
  it("returns the existing hook decision and records usage once", async () => {
    const payload = { tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: "cat 'é 😀 file'" }, session_id: "test-session" };
    const expected = buildPreToolUseOutput(payload, "claude-code", "'/fixture package/bin/tkr-exec'", () => {});
    expect(await run(JSON.stringify(payload))).toEqual({ stdout: expected, stderr: "", code: 0 });
    const usage = readFileSync(join(home, "usage.jsonl"), "utf8").trim().split("\n");
    expect(usage).toHaveLength(1);
    expect(JSON.parse(usage[0]!)).toMatchObject({ s: "test-session", o: 1 });
  });

  it("applies the calling session's Claude Code deny rules inside the shared processor", async () => {
    const project = join(home, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(git push:*)"] } }));
    vi.stubEnv("HOME", home);
    vi.stubEnv("CLAUDE_PROJECT_DIR", "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    const payload = { tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: "git push origin main" }, session_id: "deny", cwd: home };
    expect((await run(JSON.stringify(payload))).stdout).not.toBe("");
    env = { ...env, CLAUDE_PROJECT_DIR: project };
    expect(await run(JSON.stringify(payload))).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  it("resolves commands with the calling hook's PATH, not the processor's", async () => {
    const bin = join(home, "caller-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "callertool"), "#!/bin/sh\n");
    chmodSync(join(bin, "callertool"), 0o755);
    vi.stubEnv("HOME", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    const payload = { tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: "callertool --flag", timeout: 9 }, session_id: "path", cwd: home };
    expect(await run(JSON.stringify(payload))).toEqual({ stdout: "", stderr: "", code: 0 });
    env = { ...env, PATH: `${bin}:${env.PATH ?? ""}` };
    const routed = JSON.parse((await run(JSON.stringify(payload))).stdout);
    expect(routed.hookSpecificOutput.updatedInput).toEqual({ command: "'/fixture package/bin/tkr-exec' callertool --flag", timeout: 9 });
    env = { ...env, PATH: "" };
    expect(await run(JSON.stringify({ ...payload, tool_input: { command: "git log" } }))).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  it("returns allow with the rewrite for a default-mode command covered by a narrow allow rule", async () => {
    const config = join(home, "config");
    const bin = join(home, "narrow-bin");
    mkdirSync(config);
    mkdirSync(bin);
    writeFileSync(join(bin, "pytest"), "#!/bin/sh\n");
    chmodSync(join(bin, "pytest"), 0o755);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(pytest:*)"], ask: ["Bash(pytest --lf:*)"] } }));
    vi.stubEnv("HOME", home);
    env = { ...env, CLAUDE_CONFIG_DIR: config, PATH: bin };
    for (const command of ["pytest -x", "pytest --lf", "pytest; true"]) {
      const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "default", tool_input: { command, description: "d" }, session_id: "narrow", cwd: home };
      const expected = buildPreToolUseOutput(payload, "claude-code", "'/fixture package/bin/tkr-exec'", () => {}, { configDir: config }, bin) ?? "";
      expect(await run(JSON.stringify(payload)), command).toEqual({ stdout: expected, stderr: "", code: 0 });
      if (command === "pytest -x") expect(JSON.parse(expected).hookSpecificOutput).toMatchObject({ permissionDecision: "allow", updatedInput: { command: "'/fixture package/bin/tkr-exec' pytest -x", description: "d" } });
      else expect(expected, command).toBe("");
    }
  });

  it("routes an untagged PreToolUse payload exactly like --pre-tool-use", async () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: "cat file" }, session_id: "untagged" };
    const flagged = await run(JSON.stringify(payload));
    expect(flagged.stdout).not.toBe("");
    expect(await run(JSON.stringify(payload), [])).toEqual(flagged);
    await server!.close();
    server = null;
    expect(await run(JSON.stringify(payload), [])).toEqual({ stdout: JSON.stringify(payload), stderr: "", code: 0 });
  });

  it("answers a Codex payload in the Codex shape on both entry forms", async () => {
    const payload = { hook_event_name: "PreToolUse", turn_id: "t1", model: "gpt-5.5", tool_use_id: "call_1", tool_name: "Bash", tool_input: { command: "cat file" }, session_id: "codex" };
    const expected = buildPreToolUseOutput(payload, "codex", "'/fixture package/bin/tkr-exec'", () => {});
    expect(JSON.parse(expected!).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(await run(JSON.stringify(payload))).toEqual({ stdout: expected, stderr: "", code: 0 });
    expect(await run(JSON.stringify(payload), [])).toEqual({ stdout: expected, stderr: "", code: 0 });
  });

  it("stays silent on a payload carrying both hosts' fields, without the fallback", async () => {
    const payload = { hook_event_name: "PreToolUse", turn_id: "t1", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "cat file" } };
    expect(await run(JSON.stringify(payload))).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  it("exits silently without arguments when stdin is not a tool hook payload", async () => {
    for (const input of ["", "not json", "[1]", "{}", JSON.stringify({ hook_event_name: "Stop" }), JSON.stringify({ hook_event_name: "SessionStart", tool_name: "Bash" })]) {
      expect(await run(input, [])).toEqual({ stdout: "", stderr: "", code: 0 });
    }
  });

  it("preserves empty decisions and unrouted usage", async () => {
    expect(await run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" } }))).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(JSON.parse(readFileSync(join(home, "usage.jsonl"), "utf8"))).toMatchObject({ o: 0 });
  });

  it("preserves all stdin bytes on missing-service fallback", async () => {
    await server!.close();
    server = null;
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat file" } });
    expect(await run(input)).toEqual({ stdout: input, stderr: "", code: 0 });
  });

  it("passes oversized and malformed input through to the existing hook", async () => {
    for (const input of ["not json", "x".repeat(100000)]) {
      expect(await run(input)).toEqual({ stdout: input, stderr: "", code: 0 });
    }
  });

  it("preserves invalid UTF-8 and NUL bytes before and beyond the input limit", () => {
    for (const input of [Buffer.from([0xff, 0, 0xc3, 0x28]), Buffer.concat([Buffer.alloc(65536, 120), Buffer.from([0xff, 0, 0xc3, 0x28]), Buffer.alloc(35000, 121)])]) {
      const result = spawnSync(binary!, ["--pre-tool-use"], { env, input, timeout: 5000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toEqual(input);
      expect(result.stderr).toHaveLength(0);
    }
  });

  it("does not replay output when the usage confirmation is lost", async () => {
    const path = JSON.parse(readFileSync(join(home, "run", "processing.json"), "utf8")).path;
    await server!.close();
    server = null;
    let frames = 0;
    const fake = createServer((socket) => {
      const reader = new FrameReader(() => 65536, () => {
        frames += 1;
        if (frames === 1) socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify({ ok: true, protocol: 2, output: "delivered-once" }))));
        else socket.destroy();
      });
      socket.on("data", (chunk: Buffer) => reader.push(chunk));
    });
    await new Promise<void>((resolve) => fake.listen(path, resolve));
    chmodSync(path, 0o600);
    try {
      expect(await run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat file" } }))).toEqual({ stdout: "delivered-once", stderr: "", code: 0 });
      expect(frames).toBe(2);
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
});

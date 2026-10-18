import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProcessingServer } from "../exec/processing-server";
import { encodeProcessingFrame, FrameReader } from "../exec/processing-protocol";
import { buildPreToolUseOutput } from "../hooks-host/pre-tool-rewrite";
import { recordUsageSync } from "../usage";

vi.mock("../usage", () => ({ recordUsageSync: vi.fn() }));
vi.mock("../hooks-host/pre-tool-rewrite", async (original) => ({
  ...await original<typeof import("../hooks-host/pre-tool-rewrite")>(),
  execInvocation: () => "'/fixture package/bin/tkr-exec'"
}));

let home: string;
let server: Awaited<ReturnType<typeof startProcessingServer>>;
const sockets: Socket[] = [];
const token = "b".repeat(64);

beforeEach(async () => {
  vi.stubEnv("CLAUDE_PID", String(process.pid));
  home = realpathSync(mkdtempSync(join(tmpdir(), "tkr-hook-ipc-")));
  vi.stubEnv("TOKMIZER_HOME", home);
  vi.mocked(recordUsageSync).mockClear();
  server = await startProcessingServer({ path: join(home, "p.sock"), token, version: "test", getRuntime: () => null });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await server?.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function client() {
  const socket = createConnection(join(home, "p.sock"));
  socket.on("error", () => {});
  sockets.push(socket);
  await once(socket, "connect");
  return socket;
}

function receive(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off("data", data); socket.off("close", close); clearTimeout(timer); };
    const reader = new FrameReader(() => 1024 * 1024, (frame) => { cleanup(); resolve(frame); });
    const data = (chunk: Buffer) => reader.push(chunk);
    const close = () => { cleanup(); reject(new Error("closed")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 1000);
    socket.on("data", data);
    socket.once("close", close);
  });
}

function request(payload: unknown, host = "claude-code", extra: Record<string, unknown> = {}) {
  return encodeProcessingFrame(Buffer.from(JSON.stringify({ kind: "pre-tool-use", protocol: 2, version: "test", token, home, host, payload, claudePid: String(process.pid), ...extra })));
}

describe.skipIf(process.platform === "win32")("persistent hook processing", () => {
  const bypassPayload = { hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: "cat file" }, session_id: "launch", prompt_id: "p1", tool_use_id: "toolu_01" };

  it("rewrites for the calling Claude Code session only when it can read that session's launch options", async () => {
    const socket = await client();
    const response = receive(socket);
    socket.write(request(bypassPayload, "claude-code", { path: process.env.PATH }));
    expect(JSON.parse((await response).toString()).output).toContain("tkr-exec");
    const unknown = await client();
    const unknownResponse = receive(unknown);
    socket.destroy();
    unknown.write(request(bypassPayload, "claude-code", { path: process.env.PATH, claudePid: undefined }));
    expect(JSON.parse((await unknownResponse).toString())).toEqual({ ok: true, protocol: 2, output: "" });
  });

  it("never rewrites for a Claude Code session launched with --disallowedTools", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", "--", "--disallowedTools", "Bash(git push:*)"], { stdio: "ignore" });
    try {
      const socket = await client();
      const response = receive(socket);
      socket.write(request(bypassPayload, "claude-code", { path: process.env.PATH, claudePid: String(child.pid) }));
      expect(JSON.parse((await response).toString())).toEqual({ ok: true, protocol: 2, output: "" });
    } finally {
      child.kill();
    }
  });

  it("never resolves commands with the processor's own PATH", async () => {
    const socket = await client();
    const response = receive(socket);
    socket.write(request({ tool_name: "Bash", tool_input: { command: "cat file" }, session_id: "no-path" }));
    expect(JSON.parse((await response).toString())).toEqual({ ok: true, protocol: 2, output: "" });
  });

  it.each(["claude-code", "codex"] as const)("preserves %s decisions and counts usage only after delivery", async (host) => {
    for (const command of ["cat file", "git status && cat 'a b'", "git push", "cat $(touch injected)", "cat file > target", "echo keep", "tail -f log"]) {
      const payload = { tool_name: "Bash", tool_input: { command }, session_id: "session-one", ...(host === "codex" ? { turn_id: "t1" } : {}) };
      const expected = buildPreToolUseOutput(payload, host, "'/fixture package/bin/tkr-exec'") ?? "";
      const expectedUsage = vi.mocked(recordUsageSync).mock.calls.map((call) => call.slice());
      vi.mocked(recordUsageSync).mockClear();
      const socket = await client();
      const response = receive(socket);
      socket.write(request(payload, host, { path: process.env.PATH }));
      expect(JSON.parse((await response).toString())).toEqual({ ok: true, protocol: 2, output: expected });
      expect(recordUsageSync).not.toHaveBeenCalled();
      const confirmation = receive(socket);
      socket.write(encodeProcessingFrame(Buffer.from([1])));
      expect(await confirmation).toEqual(Buffer.from([1]));
      expect(vi.mocked(recordUsageSync).mock.calls).toEqual(expectedUsage);
      vi.mocked(recordUsageSync).mockClear();
    }
  });

  it("answers a default-mode command covered by a narrow allow rule exactly like the in-process hook", async () => {
    const config = join(home, "config");
    const bin = join(home, "bin");
    mkdirSync(config);
    mkdirSync(bin);
    writeFileSync(join(bin, "pytest"), "#!/bin/sh\n");
    chmodSync(join(bin, "pytest"), 0o755);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(pytest:*)"], deny: ["Bash(pytest --lf:*)"] } }));
    vi.stubEnv("HOME", home);
    for (const command of ["pytest -x", "pytest --lf", "pytest && true"]) {
      const payload = { tool_name: "Bash", permission_mode: "default", tool_input: { command, timeout: 5 }, session_id: "narrow", cwd: home };
      const expected = buildPreToolUseOutput(payload, "claude-code", "'/fixture package/bin/tkr-exec'", () => {}, { configDir: config }, bin) ?? "";
      const socket = await client();
      const response = receive(socket);
      socket.write(request(payload, "claude-code", { path: bin, claudeConfigDir: config }));
      expect(JSON.parse((await response).toString()), command).toEqual({ ok: true, protocol: 2, output: expected });
      if (command === "pytest -x") expect(JSON.parse(expected).hookSpecificOutput).toMatchObject({ permissionDecision: "allow", updatedInput: { command: "'/fixture package/bin/tkr-exec' pytest -x", timeout: 5 } });
      else expect(expected, command).toBe("");
    }
  });

  it.each([
    ["a Codex payload sent as Claude Code", { turn_id: "t1", model: "gpt-5.5", tool_use_id: "call_1" }, "codex"],
    ["a Claude Code payload sent as Codex", { prompt_id: "p1", tool_use_id: "toolu_01", permission_mode: "bypassPermissions" }, "claude-code"]
  ] as const)("answers %s in the calling host's shape", async (_name, fields, actual) => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat file" }, session_id: "s", ...fields };
    const declared = actual === "codex" ? "claude-code" : "codex";
    const socket = await client();
    const response = receive(socket);
    socket.write(request(payload, declared, { path: process.env.PATH }));
    const { output } = JSON.parse((await response).toString());
    expect(output).toBe(buildPreToolUseOutput(payload, actual, "'/fixture package/bin/tkr-exec'"));
    expect(JSON.parse(output).hookSpecificOutput.permissionDecision).toBe(actual === "codex" ? "allow" : undefined);
  });

  it("answers another agent's payload sent through the native Claude Code hook in that agent's shape", async () => {
    const { preToolUseFor } = await import("../hooks-host/hook-router");
    const payload = { conversation_id: "c", generation_id: "g", cursor_version: "1.7", hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: "cat file" } };
    const socket = await client();
    const response = receive(socket);
    socket.write(request(payload));
    const { output } = JSON.parse((await response).toString());
    expect(output).toBe(preToolUseFor("cursor", payload));
    expect(JSON.parse(output)).toMatchObject({ permission: "allow", updated_input: { command: "'/fixture package/bin/tkr-exec' cat file" } });
  });

  it("stays silent on a payload carrying both hosts' fields", async () => {
    const socket = await client();
    const response = receive(socket);
    socket.write(request({ tool_name: "Bash", tool_input: { command: "cat file" }, turn_id: "t1", prompt_id: "p1" }));
    expect(JSON.parse((await response).toString())).toEqual({ ok: true, protocol: 2, output: "" });
  });

  it("does not count a response lost before its receipt", async () => {
    const socket = await client();
    const response = receive(socket);
    socket.write(request({ tool_name: "Bash", tool_input: { command: "cat file" } }));
    await response;
    socket.destroy();
    await server.close();
    expect(recordUsageSync).not.toHaveBeenCalled();
  });

  it.each([{ token: "a".repeat(64) }, { home: "/other" }, { version: "old" }, { host: "shell" }, { exec: "unsafe" }])("rejects unsupported or unauthenticated requests: %j", async (extra) => {
    const socket = await client();
    const response = receive(socket);
    socket.write(request({ tool_name: "Bash", tool_input: { command: "cat file" } }, "claude-code", extra));
    await expect(response).rejects.toThrow("closed");
    expect(recordUsageSync).not.toHaveBeenCalled();
  });
});

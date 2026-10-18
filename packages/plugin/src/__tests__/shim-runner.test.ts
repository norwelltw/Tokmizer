import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { parseShimInvocation, runShim } from "../shim/runner";
import { shimsDir } from "../shim/install";

let dir: string;
let origHome: string | undefined;

vi.mock("../learn/recorder", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../learn/telemetry", () => ({
  recordTelemetry: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../stats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stats")>();
  return { ...actual, recordStat: vi.fn() };
});
vi.mock("../daemon/resolver", () => ({
  installDaemonResolver: vi.fn(),
  closeDaemonResolver: vi.fn()
}));

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "tok-shim-run-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
  vi.restoreAllMocks();
});

function seedState(): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      token: "t",
      plan: "smart",
      email: "x@y",
      jwt: "j",
      jwtExp: Date.now() + 60_000,
      pluginVersion: "0.1.0",
      installId: "11111111-1111-1111-1111-111111111111",
      status: "active"
    })
  );
}

describe("parseShimInvocation", () => {
  it("parses --as <cmd> args", () => {
    expect(parseShimInvocation(["--as", "git", "status"])).toEqual({
      cmdName: "git",
      args: ["status"]
    });
  });

  it("falls back to first arg when --as missing", () => {
    expect(parseShimInvocation(["ls", "-la"])).toEqual({
      cmdName: "ls",
      args: ["-la"]
    });
  });

  it("empty argv → empty cmdName", () => {
    expect(parseShimInvocation([])).toEqual({ cmdName: "", args: [] });
  });
});

describe("runShim", () => {
  it("missing cmd → exit code 2", async () => {
    const r = await runShim({ cmdName: "", args: [] });
    expect(r.exitCode).toBe(2);
  });

  it("preserves child exit code (true → 0)", async () => {
    seedState();
    const r = await runShim({ cmdName: "/usr/bin/true", args: [] });
    expect(r.exitCode).toBe(0);
  });

  it("preserves child exit code (false → 1)", async () => {
    seedState();
    const r = await runShim({ cmdName: "/usr/bin/false", args: [] });
    expect(r.exitCode).toBe(1);
  });

  it("returns 127 when command not found", async () => {
    seedState();
    const r = await runShim({ cmdName: "/no/such/cmd-xyz", args: [] });
    expect(r.exitCode).toBe(127);
  });

  it("passes through when no state (no license)", async () => {
    const r = await runShim({ cmdName: "/bin/echo", args: ["hello"] });
    expect(r.exitCode).toBe(0);
  });

  it("does not record under a native-hook host (the native PostToolUse hook records instead, avoiding double-count)", async () => {
    seedState();
    const prev = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      const { recordStat } = await import("../stats");
      const r = await runShim({ cmdName: "/bin/echo", args: ["hello"] });
      expect(r.exitCode).toBe(0);
      expect(vi.mocked(recordStat)).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prev;
    }
  });

  it("strips shimsDir from PATH before spawning child", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = `${shimsDir()}${delimiter}/bin${delimiter}/usr/bin`;
    try {
      const r = await runShim({ cmdName: "echo", args: ["x"] });
      expect(r.exitCode).toBe(0);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

const AGENT_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE",
  "CLAUDE_CODE_VERSION",
  "ANTHROPIC_CLAUDE_CODE",
  "CODEX_VERSION",
  "CODEX_CLI",
  "OPENAI_CODEX",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CURSOR_VERSION",
  "CURSOR_TRACE_ID",
  "CLINE_VERSION",
  "CLINE_API_KEY",
  "AIDER_VERSION",
  "AIDER_MODEL",
  "GEMINI_CLI_VERSION",
  "GEMINI_API_KEY",
  "WINDSURF_VERSION",
  "WINDSURF_USER",
  "GITHUB_COPILOT_VERSION",
  "COPILOT_INTEGRATION_ID"
];

describe("runShim piped and raw-byte behavior", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const v of AGENT_VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of AGENT_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  function captureStdout(): { chunks: (string | Buffer)[]; restore: () => void } {
    const orig = process.stdout.write.bind(process.stdout);
    const chunks: (string | Buffer)[] = [];
    process.stdout.write = ((c: string | Buffer) => {
      chunks.push(c);
      return true;
    }) as typeof process.stdout.write;
    return { chunks, restore: () => (process.stdout.write = orig) };
  }

  it("closes the daemon resolver when the run completes", async () => {
    seedState();
    const { closeDaemonResolver } = await import("../daemon/resolver");
    vi.mocked(closeDaemonResolver).mockClear();
    await runShim({ cmdName: "/bin/echo", args: ["x"] });
    expect(closeDaemonResolver).toHaveBeenCalled();
  });

  it("writes invalid-utf8 bytes through untouched when unlicensed", async () => {
    const cap = captureStdout();
    try {
      await runShim({ cmdName: "/bin/sh", args: ["-c", "printf '\\377\\376ok'"] });
    } finally {
      cap.restore();
    }
    const buf = Buffer.concat(cap.chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xfe);
  });

  it("passes piped non-agent output through uncompressed without writing a stat row", async () => {
    seedState();
    const { recordStat } = await import("../stats");
    const rec = await import("../learn/recorder");
    vi.mocked(recordStat).mockClear();
    vi.mocked(rec.recordEvent).mockClear();
    const r = await runShim({ cmdName: "/bin/echo", args: ["hello"] });
    expect(r.exitCode).toBe(0);
    expect(recordStat).not.toHaveBeenCalled();
    expect(rec.recordEvent).not.toHaveBeenCalled();
  });

  it("keeps the engine path when piped under a shim-only agent host", async () => {
    seedState();
    process.env.CURSOR_TRACE_ID = "test";
    const rec = await import("../learn/recorder");
    vi.mocked(rec.recordEvent).mockClear();
    try {
      await runShim({ cmdName: "/bin/echo", args: ["hello"] });
    } finally {
      delete process.env.CURSOR_TRACE_ID;
    }
    expect(rec.recordEvent).toHaveBeenCalled();
  });

  it("adds a restore hint for what it cuts", async () => {
    seedState();
    const { setFilterResolver } = await import("../engine");
    setFilterResolver(async () => ({
      slug: "stub",
      match_command: ".*",
      priority: 50,
      strip_ansi: false,
      strip_lines_matching: [],
      max_lines: 2,
      matchRegex: /.*/
    }) as never);
    const saved = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CURSOR_TRACE_ID = "test";
    const cap = captureStdout();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const r = await runShim({ cmdName: "/bin/sh", args: ["-c", "for i in 1 2 3 4 5 6 7 8; do echo line$i; done; printf 'é!' >&2"] });
      expect(r.filteredOut).toMatch(/\[tkr restore [0-9a-f]{16}\]/);
      expect(r.filteredErr).toBe("é!");
      const { recordStat } = await import("../stats");
      const { recordTelemetry } = await import("../learn/telemetry");
      const stdoutBytes = Buffer.concat(cap.chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c))).length;
      const stderrBytes = stderr.mock.calls.reduce((n, [c]) => n + Buffer.byteLength(c), 0);
      const deliveredBytes = stdoutBytes + stderrBytes;
      expect(recordStat).toHaveBeenCalledWith(51, deliveredBytes, undefined, false, "cursor", "sh", expect.any(String), expect.any(String), expect.any(Object));
      expect(recordTelemetry).toHaveBeenCalledWith(expect.objectContaining({
        tokensSaved: Math.max(0, Math.round((51 - deliveredBytes) / 4)),
        rawTokens: 13
      }));
    } finally {
      cap.restore();
      stderr.mockRestore();
      delete process.env.CURSOR_TRACE_ID;
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      setFilterResolver(null);
    }
  });

  it("counts original bytes when an empty-result message is not delivered", async () => {
    seedState();
    process.env.CURSOR_TRACE_ID = "test";
    const { setFilterResolver } = await import("../engine");
    const { recordStat } = await import("../stats");
    const { recordTelemetry } = await import("../learn/telemetry");
    setFilterResolver(async () => ({
      slug: "stub",
      match_command: ".*",
      priority: 50,
      strip_ansi: false,
      strip_lines_matching: [],
      on_empty: "No results found",
      matchRegex: /.*/
    }));
    const cap = captureStdout();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const r = await runShim({ cmdName: process.execPath, args: ["-e", "process.stderr.write('é!')"] });
      expect(r.filteredOut).toBe("");
      expect(r.filteredErr).toBe("é!");
      expect(cap.chunks).toHaveLength(0);
      expect(Buffer.concat(stderr.mock.calls.map(([c]) => Buffer.from(c))).toString("utf8")).toBe("é!");
      expect(recordStat).toHaveBeenCalledWith(3, 3, undefined, false, "cursor", "sh", expect.any(String), expect.any(String), expect.any(Object));
      expect(recordTelemetry).toHaveBeenCalledWith(expect.objectContaining({ tokensSaved: 0, rawTokens: 1 }));
    } finally {
      cap.restore();
      stderr.mockRestore();
      delete process.env.CURSOR_TRACE_ID;
      setFilterResolver(null);
    }
  });

  it("summarises a failing test runner that reports on stderr and keeps the full original restorable", async () => {
    seedState();
    const { setFilterResolver } = await import("../engine");
    const { readContentCache } = await import("../content-cache");
    setFilterResolver(async () => ({
      slug: "jest",
      match_command: ".*",
      priority: 50,
      strip_ansi: true,
      strip_lines_matching: [],
      matchRegex: /.*/
    }) as never);
    const fixture = join(__dirname, "fixtures", "test-failures", "jest.txt");
    const runner = join(dir, "jest");
    (await import("node:fs")).symlinkSync(process.execPath, runner);
    const saved = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CURSOR_TRACE_ID = "test";
    const cap = captureStdout();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const r = await runShim({ cmdName: runner, args: ["-e", `process.exitCode = 1, process.stderr.write(require("fs").readFileSync(${JSON.stringify(fixture)}, "utf8"))`] });
      expect(r.exitCode).toBe(1);
      expect(r.filteredErr).toContain("cart › lookup missing src/cart.js:2:41");
      expect(r.filteredErr).toContain("Expected: 11");
      const hash = /\[tkr restore ([0-9a-f]{16})\]$/.exec(r.filteredErr.trimEnd())?.[1];
      expect(hash).toBeDefined();
      const { readFileSync } = await import("node:fs");
      expect(await readContentCache(hash!)).toBe(readFileSync(fixture, "utf8"));
    } finally {
      cap.restore();
      stderr.mockRestore();
      delete process.env.CURSOR_TRACE_ID;
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      setFilterResolver(null);
    }
  });
});

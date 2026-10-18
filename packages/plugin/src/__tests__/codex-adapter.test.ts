import { describe, expect, it, vi } from "vitest";
import { handleCodexHook } from "../adapters/codex";

vi.mock("../state", () => ({
  loadState: vi.fn().mockResolvedValue({ token: "t", plan: "smart" })
}));
vi.mock("../settings-cache", async () => {
  const { Settings } = await import("../contracts");
  return { loadSettingsCache: vi.fn().mockResolvedValue(Settings.parse({})) };
});
vi.mock("../learn/recorder", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined),
  flush: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../learn/telemetry", () => ({
  recordTelemetry: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../stats", async () => {
  const actual = await vi.importActual<typeof import("../stats")>("../stats");
  return {
    ...actual,
    recordStat: vi.fn()
  };
});
vi.mock("../engine", async () => {
  const actual = await vi.importActual<typeof import("../engine")>("../engine");
  return {
    ...actual,
    processOutput: vi
      .fn()
      .mockImplementation(async (_cmd, raw: string, _allowed, opts?: { exitCode?: number | null }) => {
        if (opts?.exitCode != null && opts.exitCode !== 0) {
          return {
            output: raw,
            filterId: null,
            rawBytes: raw.length,
            filteredBytes: raw.length,
            debugBypass: true
          };
        }
        return {
          output: raw.slice(0, 10),
          filterId: "shell",
          rawBytes: raw.length,
          filteredBytes: Math.min(10, raw.length),
          debugBypass: false
        };
      })
  };
});

describe("handleCodexHook", () => {
  it("ignores before_tool_call", async () => {
    const r = await handleCodexHook({ event: "before_tool_call", tool: "shell" });
    expect(r.action).toBe("continue");
  });

  it("ignores non-shell tool", async () => {
    const r = await handleCodexHook({
      event: "after_tool_call",
      tool: "edit_file",
      stdout: "x"
    });
    expect(r.action).toBe("continue");
  });

  it("continues when output empty", async () => {
    const r = await handleCodexHook({
      event: "after_tool_call",
      tool: "shell",
      command: "git status",
      exit_code: 0
    });
    expect(r.action).toBe("continue");
  });

  it("replaces output when filter shrinks it", async () => {
    const r = await handleCodexHook({
      event: "after_tool_call",
      tool: "shell",
      command: "git log",
      stdout: "x".repeat(500),
      exit_code: 0
    });
    expect(r.action).toBe("replace_output");
    expect(r.replacement).toBe("xxxxxxxxxx");
    expect(r.reason).toBe("tokmizer");
  });

  it("does not compress a failing command but still counts it", async () => {
    const stats = await import("../stats");
    vi.mocked(stats.recordStat).mockClear();
    const r = await handleCodexHook({
      event: "after_tool_call",
      tool: "shell",
      command: "git log",
      stdout: "x".repeat(500),
      exit_code: 1
    });
    expect(r.action).toBe("continue");
    expect(stats.recordStat).toHaveBeenCalledWith(500, 500, undefined, false, "codex", "sh", "git log", expect.any(String), { o: "n" });
  });

  it("compresses when exit_code is unknown (engine heuristic decides)", async () => {
    const r = await handleCodexHook({
      event: "after_tool_call",
      tool: "shell",
      command: "git log",
      stdout: "x".repeat(500)
    });
    expect(r.action).toBe("replace_output");
    expect(r.replacement).toBe("xxxxxxxxxx");
  });

  it("leaves stderr untouched and appends it after the filtered stdout", async () => {
    const r = await handleCodexHook({
      event: "after_tool_call",
      tool: "shell",
      command: "git log",
      stdout: "x".repeat(500),
      stderr: "real error",
      exit_code: 0
    });
    expect(r.action).toBe("replace_output");
    expect(r.replacement).toBe("xxxxxxxxxx\nreal error");
    const { recordStat } = await import("../stats");
    const { recordTelemetry } = await import("../learn/telemetry");
    expect(recordStat).toHaveBeenLastCalledWith(510, 21, undefined, false, "codex", "sh", "git log", expect.any(String), expect.any(Object));
    expect(recordTelemetry).toHaveBeenLastCalledWith(expect.objectContaining({ tokensSaved: 122, rawTokens: 128 }));
  });

  it("counts original bytes when an expanded engine result is not delivered", async () => {
    const { processOutput } = await import("../engine");
    const { recordStat } = await import("../stats");
    const { recordTelemetry } = await import("../learn/telemetry");
    vi.mocked(processOutput).mockResolvedValueOnce({
      output: "abc expanded",
      filterId: "shell",
      rawBytes: 3,
      filteredBytes: 12,
      debugBypass: false
    });
    const r = await handleCodexHook({
      event: "after_tool_call",
      tool: "shell",
      command: "git log",
      stdout: "abc",
      stderr: "é!",
      exit_code: 0
    });
    expect(r.action).toBe("continue");
    expect(recordStat).toHaveBeenLastCalledWith(6, 6, undefined, false, "codex", "sh", "git log", expect.any(String), expect.any(Object));
    expect(recordTelemetry).toHaveBeenLastCalledWith(expect.objectContaining({ tokensSaved: 0, rawTokens: 2 }));
  });

  it("continues when filter does not shrink but still counts the command", async () => {
    const eng = await import("../engine");
    const stats = await import("../stats");
    vi.mocked(stats.recordStat).mockClear();
    vi.mocked(eng.processOutput).mockResolvedValueOnce({
      output: "abc",
      filterId: null,
      rawBytes: 3,
      filteredBytes: 3,
      debugBypass: false
    });
    const r = await handleCodexHook({
      event: "after_tool_call",
      tool: "bash",
      command: "ls",
      stdout: "abc",
      exit_code: 0
    });
    expect(r.action).toBe("continue");
    expect(stats.recordStat).toHaveBeenCalledWith(3, 3, undefined, false, "codex", "sh", "ls", expect.any(String), expect.any(Object));
  });

  it("accepts args array when command missing", async () => {
    const r = await handleCodexHook({
      event: "after_tool_call",
      tool: "exec",
      args: ["git", "log"],
      stdout: "y".repeat(500),
      exit_code: 0
    });
    expect(r.action).toBe("replace_output");
  });
});

describe("runCodexHookFromStdin error paths", () => {
  async function runWithStdin(input: string): Promise<{ out: string; err: string }> {
    const { Readable } = await import("node:stream");
    const origStdin = process.stdin;
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    let out = "";
    let err = "";
    process.stdout.write = ((chunk: unknown) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      err += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    const stream = Readable.from([Buffer.from(input)]);
    Object.defineProperty(process, "stdin", { value: stream, configurable: true });
    try {
      const { runCodexHookFromStdin } = await import("../adapters/codex");
      await runCodexHookFromStdin();
    } finally {
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }
    return { out, err };
  }

  it("empty stdin → action:continue", async () => {
    const { out } = await runWithStdin("");
    expect(JSON.parse(out)).toEqual({ action: "continue" });
  });

  it("malformed JSON → action:continue", async () => {
    const { out } = await runWithStdin("{not json");
    expect(JSON.parse(out)).toEqual({ action: "continue" });
  });

  it("valid payload returns JSON envelope", async () => {
    const { out } = await runWithStdin(
      JSON.stringify({ event: "before_tool_call", tool: "shell" })
    );
    expect(JSON.parse(out).action).toBe("continue");
  });
});

describe("codexHookResponse for real Codex hooks", () => {
  it("prints nothing for other Codex hook events instead of an unknown shape", async () => {
    const { codexHookResponse } = await import("../adapters/codex");
    expect(await codexHookResponse(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash" }))).toBe("");
  });

  it("prints nothing for an escalated Codex command", async () => {
    const { codexHookResponse } = await import("../adapters/codex");
    const out = await codexHookResponse(
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push", sandbox_permissions: "require_escalated" } })
    );
    expect(out).toBe("");
  });
});

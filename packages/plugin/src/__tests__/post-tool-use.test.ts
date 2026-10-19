import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { processToolOutput, buildHookEnvelope, postToolUseResponse } from "../hooks-host/post-tool-use";

vi.mock("../state", () => ({
  loadState: vi.fn().mockResolvedValue({ token: "tok_x", plan: "smart" })
}));
vi.mock("../learn/recorder", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../learn/telemetry", () => ({
  recordTelemetry: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../stats", async () => {
  const actual = await vi.importActual<typeof import("../stats")>("../stats");
  return { ...actual, recordStat: vi.fn() };
});
vi.mock("../host-detect", async () => {
  const actual = await vi.importActual<typeof import("../host-detect")>("../host-detect");
  return { ...actual, detectHost: vi.fn().mockReturnValue({ host: "shell" }) };
});
vi.mock("../settings-cache", () => ({
  loadSettingsCache: vi.fn().mockResolvedValue({
    enabled: true,
    telemetryOptIn: false,
    outputVerbosity: "minimal",
    filters: { enableAll: true, disabled: [] }
  })
}));
vi.mock("../engine", async () => {
  const actual = await vi.importActual<typeof import("../engine")>("../engine");
  return {
    ...actual,
    processOutput: vi.fn().mockImplementation(async (_cmd, raw: string) => ({
      output: raw.split("\n").slice(0, 3).join("\n"),
      filterId: "read-tool",
      rawBytes: raw.length,
      filteredBytes: raw.split("\n").slice(0, 3).join("\n").length,
      debugBypass: false,
      droppedTail: raw.split("\n").length > 3 ? raw.split("\n").slice(3).join("\n") : null
    }))
  };
});

describe("processToolOutput", () => {
  it("returns null for un-covered tool", async () => {
    const r = await processToolOutput({ tool_name: "WebFetch", tool_response: "x" });
    expect(r).toBeNull();
  });

  it("never hands back an output longer than the original once the restore line is added", async () => {
    const raw = [
      "bun test v1.2.20 (6ad208bc)",
      "error: optional dep resolution failed",
      "  detail: registry timeout",
      "error: caught and handled",
      "    at <anonymous> (/home/user/project/green.test.ts:9:11)",
      "checklist: a ✓ b ✗",
      "✗ optional dep missing",
      "",
      " 3 pass",
      " 0 fail",
      " 3 expect() calls",
      "Ran 3 tests across 1 file. [5.00ms]",
      ""
    ].join("\n").padEnd(1100, " ");
    const r = await processToolOutput({ tool_name: "Bash", tool_input: { command: "bun test" }, tool_response: { stdout: raw, stderr: "", interrupted: false, isImage: false } });
    if (r != null) expect(Buffer.byteLength(r)).toBeLessThan(Buffer.byteLength(raw));
  });

  it("skips Bash already routed through tkr-exec", async () => {
    const r = await processToolOutput({
      tool_name: "Bash",
      tool_input: { command: "node '/x/tkr-exec.js' ls -la" },
      tool_response: "a\n".repeat(2000)
    });
    expect(r).toBeNull();
  });

  it("does not recompress the output of a tkr restore command", async () => {
    const r = await processToolOutput({
      tool_name: "Bash",
      tool_input: { command: "tkr restore a3f9b2c1d4e5f607" },
      tool_response: "line\n".repeat(500)
    });
    expect(r).toBeNull();
  });

  it("does not recompress restore invoked through the tkr.js entrypoint", async () => {
    const r = await processToolOutput({
      tool_name: "Bash",
      tool_input: { command: "node /x/dist/bin/tkr.js restore a3f9b2c1d4e5f607" },
      tool_response: "line\n".repeat(500)
    });
    expect(r).toBeNull();
  });

  it("skips small Bash output", async () => {
    const r = await processToolOutput({
      tool_name: "Bash",
      tool_input: { command: "for s in a b; do python3 -c x; done" },
      tool_response: "tiny"
    });
    expect(r).toBeNull();
  });

  it("compresses big uncovered Bash output and records it as bash-tool", async () => {
    const rec = await import("../learn/recorder");
    vi.mocked(rec.recordEvent).mockClear();
    const r = await processToolOutput({
      tool_name: "Bash",
      tool_input: { command: "for s in a b; do python3 -c print; done" },
      tool_response: "line\n".repeat(500)
    });
    expect(r).not.toBeNull();
    const cmds = vi.mocked(rec.recordEvent).mock.calls.map((c) => c[0]?.cmd);
    expect(cmds).toEqual(["bash-tool"]);
  });

  it("leaves a ranged Read untouched so the agent sees the exact lines it asked for", async () => {
    const eng = await import("../engine");
    vi.mocked(eng.processOutput).mockClear();
    for (const extra of [{ offset: 120 }, { limit: 80 }, { offset: 1, limit: 400 }]) {
      const r = await processToolOutput({
        tool_name: "Read",
        tool_input: { file_path: "/src/big.ts", ...extra },
        tool_response: { file: { content: "line\n".repeat(500) } }
      } as never);
      expect(r).toBeNull();
    }
    expect(vi.mocked(eng.processOutput)).not.toHaveBeenCalled();
  });

  it("answers Claude Code but prints nothing when Codex runs the Claude hook (no updatedToolOutput there)", async () => {
    const read = { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/src/big.ts" }, tool_response: { file: { content: "line\n".repeat(500) } } };
    expect(await postToolUseResponse(read as never)).toContain("updatedToolOutput");
    expect(await postToolUseResponse({ ...read, turn_id: "t1", model: "gpt-5.5" } as never)).toBe("");
    expect(await postToolUseResponse({ ...read, turn_id: "t1", prompt_id: "p1" } as never)).toBe("");
  });

  it("still compresses a whole-file Read", async () => {
    const r = await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/src/big.ts" },
      tool_response: { file: { content: "line\n".repeat(500) } }
    } as never);
    expect(r).not.toBeNull();
  });

  it("replaces an identical repeated Bash output with a short restorable notice", async () => {
    const out = `report\n${"row data\n".repeat(400)}`;
    const p = (cmd: string) => ({ session_id: "rep-1", tool_name: "Bash", tool_input: { command: cmd }, tool_response: out });
    await processToolOutput(p("cat notes.md"));
    const second = await processToolOutput(p("awk '{print}' notes.md"));
    expect(second).toContain("same output as `cat notes.md`");
    expect(second).toMatch(/\[tkr restore [0-9a-f]{16}\]/);
    expect(second!.length).toBeLessThan(300);
  });

  it("leaves repeated commands already routed through tkr-exec untouched", async () => {
    const out = `x\n${"wrapped line\n".repeat(300)}`;
    const p = { session_id: "rep-2", tool_name: "Bash", tool_input: { command: "node /p/tkr-exec.js git log" }, tool_response: out };
    expect(await processToolOutput(p)).toBeNull();
    expect(await processToolOutput(p)).toBeNull();
  });

  it("never stubs a repeated tkr restore", async () => {
    const out = `x\n${"restored\n".repeat(300)}`;
    const p = { session_id: "rep-3", tool_name: "Bash", tool_input: { command: "tkr restore abcdef0123456789" }, tool_response: out };
    expect(await processToolOutput(p)).toBeNull();
    expect(await processToolOutput(p)).toBeNull();
  });

  it("does not stub for a subagent what only the parent agent saw", async () => {
    const out = `x\n${"shared\n".repeat(400)}`;
    await processToolOutput({ session_id: "rep-4", tool_name: "Bash", tool_input: { command: "cat s.md" }, tool_response: out });
    const sub = await processToolOutput({
      session_id: "rep-4",
      agent_id: "a1",
      tool_name: "Bash",
      tool_input: { command: "cat s.md" },
      tool_response: out
    } as never);
    expect(sub ?? "").not.toContain("same output as");
  });

  it("passes the real Bash command in the synthetic so command filters can match", async () => {
    const eng = await import("../engine");
    vi.mocked(eng.processOutput).mockClear();
    await processToolOutput({
      tool_name: "Bash",
      tool_input: { command: "python3 scripts/train.py --epochs 3" },
      tool_response: "line\n".repeat(500)
    });
    expect(vi.mocked(eng.processOutput).mock.calls[0]?.[0]).toBe(
      "bash-tool: python3 scripts/train.py --epochs 3"
    );
  });

  it("forwards the compression level to processOutput so caps scale", async () => {
    const eng = await import("../engine");
    vi.mocked(eng.processOutput).mockClear();
    await processToolOutput({
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: "line\n".repeat(500)
    });
    expect(vi.mocked(eng.processOutput).mock.calls[0]?.[3]?.verbosity).toBe("minimal");
  });

  it("keeps only the first line of multiline Bash commands, capped at 200 chars", async () => {
    const eng = await import("../engine");
    vi.mocked(eng.processOutput).mockClear();
    await processToolOutput({
      tool_name: "Bash",
      tool_input: { command: `${"x".repeat(300)}\nsecond line` },
      tool_response: "line\n".repeat(500)
    });
    const synthetic = vi.mocked(eng.processOutput).mock.calls[0]?.[0] as string;
    expect(synthetic.startsWith("bash-tool: xxx")).toBe(true);
    expect(synthetic.includes("second")).toBe(false);
    expect(synthetic.length).toBe("bash-tool: ".length + 200);
  });

  it("returns null for empty output", async () => {
    const r = await processToolOutput({ tool_name: "Read", tool_response: "" });
    expect(r).toBeNull();
  });

  it("returns null when over size cap", async () => {
    const big = "a".repeat(11 * 1024 * 1024);
    const r = await processToolOutput({ tool_name: "Read", tool_response: big });
    expect(r).toBeNull();
  });

  it("compresses Read output to first 3 lines", async () => {
    const r = await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/b.ts" },
      tool_response: "l1\nl2\nl3\nl4\nl5\nl6\nl7"
    });
    expect(r).toBe("l1\nl2\nl3");
  });

  it("returns null when filter does not actually compress", async () => {
    const eng = await import("../engine");
    vi.mocked(eng.processOutput).mockResolvedValueOnce({
      output: "abc",
      filterId: null,
      rawBytes: 3,
      filteredBytes: 3,
      debugBypass: false
    });
    const r = await processToolOutput({
      tool_name: "Grep",
      tool_input: { pattern: "foo" },
      tool_response: "abc"
    });
    expect(r).toBeNull();
  });

  it("supports object tool_response", async () => {
    const r = await processToolOutput({
      tool_name: "Grep",
      tool_input: { path: "/x" },
      tool_response: { output: "a\nb\nc\nd\ne" }
    });
    expect(r).toBe("a\nb\nc");
  });

  it("extracts content from the real Read payload shape", async () => {
    const r = await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/b.ts" },
      tool_response: {
        type: "text",
        file: { filePath: "/a/b.ts", content: "l1\nl2\nl3\nl4\nl5\nl6\nl7", numLines: 7, startLine: 1, totalLines: 7 }
      }
    });
    expect(r).toBe("l1\nl2\nl3");
  });

  it("extracts content from the real Grep payload shape", async () => {
    const r = await processToolOutput({
      tool_name: "Grep",
      tool_input: { pattern: "foo" },
      tool_response: { mode: "content", numFiles: 2, filenames: ["/a", "/b"], content: "m1\nm2\nm3\nm4\nm5", numLines: 5 }
    });
    expect(r).toBe("m1\nm2\nm3");
  });

  it("extracts filenames from the real Glob payload shape", async () => {
    const r = await processToolOutput({
      tool_name: "Glob",
      tool_input: { path: "/x" },
      tool_response: { filenames: Array.from({ length: 45 }, (_, i) => `/x/f${i}.ts`), durationMs: 3, numFiles: 45, truncated: false }
    });
    expect(r).toMatch(/^\/x\/f0\.ts\n\/x\/f1\.ts\n\/x\/f2\.ts\n\[tkr restore [0-9a-f]{16}\]$/);
  });

  it("leaves a short Glob result untouched", async () => {
    const r = await processToolOutput({
      tool_name: "Glob",
      tool_input: { path: "/x" },
      tool_response: { filenames: ["/x/a.ts", "/x/b.ts", "/x/c.ts", "/x/d.ts", "/x/e.ts"], durationMs: 3, numFiles: 5, truncated: false }
    });
    expect(r).toBeNull();
  });

  it("records savings to stats and telemetry so Read/Grep/Glob show in gain and dashboard", async () => {
    const stats = await import("../stats");
    const tel = await import("../learn/telemetry");
    vi.mocked(stats.recordStat).mockClear();
    vi.mocked(tel.recordTelemetry).mockClear();
    await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/b.ts" },
      tool_response: "l1\nl2\nl3\nl4\nl5\nl6\nl7"
    });
    expect(stats.recordStat).toHaveBeenCalledTimes(1);
    const telArg = vi.mocked(tel.recordTelemetry).mock.calls[0]?.[0];
    expect(telArg?.cmd).toBe("read-tool");
    expect(telArg?.tokensSaved).toBeGreaterThan(0);
  });

  it("holds deferred accounting until committed and counts a later fallback exactly once", async () => {
    const stats = await import("../stats");
    const tel = await import("../learn/telemetry");
    const rec = await import("../learn/recorder");
    vi.mocked(stats.recordStat).mockClear();
    vi.mocked(tel.recordTelemetry).mockClear();
    vi.mocked(rec.recordEvent).mockClear();
    const payload = { tool_name: "Read", tool_input: { file_path: "/a/b.ts" }, tool_response: "l1\nl2\nl3\nl4\nl5\nl6\nl7" };
    const commits: Array<() => Promise<void>> = [];
    const served = await processToolOutput(payload, { deferAccounting: (commit) => { commits.push(commit); } });
    expect(served).not.toBeNull();
    expect(commits).toHaveLength(1);
    expect(stats.recordStat).not.toHaveBeenCalled();
    expect(tel.recordTelemetry).not.toHaveBeenCalled();
    expect(rec.recordEvent).not.toHaveBeenCalled();
    await processToolOutput(payload);
    expect(stats.recordStat).toHaveBeenCalledTimes(1);
    expect(tel.recordTelemetry).toHaveBeenCalledTimes(1);
    expect(rec.recordEvent).toHaveBeenCalledTimes(1);
  });

  it("accounts a deferred delivery once even when the commit runs twice", async () => {
    const stats = await import("../stats");
    const tel = await import("../learn/telemetry");
    vi.mocked(stats.recordStat).mockClear();
    vi.mocked(tel.recordTelemetry).mockClear();
    let commit: (() => Promise<void>) | undefined;
    await processToolOutput(
      { tool_name: "Read", tool_input: { file_path: "/a/b.ts" }, tool_response: "l1\nl2\nl3\nl4\nl5\nl6\nl7" },
      { deferAccounting: (next) => { commit = next; } }
    );
    await commit!();
    await commit!();
    expect(stats.recordStat).toHaveBeenCalledTimes(1);
    expect(tel.recordTelemetry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tel.recordTelemetry).mock.calls[0]?.[0].cmd).toBe("read-tool");
  });

  it("records full uncapped raw on native-hook hosts so savings reflect real output", async () => {
    const stats = await import("../stats");
    const tel = await import("../learn/telemetry");
    const hd = await import("../host-detect");
    vi.mocked(stats.recordStat).mockClear();
    vi.mocked(tel.recordTelemetry).mockClear();
    vi.mocked(hd.detectHost).mockReturnValueOnce({
      host: "claude-code",
      source: "env",
      os: "darwin",
      arch: "arm64",
      shimRecommended: false
    });
    await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/b.ts" },
      tool_response: "line\n".repeat(7000)
    });
    const statArgs = vi.mocked(stats.recordStat).mock.calls[0];
    expect(statArgs?.[0]).toBe(35000);
    expect(statArgs?.[4]).toBe("claude-code");
    const telArg = vi.mocked(tel.recordTelemetry).mock.calls[0]?.[0];
    expect(telArg?.tokensSaved).toBeGreaterThan(0);
  });

  it("never records the grep pattern or glob path", async () => {
    const rec = await import("../learn/recorder");
    vi.mocked(rec.recordEvent).mockClear();
    await processToolOutput({
      tool_name: "Grep",
      tool_input: { pattern: "ghp_supersecretpattern" },
      tool_response: "a\nb\nc\nd"
    });
    await processToolOutput({
      tool_name: "Glob",
      tool_input: { path: "/Users/me/private" },
      tool_response: Array.from({ length: 45 }, (_, i) => `f${i}`).join("\n")
    });
    const cmds = vi.mocked(rec.recordEvent).mock.calls.map((c) => c[0]?.cmd);
    expect(cmds).toEqual(["grep-tool", "glob-tool"]);
  });

  it("caches the full raw output so the restore hint hash retrieves all of it", async () => {
    const { readContentCache } = await import("../content-cache");
    const tail = "x".repeat(80);
    const big = "l1\nl2\nl3\n" + tail;
    const r = await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/b.ts" },
      tool_response: big
    });
    const hash = r!.match(/\[tkr restore ([0-9a-f]{16})\]/)![1];
    expect(await readContentCache(hash)).toBe(big);
  });

  it("appends a restore hint and caches the full list for a filenames-only Glob response", async () => {
    const { readContentCache } = await import("../content-cache");
    const filenames = Array.from({ length: 45 }, (_, i) => `/x/some/long/path/file-${i}.ts`);
    const r = await processToolOutput({
      tool_name: "Glob",
      tool_input: { path: "/x" },
      tool_response: { filenames, numFiles: 45 }
    });
    const full = filenames.join("\n");
    const hash = createHash("sha256").update(full).digest("hex").slice(0, 16);
    expect(r).toBe(`${filenames.slice(0, 3).join("\n")}\n[tkr restore ${hash}]`);
    expect(await readContentCache(hash)).toBe(full);
  });
});

describe("buildHookEnvelope (host PostToolUse contract)", () => {
  it("emits hookSpecificOutput.updatedToolOutput, never updatedOutput", () => {
    const env = JSON.parse(buildHookEnvelope({ tool_name: "Read", tool_response: "raw" }, "small"));
    expect(env.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(env.hookSpecificOutput.updatedToolOutput).toBe("small");
    expect("updatedOutput" in env.hookSpecificOutput).toBe(false);
  });

  it("preserves the real Read shape with content replaced", () => {
    const resp = {
      type: "text",
      file: { filePath: "/a/b.ts", content: "l1\nl2\nl3\nl4", numLines: 4, startLine: 1, totalLines: 4 }
    };
    const env = JSON.parse(buildHookEnvelope({ tool_name: "Read", tool_response: resp }, "l1\nl2"));
    expect(env.hookSpecificOutput.updatedToolOutput).toEqual({
      type: "text",
      file: { filePath: "/a/b.ts", content: "l1\nl2", numLines: 4, startLine: 1, totalLines: 4 }
    });
  });

  it("preserves the real Bash shape, compressed into stdout", () => {
    const resp = { stdout: "x\n".repeat(800), stderr: "warn" };
    const env = JSON.parse(buildHookEnvelope({ tool_name: "Bash", tool_response: resp }, "squeezed"));
    expect(env.hookSpecificOutput.updatedToolOutput).toEqual({ stdout: "squeezed", stderr: "" });
  });

  it("preserves the real Glob shape as a filename list", () => {
    const resp = { filenames: ["/x/a.ts", "/x/b.ts", "/x/c.ts"], durationMs: 3, numFiles: 3, truncated: false };
    const env = JSON.parse(buildHookEnvelope({ tool_name: "Glob", tool_response: resp }, "/x/a.ts\n/x/b.ts"));
    expect(env.hookSpecificOutput.updatedToolOutput).toEqual({
      filenames: ["/x/a.ts", "/x/b.ts"],
      durationMs: 3,
      numFiles: 3,
      truncated: false
    });
  });

  it("reconstructs filenames by membership, not positional slice (robust to reordering)", () => {
    const resp = { filenames: ["/x/a.ts", "/x/b.ts", "/x/c.ts"], durationMs: 3, numFiles: 3, truncated: false };
    const env = JSON.parse(buildHookEnvelope({ tool_name: "Glob", tool_response: resp }, "/x/c.ts\n/x/a.ts"));
    expect(env.hookSpecificOutput.updatedToolOutput.filenames).toEqual(["/x/c.ts", "/x/a.ts"]);
  });

  it("keeps the omission marker so the agent knows the filename list is incomplete", () => {
    const filenames = Array.from({ length: 1500 }, (_, i) => `/x/f${i}.ts`);
    const capped = filenames.slice(0, 1000).join("\n") + "\n… (500 more lines omitted)";
    const resp = { filenames, durationMs: 3, numFiles: 1500, truncated: false };
    const env = JSON.parse(buildHookEnvelope({ tool_name: "Glob", tool_response: resp }, capped));
    const out = env.hookSpecificOutput.updatedToolOutput.filenames as string[];
    expect(out.length).toBe(1001);
    expect(out[out.length - 1]).toBe("… (500 more lines omitted)");
    expect(out.slice(0, 1000)).toEqual(filenames.slice(0, 1000));
  });

  it("keeps a restore hint line in the filenames array", () => {
    const resp = { filenames: ["/x/a.ts", "/x/b.ts", "/x/c.ts"], numFiles: 3 };
    const env = JSON.parse(
      buildHookEnvelope(
        { tool_name: "Glob", tool_response: resp },
        "/x/a.ts\n/x/b.ts\n[tkr restore a3f9b2c1d4e5f607]"
      )
    );
    expect(env.hookSpecificOutput.updatedToolOutput.filenames).toEqual([
      "/x/a.ts",
      "/x/b.ts",
      "[tkr restore a3f9b2c1d4e5f607]"
    ]);
  });

  it("preserves the real Grep content shape", () => {
    const resp = { mode: "content", numFiles: 2, filenames: ["/a", "/b"], content: "m1\nm2\nm3", numLines: 3 };
    const env = JSON.parse(buildHookEnvelope({ tool_name: "Grep", tool_response: resp }, "m1\nm2"));
    expect(env.hookSpecificOutput.updatedToolOutput).toEqual({
      mode: "content",
      numFiles: 2,
      filenames: ["/a", "/b"],
      content: "m1\nm2",
      numLines: 3
    });
  });

  it("falls back to the compressed string for string responses", () => {
    const env = JSON.parse(buildHookEnvelope({ tool_name: "Bash", tool_response: "plain" }, "c"));
    expect(env.hookSpecificOutput.updatedToolOutput).toBe("c");
  });
});

describe("failure-heuristic scoping per tool", () => {
  it("passes exitCode 0 for Read (content is never a failure)", async () => {
    const { processOutput } = await import("../engine");
    vi.mocked(processOutput).mockClear();
    await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/handler.ts" },
      tool_response: { file: { content: "try {\n} catch (e) {\n  // ERROR path\n}\n".repeat(40) } }
    });
    const call = vi.mocked(processOutput).mock.calls.at(-1)!;
    expect(call[3]?.exitCode).toBe(0);
  });

  it("passes exitCode 0 for Grep results", async () => {
    const { processOutput } = await import("../engine");
    vi.mocked(processOutput).mockClear();
    await processToolOutput({
      tool_name: "Grep",
      tool_input: { pattern: "Error" },
      tool_response: { content: "a.ts:1:Error handling\n".repeat(80) }
    });
    const call = vi.mocked(processOutput).mock.calls.at(-1)!;
    expect(call[3]?.exitCode).toBe(0);
  });

  it("leaves exitCode undefined for Bash when the command status is unknown (heuristic stays active)", async () => {
    const { processOutput } = await import("../engine");
    vi.mocked(processOutput).mockClear();
    await processToolOutput({
      tool_name: "Bash",
      tool_input: { command: "git log | grep foo || true" },
      tool_response: { stdout: "x\n".repeat(1000), stderr: "" }
    });
    const call = vi.mocked(processOutput).mock.calls.at(-1)!;
    expect(call[3]?.exitCode).toBeUndefined();
  });

  it("passes the exec exit code for a Bash command PostToolUse reports as successful", async () => {
    const { processOutput } = await import("../engine");
    vi.mocked(processOutput).mockClear();
    await processToolOutput({
      tool_name: "Bash",
      tool_input: { command: "git log | grep foo" },
      tool_response: { stdout: "x\n".repeat(1000), stderr: "" }
    });
    const call = vi.mocked(processOutput).mock.calls.at(-1)!;
    expect(call[0]).toBe("grep foo");
    expect(call[3]?.exitCode).toBe(0);
  });
});

describe("first-save notice", () => {
  it("emits a one-shot system message on the first effective save", async () => {
    const { takeFirstSaveNotice } = await import("../hooks-host/post-tool-use");
    const { rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    takeFirstSaveNotice();
    rmSync(join(process.env.TOKMIZER_HOME!, "first-save"), { force: true });
    const big = "line of content that repeats\n".repeat(200);
    await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/big.ts" },
      tool_response: { file: { content: big } }
    });
    const notice = takeFirstSaveNotice();
    expect(notice).toMatch(/tokens/i);
    expect(notice).toContain("/tkr-gain");

    await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/big.ts" },
      tool_response: { file: { content: big } }
    });
    expect(takeFirstSaveNotice()).toBeNull();
  });

  it("buildHookEnvelope carries the system message when provided", () => {
    const env = JSON.parse(buildHookEnvelope({ tool_response: "x" }, "y", "hello"));
    expect(env.systemMessage).toBe("hello");
    expect(env.hookSpecificOutput.updatedToolOutput).toBe("y");
    const bare = JSON.parse(buildHookEnvelope({ tool_response: "x" }, "y"));
    expect(bare.systemMessage).toBeUndefined();
  });
});

describe("schema drift recording", () => {
  it("logs unknown tool_response shapes to drift.jsonl and passes through", async () => {
    const { rmSync: rm, readFileSync: rf } = await import("node:fs");
    const { join: j } = await import("node:path");
    const driftFile = j(process.env.TOKMIZER_HOME!, "drift.jsonl");
    rm(driftFile, { force: true });
    const r = await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/b.ts" },
      tool_response: { brand_new_field: { content: "x".repeat(3000) } } as never
    });
    expect(r).toBeNull();
    const line = JSON.parse(rf(driftFile, "utf8").trim().split("\n")[0]!);
    expect(line.tool).toBe("Read");
    expect(line.keys).toContain("brand_new_field");
  });

  it("does not record drift for a known-empty Glob result", async () => {
    const { rmSync: rm, existsSync: ex } = await import("node:fs");
    const { join: j } = await import("node:path");
    const driftFile = j(process.env.TOKMIZER_HOME!, "drift.jsonl");
    rm(driftFile, { force: true });
    const r = await processToolOutput({
      tool_name: "Glob",
      tool_input: { pattern: "*.zz" },
      tool_response: { filenames: [] }
    });
    expect(r).toBeNull();
    expect(ex(driftFile)).toBe(false);
  });
});

describe("fold restore hint", () => {
  it("caches the original and appends a restore hint when the output contains folds", async () => {
    const { processOutput } = await import("../engine");
    const folded = "function f() {\n  … 3 lines folded …\n\n\n}";
    vi.mocked(processOutput).mockResolvedValueOnce({
      output: folded,
      filterId: "read-tool",
      rawBytes: 4000,
      filteredBytes: folded.length,
      debugBypass: false,
      droppedTail: null
    });
    const original = "function f() {\n  a();\n  b();\n  c();\n}\n" + "x".repeat(4000);
    const r = await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/f.ts" },
      tool_response: { file: { content: original } }
    });
    expect(r).toMatch(/\[tkr restore [0-9a-f]{8,64}\]$/);
    const hash = /\[tkr restore ([0-9a-f]+)\]/.exec(r!)![1]!;
    const { readContentCache } = await import("../content-cache");
    expect(await readContentCache(hash)).toBe(original);
  });

  it("keeps the tail-only hint behavior when no fold is present", async () => {
    const { processOutput } = await import("../engine");
    const plain = "line1\nline2\nline3";
    vi.mocked(processOutput).mockResolvedValueOnce({
      output: plain,
      filterId: "read-tool",
      rawBytes: 4000,
      filteredBytes: plain.length,
      debugBypass: false,
      droppedTail: null
    });
    const r = await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/a/g.ts" },
      tool_response: { file: { content: "line1\nline2\nline3\n" + "y".repeat(4000) } }
    });
    expect(r).not.toMatch(/tkr restore/);
  });
});

describe("session working-set recording", () => {
  it("records a Read event under the payload's session id", async () => {
    const { readSessionEvents } = await import("../session-log");
    const { rmSync: rm } = await import("node:fs");
    const { sessionFile } = await import("../session-log");
    rm(sessionFile("sess-rec-1"), { force: true });
    await processToolOutput({
      session_id: "sess-rec-1",
      tool_name: "Read",
      tool_input: { file_path: "/src/thing.ts" },
      tool_response: { file: { content: "line\n".repeat(300) } }
    } as never);
    const events = readSessionEvents("sess-rec-1");
    expect(events.length).toBe(1);
    expect(events[0]!.tool).toBe("Read");
    expect(events[0]!.target).toBe("/src/thing.ts");
  });

  it("does not record when the plugin is disabled", async () => {
    const { readSessionEvents, sessionFile } = await import("../session-log");
    const { rmSync: rm } = await import("node:fs");
    const { writeFileSync: wf } = await import("node:fs");
    const { join: j } = await import("node:path");
    rm(sessionFile("sess-rec-off"), { force: true });
    const settingsFile = j(process.env.TOKMIZER_HOME!, "settings-cache.json");
    wf(settingsFile, JSON.stringify({ enabled: false }));
    try {
      await processToolOutput({
        session_id: "sess-rec-off",
        tool_name: "Read",
        tool_input: { file_path: "/src/secret.ts" },
        tool_response: { file: { content: "line\n".repeat(300) } }
      } as never);
    } finally {
      rm(settingsFile, { force: true });
    }
    expect(readSessionEvents("sess-rec-off").length).toBe(0);
  });

  it("does not record on a virgin install without state", async () => {
    const { readSessionEvents, sessionFile } = await import("../session-log");
    const { rmSync: rm } = await import("node:fs");
    const { loadState } = await import("../state");
    rm(sessionFile("sess-rec-virgin"), { force: true });
    vi.mocked(loadState).mockResolvedValueOnce(null as never);
    await processToolOutput({
      session_id: "sess-rec-virgin",
      tool_name: "Read",
      tool_input: { file_path: "/src/thing.ts" },
      tool_response: { file: { content: "line\n".repeat(300) } }
    } as never);
    expect(readSessionEvents("sess-rec-virgin").length).toBe(0);
  });

  it("compresses with the built-in rules on a virgin install without account features", async () => {
    const { loadState } = await import("../state");
    const { processOutput } = await import("../engine");
    const { recordEvent } = await import("../learn/recorder");
    vi.mocked(loadState).mockResolvedValueOnce(null as never);
    vi.mocked(processOutput).mockClear();
    vi.mocked(recordEvent).mockClear();
    const r = await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/src/virgin.ts" },
      tool_response: { file: { content: "line\n".repeat(300) } }
    } as never);
    expect(r).not.toBeNull();
    expect(vi.mocked(processOutput).mock.calls[0]![2]).toBeNull();
    expect(vi.mocked(recordEvent).mock.calls[0]![0]).toMatchObject({ plan: null });
  });

  it("does not record when the payload has no session id", async () => {
    const { readSessionEvents, sessionFile } = await import("../session-log");
    const { rmSync: rm } = await import("node:fs");
    rm(sessionFile("default"), { force: true });
    await processToolOutput({
      tool_name: "Read",
      tool_input: { file_path: "/src/other.ts" },
      tool_response: { file: { content: "line\n".repeat(300) } }
    });
    expect(readSessionEvents("default").length).toBe(0);
  });
});

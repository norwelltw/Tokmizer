import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendSpool, drainSpool, commitSpool, clearSpool } from "../learn/spool";

let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-spool-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
});

describe("spool", () => {
  it("appends then drains events", () => {
    appendSpool("telemetry", { cmd: "ls", tokensSaved: 10, optimized: true });
    appendSpool("telemetry", { cmd: "git status", tokensSaved: 0, optimized: false });
    const events = drainSpool("telemetry");
    expect(events).toHaveLength(2);
    expect((events[0] as { cmd: string }).cmd).toBe("ls");
  });

  it("retains pending events across drains until commit", () => {
    appendSpool("learn", { cmd: "ls" });
    expect(drainSpool("learn")).toHaveLength(1);
    expect(drainSpool("learn")).toHaveLength(1);
    commitSpool("learn");
    expect(drainSpool("learn")).toHaveLength(0);
  });

  it("keeps events appended after a drain for the next cycle", () => {
    appendSpool("learn", { cmd: "a" });
    const first = drainSpool("learn");
    expect(first).toHaveLength(1);
    appendSpool("learn", { cmd: "b" });
    commitSpool("learn");
    const second = drainSpool("learn");
    expect(second).toHaveLength(1);
    expect((second[0] as { cmd: string }).cmd).toBe("b");
  });

  it("merges new spool events into a stuck pending file on drain", () => {
    appendSpool("learn", { cmd: "a" });
    expect(drainSpool("learn")).toHaveLength(1);
    appendSpool("learn", { cmd: "b" });
    const merged = drainSpool("learn");
    expect(merged).toHaveLength(2);
    expect((merged[1] as { cmd: string }).cmd).toBe("b");
    expect(existsSync(join(dir, "spool", "learn.jsonl"))).toBe(false);
    appendSpool("learn", { cmd: "c" });
    expect(drainSpool("learn")).toHaveLength(3);
  });

  it("recovers events from a leftover merging file", () => {
    appendSpool("learn", { cmd: "a" });
    drainSpool("learn");
    writeFileSync(join(dir, "spool", "learn.jsonl.merging"), `${JSON.stringify({ cmd: "orphan" })}\n`);
    const events = drainSpool("learn");
    expect(events.some((e) => (e as { cmd: string }).cmd === "orphan")).toBe(true);
    expect(existsSync(join(dir, "spool", "learn.jsonl.merging"))).toBe(false);
  });

  it("skips malformed lines", () => {
    appendSpool("telemetry", { cmd: "ok" });
    appendFileSync(join(dir, "spool", "telemetry.jsonl"), "not json\n");
    appendSpool("telemetry", { cmd: "ok2" });
    expect(drainSpool("telemetry")).toHaveLength(2);
  });

  it("drops new events once the spool file reaches the size cap", () => {
    mkdirSync(join(dir, "spool"), { recursive: true });
    writeFileSync(join(dir, "spool", "telemetry.jsonl"), `${JSON.stringify({ cmd: "x" })}\n`.repeat(50000));
    appendSpool("telemetry", { cmd: "dropped" });
    const events = drainSpool("telemetry");
    expect(events.some((e) => (e as { cmd: string }).cmd === "dropped")).toBe(false);
  });

  it("clearSpool removes both live and pending files", () => {
    appendSpool("telemetry", { cmd: "a" });
    drainSpool("telemetry");
    appendSpool("telemetry", { cmd: "b" });
    clearSpool("telemetry");
    expect(existsSync(join(dir, "spool", "telemetry.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "spool", "telemetry.pending.jsonl"))).toBe(false);
    expect(drainSpool("telemetry")).toHaveLength(0);
  });

  it("bounds the pending file when offline retries accumulate past the cap", () => {
    const big = "x".repeat(200);
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 700; i++) appendSpool("telemetry", { cmd: big, n: i });
      drainSpool("telemetry");
    }
    const pending = join(dir, "spool", "telemetry.pending.jsonl");
    expect(statSync(pending).size).toBeLessThanOrEqual(512 * 1024);
  });

  it("bounds the pending file in bytes when events contain multibyte characters", () => {
    const big = "é".repeat(200);
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 700; i++) appendSpool("telemetry", { cmd: big, n: i });
      drainSpool("telemetry");
    }
    const pending = join(dir, "spool", "telemetry.pending.jsonl");
    expect(statSync(pending).size).toBeLessThanOrEqual(512 * 1024);
  });

  it("does not duplicate events when removing the merging file fails", async () => {
    vi.resetModules();
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const merging = join(dir, "spool", "telemetry.jsonl.merging");
    let failNextMergeUnlink = false;
    vi.doMock("node:fs", () => ({
      ...realFs,
      unlinkSync: (p: string) => {
        if (p === merging && failNextMergeUnlink) {
          failNextMergeUnlink = false;
          throw new Error("EPERM");
        }
        return realFs.unlinkSync(p);
      }
    }));
    const spool = await import("../learn/spool");
    spool.appendSpool("telemetry", { cmd: "a" });
    spool.drainSpool("telemetry");
    spool.appendSpool("telemetry", { cmd: "b" });
    failNextMergeUnlink = true;
    spool.drainSpool("telemetry");
    spool.appendSpool("telemetry", { cmd: "c" });
    const events = spool.drainSpool("telemetry");
    const cmds = events.map((e) => (e as { cmd: string }).cmd).sort();
    expect(cmds).toEqual(["a", "b", "c"]);
    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});

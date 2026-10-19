import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStats, recordStat, rotateStats, readGain, readDaily, renderGain, formatTokens, countedSaving, monthlyProjectionUsd, statCmdLabel, withInstallAge, type GainAgg } from "../stats";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-stats-"));
  file = join(dir, "stats.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe("readGain", () => {
  it("aggregates recorded stats correctly", async () => {
    recordStat(1000, 100, file);
    recordStat(2000, 200, file);
    await flushMicrotasks();

    const agg = await readGain(file);
    expect(agg.count).toBe(2);
    expect(agg.compressedCount).toBe(2);
    expect(agg.rawTokens).toBe(750);
    expect(agg.filteredTokens).toBe(75);
    expect(agg.savedTokens).toBe(675);
    expect(agg.savedPct).toBe(90);
    expect(agg.sinceDays).toBeGreaterThanOrEqual(1);
  });

  it("keeps modeled reducer savings out of the measured headline and in a separate estimate", async () => {
    recordStat(1000, 100, file);
    recordStat(8000, 4000, file, true);
    await flushMicrotasks();

    const agg = await readGain(file);
    expect(agg.count).toBe(1);
    expect(agg.compressedCount).toBe(1);
    expect(agg.rawTokens).toBe(250);
    expect(agg.filteredTokens).toBe(25);
    expect(agg.savedTokens).toBe(225);
    expect(agg.modeledSavedTokens).toBe(1000);
  });

  it("counts equal-size runs as processed but not compressed", async () => {
    recordStat(500, 500, file);
    recordStat(500, 800, file);
    recordStat(0, 0, file);
    await flushMicrotasks();

    const agg = await readGain(file);
    expect(agg.count).toBe(2);
    expect(agg.compressedCount).toBe(0);
    expect(agg.savedTokens).toBe(0);
    expect(agg.observed?.savedTokens).toBe(-75);
  });

  it("preserves the legacy reduced-output percentage alongside the observed total", async () => {
    recordStat(1000, 100, file);
    recordStat(5000, 5000, file);
    await flushMicrotasks();

    const agg = await readGain(file);
    expect(agg.count).toBe(2);
    expect(agg.compressedCount).toBe(1);
    expect(agg.rawTokens).toBe(250);
    expect(agg.filteredTokens).toBe(25);
    expect(agg.savedTokens).toBe(225);
    expect(agg.savedPct).toBe(90);
  });

  it("returns zeros for missing file", async () => {
    const agg = await readGain(join(dir, "nope.jsonl"));
    expect(agg).toMatchObject({
      count: 0,
      compressedCount: 0,
      rawTokens: 0,
      filteredTokens: 0,
      savedTokens: 0,
      modeledSavedTokens: 0,
      savedPct: 0,
      sinceDays: 1,
      savedByProvider: {},
      shellCompressedCount: 0,
      shellSavedPct: 0,
      byCommand: []
    });
  });

  it("skips malformed lines but counts valid ones", async () => {
    writeFileSync(
      file,
      [
        '{"t":1700000000,"r":4000,"f":400}',
        "not json at all",
        '{"t":1700000001,"r":"bad","f":400}',
        "",
        '{"t":1700000002,"r":4000,"f":400}'
      ].join("\n")
    );
    const agg = await readGain(file);
    expect(agg.count).toBe(2);
    expect(agg.rawTokens).toBe(2000);
    expect(agg.filteredTokens).toBe(200);
    expect(agg.savedTokens).toBe(1800);
  });
});

describe("formatTokens", () => {
  it("humanizes magnitudes", () => {
    expect(formatTokens(6_200_000)).toBe("6.2M");
    expect(formatTokens(700_000)).toBe("700.0K");
    expect(formatTokens(950)).toBe("950");
  });
});

describe("countedSaving", () => {
  it("caps the counted raw at the host truncation, keeping filtered", () => {
    expect(countedSaving(1_460_000, 24_000, 30_000)).toEqual({ raw: 30_000, filtered: 24_000 });
  });
  it("passes through unchanged when no cap applies", () => {
    expect(countedSaving(1_460_000, 24_000, null)).toEqual({ raw: 1_460_000, filtered: 24_000 });
  });
  it("gives full credit when raw is already under the cap", () => {
    expect(countedSaving(5_000, 1_000, 30_000)).toEqual({ raw: 5_000, filtered: 1_000 });
  });
  it("reports no saving when filtered would exceed the cap", () => {
    expect(countedSaving(1_460_000, 40_000, 30_000)).toEqual({ raw: 30_000, filtered: 30_000 });
  });
});

describe("monthlyProjectionUsd", () => {
  it("projects the daily saving rate over 30 days", () => {
    expect(monthlyProjectionUsd(960_000, 6, 3)).toBeCloseTo(14.4, 5);
  });
  it("returns 0 for no savings", () => {
    expect(monthlyProjectionUsd(0, 6, 3)).toBe(0);
  });
  it("returns 0 when the window or price is non-positive", () => {
    expect(monthlyProjectionUsd(1000, 0, 3)).toBe(0);
    expect(monthlyProjectionUsd(1000, 6, 0)).toBe(0);
  });
});

describe("renderGain", () => {
  const agg: GainAgg = {
    count: 1240,
    compressedCount: 1200,
    rawTokens: 6_200_000,
    filteredTokens: 700_000,
    savedTokens: 5_500_000,
    modeledSavedTokens: 0,
    savedPct: 88,
    sinceDays: 14
  };

  it("omits the reducer line when there is no modeled estimate", () => {
    const out = renderGain(agg, { color: false, pricePerMtok: 3 });
    expect(out).not.toContain("Reducer");
  });

  it("hides the provider breakdown with a single provider", () => {
    const agg: GainAgg = {
      count: 10,
      compressedCount: 5,
      rawTokens: 1_000_000,
      filteredTokens: 500_000,
      savedTokens: 500_000,
      modeledSavedTokens: 0,
      savedPct: 50,
      sinceDays: 7,
      savedByProvider: { anthropic: 500_000 },
      shellCompressedCount: 5,
      shellSavedPct: 50,
      byCommand: []
    };
    const out = renderGain(agg, { color: false, pricePerMtok: 3 });
    expect(out).not.toContain("By provider");
  });

  it("returns a friendly message for empty aggregates", () => {
    const empty: GainAgg = {
      count: 0,
      compressedCount: 0,
      rawTokens: 0,
      filteredTokens: 0,
      savedTokens: 0,
      modeledSavedTokens: 0,
      savedPct: 0,
      sinceDays: 1
    };
    const out = renderGain(empty, { color: false, pricePerMtok: 3 });
    expect(out).toContain("No data yet");
    expect(out).not.toContain("Without tokmizer");
  });

  it("does not extrapolate a capped history into a monthly promise", () => {
    const out = renderGain(agg, { color: false, pricePerMtok: 3 });
    expect(out).not.toContain("/ month");
  });

  it("omits the projection for windows under 3 days (no 1-day extrapolation)", () => {
    const fresh: GainAgg = { ...agg, sinceDays: 1 };
    const out = renderGain(fresh, { color: false, pricePerMtok: 3 });
    expect(out).not.toContain("/ month");
  });

  it("never shows a paid-plan payback or upsell line", () => {
    for (const g of [agg, { ...agg, savedTokens: 100_000, sinceDays: 14 }]) {
      const out = renderGain(g, { color: false, pricePerMtok: 3 });
      expect(out).not.toContain("Pays for itself");
      expect(out).not.toContain("Covers");
      expect(out).not.toContain("Smart plan");
      expect(out).not.toContain("Pro plan");
    }
  });
});

describe("reduced-shell-output metric", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tkr-shell-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recordStat tags shell events with k", () => {
    const file = join(dir, "stats.jsonl");
    recordStat(1000, 100, file, false, "claude-code", "sh");
    recordStat(1000, 900, file, false, "claude-code");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines[0]).toContain('"k":"sh"');
    expect(lines[1]).not.toContain('"k"');
  });

  it("readGain computes the shell-only compressed percentage", async () => {
    const file = join(dir, "stats.jsonl");
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(file, [
      JSON.stringify({ t: now, r: 20000, f: 2000, h: "claude-code", k: "sh" }),
      JSON.stringify({ t: now, r: 500, f: 500, h: "claude-code", k: "sh" }),
      JSON.stringify({ t: now, r: 8000, f: 4000, h: "claude-code" })
    ].join("\n") + "\n");
    const agg = await readGain(file);
    expect(agg.shellCompressedCount).toBe(1);
    expect(agg.shellSavedPct).toBe(90);
  });

});

describe("per-command breakdown", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tkr-bycmd-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("statCmdLabel keeps head and clean subcommand, never arguments", () => {
    expect(statCmdLabel("git status --short")).toBe("git status");
    expect(statCmdLabel("FOO=1 /usr/bin/grep -rn secret src/")).toBe("grep");
    expect(statCmdLabel("mysql -psecret123 db")).toBe("mysql");
    expect(statCmdLabel("npm test")).toBe("npm test");
    expect(statCmdLabel("git log --oneline | head -200")).toBe("git log");
  });

  it("statCmdLabel skips wrapper flags and their values", () => {
    expect(statCmdLabel("timeout 30 git log")).toBe("git log");
    expect(statCmdLabel("timeout 30s npm test")).toBe("npm test");
    expect(statCmdLabel("sudo -u tokmizer tar -xf a.tar")).toBe("tar");
    expect(statCmdLabel("env -i git status")).toBe("git status");
    expect(statCmdLabel("nice -n 10 make")).toBe("make");
    expect(statCmdLabel("(git log --oneline &)")).toBe("git log");
    expect(statCmdLabel("cd /some/dir && git log")).toBe("git log");
  });

  it("statCmdLabel keeps quoted values with spaces inside their assignment", () => {
    expect(statCmdLabel('A="/w/ATM Industrie 84 - Bollene"; ls -la "$A"')).toBe("ls");
    expect(statCmdLabel("B='a b c' git status")).toBe("git status");
  });

  it("statCmdLabel skips cd segments ending with ; or a newline", () => {
    expect(statCmdLabel("cd /x; git log -n 3")).toBe("git log");
    expect(statCmdLabel("cd '/a b'\ngrep -rn foo .")).toBe("grep");
    expect(statCmdLabel("cd /x && cd y; npm test")).toBe("npm test");
  });

  it("statCmdLabel drops data arguments for binaries without subcommands", () => {
    expect(statCmdLabel("ssh prod-payments-db")).toBe("ssh");
    expect(statCmdLabel("psql analytics_prod")).toBe("psql");
    expect(statCmdLabel("echo hunter2pass")).toBe("echo");
    expect(statCmdLabel("scp file.txt user@host:")).toBe("scp");
    expect(statCmdLabel("curl example.com")).toBe("curl");
    expect(statCmdLabel("docker compose up")).toBe("docker compose");
  });

  it("recordStat writes the command label", () => {
    const file = join(dir, "stats.jsonl");
    recordStat(1000, 100, file, false, "claude-code", "sh", "git status");
    expect(readFileSync(file, "utf8")).toContain('"c":"git status"');
  });

  it("readGain aggregates a top-commands table", async () => {
    const file = join(dir, "stats.jsonl");
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(file, [
      JSON.stringify({ t: now, r: 24000, f: 2400, h: "claude-code", k: "sh", c: "grep" }),
      JSON.stringify({ t: now, r: 20000, f: 2000, h: "claude-code", k: "sh", c: "grep" }),
      JSON.stringify({ t: now, r: 10000, f: 9000, h: "claude-code", k: "sh", c: "git status" }),
      JSON.stringify({ t: now, r: 500, f: 500, h: "claude-code", k: "sh", c: "ls" })
    ].join("\n") + "\n");
    const agg = await readGain(file);
    expect(agg.byCommand).toBeDefined();
    expect(agg.byCommand![0]).toMatchObject({ cmd: "grep", count: 2 });
    expect(agg.byCommand![0]!.savedTokens).toBe(9900);
    expect(agg.byCommand![0]!.avgPct).toBe(90);
    expect(agg.byCommand![1]).toMatchObject({ cmd: "git status", count: 1 });
    expect(agg.byCommand!.find((r) => r.cmd === "ls")?.count).toBe(1);
  });

  it("readGain tracks coverage and native rows in the by-command table", async () => {
    const file = join(dir, "stats.jsonl");
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(file, [
      JSON.stringify({ t: now, r: 24000, f: 2400, h: "claude-code", k: "sh", c: "git log" }),
      JSON.stringify({ t: now, r: 20000, f: 20000, h: "claude-code", k: "sh", c: "git log" }),
      JSON.stringify({ t: now, r: 30000, f: 3000, h: "claude-code", c: "Read" })
    ].join("\n") + "\n");
    const agg = await readGain(file);
    const gitRow = agg.byCommand!.find((r) => r.cmd === "git log")!;
    expect(gitRow.count).toBe(2);
    expect(gitRow.compressedCount).toBe(1);
    expect(gitRow.native).toBe(false);
    const readRow = agg.byCommand!.find((r) => r.cmd === "Read")!;
    expect(readRow.native).toBe(true);
    expect(readRow.compressedCount).toBe(1);
  });

});

describe("lifetime totals across rotation", () => {
  function writeLines(n: number, t: number, cmd: string): void {
    const line = JSON.stringify({ t, r: 4000, f: 400, k: "sh", c: cmd, h: "x".repeat(60) });
    writeFileSync(file, `${line}\n`.repeat(n));
  }

  it("keeps every record in the totals after the journal rotates", async () => {
    const old = Math.floor(Date.now() / 1000) - 40 * 86400;
    writeLines(30000, old, "rg");
    recordStat(1000, 100, file, false, undefined, "sh", "git diff");
    const live = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    expect(live.length).toBeLessThan(30001);
    expect(existsSync(join(dir, "stats-ledger.json"))).toBe(true);
    const agg = await readGain(file);
    expect(agg.count).toBe(30001);
    expect(agg.compressedCount).toBe(30001);
    expect(agg.rawTokens).toBe(30000 * 1000 + 250);
    expect(agg.window?.firstAt).toBe(old);
    expect(agg.byCommand?.find((r) => r.cmd === "rg")).toMatchObject({ count: 30000, compressedCount: 30000, native: false });
    const days = await readDaily(file);
    expect(days.reduce((sum, d) => sum + d.count, 0)).toBe(30001);
  });

  it("keeps folded days out of a window that starts after them", async () => {
    const old = Math.floor(Date.now() / 1000) - 40 * 86400;
    writeLines(30000, old, "rg");
    recordStat(1000, 100, file);
    const today = new Date();
    const since = Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000);
    const agg = await readGain(file, since);
    expect(agg.count).toBe(1);
  });

  it("does not fold the same records twice when rotation runs again", async () => {
    writeLines(30000, 1_700_000_000, "rg");
    rotateStats(file);
    rotateStats(file);
    expect((await readGain(file)).count).toBe(30000);
  });

  it("skips rotation while another process holds the lock", async () => {
    writeLines(30000, 1_700_000_000, "rg");
    writeFileSync(`${file}.lock`, "1");
    rotateStats(file);
    expect(existsSync(join(dir, "stats-ledger.json"))).toBe(false);
    expect((await readGain(file)).count).toBe(30000);
  });

  it("sets a corrupt ledger aside instead of failing", async () => {
    writeFileSync(join(dir, "stats-ledger.json"), "{oops");
    recordStat(1000, 100, file);
    expect((await readGain(file)).count).toBe(1);
    expect(readdirSync(dir).some((f) => f.startsWith("stats-ledger.json.corrupt-"))).toBe(true);
  });

  it("clearStats removes the lifetime totals too", async () => {
    writeLines(30000, 1_700_000_000, "rg");
    rotateStats(file);
    await clearStats(file);
    expect(existsSync(join(dir, "stats-ledger.json"))).toBe(false);
    expect((await readGain(file)).count).toBe(0);
  });
});

describe("renderGain zero state", () => {
  it("points at tkr session instead of a bare no-data message", () => {
    const out = renderGain(
      { count: 0, rawTokens: 0, filteredTokens: 0, savedTokens: 0 } as never,
      { color: false, pricePerMtok: 3 }
    );
    expect(out).toContain("tkr session");
  });
});

describe("stats rotation at write", () => {
  it("trims the file to the cap once it grows past the rotate threshold", async () => {
    const { mkdtempSync, writeFileSync: wf, readFileSync: rf } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "tkr-rot-"));
    const file = join(dir, "stats.jsonl");
    const line = `{"t":1,"r":100,"f":50,"h":"${"x".repeat(100)}"}\n`;
    wf(file, line.repeat(25000));
    recordStat(200, 100, file);
    const lines = rf(file, "utf8").split("\n").filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(20000);
    expect(lines[lines.length - 1]).toContain('"r":200');
  });
});

describe("withInstallAge", () => {
  const base: GainAgg = {
    count: 1,
    compressedCount: 1,
    rawTokens: 100,
    filteredTokens: 50,
    savedTokens: 50,
    modeledSavedTokens: 0,
    savedPct: 50,
    sinceDays: 12,
    savedByProvider: {},
    shellCompressedCount: 0,
    shellSavedPct: 0,
    byCommand: []
  };

  it("overrides sinceDays with the real install age", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(withInstallAge(base, now - 90 * 86400, now).sinceDays).toBe(90);
  });

  it("falls back to the aggregate window without installedAt", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(withInstallAge(base, undefined, now).sinceDays).toBe(12);
  });
});

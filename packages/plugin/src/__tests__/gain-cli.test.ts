import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let dir: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-gain-cli-"));
  now = Math.floor(Date.now() / 1000);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", resolve("packages/plugin/src/bin/tkr.ts"), ...args], {
    encoding: "utf8",
    input: "",
    timeout: 10000,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      TOKMIZER_HOME: dir,
      TOKMIZER_BASE_URL: "http://127.0.0.1:1",
      TOKMIZER_AUTO_UPDATE: "0",
      TOKMIZER_DAEMON_BIN: join(dir, "disabled-daemon.js"),
      TOKMIZER_CLAUDE_COMMANDS_DIR: join(dir, "commands"),
      XDG_RUNTIME_DIR: ""
    }
  });
}

function seedState() {
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    plan: "pro",
    linked: false,
    installedAt: now - 365 * 86400
  }));
}

function seedStats(records: Record<string, unknown>[]) {
  writeFileSync(join(dir, "stats.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

describe("gain CLI measurement contract", () => {
  it("keeps the retained observation window instead of substituting installation age", () => {
    seedState();
    seedStats([
      { t: now - 3600, r: 4000, f: 2000, h: "codex" },
      { t: now - 60, r: 4000, f: 4000, h: "codex" }
    ]);
    const result = run("gain", "--json");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const gain = JSON.parse(result.stdout);
    expect(gain.sinceDays).toBe(1);
    expect(gain.window).toEqual({ firstAt: now - 3600, lastAt: now - 60 });
    expect(gain.observed).toMatchObject({ count: 2, rawTokens: 2000, filteredTokens: 1500, savedTokens: 500, savedPct: 25 });
  });

  it("labels the reference-price estimate and keeps modeled reductions separate", () => {
    seedState();
    seedStats([
      { t: now - 3600, r: 8000000, f: 4000000, h: "codex" },
      { t: now - 60, r: 4000000, f: 4000000, h: "codex" },
      { t: now - 60, r: 40000000, f: 20000000, h: "codex", m: 1 }
    ]);
    const result = run("gain", "--json");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const gain = JSON.parse(result.stdout);
    expect(gain).toMatchObject({
      count: 2,
      rawTokens: 2000000,
      filteredTokens: 1000000,
      savedTokens: 1000000,
      modeledSavedTokens: 5000000,
      savedPct: 50,
      savedUsd: 2.5,
      savedUsdBasis: "reference-input-price",
      savedUsdScope: "reduced-outputs",
      netSavedUsd: 2.5,
      netSavedUsdScope: "all-observed-outputs",
      referencePricePerMtok: 2.5,
      plan: "pro",
      measurement: { scope: "tool-output", tokenMethod: "bytes/4", tokenCounts: "estimated", billing: "not-measured" }
    });
    expect(gain.observed).toMatchObject({ count: 2, rawTokens: 3000000, filteredTokens: 2000000, savedTokens: 1000000, savedPct: 33.33 });
  });

  it("deducts expanded outputs from the net estimate while retaining legacy reduced-output savings", () => {
    seedStats([
      { t: now - 60, r: 4000000, f: 0, h: "codex" },
      { t: now, r: 4000000, f: 12000000, h: "codex" }
    ]);
    const result = run("gain", "--json");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      savedTokens: 1000000,
      savedUsd: 2.5,
      savedUsdBasis: "reference-input-price",
      savedUsdScope: "reduced-outputs",
      netSavedUsd: -2.5,
      netSavedUsdScope: "all-observed-outputs",
      referencePricePerMtok: 2.5,
      observed: { count: 2, rawTokens: 2000000, filteredTokens: 3000000, savedTokens: -1000000, savedPct: -50, expandedCount: 1 }
    });
  });

  it("does not claim a paid-plan payback or an installation-long measurement", () => {
    seedState();
    seedStats([
      { t: now - 3 * 86400, r: 4000000000, f: 4000000, h: "codex", k: "sh", c: "git diff" },
      { t: now - 60, r: 4000, f: 2000, h: "codex", k: "sh", c: "git diff" }
    ]);
    const result = run("gain");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/Pays for itself|Covers\s+.*plan|since install|365d|366d/);
    expect(result.stdout).not.toContain("Only agent commands are counted here");
    expect(result.stdout).not.toContain("tkr shim install");
  });

  it("exposes an empty measured window without activation or an implied billing saving", () => {
    const result = run("gain", "--json");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      count: 0,
      savedTokens: 0,
      savedUsd: 0,
      savedUsdBasis: "reference-input-price",
      savedUsdScope: "reduced-outputs",
      netSavedUsd: 0,
      netSavedUsdScope: "all-observed-outputs",
      referencePricePerMtok: 3,
      plan: "free",
      observed: { count: 0, rawTokens: 0, filteredTokens: 0, savedTokens: 0, savedPct: null },
      window: { firstAt: null, lastAt: null },
      measurement: { scope: "tool-output", tokenMethod: "bytes/4", tokenCounts: "estimated", billing: "not-measured" }
    });
  });

  it.each([
    { flag: "--day", includesEarlierDays: false },
    { flag: "--jour", includesEarlierDays: false },
    { flag: "--week", includesEarlierDays: true },
    { flag: "--semaine", includesEarlierDays: true }
  ])("keeps the requested history scope for $flag", ({ flag, includesEarlierDays }) => {
    seedStats([
      { t: now - 8 * 86400, r: 4000, f: 2000, c: "older-fixture" },
      { t: now - 3 * 86400, r: 4000, f: 2000, c: "week-fixture" },
      { t: now, r: 4000, f: 2000, c: "today-fixture" }
    ]);
    const result = run("gain", flag);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("today-fixture");
    expect(result.stdout).not.toContain("older-fixture");
    expect(result.stdout.includes("week-fixture")).toBe(includesEarlierDays);
  });

  it("adds a 30-day view and period lines on the default view", () => {
    seedStats([
      { t: now - 40 * 86400, r: 4000, f: 2000, c: "ancient-fixture" },
      { t: now - 20 * 86400, r: 4000, f: 2000, c: "month-fixture" },
      { t: now, r: 4000, f: 2000, c: "today-fixture" }
    ]);
    const month = run("gain", "--month");
    expect(month.status).toBe(0);
    expect(month.stdout).toContain("last 30 days");
    expect(month.stdout).toContain("month-fixture");
    expect(month.stdout).not.toContain("ancient-fixture");
    const all = run("gain");
    expect(all.status).toBe(0);
    expect(all.stdout).toContain("all time");
    expect(all.stdout).toMatch(/Today\s+500 saved · 1 commands/);
    expect(all.stdout).toMatch(/Last 7 days\s+500 saved · 1 commands/);
    expect(all.stdout).toMatch(/Tokens saved\s+1\.5K \(50 %\)/);
    expect(all.stdout).not.toMatch(/Account|\bpro\b/);
    expect(all.stdout).not.toContain("not a lifetime total");
  });
});

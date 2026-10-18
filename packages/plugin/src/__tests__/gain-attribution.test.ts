import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { quotaEstimate, readGain, recordStat, renderByRule, renderFallbacks, rotateStats, statOutcome } from "../stats";

let dir: string;
let file: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-gain-attr-"));
  file = join(dir, "stats.jsonl");
  now = Math.floor(Date.now() / 1000);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(records: Record<string, unknown>[]): void {
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, resolve("packages/plugin/src/bin/tkr.ts"), ...args], {
    encoding: "utf8",
    input: "",
    timeout: 10000,
    cwd: dir,
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

const MIXED = (): Record<string, unknown>[] => [
  { t: now - 50, r: 8000, f: 2000, h: "claude-code", k: "sh", c: "git status", s: "b" },
  { t: now - 45, r: 4000, f: 2000, h: "claude-code", k: "sh", c: "git log", s: "b" },
  { t: now - 40, r: 2000, f: 400, h: "claude-code", k: "sh", c: "mytool", s: "u:mytool" },
  { t: now - 35, r: 6000, f: 6000, h: "claude-code", k: "sh", c: "docker build", o: "n" },
  { t: now - 30, r: 1200, f: 1200, h: "claude-code", k: "sh", c: "cat", s: "b", o: "g" },
  { t: now - 25, r: 3000, f: 3000, h: "claude-code", k: "sh", c: "pytest", s: "b", o: "e" },
  { t: now - 20, r: 1000, f: 500, h: "claude-code", k: "sh", c: "legacy" },
  { t: now - 15, r: 0, f: 800, h: "claude-code", k: "restore", c: "tkr restore" },
  { t: now - 10, r: 40000, f: 40000, h: "claude-code", k: "sh", c: "huge", o: "n" }
];

describe("statOutcome", () => {
  it("records the rule source and why an output stayed unchanged, never a built-in rule name", () => {
    expect(statOutcome({ filterId: "git-status", rawBytes: 100, filteredBytes: 40, debugBypass: false })).toEqual({ s: "b" });
    expect(statOutcome({ filterId: "user/mytool", rawBytes: 100, filteredBytes: 40, debugBypass: false })).toEqual({ s: "u:mytool" });
    expect(statOutcome({ filterId: null, rawBytes: 100, filteredBytes: 100, debugBypass: false })).toEqual({ o: "n" });
    expect(statOutcome({ filterId: "cat", rawBytes: 100, filteredBytes: 100, debugBypass: false })).toEqual({ s: "b", o: "g" });
    expect(statOutcome({ filterId: "pytest", rawBytes: 100, filteredBytes: 100, debugBypass: true })).toEqual({ s: "b", o: "e" });
  });

  it("recordStat appends the outcome fields and readGain parses them back", async () => {
    recordStat(4000, 1000, file, false, "claude-code", "sh", "git status", undefined, { s: "b" });
    recordStat(4000, 4000, file, false, "claude-code", "sh", "docker build", undefined, { o: "n" });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ s: "b" });
    expect(lines[0]).not.toHaveProperty("o");
    expect(lines[1]).toMatchObject({ o: "n" });
    expect(lines[1]).not.toHaveProperty("s");
    const agg = await readGain(file);
    expect(agg.byRule?.map((r) => [r.kind, r.rule, r.count])).toEqual([["built-in", "git", 1], ["none", "none", 1]]);
  });
});

describe("readGain attribution", () => {
  it("groups built-in rules by command, keeps user filters by name and skips restores and oversized outputs", async () => {
    seed(MIXED());
    const agg = await readGain(file);
    const byRule = Object.fromEntries((agg.byRule ?? []).map((r) => [`${r.kind}:${r.rule}`, r]));
    expect(byRule["built-in:git"]).toMatchObject({ count: 2, compressedCount: 2, rawTokens: 3000, savedTokens: 2000, avgPct: 67 });
    expect(byRule["user:mytool"]).toMatchObject({ count: 1, savedTokens: 400 });
    expect(byRule["built-in:cat"]).toMatchObject({ count: 1, savedTokens: 0 });
    expect(byRule["none:none"]).toMatchObject({ count: 1, rawTokens: 1500 });
    expect(byRule["unattributed:unattributed"]).toMatchObject({ count: 1 });
    expect(Object.keys(byRule)).not.toContain("built-in:tkr");
    expect(agg.fallbacks).toEqual([
      { cmd: "docker build", reason: "no-rule", count: 1, tokens: 1500 },
      { cmd: "pytest", reason: "failed-run", count: 1, tokens: 750 },
      { cmd: "cat", reason: "no-gain", count: 1, tokens: 300 }
    ]);
  });

  it("keeps attribution in the rotated ledger and counts older ledger days as not attributed", async () => {
    const day = (n: number): number => now - n * 86400;
    seed([
      { t: day(3), r: 4000, f: 1000, h: "claude-code", k: "sh", c: "git diff", s: "b" },
      { t: day(3), r: 2000, f: 2000, h: "claude-code", k: "sh", c: "make", o: "n" },
      { t: now - 5, r: 800, f: 200, h: "claude-code", k: "sh", c: "git log", s: "b" }
    ]);
    rotateStats(file, 1, 120);
    const ledger = JSON.parse(readFileSync(join(dir, "stats-ledger.json"), "utf8"));
    const days = Object.values(ledger.days) as { n: number; rl?: unknown }[];
    days[0]!.n += 2;
    writeFileSync(join(dir, "stats-ledger.json"), JSON.stringify(ledger));
    const agg = await readGain(file);
    const git = agg.byRule!.find((r) => r.rule === "git")!;
    expect(git.count).toBe(2);
    expect(agg.fallbacks).toEqual([{ cmd: "make", reason: "no-rule", count: 1, tokens: 500 }]);
    expect(agg.byRule!.find((r) => r.kind === "unattributed")!.count).toBe(2);
  });

  it("renders readable empty states", async () => {
    const agg = await readGain(file);
    expect(renderByRule(agg, { color: false })).toContain("No run with rule details in this scope yet.");
    expect(renderFallbacks(agg, {})).toContain("No command was left unchanged in this scope.");
  });
});

describe("quotaEstimate", () => {
  it("projects agent savings to 30 days and divides by the assumed plan budget", async () => {
    seed([{ t: now - 10, r: 20000, f: 2000, h: "claude-code", k: "sh", c: "git log", s: "b" }]);
    const agg = await readGain(file);
    const pro = quotaEstimate(agg, "pro");
    expect(pro).toMatchObject({ plan: "Claude Pro", savedTokens: 4500, days: 1, monthlySavedTokens: 135000, monthlyBudgetTokens: 6336000, pct: 2.1, basis: "estimate" });
    expect(pro.formula).toBe("savedTokens / days * 30 / (44000 tokens per 5-hour window * 144 windows * 1)");
    expect(quotaEstimate(agg, "5x")).toMatchObject({ monthlyBudgetTokens: 31680000, pct: 0.4 });
    expect(quotaEstimate(agg, "20x")).toMatchObject({ monthlyBudgetTokens: 126720000, pct: 0.1 });
  });

  it("leaves terminal commands with no agent out of the estimate", async () => {
    seed([
      { t: now - 10, r: 4000, f: 0, h: "claude-code", k: "sh", c: "ls", s: "b" },
      { t: now - 9, r: 400000, f: 0, h: "shell", k: "sh", c: "ls", s: "b" }
    ]);
    expect(quotaEstimate(await readGain(file), "pro").savedTokens).toBe(1000);
  });
});

describe("tkr gain report views", () => {
  it("--by-rule shows per-rule savings, the unmatched runs and older runs", () => {
    seed(MIXED());
    const r = run("gain", "--by-rule");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Tokmizer savings by rule · all time");
    expect(r.stdout).toMatch(/1\. built-in · git\s+2\s+2\.0K\s+67 %/);
    expect(r.stdout).toMatch(/2\. your filter · mytool\s+1\s+400\s+80 %/);
    expect(r.stdout).toContain("No rule matched: 1 run, 1.5K tokens left unchanged (tkr gain --failures).");
    expect(r.stdout).toContain("1 older run recorded before rule tracking are not attributed.");
    expect(r.stdout).toContain("Built-in rules are grouped by command.");
  });

  it("--failures lists commands left unchanged with the reason", () => {
    seed(MIXED());
    const r = run("gain", "--failures");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Commands left unchanged · all time");
    expect(r.stdout).toMatch(/1\. docker build\s+1\s+1\.5K\s+no rule/);
    expect(r.stdout).toMatch(/2\. pytest\s+1\s+750\s+failed run, in full/);
    expect(r.stdout).toMatch(/3\. cat\s+1\s+300\s+nothing to cut/);
    expect(r.stdout).toContain("no rule: neither a built-in nor a custom filter matches");
    expect(r.stdout).not.toContain("huge");
  });

  it("--quota defaults to Pro over the last 30 days, accepts a tier and labels the estimate", () => {
    seed([
      { t: now - 10, r: 20000, f: 2000, h: "claude-code", k: "sh", c: "git log", s: "b" },
      { t: now - 40 * 86400, r: 400000, f: 0, h: "claude-code", k: "sh", c: "git log", s: "b" }
    ]);
    const pro = run("gain", "--quota");
    expect(pro.status).toBe(0);
    expect(pro.stdout).toContain("Tokmizer quota estimate · last 30 days");
    expect(pro.stdout).toMatch(/Plan \(assumed\)\s+Claude Pro/);
    expect(pro.stdout).toMatch(/Tokens saved\s+4\.5K over 1 day$/m);
    expect(pro.stdout).toMatch(/Per month\s+135\.0K \(projected\)/);
    expect(pro.stdout).toMatch(/Plan budget\s+6\.3M per month \(assumed\)/);
    expect(pro.stdout).toMatch(/Quota kept\s+█░+ 2\.1 %/);
    expect(pro.stdout).toContain("Estimate, not a plan limit. Formula: tokens saved ÷ days × 30");
    expect(pro.stdout).toContain("÷ (44.0K tokens per 5-hour window × 144 windows × 1).");
    const max = run("gain", "--quota", "5x", "--week");
    expect(max.stdout).toContain("Tokmizer quota estimate · last 7 days");
    expect(max.stdout).toMatch(/Plan \(assumed\)\s+Claude Max 5x/);
    expect(max.stdout).toMatch(/Quota kept\s+░+ 0\.4 %/);
  });

  it("--json carries attribution, fallbacks and restore cache totals, plus the quota when asked", () => {
    seed(MIXED());
    const plain = JSON.parse(run("gain", "--json").stdout);
    expect(plain.byRule.length).toBeGreaterThan(0);
    expect(plain.fallbacks[0]).toEqual({ cmd: "docker build", reason: "no-rule", count: 1, tokens: 1500 });
    expect(plain.restoreCache).toMatchObject({ entries: 0, bytes: 0, retentionDays: 30 });
    expect(plain).not.toHaveProperty("quota");
    const withQuota = JSON.parse(run("gain", "--json", "--quota", "20x").stdout);
    expect(withQuota.quota).toMatchObject({ tier: "20x", plan: "Claude Max 20x", basis: "estimate" });
    expect(withQuota.since).toBeGreaterThan(0);
    const byRule = JSON.parse(run("gain", "--by-rule", "--json").stdout);
    expect(byRule.byRule).toEqual(plain.byRule);
  });

  it("the main panel shows restore counts and the cache size", () => {
    seed(MIXED());
    const cache = join(dir, "content-cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "0123456789abcdef"), "x".repeat(3000));
    const r = run("gain");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Restored\s+200 tokens, deducted · 1 restore$/m);
    expect(r.stdout).toMatch(/Restore cache\s+1 entry · 3 KB · kept 30 days$/m);
  });
});

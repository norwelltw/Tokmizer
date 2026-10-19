import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeProject, readAgentDaily, readGain, readHistory, recordStat, renderCsv, renderGraph, renderHistory, rotateStats } from "../stats";

let dir: string;
let file: string;
let now: number;
let projA: string;
let projB: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-gain-reports-"));
  file = join(dir, "stats.jsonl");
  now = Math.floor(Date.now() / 1000);
  mkdirSync(join(dir, "proj-a"));
  mkdirSync(join(dir, "proj-b"));
  projA = normalizeProject(join(dir, "proj-a"));
  projB = normalizeProject(join(dir, "proj-b"));
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
    cwd: projA,
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

function dayOf(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("project field in stats records", () => {
  it("recordStat writes the project path and parses it back", async () => {
    recordStat(4000, 1000, file, false, "claude-code", "sh", "git diff", projA);
    recordStat(4000, 1000, file, false, "claude-code", "sh", "rg");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]!).p).toBe(projA);
    expect(JSON.parse(lines[1]!)).not.toHaveProperty("p");
    expect((await readGain(file, 0, projA)).count).toBe(1);
    expect((await readGain(file, 0)).count).toBe(2);
  });

  it("skips a project path longer than the stored limit instead of bloating the journal", () => {
    recordStat(4000, 1000, file, false, "claude-code", "sh", "rg", "/" + "x".repeat(300));
    expect(JSON.parse(readFileSync(file, "utf8").trim())).not.toHaveProperty("p");
  });

  it("matches subdirectories of the project but not sibling prefixes", async () => {
    seed([
      { t: now - 30, r: 4000, f: 1000, h: "claude-code", k: "sh", c: "rg", p: join(projA, "src") },
      { t: now - 20, r: 4000, f: 1000, h: "claude-code", k: "sh", c: "rg", p: `${projA}-other` },
      { t: now - 10, r: 4000, f: 1000, h: "claude-code", k: "sh", c: "rg", p: projB }
    ]);
    expect((await readGain(file, 0, projA)).count).toBe(1);
    expect((await readGain(file, 0, projB)).count).toBe(1);
  });

  it("excludes old records without a project from project views", async () => {
    seed([
      { t: now - 30, r: 4000, f: 1000, h: "claude-code", k: "sh", c: "legacy" },
      { t: now - 10, r: 4000, f: 1000, h: "claude-code", k: "sh", c: "fresh", p: projA }
    ]);
    const agg = await readGain(file, 0, projA);
    expect(agg.count).toBe(1);
    expect(agg.byCommand?.map((r) => r.cmd)).toEqual(["fresh"]);
    expect((await readGain(file, 0)).count).toBe(2);
  });

  it("reads project views from the live journal only, not the rotated ledger", async () => {
    const line = JSON.stringify({ t: now - 40 * 86400, r: 4000, f: 400, k: "sh", c: "rg", h: "claude-code", p: projA });
    writeFileSync(file, `${line}\n`.repeat(30000));
    rotateStats(file);
    expect(existsSync(join(dir, "stats-ledger.json"))).toBe(true);
    recordStat(1000, 100, file, false, "claude-code", "sh", "git diff", projA);
    expect((await readGain(file, 0)).count).toBe(30001);
    const project = await readGain(file, 0, projA);
    expect(project.count).toBeLessThan(30001);
    expect(project.byCommand?.find((r) => r.cmd === "git diff")).toMatchObject({ count: 1 });
  });

  it("normalizeProject resolves symlinks, makes the path absolute and drops a trailing slash", () => {
    expect(normalizeProject(`${projA}/`)).toBe(projA);
    expect(normalizeProject(projA)).toBe(projA);
    expect(normalizeProject("/")).toBe("/");
    expect(normalizeProject(join(dir, "missing/"))).toBe(join(normalizeProject(dir), "missing"));
    const link = join(dir, "link-a");
    symlinkSync(projA, link);
    expect(normalizeProject(link)).toBe(projA);
    recordStat(4000, 1000, file, false, "claude-code", "sh", "rg", link);
    expect(JSON.parse(readFileSync(file, "utf8").trim()).p).toBe(projA);
  });
});

describe("readAgentDaily and renderCsv", () => {
  it("uses the agent scope the panel shows and leaves terminal-only runs out", async () => {
    seed([
      { t: now - 86400, r: 4000, f: 1000, h: "claude-code", k: "sh", c: "rg" },
      { t: now - 86400, r: 4000, f: 4000, h: "shell", k: "sh", c: "ls" },
      { t: now, r: 2000, f: 1000, h: "claude-code", k: "sh", c: "cat" },
      { t: now, r: 8000, f: 4000, h: "claude-code", m: 1 }
    ]);
    const rows = await readAgentDaily(file);
    expect(rows).toEqual([
      { day: dayOf(now - 86400), count: 1, rawTokens: 1000, filteredTokens: 250, savedTokens: 750, pct: 75 },
      { day: dayOf(now), count: 1, rawTokens: 500, filteredTokens: 250, savedTokens: 250, pct: 50 }
    ]);
    const agg = await readGain(file);
    expect(rows.reduce((a, r) => a + r.count, 0)).toBe(agg.agent?.count);
    expect(rows.reduce((a, r) => a + r.savedTokens, 0)).toBe(agg.agent!.rawTokens - agg.agent!.filteredTokens);
    expect(renderCsv(rows)).toBe(
      "date,commands,tokens_in,tokens_out,tokens_saved,percent\n" +
      `${dayOf(now - 86400)},1,1000,250,750,75\n` +
      `${dayOf(now)},1,500,250,250,50\n`
    );
  });

  it("writes a header only when the scope has no agent commands", async () => {
    expect(renderCsv(await readAgentDaily(file))).toBe("date,commands,tokens_in,tokens_out,tokens_saved,percent\n");
  });

  it("reports a day that added tokens with a negative saving", async () => {
    seed([{ t: now, r: 1000, f: 3000, h: "claude-code", k: "sh", c: "tkr restore" }]);
    expect(renderCsv(await readAgentDaily(file))).toContain(`${dayOf(now)},1,250,750,-500,-200`);
  });
});

describe("renderGraph", () => {
  it("fills every calendar day of the period and scales bars to the best day", () => {
    const out = renderGraph(
      [
        { day: dayOf(now - 2 * 86400), count: 2, rawTokens: 2000, filteredTokens: 1000, savedTokens: 1000, pct: 50 },
        { day: dayOf(now), count: 1, rawTokens: 1000, filteredTokens: 500, savedTokens: 500, pct: 50 }
      ],
      { color: false, sinceTs: now - 2 * 86400, nowTs: now, subtitle: "last 3 days" }
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("  Tokens saved per day · last 3 days");
    const bars = lines.filter((l) => /^  \d\d\/\d\d  /.test(l));
    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatch(/█{30} {8}1\.0K$/);
    expect(bars[1]).toMatch(/░{30} {11}0$/);
    expect(bars[2]).toMatch(/█{15}░{15} {9}500$/);
    expect(out).toMatch(/Total\s+.*1\.5K saved/);
    expect(out).toContain("Estimates from output size (bytes ÷ 4), not provider-counted tokens.");
  });

  it("shows added tokens without a bar and no bar at all when nothing was saved", () => {
    const out = renderGraph(
      [{ day: dayOf(now), count: 1, rawTokens: 250, filteredTokens: 750, savedTokens: -500, pct: -200 }],
      { color: false, sinceTs: now, nowTs: now, subtitle: "today" }
    );
    expect(out).toMatch(/░{30} {3}500 added\n/);
    expect(out).not.toContain("█");
    expect(out).toMatch(/Total\s+500 added/);
  });
});

describe("readHistory and renderHistory", () => {
  it("keeps the last 20 agent commands in order and drops terminal-only and modeled rows", async () => {
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 25; i += 1) records.push({ t: now - 1000 + i, r: 4000, f: 2000, h: "claude-code", k: "sh", c: `cmd-${i}` });
    records.push({ t: now - 5, r: 4000, f: 4000, h: "shell", k: "sh", c: "terminal-only" });
    records.push({ t: now - 4, r: 8000, f: 4000, h: "claude-code", m: 1 });
    records.push({ t: now - 3, r: 0, f: 4000, h: "claude-code", k: "restore", c: "tkr restore" });
    seed(records);
    const rows = await readHistory(file);
    expect(rows).toHaveLength(20);
    expect(rows[0]!.cmd).toBe("cmd-6");
    expect(rows[18]!.cmd).toBe("cmd-24");
    expect(rows[19]).toEqual({ at: now - 3, cmd: "tkr restore", rawTokens: 0, filteredTokens: 1000, savedTokens: -1000 });
    expect(rows.some((r) => r.cmd === "terminal-only")).toBe(false);
  });

  it("honors the period and project filters", async () => {
    seed([
      { t: now - 10 * 86400, r: 4000, f: 2000, h: "claude-code", k: "sh", c: "old", p: projA },
      { t: now - 10, r: 4000, f: 2000, h: "claude-code", k: "sh", c: "other-project", p: projB },
      { t: now - 5, r: 4000, f: 2000, h: "claude-code", k: "sh", c: "fresh", p: projA }
    ]);
    expect((await readHistory(file, now - 86400)).map((r) => r.cmd)).toEqual(["other-project", "fresh"]);
    expect((await readHistory(file, 0, projA)).map((r) => r.cmd)).toEqual(["old", "fresh"]);
    expect((await readHistory(file, now - 86400, projA)).map((r) => r.cmd)).toEqual(["fresh"]);
  });

  it("renders time, label and token columns with a total", () => {
    const out = renderHistory(
      [
        { at: now, cmd: "git diff", rawTokens: 1000, filteredTokens: 250, savedTokens: 750 },
        { at: now, cmd: "a-very-long-command-label-here", rawTokens: 100, filteredTokens: 300, savedTokens: -200 }
      ],
      { color: false, subtitle: "all time" }
    );
    expect(out).toContain("Last 2 commands · all time");
    expect(out).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}  git diff {18}1\.0K {5}250 {7}750/);
    expect(out).toMatch(/a-very-long-command-l {6}100 {5}300 {6}-200/);
    expect(out).toMatch(/Total\s+550 saved/);
    expect(renderHistory([], { color: false, subtitle: "today" })).toBe("  No commands recorded in this scope.\n");
  });
});

describe("gain CLI report flags", () => {
  function seedMixed(): void {
    seed([
      { t: now - 40 * 86400, r: 4000, f: 2000, h: "claude-code", k: "sh", c: "ancient", p: projA },
      { t: now - 3 * 86400, r: 4000, f: 2000, h: "claude-code", k: "sh", c: "week-a", p: projA },
      { t: now - 2 * 86400, r: 4000, f: 1000, h: "claude-code", k: "sh", c: "week-b", p: projB },
      { t: now - 60, r: 4000, f: 4000, h: "shell", k: "sh", c: "terminal-only" },
      { t: now - 30, r: 4000, f: 2000, h: "claude-code", k: "sh", c: "legacy-no-project" },
      { t: now - 10, r: 4000, f: 2000, h: "claude-code", k: "sh", c: "today-a", p: join(projA, "src") }
    ]);
  }

  it("--csv writes one row per day for the selected period with panel numbers", () => {
    seedMixed();
    const all = run("gain", "--csv");
    expect(all.status).toBe(0);
    expect(all.stderr).toBe("");
    const lines = all.stdout.trim().split("\n");
    expect(lines[0]).toBe("date,commands,tokens_in,tokens_out,tokens_saved,percent");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe(`${dayOf(now)},2,2000,1000,1000,50`);
    const week = run("gain", "--week", "--csv");
    expect(week.status).toBe(0);
    expect(week.stdout.trim().split("\n")).toHaveLength(4);
    const day = run("gain", "--csv", "--day");
    expect(day.stdout.trim().split("\n")).toEqual(["date,commands,tokens_in,tokens_out,tokens_saved,percent", `${dayOf(now)},2,2000,1000,1000,50`]);
    const panel = run("gain", "--day");
    expect(panel.stdout).toMatch(/Commands\s+2 · 2 reduced/);
    expect(panel.stdout).toMatch(/Tokens saved\s+1\.0K \(50 % of all commands\)/);
  });

  it("--project filters to the current directory by default and to a given path", () => {
    seedMixed();
    const current = run("gain", "--project", "--json");
    expect(current.status).toBe(0);
    const json = JSON.parse(current.stdout);
    expect(json).toMatchObject({ count: 3, project: projA, projectScope: "live-journal" });
    expect(json.byCommand.map((r: { cmd: string }) => r.cmd).sort()).toEqual(["ancient", "today-a", "week-a"]);
    const other = run("gain", "--json", "--project", projB);
    expect(JSON.parse(other.stdout)).toMatchObject({ count: 1, project: projB });
    expect(JSON.parse(other.stdout).byCommand.map((r: { cmd: string }) => r.cmd)).toEqual(["week-b"]);
    const panel = run("gain", "--project", projB, "--week");
    expect(panel.status).toBe(0);
    expect(panel.stdout).toContain("last 7 days · proj-b");
    expect(panel.stdout).toContain(`Project ${projB}: live journal only, rotated history not included.`);
    expect(panel.stdout).toContain("week-b");
    expect(panel.stdout).not.toContain("week-a");
    expect(panel.stdout).not.toContain("legacy-no-project");
  });

  it("--project with no matching records says so without crashing", () => {
    seedMixed();
    const empty = run("gain", "--project", join(dir, "nowhere"));
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain("No data yet");
    expect(empty.stdout).toContain("live journal only");
  });

  it("--json keeps its shape and adds since only when a period is given", () => {
    seedMixed();
    const plain = JSON.parse(run("gain", "--json").stdout);
    expect(plain).not.toHaveProperty("since");
    expect(plain).not.toHaveProperty("project");
    expect(plain.count).toBe(6);
    const week = JSON.parse(run("gain", "--json", "--week").stdout);
    expect(typeof week.since).toBe("number");
    expect(week.count).toBe(5);
  });

  it("--graph defaults to the last 30 days and follows an explicit period", () => {
    seedMixed();
    const month = run("gain", "--graph");
    expect(month.status).toBe(0);
    expect(month.stdout).toContain("Tokens saved per day · last 30 days");
    expect(month.stdout.split("\n").filter((l) => /^  \d\d\/\d\d  /.test(l))).toHaveLength(30);
    expect(month.stdout).toMatch(/Total\s+.*2\.3K saved/);
    const week = run("gain", "--week", "--graph", "--project", projA);
    expect(week.stdout).toContain("last 7 days · proj-a");
    expect(week.stdout.split("\n").filter((l) => /^  \d\d\/\d\d  /.test(l))).toHaveLength(7);
    expect(week.stdout).toMatch(/Total\s+.*1\.0K saved/);
    expect(week.stdout).toContain("live journal only");
    const day = run("gain", "--graph", "--day");
    expect(day.stdout.split("\n").filter((l) => /^  \d\d\/\d\d  /.test(l))).toHaveLength(1);
  });

  it("--history lists recent agent commands and combines with period and project", () => {
    seedMixed();
    const all = run("gain", "--history");
    expect(all.status).toBe(0);
    expect(all.stdout).toContain("Last 5 commands · all time");
    expect(all.stdout).toContain("ancient");
    expect(all.stdout).toContain("today-a");
    expect(all.stdout).not.toContain("terminal-only");
    const scoped = run("gain", "--history", "--day", "--project");
    expect(scoped.stdout).toContain("Last 1 commands · today · proj-a");
    expect(scoped.stdout).toMatch(/today-a\s+1\.0K\s+500\s+500/);
    expect(scoped.stdout).not.toContain("legacy-no-project");
  });

  it("rejects two output modes, repeated flags and unknown arguments", () => {
    for (const args of [["--csv", "--json"], ["--graph", "--json"], ["--by-rule", "--failures"], ["--quota", "10x"], ["--quota", "--csv"], ["--day", "--week"], ["--graph", "--history"], ["--bogus"], ["--project", "--project"]]) {
      const result = run("gain", ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("Usage: tkr gain [--day|--week|--month] [--project [path]] [--json] [--csv|--graph|--history|--by-rule|--failures|--quota [pro|5x|20x]]\n");
    }
  });
});

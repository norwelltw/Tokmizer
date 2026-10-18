import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { processOutput, type LoadedFilter } from "../engine";
import { __resetUserFilters, loadUserFilters, runUserFilterTests, trustUserFilters, untrustUserFilters, userFiltersTrustFile } from "../engine/user-filters";
import { recordEvent } from "../learn/recorder";
import { commitSpool, drainSpool } from "../learn/spool";
import { loadSettingsCache, saveSettingsCache } from "../settings-cache";

let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-user-filters-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
  __resetUserFilters();
});

afterEach(() => {
  __resetUserFilters();
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
});

function writeFilter(name: string, body: string): void {
  mkdirSync(join(dir, "filters"), { recursive: true });
  writeFileSync(join(dir, "filters", name), body);
}

const bundle: LoadedFilter = {
  slug: "mytool",
  match_command: "^mytool(\\s|$)",
  matchRegex: /^mytool(\s|$)/,
  priority: 50,
  strip_ansi: false,
  strip_lines_matching: ["^bundle-noise"],
  keep_failures: false,
  fold_passing: false,
  mask_abs_paths: false,
  preserve_exact: false,
  scale_with_level: true
};

const bundleResolver = async (cmd: string): Promise<LoadedFilter | null> => (bundle.matchRegex.test(cmd) ? bundle : null);

const INVALID_FILES = [
  ["broken.toml", "this is = not [ toml"],
  [
    "bad-rules.toml",
    [
      "[filters.bad-regex]",
      'match_command = "("',
      "",
      "[filters.bad-cap]",
      'match_command = "^x"',
      "max_lines = -3",
      "",
      "[filters.good]",
      'match_command = "^goodtool(\\\\s|$)"',
      "max_lines = 2",
      ""
    ].join("\n")
  ]
] as const;

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", resolve("packages/plugin/src/bin/tkr.ts"), ...args], {
    encoding: "utf8",
    input: "",
    timeout: 10000,
    env: {
      ...process.env,
      CI: "1",
      TOKMIZER_HOME: dir,
      TOKMIZER_BASE_URL: "http://127.0.0.1:1",
      TOKMIZER_AUTO_UPDATE: "0",
      TOKMIZER_DAEMON_BIN: join(dir, "disabled-daemon.js"),
      TOKMIZER_CLAUDE_COMMANDS_DIR: join(dir, "commands"),
      XDG_RUNTIME_DIR: ""
    }
  });
}

describe("user filters", () => {
  it("loads nothing when the directory does not exist", async () => {
    const user = await loadUserFilters();
    expect(user.dir).toBe(join(dir, "filters"));
    expect(user.filters.size).toBe(0);
    expect(user.issues).toEqual([]);
  });

  it("applies a valid user filter and lets it win over the bundle filter", async () => {
    writeFilter("mine.toml", [
      "[filters.mytool]",
      'match_command = "^mytool(\\\\s|$)"',
      'strip_lines_matching = ["^user-noise"]',
      ""
    ].join("\n"));
    await trustUserFilters();
    const result = await processOutput("mytool run", "keep\nuser-noise 1\nbundle-noise 2\n", null, { resolver: bundleResolver });
    expect(result.filterId).toBe("user/mytool");
    expect(result.output).toBe("keep\nbundle-noise 2\n");
  });

  it("falls back to the bundle filter when no user filter matches", async () => {
    writeFilter("mine.toml", '[filters.other]\nmatch_command = "^othertool(\\\\s|$)"\nmax_lines = 2\n');
    await trustUserFilters();
    const result = await processOutput("mytool run", "keep\nuser-noise 1\nbundle-noise 2\n", null, { resolver: bundleResolver });
    expect(result.filterId).toBe("mytool");
    expect(result.output).toBe("keep\nuser-noise 1\n");
  });

  it("skips invalid files and rules, keeps the valid ones and reports each problem", async () => {
    for (const [name, body] of INVALID_FILES) writeFilter(name, body);
    await trustUserFilters();
    const user = await loadUserFilters();
    expect([...user.filters.keys()]).toEqual(["user/good"]);
    expect(user.issues.map((i) => i.file)).toEqual(["bad-rules.toml", "bad-rules.toml", "broken.toml"]);
    expect(user.issues[0]!.message).toContain("bad-regex");
    expect(user.issues[1]!.message).toContain("bad-cap");
    expect(user.issues[2]!.message).toContain("not valid TOML");
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const result = await processOutput("goodtool go", long, null, { resolver: bundleResolver });
    expect(result.filterId).toBe("user/good");
    expect(result.output).toContain("omitted");
    expect(result.output).not.toContain("line 15");
    const untouched = await processOutput("x marks", "a\nb\n", null, { resolver: bundleResolver });
    expect(untouched.filterId).toBeNull();
  });

  it("tkr doctor lists loaded user filters and the skipped ones", async () => {
    for (const [name, body] of INVALID_FILES) writeFilter(name, body);
    await trustUserFilters();
    const res = run("doctor");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`Filters:  1 user filter loaded from ${join(dir, "filters")}`);
    expect(res.stdout).toContain("skipped broken.toml: not valid TOML");
    expect(res.stdout).toContain("skipped bad-rules.toml: bad-regex");
    expect(res.stdout).toContain("skipped bad-rules.toml: bad-cap");
  });

  it("tkr doctor points to the folder when there are no user filters", () => {
    const res = run("doctor");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`Filters:  no user filters (optional: *.toml files in ${join(dir, "filters")})`);
  });

  it("never queues a learn event for a command handled by a user filter", async () => {
    await saveSettingsCache({ ...(await loadSettingsCache()), telemetryOptIn: true });
    commitSpool("learn");
    await recordEvent({ cmd: "mytool run", filterId: "user/mytool", rawBytes: 100, filteredBytes: 10, plan: "pro" });
    expect(drainSpool("learn")).toEqual([]);
    await recordEvent({ cmd: "mytool run", filterId: "mytool", rawBytes: 100, filteredBytes: 10, plan: "pro" });
    expect(drainSpool("learn")).toHaveLength(1);
    commitSpool("learn");
  });
});

const MYTOOL = [
  "schema_version = 1",
  "",
  "[filters.mytool]",
  'match_command = "^mytool(\\\\s|$)"',
  'strip_lines_matching = ["^user-noise"]',
  "",
  "[[filters.mytool.tests]]",
  'name = "drops noise"',
  'input = "keep\\nuser-noise 1\\n"',
  'expected = "keep"',
  "",
  "[[filters.mytool.tests]]",
  'input = "user-noise\\nother\\n"',
  'expected = "wrong"',
  ""
].join("\n");

describe("user filter trust gate", () => {
  it("ignores an untrusted file and says how to trust it", async () => {
    writeFilter("mine.toml", MYTOOL);
    const user = await loadUserFilters();
    expect(user.filters.size).toBe(0);
    expect(user.issues).toEqual([{ file: "mine.toml", message: "not trusted yet. Review it, then run: tkr filters trust mine.toml" }]);
    const result = await processOutput("mytool run", "keep\nuser-noise 1\nbundle-noise 2\n", null, { resolver: bundleResolver });
    expect(result.filterId).toBe("mytool");
  });

  it("records a SHA-256 per file and loads the file once trusted", async () => {
    writeFilter("mine.toml", MYTOOL);
    expect(await trustUserFilters()).toEqual({ trusted: ["mine.toml"], missing: [] });
    const store = JSON.parse(readFileSync(userFiltersTrustFile(), "utf8"));
    expect(store.files["mine.toml"]).toBe(createHash("sha256").update(MYTOOL).digest("hex"));
    const user = await loadUserFilters();
    expect([...user.filters.keys()]).toEqual(["user/mytool"]);
    expect(user.issues).toEqual([]);
  });

  it("stops using a file edited after it was trusted, without a restart", async () => {
    writeFilter("mine.toml", MYTOOL);
    await trustUserFilters();
    expect((await loadUserFilters()).filters.size).toBe(1);
    writeFilter("mine.toml", MYTOOL.replace("^user-noise", "^keep"));
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, "filters", "mine.toml"), later, later);
    await new Promise((r) => setTimeout(r, 1100));
    const user = await loadUserFilters();
    expect(user.filters.size).toBe(0);
    expect(user.issues[0]!.message).toBe("changed since it was trusted. Review it, then run: tkr filters trust mine.toml");
  });

  it("untrust removes the recorded hash", async () => {
    writeFilter("mine.toml", MYTOOL);
    await trustUserFilters(["mine.toml"]);
    expect(await untrustUserFilters(["mine.toml"])).toEqual(["mine.toml"]);
    expect(await untrustUserFilters()).toEqual([]);
    expect((await loadUserFilters()).filters.size).toBe(0);
  });

  it("reports a file that does not exist", async () => {
    expect(await trustUserFilters(["nope.toml"])).toEqual({ trusted: [], missing: ["nope.toml"] });
  });
});

describe("user filter schema_version", () => {
  it("rejects an unsupported or malformed version with a clear message and accepts 1 or none", async () => {
    writeFilter("future.toml", 'schema_version = 2\n[filters.a]\nmatch_command = "^a"\n');
    writeFilter("text.toml", 'schema_version = "1"\n[filters.b]\nmatch_command = "^b"\n');
    writeFilter("none.toml", '[filters.c]\nmatch_command = "^c"\n');
    writeFilter("one.toml", 'schema_version = 1\n[filters.d]\nmatch_command = "^d"\n');
    await trustUserFilters();
    const user = await loadUserFilters();
    expect([...user.filters.keys()].sort()).toEqual(["user/c", "user/d"]);
    expect(user.issues).toEqual([
      { file: "future.toml", message: "schema_version 2 is not supported: this tkr reads schema_version = 1. Update tkr, or write the file for version 1" },
      { file: "text.toml", message: "schema_version must be the number 1" }
    ]);
  });
});

describe("user filter inline tests", () => {
  it("runs each [[filters.<name>.tests]] case against the rule, even before the file is trusted", async () => {
    writeFilter("mine.toml", MYTOOL);
    const { results, issues, untested } = await runUserFilterTests();
    expect(issues).toEqual([]);
    expect(untested).toEqual([]);
    expect(results.map((r) => [r.rule, r.index, r.name ?? null, r.pass])).toEqual([["mytool", 1, "drops noise", true], ["mytool", 2, null, false]]);
    expect(results[1]!.actual).toBe("other\n");
  });

  it("rejects a rule whose tests are malformed", async () => {
    writeFilter("bad.toml", '[filters.x]\nmatch_command = "^x"\n[[filters.x.tests]]\ninput = 3\n');
    await trustUserFilters();
    const user = await loadUserFilters();
    expect(user.filters.size).toBe(0);
    expect(user.issues[0]!.message).toBe("x: tests: each [[filters.x.tests]] needs input and expected strings");
  });

  it("tkr filters test prints PASS/FAIL with the difference and exits 1 on a failure", () => {
    writeFilter("mine.toml", MYTOOL);
    writeFilter("plain.toml", '[filters.plain]\nmatch_command = "^plain"\n');
    const res = run("filters", "test");
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("  PASS mytool #1 (drops noise)");
    expect(res.stdout).toContain("  FAIL mytool #2\n    expected:\n      wrong\n    got:\n      other");
    expect(res.stdout).toContain("  2 tests: 1 passed, 1 failed");
    expect(res.stdout).toContain("  Without tests: plain");
  });

  it("tkr filters test <rule> exits 0 when that rule passes, 1 for an unknown rule", () => {
    writeFilter("ok.toml", '[filters.ok]\nmatch_command = "^ok"\nmax_lines = 1\n[[filters.ok.tests]]\ninput = "a\\n"\nexpected = "a\\n"\n');
    const ok = run("filters", "test", "ok");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("  1 test: 1 passed, 0 failed");
    const missing = run("filters", "test", "ghost");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("No rule named ghost");
  });

  it("tkr filters trust, doctor and untrust work end to end", () => {
    writeFilter("mine.toml", MYTOOL);
    const before = run("doctor");
    expect(before.stdout).toContain("skipped mine.toml: not trusted yet. Review it, then run: tkr filters trust mine.toml");
    const trust = run("filters", "trust");
    expect(trust.status).toBe(0);
    expect(trust.stdout).toContain(`Trusted 1 filter file in ${join(dir, "filters")}: mine.toml`);
    expect(run("doctor").stdout).toContain(`Filters:  1 user filter loaded from ${join(dir, "filters")}`);
    const untrust = run("filters", "untrust", "mine.toml");
    expect(untrust.stdout).toBe("No longer used: mine.toml\n");
    expect(run("filters", "trust", "ghost.toml").status).toBe(1);
    const usage = run("filters");
    expect(usage.status).toBe(1);
    expect(usage.stderr).toContain("Usage: tkr filters trust");
  });
});

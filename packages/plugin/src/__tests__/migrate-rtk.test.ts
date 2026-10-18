import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scanSqliteTable, SqliteReadError } from "../migrate/sqlite-read";
import { readRtkHistory, loadRtkImport, renderRtkImportLine } from "../migrate/rtk-history";
import { convertRtkFilters, rtkFilterSources, anchoredForRtk } from "../migrate/rtk-filters";
import { readRtkConfig, excludeRegex } from "../migrate/rtk-config";
import { isRtkHookCommand, scanRtkHooks, doubleHooked } from "../migrate/rtk-hooks";
import { buildPlan, applyPlan, undoMigration, renderPlan, planHasWork, pendingWork } from "../migrate/migrate-rtk";
import { rtkCompatAction, rtkShimContent } from "../migrate/rtk-compat";
import { findRtkBinary, type RtkEnv } from "../migrate/rtk-paths";
import { __resetUserFilters, loadUserFilters } from "../engine/user-filters";
import { processOutput } from "../engine";
import { contentCacheLimits, captureForRestore } from "../content-cache";
import { saveSettingsCache, loadSettingsCache } from "../settings-cache";

const FIX = resolve("packages/plugin/src/__tests__/fixtures/rtk");
const ENV_KEYS = ["HOME", "TOKMIZER_HOME", "TOKMIZER_NETWORK", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME", "GEMINI_CLI_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PI_CODING_AGENT_DIR", "HERMES_HOME", "QWEN_HOME"];

let root: string;
let home: string;
let project: string;
let saved: Record<string, string | undefined>;
let e: RtkEnv;

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const writeJson = (path: string, data: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
};
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const rtkConfigDir = () => join(home, ".config", "rtk");
const rtkDataDir = () => join(home, ".local", "share", "rtk");

function installRtkFiles(opts: { trustGlobal?: boolean } = {}): void {
  mkdirSync(rtkConfigDir(), { recursive: true });
  mkdirSync(rtkDataDir(), { recursive: true });
  copyFileSync(join(FIX, "filters.toml"), join(rtkConfigDir(), "filters.toml"));
  copyFileSync(join(FIX, "config.toml"), join(rtkConfigDir(), "config.toml"));
  copyFileSync(join(FIX, "history.db"), join(rtkDataDir(), "history.db"));
  if (opts.trustGlobal) {
    const path = realpathSync(join(rtkConfigDir(), "filters.toml"));
    writeJson(join(rtkDataDir(), "trusted_filters.json"), { version: 1, trusted: { [path]: { sha256: sha(path), trusted_at: "2026-10-01T00:00:00Z" } } });
  }
}

const claudeSettings = () => ({
  enabledPlugins: { "tokmizer@tokmizer": true },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard.sh" }, { type: "command", command: "\"/opt/homebrew/bin/rtk\" hook claude" }] }
    ],
    Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }]
  },
  permissions: { deny: ["Bash(rm -rf:*)"] }
});

function installAgents(): void {
  writeJson(join(home, ".claude", "settings.json"), claudeSettings());
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Mine\nkeep me\n@RTK.md\n");
  writeJson(join(home, ".codex", "hooks.json"), {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "rtk hook codex" }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "/x/tkr-codex-hook", timeout: 10 }] }
      ]
    }
  });
  writeJson(join(home, ".cursor", "hooks.json"), { version: 1, hooks: { preToolUse: [{ command: "rtk hook cursor", matcher: "Shell" }] } });
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-migrate-rtk-")));
  home = join(root, "home");
  project = join(root, "work", "My App");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = home;
  process.env.TOKMIZER_HOME = join(home, ".tokmizer");
  process.env.TOKMIZER_NETWORK = "0";
  e = { home, env: { HOME: home, PATH: "" }, platform: "linux", cwd: project };
  __resetUserFilters();
});

afterEach(() => {
  __resetUserFilters();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("read-only SQLite reader", () => {
  it("reads every row of rtk's history.db, across interior pages, overflow pages and pre-ALTER rows", () => {
    let rows = 0;
    let saved = 0;
    let longest = 0;
    let idSum = 0;
    let withProject = 0;
    scanSqliteTable(readFileSync(join(FIX, "history.db")), "commands", (row) => {
      rows += 1;
      saved += row.saved_tokens as number;
      longest = Math.max(longest, (row.original_cmd as string).length);
      idSum += row.id as number;
      if (row.project_path === "/work/app") withProject += 1;
    });
    expect({ rows, saved, longest, idSum, withProject }).toEqual({ rows: 300, saved: 378000, longest: 3011, idSum: 45150, withProject: 180 });
  });

  it("rejects files that are not SQLite and leaves them untouched", () => {
    const bad = join(root, "bad.db");
    writeFileSync(bad, "not a database at all, just text that is long enough to have a header".repeat(3));
    const before = sha(bad);
    expect(() => scanSqliteTable(readFileSync(bad), "commands", () => {})).toThrow(SqliteReadError);
    expect(readRtkHistory(bad)).toEqual({ error: expect.stringContaining("not a SQLite database") });
    expect(sha(bad)).toBe(before);
  });

  it("reports a truncated database instead of failing", () => {
    const cut = join(root, "cut.db");
    writeFileSync(cut, readFileSync(join(FIX, "history.db")).subarray(0, 2048));
    expect(readRtkHistory(cut)).toEqual({ error: expect.stringContaining("could not read it") });
    expect(readRtkHistory(join(root, "missing.db"))).toEqual({ error: "no history file" });
  });

  it("sums rtk's totals", () => {
    const r = readRtkHistory(join(FIX, "history.db"), new Date("2026-10-16T00:00:00Z"));
    expect(r).toMatchObject({ totals: { commands: 300, inputTokens: 487260, outputTokens: 109260, savedTokens: 378000, firstAt: "2026-09-01T10:00:00+00:00", lastAt: "2026-10-14T08:30:00+00:00" } });
    if ("totals" in r) expect(renderRtkImportLine(r.totals)).toBe("  Imported from rtk: 378.0K tokens saved over 300 commands, 2026-09-01 to 2026-10-14 (rtk's own estimate, not included above)\n");
  });
});

describe("rtk filters", () => {
  it("imports supported filters, runs their tests on Tokmizer and reports every skipped filter", async () => {
    installRtkFiles();
    const source = rtkFilterSources(e).find((s) => s.scope === "global")!;
    const r = (await convertRtkFilters(e, source))!;
    expect(r.imported).toEqual(["make-quiet", "short-log"]);
    expect(r.skipped).toEqual([
      { name: "keep-errors", reason: "uses keep_lines_matching, which Tokmizer filters do not support" },
      { name: "loose", reason: "match_command is not anchored with ^, so rtk ignored this filter" },
      { name: "weird", reason: "unknown key colour (rtk rejects them too)" }
    ]);
    expect(r.tests.map((t) => [t.rule, t.index, t.pass])).toEqual([
      ["make-quiet", 1, true],
      ["make-quiet", 2, true],
      ["short-log", 1, false]
    ]);
    expect(r.orphanTests).toEqual(["ghost"]);
    expect(r.trustedByRtk).toBe(false);
    expect(r.text).toContain("scale_with_level = false");
    expect(r.text).not.toMatch(/keep_lines_matching|colour|loose/);
  });

  it("recognises filters rtk trusted, by path and SHA-256", async () => {
    installRtkFiles({ trustGlobal: true });
    const source = rtkFilterSources(e).find((s) => s.scope === "global")!;
    expect((await convertRtkFilters(e, source))!.trustedByRtk).toBe(true);
    writeFileSync(join(rtkConfigDir(), "filters.toml"), readFileSync(join(rtkConfigDir(), "filters.toml"), "utf8") + "\n");
    expect((await convertRtkFilters(e, source))!.trustedByRtk).toBe(false);
  });

  it("skips files rtk itself would not load", async () => {
    mkdirSync(join(project, ".rtk"), { recursive: true });
    writeFileSync(join(project, ".rtk", "filters.toml"), "schema_version = 2\n[filters.a]\nmatch_command = \"^a\"\n");
    const source = rtkFilterSources(e).find((s) => s.scope === "project")!;
    expect(source.target).toBe("rtk-project-my-app.toml");
    const r = (await convertRtkFilters(e, source))!;
    expect(r.text).toBeNull();
    expect(r.fileIssue).toContain("schema_version 2");
  });

  it("checks anchoring like rtk does", () => {
    expect(anchoredForRtk("^git\\b")).toBe(true);
    expect(anchoredForRtk("^a|^b")).toBe(true);
    expect(anchoredForRtk("(?i)^a")).toBe(true);
    expect(anchoredForRtk("^a|b")).toBe(false);
    expect(anchoredForRtk("^(a|b)")).toBe(true);
    expect(anchoredForRtk("[|]^a")).toBe(false);
  });
});

describe("rtk config.toml", () => {
  it("maps settings that have a Tokmizer equivalent and lists the others", async () => {
    installRtkFiles();
    const c = await readRtkConfig(e);
    expect(c.excludePatterns).toEqual(["curl", "^playwright test", "  "]);
    expect(c.excludeSkipped).toEqual([{ name: "  ", reason: "empty pattern, rtk ignores it too" }]);
    expect(c.excludeText).toContain('match_command = "^curl($|\\\\s)"');
    expect(c.excludeText).toContain('match_command = "^playwright test"');
    expect(c.retentionDays).toBe(14);
    expect(c.restoreDisabled).toBe(false);
    expect(c.telemetryOff).toBe(true);
    expect(c.notImported).toEqual(["hooks.transparent_prefixes", "retriever.max_entries", "limits.grep_max_results"]);
  });

  it("anchors plain exclude patterns like rtk", () => {
    expect(excludeRegex("curl")).toBe("^curl($|\\s)");
    expect(excludeRegex("npm run")).toBe("^npm run($|\\s)");
    expect(excludeRegex("^x")).toBe("^x");
    expect(excludeRegex("^")).toBeNull();
  });

  it("reports an unreadable config.toml", async () => {
    mkdirSync(rtkConfigDir(), { recursive: true });
    writeFileSync(join(rtkConfigDir(), "config.toml"), "[hooks\nbroken");
    expect((await readRtkConfig(e)).parseError).toBeTruthy();
  });
});

describe("rtk agent hooks", () => {
  it("recognises rtk hook commands precisely", () => {
    expect(isRtkHookCommand("rtk hook claude", "claude")).toBe(true);
    expect(isRtkHookCommand("\"/opt/homebrew/bin/rtk\" hook claude", "claude")).toBe(true);
    expect(isRtkHookCommand("C:\\tools\\rtk.exe hook codex", "codex")).toBe(true);
    expect(isRtkHookCommand("/home/u/.claude/hooks/rtk-rewrite.sh", "claude")).toBe(true);
    expect(isRtkHookCommand("echo rtk hook claude", "claude")).toBe(false);
    expect(isRtkHookCommand("rtk hook claude --x", "claude")).toBe(false);
    expect(isRtkHookCommand("rtk hook codex", "claude")).toBe(false);
    expect(isRtkHookCommand("/x/tkr-codex-hook", "codex")).toBe(false);
  });

  it("plans removal only where Tokmizer is installed too, keeping every other hook", () => {
    installAgents();
    const findings = scanRtkHooks(e);
    const claude = findings.find((f) => f.agent === "Claude Code")!;
    expect(claude.tkrInstalled).toBe(true);
    const settings = JSON.parse(claude.edits.find((x) => x.file.endsWith("settings.json"))!.content!);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard.sh" }] }]);
    expect(settings.hooks.Stop).toEqual(claudeSettings().hooks.Stop);
    expect(settings.permissions).toEqual(claudeSettings().permissions);
    expect(claude.edits.find((x) => x.file.endsWith("CLAUDE.md"))!.content).toBe("# Mine\nkeep me\n");
    expect(findings.find((f) => f.agent === "Codex")!.tkrInstalled).toBe(true);
    const cursor = findings.find((f) => f.agent === "Cursor")!;
    expect(cursor.tkrInstalled).toBe(false);
    expect(doubleHooked(e)).toEqual(["Claude Code", "Codex"]);
  });

  it("finds rtk in Gemini, Copilot, Droid, Trae, Vibe, Antigravity, OpenCode and Pi", () => {
    writeJson(join(home, ".gemini", "settings.json"), { hooks: { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: `${home}/.gemini/hooks/rtk-hook-gemini.sh` }] }] } });
    writeJson(join(home, ".copilot", "hooks", "rtk-rewrite.json"), { version: 1, hooks: { PreToolUse: [{ type: "command", command: "rtk hook copilot" }] } });
    writeJson(join(home, ".factory", "settings.json"), { hooks: { PreToolUse: [{ matcher: "Execute", hooks: [{ type: "command", command: "rtk hook droid" }] }] } });
    writeJson(join(home, ".trae", "hooks.json"), { version: 1, hooks: { PreToolUse: [{ matcher: "RunCommand", hooks: [{ type: "command", command: "rtk hook trae", timeout: 30 }] }] } });
    mkdirSync(join(home, ".vibe"), { recursive: true });
    writeFileSync(join(home, ".vibe", "hooks.toml"), "[[hooks]]\nname = \"mine\"\ncommand = \"x\"\n\n[[hooks]]\nname = \"rtk-rewrite\"\ntype = \"pre_tool\"\ncommand = \"rtk hook vibe\"\n");
    writeJson(join(home, ".gemini", "config", "plugins", "rtk", "hooks.json"), { "rtk-rewrite": { enabled: true, PreToolUse: [] } });
    mkdirSync(join(home, ".config", "opencode", "plugins"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "plugins", "rtk.ts"), "spawn('rtk hook opencode')");
    mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "extensions", "rtk.ts"), "pi.exec(\"rtk\", [\"rewrite\", cmd])");
    const byAgent = Object.fromEntries(scanRtkHooks(e).map((f) => [f.agent, f.edits]));
    expect(Object.keys(byAgent).sort()).toEqual(["Antigravity", "Factory Droid", "Gemini CLI", "GitHub Copilot", "Mistral Vibe", "OpenCode", "Pi", "Trae"]);
    expect(byAgent["Gemini CLI"]![0]!.content).not.toContain("rtk");
    expect(byAgent["GitHub Copilot"]![0]!.action).toBe("delete");
    expect(byAgent["Mistral Vibe"]![0]!.content).toBe("[[hooks]]\nname = \"mine\"\ncommand = \"x\"\n");
    expect(JSON.parse(byAgent["Antigravity"]![0]!.content!)["rtk-rewrite"].enabled).toBe(false);
    expect(byAgent["Pi"]![0]!.action).toBe("delete");
  });
});

describe("migration apply and undo", () => {
  it("applies the plan with backups, then undo restores every file exactly", async () => {
    installRtkFiles({ trustGlobal: true });
    installAgents();
    await saveSettingsCache({ ...(await loadSettingsCache()), telemetryOptIn: true });
    const before = {
      claude: sha(join(home, ".claude", "settings.json")),
      claudeMd: sha(join(home, ".claude", "CLAUDE.md")),
      codex: sha(join(home, ".codex", "hooks.json")),
      cursor: sha(join(home, ".cursor", "hooks.json"))
    };
    const rtkBefore = [join(rtkConfigDir(), "filters.toml"), join(rtkConfigDir(), "config.toml"), join(rtkDataDir(), "history.db")].map(sha);

    const plan = await buildPlan(e, { shim: { tkr: ["/opt/tkr"] } });
    expect(planHasWork(plan)).toBe(true);
    const text = renderPlan(plan);
    expect(text).toContain("not imported: keep-errors: uses keep_lines_matching");
    expect(text).toContain("test FAIL short-log #1 (keeps the first lines)");
    expect(text).toContain("Cursor: rtk kept in");
    expect(text).toContain("no Tokmizer equivalent, not imported: hooks.transparent_prefixes, retriever.max_entries, limits.grep_max_results");

    await applyPlan(plan);
    const tkHome = join(home, ".tokmizer");
    expect(readFileSync(join(tkHome, "filters", "rtk-global.toml"), "utf8")).toContain("[filters.make-quiet]");
    expect(Object.keys(readJson(join(tkHome, "filters-trust.json")).files).sort()).toEqual(["rtk-excluded.toml", "rtk-global.toml"]);
    expect((await loadUserFilters()).filters.has("user/make-quiet")).toBe(true);
    expect(readJson(join(tkHome, "restore.json"))).toEqual({ maxAgeDays: 14 });
    expect(contentCacheLimits({}).maxAgeMs).toBe(14 * 24 * 60 * 60 * 1000);
    expect((await loadRtkImport())?.savedTokens).toBe(378000);
    expect((await loadSettingsCache()).telemetryOptIn).toBe(false);
    expect(readJson(join(home, ".claude", "settings.json")).hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard.sh" }] }]);
    expect(readJson(join(home, ".codex", "hooks.json")).hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "/x/tkr-codex-hook", timeout: 10 }] }]);
    expect(sha(join(home, ".cursor", "hooks.json"))).toBe(before.cursor);
    expect(readFileSync(join(tkHome, "shims", "rtk"), "utf8")).toContain("rtk-compat");
    expect(findRtkBinary({ ...e, env: { PATH: join(tkHome, "shims") } })).toMatchObject({ compatShim: true });

    const undo = await undoMigration();
    expect(undo.ok).toBe(true);
    expect(sha(join(home, ".claude", "settings.json"))).toBe(before.claude);
    expect(sha(join(home, ".claude", "CLAUDE.md"))).toBe(before.claudeMd);
    expect(sha(join(home, ".codex", "hooks.json"))).toBe(before.codex);
    for (const f of ["filters/rtk-global.toml", "filters/rtk-excluded.toml", "filters-trust.json", "restore.json", "rtk-import.json", "shims/rtk"]) {
      expect(existsSync(join(tkHome, f))).toBe(false);
    }
    expect((await loadSettingsCache()).telemetryOptIn).toBe(true);
    expect([join(rtkConfigDir(), "filters.toml"), join(rtkConfigDir(), "config.toml"), join(rtkDataDir(), "history.db")].map(sha)).toEqual(rtkBefore);
    expect((await undoMigration()).lines).toEqual(["Nothing to undo: no rtk migration found."]);
  });

  it("applies nothing twice: a second run reports it is already migrated and creates no second backup set", async () => {
    installRtkFiles({ trustGlobal: true });
    installAgents();
    const first = await applyPlan(await buildPlan(e));
    expect(first.at(-1)).toMatch(/^Backups: /);
    const tkHome = join(home, ".tokmizer");
    const after = ["filters/rtk-global.toml", "filters/rtk-excluded.toml", "filters-trust.json", "restore.json", "rtk-import.json"].map((f) => sha(join(tkHome, f)));
    const again = await buildPlan(e);
    expect(planHasWork(again)).toBe(false);
    expect(await applyPlan(again)).toEqual(["Already migrated: nothing to change."]);
    expect(readdirSync(join(tkHome, "migrate-rtk"))).toHaveLength(1);
    expect(["filters/rtk-global.toml", "filters/rtk-excluded.toml", "filters-trust.json", "restore.json", "rtk-import.json"].map((f) => sha(join(tkHome, f)))).toEqual(after);
  });

  it("undoes every migration still in place, newest first, back to the original bytes", async () => {
    installRtkFiles();
    installAgents();
    const before = {
      claude: sha(join(home, ".claude", "settings.json")),
      claudeMd: sha(join(home, ".claude", "CLAUDE.md")),
      codex: sha(join(home, ".codex", "hooks.json"))
    };
    await applyPlan(await buildPlan(e));
    const tkHome = join(home, ".tokmizer");
    expect(readJson(join(tkHome, "restore.json"))).toEqual({ maxAgeDays: 14 });
    writeFileSync(join(rtkConfigDir(), "config.toml"), readFileSync(join(rtkConfigDir(), "config.toml"), "utf8").replace("retention_days = 14", "retention_days = 21"));
    const second = await buildPlan(e);
    expect(pendingWork(second).steps.map((s) => s.path)).toEqual([join(tkHome, "restore.json")]);
    const done = await applyPlan(second);
    expect(done).toEqual(["tkr restore keeps outputs 21 days", expect.stringMatching(/^Backups: /)]);
    expect(readJson(join(tkHome, "restore.json"))).toEqual({ maxAgeDays: 21 });
    expect(readdirSync(join(tkHome, "migrate-rtk"))).toHaveLength(2);

    const undo = await undoMigration();
    expect(undo.ok).toBe(true);
    expect(undo.lines.filter((l) => l.startsWith("Undid the rtk migration of"))).toHaveLength(2);
    expect(undo.lines.at(-1)).toBe("2 migrations undone, newest first.");
    expect(sha(join(home, ".claude", "settings.json"))).toBe(before.claude);
    expect(sha(join(home, ".claude", "CLAUDE.md"))).toBe(before.claudeMd);
    expect(sha(join(home, ".codex", "hooks.json"))).toBe(before.codex);
    for (const f of ["filters/rtk-global.toml", "filters/rtk-excluded.toml", "filters-trust.json", "restore.json", "rtk-import.json"]) {
      expect(existsSync(join(tkHome, f))).toBe(false);
    }
    expect((await undoMigration()).lines).toEqual(["Nothing to undo: no rtk migration found."]);
  });

  it("does not overwrite a file changed after the migration", async () => {
    installAgents();
    await applyPlan(await buildPlan(e));
    writeFileSync(join(home, ".codex", "hooks.json"), "{\"edited\": true}\n");
    const undo = await undoMigration();
    expect(undo.ok).toBe(false);
    expect(undo.lines.join("\n")).toContain(`Kept ${join(home, ".codex", "hooks.json")}: it changed after the migration.`);
    expect(readJson(join(home, ".codex", "hooks.json"))).toEqual({ edited: true });
    expect(readJson(join(home, ".claude", "settings.json"))).toEqual(claudeSettings());
  });

  it("leaves untrusted rtk filters inactive until the user trusts them", async () => {
    installRtkFiles();
    await applyPlan(await buildPlan(e));
    const user = await loadUserFilters();
    expect(user.filters.has("user/make-quiet")).toBe(false);
    expect(user.issues.map((i) => i.file)).toContain("rtk-global.toml");
    expect(user.filters.has("user/rtk-exclude-1")).toBe(true);
  });

  it("keeps the output of excluded commands unchanged", async () => {
    installRtkFiles();
    await applyPlan(await buildPlan(e));
    const noisy = Array.from({ length: 400 }, (_, i) => `line ${i % 3}`).join("\n") + "\n";
    const r = await processOutput("curl -s https://example.com", noisy, null, { exitCode: 0, verbosity: "compact" });
    expect(r.output).toBe(noisy);
    expect(r.filterId).toBe("user/rtk-exclude-1");
  });
});

describe("restore settings imported from rtk", () => {
  it("disables tkr restore when rtk recall was disabled", async () => {
    mkdirSync(rtkConfigDir(), { recursive: true });
    writeFileSync(join(rtkConfigDir(), "config.toml"), "[retriever]\nmode = \"disabled\"\n");
    const plan = await buildPlan(e);
    expect(plan.config.restoreDisabled).toBe(true);
    const tail = "dropped line\n".repeat(50);
    expect(await captureForRestore(tail, "kept", {})).toMatch(/\[tkr restore [0-9a-f]{16}\]$/);
    await applyPlan(plan);
    expect(await captureForRestore(tail, "kept", {})).toBe("kept");
    await undoMigration();
    expect(await captureForRestore(tail, "kept", {})).toMatch(/\[tkr restore [0-9a-f]{16}\]$/);
  });
});

describe("rtk compatibility command", () => {
  it("forwards gain, recall and bypass and explains the rest", () => {
    expect(rtkCompatAction(["gain", "--week"])).toEqual({ kind: "tkr", argv: ["gain", "--week"] });
    expect(rtkCompatAction(["recall", "abc123", "--full"])).toEqual({ kind: "tkr", argv: ["restore", "abc123"] });
    expect(rtkCompatAction(["restore", "--list"])).toEqual({ kind: "tkr", argv: ["restore", "--list"] });
    expect(rtkCompatAction(["bypass", "git", "status"])).toEqual({ kind: "raw", argv: ["git", "status"] });
    expect(rtkCompatAction(["proxy", "ls"])).toEqual({ kind: "raw", argv: ["ls"] });
    expect(rtkCompatAction(["bypass"])).toMatchObject({ kind: "message", code: 2 });
    const unknown = rtkCompatAction(["git", "status"]);
    expect(unknown).toMatchObject({ kind: "message", code: 1 });
    expect(unknown.kind === "message" && unknown.stderr).toContain("Run the command directly, Tokmizer compresses its output on its own: git status");
  });

  it("writes a POSIX script and a Windows cmd file", () => {
    expect(rtkShimContent(["/opt/my tkr"], "linux")).toBe("#!/bin/sh\nTOKMIZER_SHIM=tokmizer-rtk-compat exec '/opt/my tkr' rtk-compat \"$@\"\n");
    expect(rtkShimContent(["C:\\node.exe", "C:\\tkr.js"], "win32")).toBe("@echo off\r\nset TOKMIZER_SHIM=tokmizer-rtk-compat\r\n\"C:\\node.exe\" \"C:\\tkr.js\" rtk-compat %*\r\n");
  });
});

describe("tkr migrate rtk (CLI)", () => {
  function tkr(args: string[], extra: Record<string, string> = {}) {
    return spawnSync(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, resolve("packages/plugin/src/bin/tkr.ts"), ...args], {
      encoding: "utf8",
      input: "",
      timeout: 20000,
      cwd: project,
      env: {
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        HOME: home,
        CI: "1",
        TOKMIZER_HOME: join(home, ".tokmizer"),
        TOKMIZER_NETWORK: "0",
        TOKMIZER_BASE_URL: "http://127.0.0.1:1",
        TOKMIZER_AUTO_UPDATE: "0",
        TOKMIZER_DAEMON_BIN: join(root, "disabled-daemon.js"),
        TOKMIZER_CLAUDE_COMMANDS_DIR: join(root, "commands"),
        XDG_RUNTIME_DIR: "",
        ...(process.platform === "darwin" ? { XDG_CONFIG_HOME: "" } : {}),
        ...extra
      }
    });
  }

  function fakeRtk(): void {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "rtk"), "#!/bin/sh\necho 'rtk 1.0.1'\n");
    chmodSync(join(root, "bin", "rtk"), 0o755);
  }

  function placeForPlatform(): void {
    if (process.platform !== "darwin") return;
    const mac = join(home, "Library", "Application Support", "rtk");
    mkdirSync(mac, { recursive: true });
    for (const f of ["filters.toml", "config.toml", "history.db"]) copyFileSync(join(FIX, f), join(mac, f));
  }

  it.skipIf(process.platform === "win32")("shows a plan by default, applies with --yes, shows imported history in gain, and undoes", () => {
    fakeRtk();
    installRtkFiles();
    placeForPlatform();
    installAgents();
    const dry = tkr(["migrate", "rtk", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(`rtk: ${join(root, "bin", "rtk")} (rtk 1.0.1)`);
    expect(dry.stdout).toContain("Dry run: nothing changed.");
    expect(existsSync(join(home, ".tokmizer", "migrate-rtk"))).toBe(false);

    const noTty = tkr(["migrate", "rtk"]);
    expect(noTty.stdout).toContain("Nothing changed. Apply with: tkr migrate rtk --yes");

    const applied = tkr(["migrate", "rtk", "--yes"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("Imported rtk savings history");
    expect(applied.stdout).toContain("Claude Code: removed rtk PreToolUse/PostToolUse hook");

    const gain = tkr(["gain"]);
    expect(gain.stdout).toContain("Imported from rtk: 378.0K tokens saved over 300 commands");
    const json = JSON.parse(tkr(["gain", "--json"]).stdout);
    expect(json.importedFromRtk).toMatchObject({ commands: 300, savedTokens: 378000, scope: "rtk-estimate-not-in-totals" });
    expect(json.savedTokens).toBe(0);
    expect(tkr(["gain", "--week"]).stdout).not.toContain("Imported from rtk");

    const again = tkr(["migrate", "rtk", "--yes"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("Already migrated: nothing to change. Undo with: tkr migrate rtk --undo");
    expect(readdirSync(join(home, ".tokmizer", "migrate-rtk"))).toHaveLength(1);

    const undo = tkr(["migrate", "rtk", "--undo"]);
    expect(undo.status).toBe(0);
    expect(readJson(join(home, ".claude", "settings.json"))).toEqual(claudeSettings());
    expect(tkr(["migrate", "rtk", "--undo"]).stdout).toContain("Nothing to undo");
  });

  it.skipIf(process.platform === "win32")("reports double hooks in doctor and offers the migration in setup", () => {
    fakeRtk();
    writeJson(join(home, ".cursor", "hooks.json"), { version: 1, hooks: { preToolUse: [{ command: "rtk hook cursor", matcher: "Shell" }] } });
    const setup = tkr(["setup-cursor"]);
    expect(setup.stdout).toContain("rtk is installed too.");
    expect(setup.stdout).toContain("tkr migrate rtk");
    const doctor = tkr(["doctor"]);
    expect(doctor.stdout).toContain("double hook — rtk and Tokmizer both wrap commands in Cursor. Fix: tkr migrate rtk");
  });

  it.skipIf(process.platform === "win32")("says so when rtk is absent, and validates arguments", () => {
    expect(tkr(["migrate", "rtk"]).stdout).toContain("rtk was not found on this machine");
    expect(tkr(["migrate", "rtk", "--bogus"]).status).toBe(1);
    expect(tkr(["migrate", "foo"]).status).toBe(1);
  });

  it.skipIf(process.platform === "win32")("runs rtk-compat: bypass runs the command raw with its exit code", () => {
    const r = tkr(["rtk-compat", "bypass", "sh", "-c", "printf raw; exit 3"]);
    expect(r.stdout).toBe("raw");
    expect(r.status).toBe(3);
    const unknown = tkr(["rtk-compat", "cargo", "build"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("cargo build");
  });
});

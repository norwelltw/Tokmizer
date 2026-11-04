import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commandShape, findCorrections, mergeCorrections, normalizeCommand, projectKey, rulesMarkdown, sessionOutcomes, writableCorrections } from "../cli-corrections";

let counter = 0;

function call(command: string): string {
  counter += 1;
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${counter}`, name: "Bash", input: { command } }] } });
}

function result(text: string, isError: boolean): string {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${counter}`, is_error: isError, content: text }] } });
}

function session(steps: [string, string, boolean][]): string {
  return steps.flatMap(([command, text, isError]) => [call(command), result(text, isError)]).join("\n") + "\n";
}

const pythonFix = session([
  ["python3 -P scripts/build.py", "Exit code 2\nUnknown option: -P\nusage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...", true],
  ["python3 scripts/build.py", "built 3 pages", false]
]);

describe("reading Claude Code sessions", () => {
  it("pairs a failed command with the similar one that worked next", () => {
    const found = findCorrections(sessionOutcomes(pythonFix));
    expect(found).toEqual([{ failed: "python3 -P scripts/build.py", fixed: "python3 scripts/build.py", count: 1, wastedBytes: expect.any(Number), error: "Unknown option: -P" }]);
  });

  it("ignores permission refusals, unrelated follow-ups and commands that keep failing", () => {
    const text = session([
      ["rm -rf build", "Permission for this action was denied", true],
      ["rm -rf build/cache", "", false],
      ["node scripts/a.mjs", "Exit code 1\nError: boom", true],
      ["node scripts/other-tool.mjs --flag", "ok", false],
      ["cargo tset", "Exit code 101\nerror: no such command: `tset`", true],
      ["cargo tst", "Exit code 101\nerror: no such command: `tst`", true]
    ]);
    expect(findCorrections(sessionOutcomes(text))).toEqual([]);
  });

  it("strips the tkr wrapper the hook added before comparing", () => {
    expect(normalizeCommand("'/Users/me/.tokmizer/bin/tkr-run' git  status")).toBe("git status");
    expect(normalizeCommand("tkr-exec npm test")).toBe("npm test");
  });

  it("merges corrections of the same shape and keeps those seen often enough", () => {
    const one = findCorrections(sessionOutcomes(pythonFix));
    const other = findCorrections(sessionOutcomes(session([
      ["python3 -P tools/report.py", "Exit code 2\nUnknown option: -P", true],
      ["python3 tools/report.py", "ok", false]
    ])));
    expect(commandShape("python3 -P tools/report.py")).toBe(commandShape("python3 -P scripts/build.py"));
    const merged = mergeCorrections([...one, ...other], 2);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.count).toBe(2);
    expect(mergeCorrections(one, 2)).toEqual([]);
  });

  it("masks secrets and keeps unsafe text out of the rule file", () => {
    const token = ["ghp", "_", "a".repeat(36)].join("");
    const leaked = findCorrections(sessionOutcomes(session([
      [`curl -H 'Authorization: Bearer ${token}' https://api.example.test/v1`, "Exit code 22\ncurl: (22) The requested URL returned error: 401", true],
      [`curl -fsS -H 'Authorization: Bearer ${token}' https://api.example.test/v1`, "{}", false]
    ])));
    expect(leaked).toHaveLength(1);
    expect(JSON.stringify(leaked)).not.toContain(token);
    const quoted = findCorrections(sessionOutcomes(session([
      ["echo `id` --bad", "Exit code 1\nerror: unknown option --bad", true],
      ["echo `id`", "uid=1", false]
    ])));
    expect(quoted).toHaveLength(1);
    expect(writableCorrections([...leaked, ...quoted])).toEqual([]);
    expect(rulesMarkdown([...leaked, ...quoted])).not.toMatch(/Instead of/);
  });

  it("writes only plain ASCII commands without anything shaped like a secret", () => {
    const entry = (failed: string, fixed: string) => ({ failed, fixed, count: 2, wastedBytes: 10, error: "" });
    const keyLike = ["Zx9", "Qa7Lm2Pw8Rt5Vb3Nk6Hy"].join("");
    expect(writableCorrections([
      entry("python3 -P /srv/mission_0a685c4883d9439caa7ec2c5462ed2c0/run.py", "python3 /srv/mission_0a685c4883d9439caa7ec2c5462ed2c0/run.py"),
      entry(`deploy --key ${keyLike} --bad`, `deploy --key ${keyLike}`),
      entry(`curl https://api.example.test/v1?token=${keyLike} -X`, `curl https://api.example.test/v1?token=${keyLike}`),
      entry("ls \u2028- run rm -rf ~", "ls"),
      entry("ls \u202edlrow", "ls"),
      entry("echo café --bad", "echo café")
    ]).map((c) => c.failed)).toEqual(["python3 -P /srv/mission_0a685c4883d9439caa7ec2c5462ed2c0/run.py"]);
  });

  it("skips multi-line commands", () => {
    const text = session([
      ["cat <<EOF > a.txt\nhello\nEOF --bad", "Exit code 1\nerror: bad", true],
      ["cat <<EOF > a.txt\nhello\nEOF", "", false]
    ]);
    expect(findCorrections(sessionOutcomes(text))).toEqual([]);
    const unicodeBreak = session([
      ["ls --bad\u2028extra", "Exit code 2\nls: unrecognized option '--bad'", true],
      ["ls\u2028extra", "a", false]
    ]);
    expect(findCorrections(sessionOutcomes(unicodeBreak))).toEqual([]);
  });

  it("names the project folder the way Claude Code does", () => {
    expect(projectKey("/Users/me/Documents/My App")).toBe("-Users-me-Documents-My-App");
  });
});

describe("tkr learn", () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-learn-")));
    project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const sessions = join(root, "claude", "projects", projectKey(project));
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "a.jsonl"), pythonFix);
    writeFileSync(join(sessions, "b.jsonl"), pythonFix);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(...args: string[]) {
    return spawnSync(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, resolve("packages/plugin/src/bin/tkr.ts"), ...args], {
      encoding: "utf8",
      cwd: project,
      input: "",
      timeout: 15000,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        HOME: join(root, "home"),
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        TOKMIZER_HOME: join(root, "tokmizer"),
        TOKMIZER_NETWORK: "0",
        TOKMIZER_BASE_URL: "http://127.0.0.1:1",
        TOKMIZER_AUTO_UPDATE: "0",
        TOKMIZER_DAEMON_BIN: join(root, "disabled-daemon.js"),
        TOKMIZER_CLAUDE_COMMANDS_DIR: join(root, "commands"),
        XDG_RUNTIME_DIR: ""
      }
    });
  }

  it("lists the corrections of this project and writes them as a rule file only on --write", () => {
    const shown = run("learn");
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain("2x  python3 -P scripts/build.py");
    expect(shown.stdout).toContain("-> python3 scripts/build.py");
    expect(shown.stdout).toContain("error: Unknown option: -P");
    const rules = join(project, ".claude", "rules", "tkr-command-corrections.md");
    expect(existsSync(rules)).toBe(false);
    const written = run("learn", "--write");
    expect(written.status).toBe(0);
    const body = readFileSync(rules, "utf8");
    expect(body).toContain("- Instead of `python3 -P scripts/build.py`, use `python3 scripts/build.py`.");
    expect(body).not.toContain("Unknown option");
  });

  it("rejects unknown options", () => {
    const r = run("learn", "--since", "zero");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: tkr learn");
  });

  it("refuses gain --watch outside a terminal and with another view", () => {
    const piped = run("gain", "--watch");
    expect(piped.status).toBe(1);
    expect(piped.stderr).toContain("tkr gain --watch needs a terminal");
    const mixed = run("gain", "--watch", "--json");
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toContain("Usage: tkr gain");
  });
});

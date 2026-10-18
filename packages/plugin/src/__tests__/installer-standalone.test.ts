import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("packages/plugin/scripts/install-mac-linux.sh");
const single = process.env.TOKMIZER_SINGLE_TEST_BIN;
const native = process.env.TOKMIZER_NATIVE_TEST_BIN;
const key = `${process.platform}-${process.arch}`;
let root: string;
let home: string;
let release: string;

const stub = (log: string) => `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$1" = "--single-check" ] && printf 'tokmizer-single 9.9.9\\n'\nexit 0\n`;

function publish(tkr: string, exec: string) {
  const name = `tokmizer-9.9.9-${key}`;
  const stage = join(root, "stage");
  mkdirSync(join(stage, name, "dist", "bin"), { recursive: true });
  copyFileSync(tkr, join(stage, name, "dist", "bin", "tkr"));
  copyFileSync(exec, join(stage, name, "dist", "bin", "tkr-exec"));
  chmodSync(join(stage, name, "dist", "bin", "tkr"), 0o755);
  chmodSync(join(stage, name, "dist", "bin", "tkr-exec"), 0o755);
  const archive = join(release, `${name}.tar.gz`);
  const packed = spawnSync("tar", ["-czf", archive, "-C", stage, name]);
  expect(packed.status).toBe(0);
  const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(join(release, "SHA256SUMS"), `${sum}  ${name}.tar.gz\n`);
}

function install(extra: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [script], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      TOKMIZER_HOME: join(home, ".tokmizer"),
      TOKMIZER_STANDALONE: "1",
      TOKMIZER_DOWNLOAD_BASE: `file://${release}`,
      TOKMIZER_BASE_URL: "http://127.0.0.1:9",
      TOKMIZER_AUTO_UPDATE: "0",
      TOKMIZER_NETWORK: "off",
      ...extra
    }
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-standalone-install-")));
  home = join(root, "home");
  release = join(root, "release");
  mkdirSync(home);
  mkdirSync(release);
});

afterEach(() => {
  const run = join(home, ".tokmizer", "run");
  if (existsSync(run)) {
    for (const name of readdirSync(run).filter((n) => n.endsWith(".pid"))) {
      try {
        process.kill(Number(readFileSync(join(run, name), "utf8")), "SIGTERM");
      } catch {}
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32" || !["darwin", "linux"].includes(process.platform))("standalone installer and Claude Code", () => {
  it("adds the Claude Code hooks when Claude Code is installed", () => {
    const log = join(root, "calls");
    writeFileSync(join(root, "tkr"), stub(log));
    publish(join(root, "tkr"), join(root, "tkr"));
    mkdirSync(join(home, ".claude"));
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, "utf8").split("\n")).toEqual(expect.arrayContaining(["shim install", "setup-claude"]));
  });

  it("leaves Claude Code alone when it is not installed", () => {
    const log = join(root, "calls");
    writeFileSync(join(root, "tkr"), stub(log));
    publish(join(root, "tkr"), join(root, "tkr"));
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("shim install");
    expect(readFileSync(log, "utf8")).not.toContain("setup-claude");
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it.skipIf(!single || !native)("installs working Node-free Claude Code hooks from the real standalone build", () => {
    publish(single!, native!);
    mkdirSync(join(home, ".claude"));
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    const bin = join(home, ".local", "bin");
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const pre = settings.hooks.PreToolUse.flatMap((g: { hooks: { command: string }[] }) => g.hooks).map((h: { command: string }) => h.command);
    expect(pre).toEqual([`[ ! -x '${join(bin, "tkr-exec")}' ] || exec '${join(bin, "tkr-exec")}' --pre-tool-use`]);
    expect(JSON.stringify(settings.hooks)).not.toMatch(/\bnode\b/);
    const hook = spawnSync("/bin/sh", ["-c", pre[0]], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: "git status" } }),
      encoding: "utf8",
      timeout: 20000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TOKMIZER_HOME: join(home, ".tokmizer"), TOKMIZER_NETWORK: "off", TOKMIZER_AUTO_UPDATE: "0" }
    });
    expect(hook.status, hook.stderr).toBe(0);
    expect(JSON.parse(hook.stdout).hookSpecificOutput.updatedInput.command).toMatch(/ git status$/);
  });
});

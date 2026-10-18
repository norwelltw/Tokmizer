import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env.TOKMIZER_NATIVE_TEST_BIN;
let root: string;
let log: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-single-launcher-")));
  log = join(root, "calls.log");
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "home"));
  copyFileSync(binary!, join(root, "bin", "tkr-exec"));
  chmodSync(join(root, "bin", "tkr-exec"), 0o755);
  writeFileSync(join(root, "bin", "tkr"), `#!/bin/sh\nprintf 'single %s|%s\\n' "$*" "$TOKMIZER_HOME" >> '${log}'\n[ "$1" = processor ] && exit 0\ncat >> '${log}'\nexit 5\n`, { mode: 0o755 });
  writeFileSync(join(root, "bin", "tkr-exec.js"), `require("node:fs").appendFileSync(${JSON.stringify(log)}, "node " + process.argv.slice(2).join(" ") + "\\n"); process.exit(6);`);
  writeFileSync(join(root, "hooks-pre.js"), `require("node:fs").appendFileSync(${JSON.stringify(log)}, "node-pre\\n");`);
  env = { PATH: "/usr/bin:/bin", HOME: root, TOKMIZER_HOME: join(root, "home"), TOKMIZER_NODE_BIN: process.execPath };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[], extra: NodeJS.ProcessEnv = {}, input = "") {
  return spawnSync(join(root, "bin", "tkr-exec"), args, { env: { ...env, ...extra }, input, encoding: "utf8", timeout: 5000 });
}

function calls(): string {
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

describe.skipIf(process.platform === "win32" || !binary)("native launcher with a bundled executable", () => {
  it("falls back to the executable's exec entry instead of node", () => {
    const result = run(["echo", "hi"], { TOKMIZER_DEV: "1" });
    expect(result.status).toBe(5);
    expect(calls()).toBe(`single exec echo hi|${join(root, "home")}\n`);
  });

  it("uses node when the executable is disabled, overridden or not runnable", () => {
    expect(run(["echo", "a"], { TOKMIZER_DEV: "1", TOKMIZER_SINGLE_EXEC: "0" }).status).toBe(6);
    expect(run(["echo", "b"], { TOKMIZER_DEV: "1", TOKMIZER_EXEC_JS: join(root, "bin", "tkr-exec.js") }).status).toBe(6);
    chmodSync(join(root, "bin", "tkr"), 0o644);
    expect(run(["echo", "c"], { TOKMIZER_DEV: "1" }).status).toBe(6);
    expect(calls()).toBe("node echo a\nnode echo b\nnode echo c\n");
  });

  it("hands hook payloads to the executable's hook entry", () => {
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    const result = run(["--pre-tool-use"], { TOKMIZER_DEV: "1" }, payload);
    expect(result.status).toBe(5);
    expect(calls()).toBe(`single hook pre-tool-use|${join(root, "home")}\n${payload}`);
    expect(run(["--pre-tool-use"], { TOKMIZER_DEV: "1", TOKMIZER_PRE_TOOL_JS: join(root, "hooks-pre.js") }, payload).status).toBe(0);
    expect(calls().endsWith("node-pre\n")).toBe(true);
  });

  it("starts the processor through the executable", async () => {
    expect(run(["--session-start"], {}, "{}").status).toBe(0);
    const deadline = Date.now() + 2000;
    while (!calls().includes("processor") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls()).toBe(`single processor|${realpathSync(join(root, "home"))}\n`);
  });
});

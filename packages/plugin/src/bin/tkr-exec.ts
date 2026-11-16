#!/usr/bin/env node
import spawn from "cross-spawn";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { runWrapped, signalNumber, underCapturingExec } from "../exec/wrapper";
import { exitOnBrokenPipe } from "../epipe";
import { failOpenActive } from "../shim/sh";
import { windowsCommand } from "../exec/windows-command";

exitOnBrokenPipe();

async function passthrough(argv: string[]): Promise<never> {
  const [cmd, ...args] = argv;
  if (!cmd) process.exit(2);
  const child = spawn(windowsCommand(cmd, process.env), args, { stdio: "inherit" });
  const code: number = await new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (c, signal) => resolve(c != null ? c : signal ? 128 + signalNumber(signal) : 0));
  });
  process.exit(code);
}

// hooks.json calls `tkr-exec --pre-tool-use` etc. When the native launcher is not
// installed (Claude Code plugin installs skip postinstall), this JS copy answers them.
const HOOK_SCRIPTS: Record<string, string> = {
  "--pre-tool-use": "pre-tool-use.js",
  "--post-tool-use": "post-tool-use.js"
};

async function hookFlag(flag: string): Promise<never> {
  if (flag === "--session-start") {
    process.stdin.resume();
    process.stdin.on("error", () => process.exit(0));
    process.stdin.on("end", () => process.exit(0));
    return new Promise<never>(() => {});
  }
  let script: string;
  try {
    script = join(dirname(realpathSync(process.argv[1] ?? "")), "..", "hooks-host", HOOK_SCRIPTS[flag]!);
  } catch {
    process.exit(0);
  }
  if (!existsSync(script)) {
    process.stderr.write(`tkr-exec: missing hook script ${script}\n`);
    process.exit(0);
  }
  const child = spawn(process.execPath, [script], { stdio: "inherit" });
  const code: number = await new Promise((resolve) => {
    child.on("error", () => resolve(0));
    child.on("close", (c) => resolve(c ?? 0));
  });
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--session-start" || Object.hasOwn(HOOK_SCRIPTS, argv[0]!))) return hookFlag(argv[0]!);
  if (argv.length === 0) {
    process.stderr.write("tkr-exec: missing command\n");
    process.exit(2);
  }
  if (underCapturingExec() || failOpenActive()) return passthrough(argv);
  let result;
  try {
    result = await runWrapped(argv);
  } catch (err) {
    process.stderr.write(`tkr-exec: ${(err as Error).message ?? err}\n`);
    return passthrough(argv);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message ?? e}\n`);
  process.exit(1);
});

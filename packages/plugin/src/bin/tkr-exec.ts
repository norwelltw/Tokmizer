#!/usr/bin/env node
import spawn from "cross-spawn";
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

async function main() {
  const argv = process.argv.slice(2);
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

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkg, "..", "..");
const suite = "packages/plugin/src/__tests__/upgrade-safety.test.ts";

if (process.platform === "win32") {
  console.error("check-upgrade-safety: the upgrade matrix runs real POSIX shells; release from macOS or Linux.");
  process.exit(1);
}

const single = join(pkg, "native", "artifacts", `${process.platform}-${process.arch}`, "tkr");
const env = { ...process.env };
if (!env.TOKMIZER_SINGLE_TEST_BIN && existsSync(single)) env.TOKMIZER_SINGLE_TEST_BIN = single;
const allowSkip = env.TOKMIZER_UPGRADE_ALLOW_NO_SINGLE === "1" && !env.TOKMIZER_SINGLE_TEST_BIN;

const report = join(tmpdir(), `tkr-upgrade-safety-${process.pid}.json`);
const run = spawnSync("npx", ["vitest", "run", suite, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`], { cwd: repo, env, stdio: "inherit" });
let result;
try {
  result = JSON.parse(readFileSync(report, "utf8"));
} catch {
  console.error("check-upgrade-safety: the upgrade matrix did not produce a report");
  process.exit(1);
} finally {
  rmSync(report, { force: true });
}

const failed = result.numFailedTests ?? 1;
const skipped = (result.numPendingTests ?? 0) + (result.numTodoTests ?? 0);
const passed = result.numPassedTests ?? 0;
if (run.status !== 0 || failed > 0 || passed < 12 || (skipped > 0 && !(allowSkip && skipped === 1))) {
  console.error(`check-upgrade-safety: FAILED (passed ${passed}, failed ${failed}, skipped ${skipped}). Build the single binary or set TOKMIZER_SINGLE_TEST_BIN.`);
  process.exit(1);
}
console.log(`upgrade safety: ${passed} scenarios passed${skipped ? `, ${skipped} skipped (no single binary)` : ""}`);

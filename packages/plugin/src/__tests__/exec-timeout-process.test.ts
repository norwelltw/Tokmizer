import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../dist/bin/tkr-exec.js", import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-timeout-process-"));
  writeFileSync(join(dir, "settings-cache.json"), JSON.stringify({ enabled: false }));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(script: string): Promise<{ code: number | null; stdout: string; stderr: string; finishedAt: number }> {
  const counter = join(dir, "executions");
  const program = `setTimeout(()=>process.exit(99),6500).unref();require('node:fs').appendFileSync(process.env.TKR_TEST_COUNTER, 'run\\n');${script}`;
  const child = spawn(process.execPath, [cli, process.execPath, "-e", program], {
    env: {
      ...process.env,
      TOKMIZER_HOME: dir,
      TOKMIZER_TKR_BIN: join(dir, "no-enrollment.js"),
      TOKMIZER_EXEC_TIMEOUT_MS: "1000",
      TKR_TEST_COUNTER: counter
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; finishedAt: number }>((resolve, reject) => {
    let expired = false;
    const watchdog = setTimeout(() => {
      expired = true;
      child.kill("SIGKILL");
    }, 8000);
    child.once("error", (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      if (expired) reject(new Error("Packaged CLI did not exit within the test deadline"));
      else resolve({ code, stdout, stderr, finishedAt: Date.now() });
    });
  });
  expect(readFileSync(counter, "utf8")).toBe("run\n");
  return result;
}

describe("packaged CLI timeout lifecycle", () => {
  it.skipIf(process.platform === "win32")("exits promptly after a timed-out command shuts down cooperatively", async () => {
    const result = await run("process.on('SIGTERM',()=>{process.stdout.write('stopped:'+Date.now());process.stderr.write('diagnostic');process.exitCode=23;clearInterval(timer)});const timer=setInterval(()=>{},100);");
    expect(result.code).toBe(23);
    expect(result.stderr).toBe("diagnostic");
    expect(result.stdout).toMatch(/^stopped:\d+$/);
    const stoppedAt = Number(result.stdout.slice("stopped:".length));
    expect(result.finishedAt - stoppedAt).toBeLessThan(1200);
  }, 10000);

  it.skipIf(process.platform === "win32")("still force-stops a command that ignores termination after the grace period", async () => {
    const result = await run("process.on('SIGTERM',()=>process.stdout.write('ignored:'+Date.now()));setInterval(()=>{},100);");
    expect(result.code).toBe(137);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^ignored:\d+$/);
    const ignoredAt = Number(result.stdout.slice("ignored:".length));
    expect(result.finishedAt - ignoredAt).toBeGreaterThanOrEqual(1800);
  }, 10000);

  it("preserves the output and exit code of a command finishing before its deadline", async () => {
    const result = await run("process.stdout.write('complete:'+Date.now());process.stderr.write('warning');process.exitCode=7;");
    expect(result.code).toBe(7);
    expect(result.stderr).toBe("warning");
    expect(result.stdout).toMatch(/^complete:\d+$/);
    const completedAt = Number(result.stdout.slice("complete:".length));
    expect(result.finishedAt - completedAt).toBeLessThan(1200);
  }, 10000);
});

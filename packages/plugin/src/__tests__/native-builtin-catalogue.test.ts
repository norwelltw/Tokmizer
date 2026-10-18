import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROCESSOR = join(PKG_ROOT, "dist", "bin", "tkr-processor.js");
const binary = process.env.TOKMIZER_NATIVE_TEST_BIN;

const terraformPlan = Array.from({ length: 300 }, (_, i) => [
  `Refreshing state... [id=${(i * 7919).toString(16).padStart(30, "0")}]`,
  `  \x1b[33m~\x1b[0m resource "aws_instance" "web_${i}" {`,
  `      \x1b[33m~\x1b[0m id              = "${(i * 104729).toString(16).padStart(16, "0")}" -> (known after apply)`,
  `      \x1b[2m# (${i % 40} unchanged attributes hidden)\x1b[0m`,
  "    }"
].join("\n")).join("\n") + "\nPlan: 3 to add, 8 to change, 4 to destroy.\n";

const gcloudHeader = "NAME                                       ZONE              MACHINE_TYPE      PREEMPTIBLE  INTERNAL_IP    EXTERNAL_IP     STATUS";
const gcloudList = [gcloudHeader, ...Array.from({ length: 1000 }, (_, i) =>
  `${`instance-${(i * 7919).toString(16).padStart(12, "0")}-web`.padEnd(43)}${"us-central1-b".padEnd(18)}${"e2-medium".padEnd(18)}${"".padEnd(13)}${`10.0.${i % 250}.${i % 200}`.padEnd(15)}${`34.1.${i % 250}.${i % 99}`.padEnd(16)}RUNNING`
)].join("\n") + "\n";

let root: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-builtin-")));
  home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "terraform.txt"), terraformPlan);
  writeFileSync(join(root, "gcloud.txt"), gcloudList);
  writeFileSync(join(bin, "terraform"), `#!/bin/sh\ncat '${join(root, "terraform.txt")}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, "gcloud"), `#!/bin/sh\ncat '${join(root, "gcloud.txt")}'\n`, { mode: 0o755 });
  const fallback = join(root, "fallback.mjs");
  writeFileSync(fallback, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(root, "fallback-count"))}, "1");\nprocess.exit(97);\n`);
  env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    CLAUDECODE: "1",
    TOKMIZER_HOME: home,
    TOKMIZER_AUTO_UPDATE: "0",
    TOKMIZER_TKR_BIN: join(root, "missing-tkr.js"),
    TOKMIZER_NODE_BIN: process.execPath,
    TOKMIZER_PROCESSOR_JS: PROCESSOR,
    TOKMIZER_EXEC_JS: fallback,
    TOKMIZER_PROCESSOR_IDLE_MS: "60000"
  };
});

afterEach(() => {
  const run = join(home, "run");
  if (existsSync(run)) {
    for (const name of readdirSync(run).filter((n) => /^processor-.*\.pid$/.test(n))) {
      try {
        process.kill(Number(readFileSync(join(run, name), "utf8")), "SIGTERM");
      } catch {}
    }
  }
  rmSync(root, { recursive: true, force: true });
});

async function warmProcessor(): Promise<void> {
  spawnSync(binary!, ["--session-start"], { env, input: JSON.stringify({ hook_event_name: "SessionStart" }) });
  const run = join(home, "run");
  const deadline = Date.now() + 10_000;
  while (!(existsSync(run) && readdirSync(run).some((n) => n.endsWith(".json")))) {
    if (Date.now() > deadline) throw new Error("processor did not start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function runNative(args: string[]): string {
  const result = spawnSync(binary!, args, { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  expect(result.status).toBe(0);
  return result.stdout;
}

function withVerbosity(outputVerbosity: string): void {
  writeFileSync(join(home, "settings-cache.json"), JSON.stringify({ enabled: true, telemetryOptIn: false, outputVerbosity, reducer: "off", filters: { enableAll: true, disabled: [] } }));
}

describe.skipIf(process.platform === "win32" || !binary || !existsSync(PROCESSOR))("built-in catalogue through the native launcher and processor", () => {
  it("compacts terraform plan and gcloud listings offline with no account and default settings", async () => {
    await warmProcessor();
    expect(existsSync(join(home, "settings-cache.json"))).toBe(false);

    const plan = runNative(["terraform", "plan"]);
    expect(plan).toContain("Plan: 3 to add, 8 to change, 4 to destroy.");
    expect(plan).not.toContain("unchanged attributes hidden");
    expect(plan).not.toContain("Refreshing state");
    expect(plan).not.toContain("\x1b[");
    expect(plan).not.toMatch(/id {2,}=/);
    expect(Buffer.byteLength(plan)).toBeLessThan(Buffer.byteLength(terraformPlan) / 4);

    const list = runNative(["gcloud", "compute", "instances", "list"]);
    expect(list).toContain("NAME\tZONE\tMACHINE_TYPE\tPREEMPTIBLE\tINTERNAL_IP\tEXTERNAL_IP\tSTATUS");
    expect(list.split("\n").length).toBeLessThanOrEqual(70);
    expect(Buffer.byteLength(list)).toBeLessThan(Buffer.byteLength(gcloudList) / 10);

    expect(existsSync(join(home, "state.json"))).toBe(false);
    expect(existsSync(join(root, "fallback-count"))).toBe(false);

    withVerbosity("normal");
    expect(Buffer.byteLength(runNative(["terraform", "plan"]))).toBeGreaterThan(Buffer.byteLength(plan));
    expect(Buffer.byteLength(runNative(["gcloud", "compute", "instances", "list"]))).toBeGreaterThan(Buffer.byteLength(list));
    expect(existsSync(join(root, "fallback-count"))).toBe(false);
  }, 60_000);
});

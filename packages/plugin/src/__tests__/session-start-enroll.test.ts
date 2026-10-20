import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const realHook = join(here, "..", "..", "hooks", "on-session-start.mjs");

let root: string;
let home: string;
let ran: string;

function runHook(env: Record<string, string> = {}): void {
  execFileSync(process.execPath, [join(root, "hooks", "on-session-start.mjs")], {
    env: { ...process.env, TOKMIZER_HOME: home, CLAUDE_PLUGIN_ROOT: root, TOKMIZER_CLAUDE_COMMANDS_DIR: join(home, "commands"), TOKMIZER_NATIVE_EXEC: "0", TOKMIZER_NETWORK: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function calls(): string[] {
  return existsSync(ran) ? readFileSync(ran, "utf8").split("\n").filter(Boolean) : [];
}

async function waitForHeartbeat(): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if (calls().includes("heartbeat")) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tkr-enroll-root-"));
  home = mkdtempSync(join(tmpdir(), "tkr-enroll-home-"));
  ran = join(root, "ran");
  mkdirSync(join(root, "hooks"), { recursive: true });
  mkdirSync(join(root, "dist", "bin"), { recursive: true });
  copyFileSync(realHook, join(root, "hooks", "on-session-start.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  writeFileSync(join(root, "dist", "bin", "tkr.js"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(ran)}, process.argv.slice(2).join(" ") + "\\n");`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("sign-up from SessionStart", () => {
  it("signs up a new Claude Code install on its first session, after the network notice", async () => {
    runHook();
    expect(existsSync(join(home, "network-notice-shown"))).toBe(true);
    expect(await waitForHeartbeat()).toBe(true);
  });

  it("stays offline when the network is off", async () => {
    runHook({ TOKMIZER_NETWORK: "0" });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls()).not.toContain("heartbeat");
  });
});

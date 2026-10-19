import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const hookPath = join(here, "..", "..", "hooks", "on-session-start.mjs");
const NODE_HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks-host/pre-tool-use.js"' }] }] } });

let root: string;
let home: string;
let ran: string;

function runHook(env: Record<string, string> = {}): void {
  execFileSync(process.execPath, [hookPath], {
    env: { ...process.env, TOKMIZER_HOME: home, CLAUDE_PLUGIN_ROOT: root, TOKMIZER_CLAUDE_COMMANDS_DIR: join(home, "commands"), TOKMIZER_NETWORK: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitFor(path: string): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tkr-native-root-"));
  home = mkdtempSync(join(tmpdir(), "tkr-native-home-"));
  ran = join(root, "ran");
  mkdirSync(join(root, "hooks"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "hooks", "hooks.json"), NODE_HOOKS);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  writeFileSync(join(root, "scripts", "install-native.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(ran)}, process.argv.slice(2).join(" ") + "\\n");`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("native launcher from SessionStart", () => {
  it("switches a node-launched install to the native launcher once per version", async () => {
    runHook();
    expect(await waitFor(ran)).toBe(true);
    expect(readFileSync(ran, "utf8")).toBe("--native-only\n");
    expect(existsSync(join(home, "native-attempt-9.9.9"))).toBe(true);
    runHook();
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(ran, "utf8")).toBe("--native-only\n");
  });

  it("does nothing when the native launcher is turned off or already in use", async () => {
    runHook({ TOKMIZER_NATIVE_EXEC: "0" });
    writeFileSync(join(root, "hooks", "hooks.json"), NODE_HOOKS.replace('node \\"${CLAUDE_PLUGIN_ROOT}/dist/hooks-host/pre-tool-use.js\\"', '\\"${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec\\" --pre-tool-use'));
    runHook();
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(ran)).toBe(false);
  });
});

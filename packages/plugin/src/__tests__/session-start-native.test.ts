import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const hookPath = join(here, "..", "..", "hooks", "on-session-start.mjs");
const NODE_HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks-host/pre-tool-use.js"' }] }] } });

let root: string;
let home: string;
let ran: string;

function runHook(env: Record<string, string> = {}, pluginRoot: string = root): void {
  execFileSync(process.execPath, [hookPath], {
    env: { ...process.env, TOKMIZER_HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot, TOKMIZER_CLAUDE_COMMANDS_DIR: join(home, "commands"), TOKMIZER_NETWORK: "0", ...env },
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

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "tkr-native-root-"));
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), NODE_HOOKS);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
  writeFileSync(join(dir, "scripts", "install-native.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(join(dir, "ran"))}, process.argv.slice(2).join(" ") + "\\n");`);
  return dir;
}

const markers = (): string[] => readdirSync(home).filter((name) => name.startsWith("native-attempt-"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-native-home-"));
  root = makeRoot();
  ran = join(root, "ran");
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
    expect(markers()).toHaveLength(1);
    expect(markers()[0]).toMatch(/^native-attempt-9\.9\.9-[0-9a-f]{12}$/);
    runHook();
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(ran, "utf8")).toBe("--native-only\n");
  });

  it("switches every plugin copy that shares the same state folder", async () => {
    const other = makeRoot();
    try {
      runHook();
      expect(await waitFor(ran)).toBe(true);
      runHook({}, other);
      expect(await waitFor(join(other, "ran"))).toBe(true);
      expect(markers()).toHaveLength(2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("tries again after six hours when the install is still launched by node, and clears stale markers", async () => {
    writeFileSync(join(home, "native-attempt-9.9.8"), "0");
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(join(home, "native-attempt-9.9.8"), old, old);
    runHook();
    expect(await waitFor(ran)).toBe(true);
    expect(markers()).toHaveLength(1);
    utimesSync(join(home, markers()[0]!), old, old);
    runHook();
    for (let i = 0; i < 50 && readFileSync(ran, "utf8") !== "--native-only\n--native-only\n"; i += 1) await new Promise((r) => setTimeout(r, 40));
    expect(readFileSync(ran, "utf8")).toBe("--native-only\n--native-only\n");
  });

  it("does nothing when the native launcher is turned off or already in use", async () => {
    runHook({ TOKMIZER_NATIVE_EXEC: "0" });
    writeFileSync(join(root, "hooks", "hooks.json"), NODE_HOOKS.replace('node \\"${CLAUDE_PLUGIN_ROOT}/dist/hooks-host/pre-tool-use.js\\"', '\\"${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec\\" --pre-tool-use'));
    runHook();
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(ran)).toBe(false);
  });
});

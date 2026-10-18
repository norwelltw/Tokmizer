import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const codex = process.env.TOKMIZER_CODEX_E2E_BIN;
const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const built = existsSync(join(pkg, "dist", "bin", "tkr.js"));

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-codex-e2e-")));
  mkdirSync(join(root, "home", ".codex"), { recursive: true });
  env = { PATH: process.env.PATH, HOME: join(root, "home"), CODEX_HOME: join(root, "home", ".codex"), TOKMIZER_HOME: join(root, "home", ".tokmizer"), CLAUDE_CONFIG_DIR: join(root, "home", ".claude"), TOKMIZER_TELEMETRY: "0" };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function marketplace(withCodexManifest: boolean): string {
  const mkt = join(root, withCodexManifest ? "mkt" : "mkt-legacy");
  const plugin = join(mkt, "tokmizer");
  for (const entry of [".claude-plugin", "hooks", "codex-hooks", "package.json", ...(withCodexManifest ? [".codex-plugin"] : [])]) cpSync(join(pkg, entry), join(plugin, entry), { recursive: true });
  mkdirSync(join(plugin, "dist", "bin"), { recursive: true });
  cpSync(join(pkg, "dist", "bin", "tkr-codex-hook.js"), join(plugin, "dist", "bin", "tkr-codex-hook.js"));
  mkdirSync(join(mkt, ".claude-plugin"), { recursive: true });
  writeFileSync(join(mkt, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "tokmizer", owner: { name: "Tokmizer" }, plugins: [{ name: "tokmizer", version: "0.0.0", source: "./tokmizer" }] }));
  return mkt;
}

function install(mkt: string) {
  for (const args of [["plugin", "marketplace", "add", mkt], ["plugin", "add", "tokmizer@tokmizer"]]) {
    const r = spawnSync(codex!, args, { env, cwd: root, encoding: "utf8", timeout: 60000 });
    expect(r.status, r.stderr).toBe(0);
  }
}

async function hooks(): Promise<{ eventName: string; command: string; pluginId?: string }[]> {
  const child = spawn(codex!, ["app-server"], { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const answers = new Map<number, (value: unknown) => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      answers.get(message.id)?.(message.result);
    }
  });
  const call = (id: number, method: string, params: unknown) => new Promise<unknown>((resolve) => {
    answers.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await call(1, "initialize", { clientInfo: { name: "tkr-e2e", version: "1" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const result = await call(2, "hooks/list", {}) as { data: { hooks: { eventName: string; command: string; pluginId?: string }[] }[] };
    return result.data.flatMap((d) => d.hooks);
  } finally {
    child.kill();
  }
}

describe.skipIf(!codex || !built || process.platform === "win32")("Codex plugin install with the real codex CLI", () => {
  it("loads only the Codex hook from the Tokmizer plugin", async () => {
    install(marketplace(true));
    const found = (await hooks()).filter((h) => h.pluginId === "tokmizer@tokmizer");
    expect(found.map((h) => h.eventName)).toEqual(["preToolUse"]);
    expect(found[0]!.command).toContain("dist/bin/tkr-codex-hook.js");
    const doctor = spawnSync(process.execPath, [join(pkg, "dist", "bin", "tkr.js"), "doctor"], { env, cwd: root, encoding: "utf8", timeout: 60000 });
    expect(doctor.stdout).toContain("Codex:    hook installed");
    expect(doctor.stdout).not.toContain("made for another agent");
  }, 120000);

  it("without the Codex manifest Codex falls back to the Claude hooks, and tkr doctor --fix turns them off", async () => {
    install(marketplace(false));
    expect((await hooks()).filter((h) => h.pluginId === "tokmizer@tokmizer").map((h) => h.eventName)).toContain("postToolUse");
    const fix = spawnSync(process.execPath, [join(pkg, "dist", "bin", "tkr.js"), "doctor", "--fix"], { env, cwd: root, encoding: "utf8", timeout: 60000 });
    expect(fix.stdout).toContain("Turned off the old tokmizer@tokmizer Codex plugin");
    const after = await hooks();
    expect(after.filter((h) => h.pluginId === "tokmizer@tokmizer")).toEqual([]);
    expect(after.map((h) => h.command).filter((c) => c.includes("tkr-codex-hook"))).toHaveLength(1);
  }, 120000);
});

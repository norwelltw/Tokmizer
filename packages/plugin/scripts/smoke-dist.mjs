import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "tkr-dist-smoke-"));
const home = join(root, ".tokmizer");
mkdirSync(home);
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  TOKMIZER_HOME: home,
  TOKMIZER_AUTO_UPDATE: "0",
  TOKMIZER_NETWORK: "off"
};

function stopProcessors() {
  const run = join(home, "run");
  if (!existsSync(run)) return;
  for (const name of readdirSync(run).filter((entry) => entry.endsWith(".pid"))) {
    try {
      process.kill(Number(readFileSync(join(run, name), "utf8")), "SIGTERM");
    } catch {}
  }
}

try {
  const echoed = execFileSync(process.execPath, [join(directory, "dist", "bin", "tkr-exec.js"), "echo", "dist-smoke-ok"], { env, encoding: "utf8", timeout: 30000 });
  if (!echoed.includes("dist-smoke-ok")) throw new Error(`tkr-exec smoke printed: ${echoed}`);
  // Every `tkr-exec --flag` that hooks.json calls must answer, even when the
  // native launcher is absent (Claude Code plugin installs skip postinstall).
  const hooksJson = readFileSync(join(directory, "hooks", "hooks.json"), "utf8");
  const flags = [...new Set([...hooksJson.matchAll(/tkr-exec\\?"? (--[a-z-]+)/g)].map((m) => m[1]))];
  if (flags.length === 0) throw new Error("hooks.json calls no tkr-exec flag; update this smoke");
  for (const flag of flags) {
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "smoke", cwd: root, tool_name: "Bash", tool_input: { command: "git status" }, tool_response: { stdout: "ok" } });
    const r = spawnSync(join(directory, "dist", "bin", "tkr-exec"), [flag], { env, input: payload, encoding: "utf8", timeout: 30000 });
    if (r.status !== 0 || /ENOENT|spawn --|missing hook script/.test(r.stderr ?? "")) throw new Error(`tkr-exec ${flag} failed (${r.status}): ${r.stderr}`);
  }
  execFileSync(process.execPath, [join(directory, "dist", "bin", "tkr.js"), "help"], { env, stdio: ["ignore", "ignore", "inherit"], timeout: 30000 });
  console.log(`dist smoke: ok (hook flags: ${flags.join(", ")})`);
} finally {
  stopProcessors();
  rmSync(root, { recursive: true, force: true });
}

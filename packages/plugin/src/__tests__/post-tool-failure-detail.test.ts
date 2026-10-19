import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hook = join(pluginRoot, "dist", "hooks-host", "post-tool-use.js");
const failures = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "post", "vitest-failures.txt"), "utf8");

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tkr-post-fail-")));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seen(response: Record<string, unknown>): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("TOKMIZER_") && !k.startsWith("CLAUDE")) env[k] = v;
  const payload = { session_id: "s", cwd: home, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: response, tool_use_id: "toolu_1" };
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    env: { ...env, HOME: home, TOKMIZER_HOME: join(home, ".tokmizer"), CLAUDE_PLUGIN_ROOT: pluginRoot, TOKMIZER_NETWORK: "off" },
    encoding: "utf8",
    timeout: 10_000
  });
  expect(r.status).toBe(0);
  if (!r.stdout) return String(response.stdout);
  const out = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  return typeof out === "string" ? out : out.stdout;
}

describe("PostToolUse keeps every failed assertion of a test run", () => {
  it("when Claude Code reports how the command ended", () => {
    const out = seen({ stdout: failures, stderr: "", interrupted: false, isImage: false, returnCodeInterpretation: "Tests failed" });
    expect(out.match(/AssertionError/g)?.length).toBe(16);
  });

  it("when the payload does not say how the command ended", () => {
    const out = seen({ stdout: failures, stderr: "", interrupted: false, isImage: false });
    expect(out.match(/AssertionError/g)?.length).toBe(16);
  });
});

describe("PostToolUse and images", () => {
  it("leaves a response marked as an image untouched", () => {
    const image = `data:image/png;base64,${Array.from({ length: 1000 }, () => "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk").join("\n")}`;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("TOKMIZER_") && !k.startsWith("CLAUDE")) env[k] = v;
    const payload = { session_id: "s", cwd: home, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "cat shot.b64" }, tool_response: { stdout: image, stderr: "", interrupted: false, isImage: true }, tool_use_id: "toolu_2" };
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify(payload),
      env: { ...env, HOME: home, TOKMIZER_HOME: join(home, ".tokmizer"), CLAUDE_PLUGIN_ROOT: pluginRoot, TOKMIZER_NETWORK: "off" },
      encoding: "utf8",
      timeout: 10_000
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

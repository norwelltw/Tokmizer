import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encryptBundle } from "../bundle-crypto";
import { Settings } from "../contracts";
import { buildDefaultRules } from "../default-rules-build";
import { FilterDef } from "../engine/schema";
import { hostEnvVars } from "../host-detect";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const signingSecret = "modes-gating-test-fixture";
const raw = Array.from({ length: 100 }, (_, index) => `entry ${index}: useful output details ${index * 123}`).join("\n");
const routes = ["wrapper", "shim", "codex", "native"] as const;
type Route = typeof routes[number];
let home: string;
let defaultRules: string;

beforeAll(async () => {
  defaultRules = await buildDefaultRules();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-modes-"));
  writeFileSync(join(home, "state.json"), JSON.stringify({
    token: "tokmizer_modes_test",
    jwt: "modes-test-jwt",
    signingSecret,
    plan: "pro",
    status: "active",
    trialEndsAt: null,
    subEndsAt: null,
    jwtVersion: 1,
    installId: "modes-test-install",
    allowedFilters: ["modes-fixture"],
    lastHeartbeatOkAt: Date.now()
  }));
  seedFilters([FilterDef.parse({ slug: "modes-fixture", match_command: ".*", max_lines: 60, scale_with_level: true })]);
  writeFileSync(join(home, "daemon.spawn.fail"), String(Date.now()));
});

function seedFilters(filters: FilterDef[]) {
  const payload = encryptBundle(JSON.stringify({
    bundleVersion: 1,
    signedAt: Date.now(),
    filters
  }), signingSecret);
  writeFileSync(join(home, "bundle-cache.json"), JSON.stringify({
    payload,
    signature: sign(null, Buffer.from(payload), privateKey).toString("base64url"),
    enc: "v1",
    fetchedAt: Date.now()
  }));
}

function setAllowed(allowedFilters: string[]) {
  const path = join(home, "state.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), allowedFilters }));
}

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(route: Route, settings: Parameters<typeof Settings.parse>[0], yolo = false, nativePayload?: unknown): string {
  writeFileSync(join(home, "settings-cache.json"), JSON.stringify(Settings.parse(settings)));
  if (yolo) writeFileSync(join(home, "yolo-mode"), "on");
  const script = `process.stdout.write(${JSON.stringify(raw)})`;
  const target = route === "wrapper" ? "bin/tkr-exec.ts"
    : route === "shim" ? "bin/tkr-shim.ts"
      : route === "codex" ? "bin/tkr-codex-hook.ts" : "hooks-host/post-tool-use.ts";
  const args = route === "wrapper" || route === "shim" ? [process.execPath, "-e", script] : [];
  const input = route === "codex"
    ? JSON.stringify({ event: "after_tool_call", tool: "shell", command: "fixture", stdout: raw, exit_code: 0 })
    : route === "native"
      ? JSON.stringify(nativePayload ?? { tool_name: "Read", tool_input: { file_path: "fixture.txt" }, tool_response: { file: { content: raw } } }) : "";
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("packages/plugin/src", target), ...args], {
    encoding: "utf8",
    input,
    timeout: 10000,
    env: {
      ...process.env,
      ...Object.fromEntries([...hostEnvVars(true), ...hostEnvVars(false)].map((key) => [key, ""])),
      CURSOR_VERSION: "modes-test",
      TOKMIZER_HOME: home,
      TOKMIZER_BASE_URL: "http://127.0.0.1:1",
      TOKMIZER_AUTO_UPDATE: "0",
      TOKMIZER_DEV: "1",
      TOKMIZER_DEFAULT_RULES: defaultRules,
      TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM: publicPem,
      TOKMIZER_DAEMON_BIN: join(home, "disabled-daemon.js"),
      TOKMIZER_SHIM_STREAM_AFTER_MS: "0",
      TOKMIZER_CLAUDE_COMMANDS_DIR: join(home, "commands"),
      XDG_RUNTIME_DIR: ""
    }
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  if (route === "codex") {
    const response = JSON.parse(result.stdout);
    return response.action === "replace_output" ? response.replacement : raw;
  }
  if (route === "native") {
    if (!result.stdout) return raw;
    const updated = JSON.parse(result.stdout).hookSpecificOutput.updatedToolOutput;
    return typeof updated === "string" ? updated : updated.file.content;
  }
  return result.stdout;
}

describe.each(routes)("settings gate through the real %s route", (route) => {
  it.each(["normal", "compact", "minimal", "yolo"])("loads its signed filter and applies %s", (mode) => {
    const delivered = run(route, { outputVerbosity: mode === "yolo" ? "normal" : mode }, mode === "yolo");
    expect(Buffer.byteLength(delivered)).toBeLessThan(Buffer.byteLength(raw));
    expect(delivered).toContain("entry 0:");
    if (mode === "yolo") expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(256);
  });

  it.each([
    { enableAll: true, yolo: false },
    { enableAll: false, yolo: false },
    { enableAll: true, yolo: true },
    { enableAll: false, yolo: true }
  ])("honors explicit exclusions with enableAll=$enableAll and yolo=$yolo", ({ enableAll, yolo }) => {
    const delivered = run(route, {
      outputVerbosity: "minimal",
      filters: { enableAll, disabled: ["modes-fixture"] }
    }, yolo);
    expect(delivered).toBe(raw);
  });

  it("honors the global disabled setting even with YOLO enabled", () => {
    expect(run(route, { enabled: false }, true)).toBe(raw);
  });
});

describe.each(["normal", "compact", "minimal", "yolo"])("repeated native Bash gating in %s", (mode) => {
  beforeEach(() => {
    seedFilters([
      FilterDef.parse({ slug: "cat", match_command: "^cat ", max_lines: 60, scale_with_level: true }),
      FilterDef.parse({ slug: "bash-tool", match_command: "^bash-tool:", max_lines: 60, scale_with_level: true })
    ]);
  });

  it.each([
    { name: "excluded command and fallback", allowed: ["cat", "bash-tool"], disabled: ["cat", "bash-tool"], enabled: true, command: "cat report.txt" },
    { name: "empty server allowlist with fallback excluded", allowed: [], disabled: ["cat", "bash-tool"], enabled: true, command: "cat report.txt" },
    { name: "global disable", allowed: ["cat", "bash-tool"], disabled: [], enabled: false, command: "cat report.txt" },
    { name: "uncovered command", allowed: ["cat"], disabled: [], enabled: true, command: "uncovered report.txt" }
  ])("leaves both outputs unchanged for $name", ({ allowed, disabled, enabled, command }) => {
    setAllowed(allowed);
    const settings = { outputVerbosity: mode === "yolo" ? "normal" : mode, enabled, filters: { disabled } };
    const payload = { session_id: "repeated-gating", tool_name: "Bash", tool_input: { command }, tool_response: raw };
    expect(run("native", settings, mode === "yolo", payload)).toBe(raw);
    expect(run("native", settings, mode === "yolo", payload)).toBe(raw);
    expect(existsSync(join(home, "sessions", "repeated-gating.seen"))).toBe(false);
  });

  it.each([{ allowed: ["cat", "bash-tool"] }, { allowed: [] }])("preserves authorized repeat notices and restoration policy with allowlist $allowed", ({ allowed }) => {
    setAllowed(allowed);
    const settings = { outputVerbosity: mode === "yolo" ? "normal" : mode };
    const payload = { session_id: "authorized-repeat", tool_name: "Bash", tool_input: { command: "cat report.txt" }, tool_response: raw };
    expect(run("native", settings, mode === "yolo", payload)).not.toBe(raw);
    const repeated = run("native", settings, mode === "yolo", payload);
    expect(repeated).toContain("same output as `cat report.txt`");
    if (mode === "yolo") {
      expect(repeated).not.toContain("tkr restore");
      expect(existsSync(join(home, "content-cache"))).toBe(false);
    } else {
      const hash = /\[tkr restore ([0-9a-f]{16})\]/.exec(repeated)?.[1];
      expect(hash).toBeDefined();
      expect(readFileSync(join(home, "content-cache", hash!), "utf8")).toBe(raw);
    }
  });

  it("honors exclusions enabled after an earlier authorized output", () => {
    setAllowed(["cat", "bash-tool"]);
    const settings = { outputVerbosity: mode === "yolo" ? "normal" : mode };
    const payload = { session_id: "changed-exclusion", tool_name: "Bash", tool_input: { command: "cat report.txt" }, tool_response: raw };
    expect(run("native", settings, mode === "yolo", payload)).not.toBe(raw);
    expect(run("native", { ...settings, filters: { disabled: ["cat", "bash-tool"] } }, mode === "yolo", payload)).toBe(raw);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]) {
  return runWith({}, ...args);
}

function runWith(extra: Record<string, string>, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", resolve("packages/plugin/src/bin/tkr.ts"), ...args], {
    encoding: "utf8",
    input: "",
    timeout: 10000,
    env: {
      ...process.env,
      ...extra,
      CI: "1",
      TOKMIZER_HOME: dir,
      TOKMIZER_BASE_URL: "http://127.0.0.1:1",
      TOKMIZER_AUTO_UPDATE: "0",
      TOKMIZER_DAEMON_BIN: join(dir, "disabled-daemon.js"),
      TOKMIZER_CLAUDE_COMMANDS_DIR: join(dir, "commands"),
      XDG_RUNTIME_DIR: ""
    }
  });
}

function seedState(overrides: Record<string, unknown> = {}) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    token: "tokmizer_cli_test",
    jwt: "cli-test-jwt",
    signingSecret: "cli-test-signing-secret",
    plan: "pro",
    status: "active",
    trialEndsAt: null,
    subEndsAt: null,
    jwtVersion: 1,
    installId: "cli-test-install",
    linked: false,
    lastHeartbeatOkAt: 1,
    ...overrides
  }));
}

describe("CLI command outcomes", () => {
  it("deducts restored output from local net savings with telemetry disabled", () => {
    const content = "x".repeat(400);
    const hash = "0123456789abcdef";
    mkdirSync(join(dir, "content-cache"), { recursive: true });
    writeFileSync(join(dir, "content-cache", hash), content);
    writeFileSync(join(dir, "settings-cache.json"), JSON.stringify({ telemetryOptIn: false }));
    writeFileSync(join(dir, "stats.jsonl"), JSON.stringify({ t: Math.floor(Date.now() / 1000), r: 400, f: 40 }) + "\n");
    const restored = run("restore", hash);
    expect(restored.status).toBe(0);
    expect(restored.stdout).toBe(content);
    const gain = JSON.parse(run("gain", "--json").stdout);
    expect(gain.observed.savedTokens).toBe(-10);
    expect(gain.restoration).toMatchObject({ count: 1, tokens: 100 });
    expect(run("restore", hash).status).toBe(0);
    expect(JSON.parse(run("gain", "--json").stdout).observed.savedTokens).toBe(-110);
  });

  it.each(["--help", "-h"])("accepts the standard help option %s", (flag) => {
    const result = run(flag);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: tkr <command>");
    expect(result.stderr).toBe("");
  });

  it("keeps rejecting unknown commands", () => {
    const result = run("unknown-command");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
  });

  it.each([false, true])("reports a failed offline heartbeat with cached state %s", (cached) => {
    if (cached) seedState();
    const result = run("heartbeat");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Heartbeat failed");
    expect(result.stdout).not.toContain("OK plan=");
  });

  it.each([["--token"], ["invalid"], ["--unknown"]])("rejects malformed link arguments %j without prompting", (...args) => {
    const result = run("link", ...args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Usage: tkr link");
    expect(result.stdout).not.toContain("Paste your");
  });

  it.each([
    { args: ["--invalid"] },
    { args: ["--json", "--invalid"] },
    { args: ["--json", "--csv"] },
    { args: ["--day", "--week"] }
  ])("rejects invalid savings arguments $args instead of reporting an unrelated total", ({ args }) => {
    const result = run("gain", ...args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: tkr gain");
    expect(result.stdout).toBe("");
  });

  it("keeps machine-readable savings available without activation", () => {
    const result = run("gain", "--json");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ count: 0, savedTokens: 0 });
  });

  it.skipIf(process.platform === "win32")("does not report an anonymously enrolled device as account-linked", () => {
    seedState();
    const display = run("gain");
    expect(display.status).toBe(0);
    expect(display.stdout).toContain("Not linked: run tkr link");
  });

  it("reports available features consistently for a legacy smart token", () => {
    seedState({ plan: "smart", bonusActive: false });
    const result = run("status");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("power: available");
    expect(result.stdout).not.toContain("/power is not available");
  });

  it.each(["free", "smart", "pro"])("never names a plan in status for a %s token", (plan) => {
    seedState({ plan });
    const result = run("status");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Status /m);
    expect(result.stdout).not.toMatch(/\bplan\b|\bPlan\b|\bpro\b|\bsmart\b|\bfree\b|included on this token/i);
  });
});

describe("agent hook setup commands", () => {
  it("installs and removes the Cursor hook in a temporary home", () => {
    const home = { HOME: dir, USERPROFILE: dir };
    const added = runWith(home, "setup-cursor");
    expect(added.status).toBe(0);
    expect(added.stdout).toContain(`Added the tokmizer hook in ${join(dir, ".cursor", "hooks.json")}`);
    const file = JSON.parse(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8"));
    expect(file.version).toBe(1);
    expect(file.hooks.preToolUse[0].matcher).toBe("Shell");
    expect(file.hooks.preToolUse[0].command).toContain("tkr-cursor-hook");
    expect(runWith(home, "setup-cursor").stdout).toContain("Cursor hook already set");
    const removed = runWith(home, "setup-cursor", "--remove");
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain("Removed the tokmizer hook");
    expect(JSON.parse(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8")).hooks).toEqual({});
    expect(runWith(home, "setup-cursor", "--remove").stdout).toContain("No tokmizer hook found");
  });

  it("installs and removes the Gemini CLI hook without touching other settings", () => {
    const home = { GEMINI_CLI_HOME: dir };
    mkdirSync(join(dir, ".gemini"));
    writeFileSync(join(dir, ".gemini", "settings.json"), JSON.stringify({ theme: "GitHub" }));
    const added = runWith(home, "setup-gemini");
    expect(added.status).toBe(0);
    expect(added.stdout).toContain(`Added the tokmizer hook in ${join(dir, ".gemini", "settings.json")}`);
    const file = JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf8"));
    expect(file.theme).toBe("GitHub");
    expect(file.hooks.BeforeTool[0].matcher).toBe("run_shell_command");
    expect(file.hooks.BeforeTool[0].hooks[0].command).toContain("tkr-gemini-hook");
    const removed = runWith(home, "setup-gemini", "--remove");
    expect(removed.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf8"))).toEqual({ theme: "GitHub", hooks: {} });
  });

  it("doctor and discover switch Cursor and Gemini CLI from shim to native once their hook is installed", () => {
    const home = { HOME: dir, USERPROFILE: dir, GEMINI_CLI_HOME: dir, TOKMIZER_HOST: "cursor" };
    const before = runWith(home, "doctor");
    expect(before.status).toBe(0);
    expect(before.stdout).toContain("Adapter:  shell-shim — native hook available, run: tkr setup-cursor");
    const discoverBefore = runWith(home, "discover").stdout;
    expect(discoverBefore).toContain("Claude Code / Codex    ✅ optimized automatically");
    expect(discoverBefore).toContain("Your terminal          unchanged (optional: tkr shim global-path on)");
    expect(discoverBefore).not.toContain("tkr shim install");
    expect(discoverBefore).toMatch(/Cursor\s+⚠️ {2}not covered — run: tkr setup-cursor/);
    expect(discoverBefore).toMatch(/Gemini CLI\s+⚠️ {2}not covered — run: tkr setup-gemini/);
    expect(runWith(home, "setup-cursor").status).toBe(0);
    expect(runWith(home, "setup-gemini").status).toBe(0);
    const after = runWith(home, "doctor");
    expect(after.stdout).toContain("Adapter:  native-hooks\n");
    expect(after.stdout).toContain("Cursor:   hook installed");
    expect(after.stdout).toContain("Gemini:   hook installed");
    const discoverAfter = runWith(home, "discover").stdout;
    expect(discoverAfter).toMatch(/Cursor\s+✅ optimized automatically/);
    expect(discoverAfter).toMatch(/Gemini CLI\s+✅ optimized automatically/);
    expect(discoverAfter).not.toContain("setup-cursor");
  });

  it("rejects unknown setup flags and refuses an unreadable hooks file", () => {
    const home = { HOME: dir, USERPROFILE: dir };
    expect(runWith(home, "setup-cursor", "--bogus").status).toBe(1);
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(join(dir, ".cursor", "hooks.json"), "{ not json");
    const r = runWith(home, "setup-cursor");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("not valid JSON");
    expect(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8")).toBe("{ not json");
  });

  const agentHome = () => ({ HOME: dir, USERPROFILE: dir, COPILOT_HOME: "", QWEN_HOME: "", XDG_CONFIG_HOME: "" });
  const agents = [
    { cmd: "setup-copilot", label: "GitHub Copilot", bin: "tkr-copilot-hook", file: () => join(dir, ".copilot", "hooks", "tokmizer.json") },
    { cmd: "setup-droid", label: "Factory Droid", bin: "tkr-droid-hook", file: () => join(dir, ".factory", "hooks.json") },
    { cmd: "setup-trae", label: "Trae", bin: "tkr-trae-hook", file: () => join(dir, ".trae", "hooks.json") },
    { cmd: "setup-qwen", label: "Qwen Code", bin: "tkr-qwen-hook", file: () => join(dir, ".qwen", "settings.json") },
    { cmd: "setup-crush", label: "Crush", bin: "tkr-crush-hook", file: () => join(dir, ".config", "crush", "crush.json") },
    { cmd: "setup-junie", label: "Junie CLI", bin: "tkr-junie-hook", file: () => join(dir, ".junie", "config.json") }
  ];

  it.each(agents)("$cmd installs, detects and removes its hook without touching other settings", ({ cmd, label, bin, file }) => {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify({ keep: true }));
    const added = runWith(agentHome(), cmd);
    expect(added.status).toBe(0);
    expect(added.stdout).toContain(`Added the tokmizer hook in ${file()}`);
    expect(readFileSync(file(), "utf8")).toContain(bin);
    expect(JSON.parse(readFileSync(file(), "utf8")).keep).toBe(true);
    expect(runWith(agentHome(), cmd).stdout).toContain(`${label} hook already set`);
    const removed = runWith(agentHome(), cmd, "--remove");
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain(`Removed the tokmizer hook for ${label}`);
    expect(readFileSync(file(), "utf8")).not.toContain(bin);
    expect(JSON.parse(readFileSync(file(), "utf8")).keep).toBe(true);
    expect(runWith(agentHome(), cmd, "--remove").stdout).toContain(`No tokmizer hook found for ${label}`);
    expect(runWith(agentHome(), cmd, "--bogus").status).toBe(1);
  });

  it("refuses to rewrite an agent config it cannot parse", () => {
    mkdirSync(join(dir, ".qwen"));
    writeFileSync(join(dir, ".qwen", "settings.json"), "{ not json");
    const r = runWith(agentHome(), "setup-qwen");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("not valid JSON");
    expect(readFileSync(join(dir, ".qwen", "settings.json"), "utf8")).toBe("{ not json");
  });

  it("lists the JSON-hook agents in help, doctor and discover", () => {
    const home = { ...agentHome(), TOKMIZER_HOST: "trae" };
    expect(runWith(home, "help").stdout).toMatch(/setup-trae \[--remove\]\s+install or remove the Trae hook/);
    const before = runWith(home, "doctor").stdout;
    expect(before).toContain("Host:     trae (source: env)");
    expect(before).toContain("Adapter:  shell-shim — native hook available, run: tkr setup-trae");
    expect(before).toContain("Trae:     hook not installed — run: tkr setup-trae");
    expect(before).toContain("GitHub Copilot: hook not installed — run: tkr setup-copilot");
    expect(runWith(home, "discover").stdout).toMatch(/Factory Droid\s+⚠️ {2}not covered — run: tkr setup-droid/);
    expect(runWith(home, "setup-trae").status).toBe(0);
    expect(runWith(home, "setup-droid").status).toBe(0);
    const after = runWith(home, "doctor").stdout;
    expect(after).toContain("Adapter:  native-hooks\n");
    expect(after).toContain("Trae:     hook installed");
    const discover = runWith(home, "discover").stdout;
    expect(discover).toMatch(/Factory Droid\s+✅ optimized automatically/);
    expect(discover).toMatch(/Trae\s+✅ optimized automatically/);
    expect(discover).toMatch(/Junie CLI\s+⚠️ {2}not covered — run: tkr setup-junie/);
  });
});

describe("version", () => {
  it.each(["--version", "-v", "version"])("prints the plugin version for %s", (flag) => {
    const pkg = JSON.parse(readFileSync(resolve("packages/plugin/package.json"), "utf8")) as { version: string };
    const result = run(flag);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${pkg.version}\n`);
  });
});

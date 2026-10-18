import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SETUPS } from "../agent-plugins";
import { JSON_HOOK_AGENTS } from "../agent-hooks";
import { AGENT_PROBES, detectedAgents, parseSelection, runSetups, setupSummary } from "../setup-all";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tkrJs = join(pkg, "dist", "bin", "tkr.js");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-setup-all-"));
  vi.stubEnv("HOME", home);
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "COPILOT_HOME", "QWEN_HOME", "XDG_CONFIG_HOME", "VIBE_HOME", "PI_CODING_AGENT_DIR", "HERMES_HOME"]) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("detectedAgents", () => {
  it("finds agents by their config folder or their program on PATH, and nothing else", () => {
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "droid"), "#!/bin/sh\n");
    chmodSync(join(bin, "droid"), 0o755);
    writeFileSync(join(bin, "junie"), "not executable");
    const found = detectedAgents(process.platform === "win32" ? "" : bin).map((a) => a.id);
    expect(found).toEqual(process.platform === "win32" ? ["codex", "opencode"] : ["codex", "droid", "opencode"]);
    expect(detectedAgents("")).toHaveLength(2);
  });

  it("has a setup command for every probe", () => {
    expect(new Set(AGENT_PROBES.map((a) => a.command)).size).toBe(AGENT_PROBES.length);
    const known = ["setup-claude", "setup-codex", "setup-cursor", "setup-gemini", ...AGENT_SETUPS.map((a) => a.command), ...JSON_HOOK_AGENTS.map((a) => a.setup.replace(/^tkr /, ""))];
    expect(AGENT_PROBES.map((a) => a.command).sort()).toEqual(known.sort());
  });
});

describe("parseSelection", () => {
  it("reads all, none and numbers", () => {
    expect(parseSelection("", 3)).toEqual([0, 1, 2]);
    expect(parseSelection("all", 3)).toEqual([0, 1, 2]);
    expect(parseSelection(" none ", 3)).toEqual([]);
    expect(parseSelection("3, 1 3", 3)).toEqual([0, 2]);
    expect(parseSelection("4", 3)).toBeNull();
    expect(parseSelection("x", 3)).toBeNull();
  });
});

describe("runSetups", () => {
  it.skipIf(process.platform === "win32")("runs each setup command and summarises the result", () => {
    const fake = join(home, "fake-tkr.mjs");
    writeFileSync(fake, "const c = process.argv[2]; console.log(`ran ${c}`); process.exit(c === 'setup-cursor' ? 1 : 0);");
    const agents = AGENT_PROBES.filter((a) => a.id === "codex" || a.id === "cursor");
    const results = runSetups(agents, [process.execPath, fake]);
    expect(results.map((r) => [r.agent.id, r.ok, r.output])).toEqual([["codex", true, "ran setup-codex"], ["cursor", false, "ran setup-cursor"]]);
    const summary = setupSummary(results, [AGENT_PROBES.find((a) => a.id === "amp")!]);
    expect(summary).toContain("  Codex:    done — ran setup-codex");
    expect(summary).toContain("  Cursor:   FAILED — ran setup-cursor");
    expect(summary).toContain("  Not found, skipped: Amp");
  });
});

describe.skipIf(!existsSync(tkrJs) || process.platform === "win32")("tkr setup --all", () => {
  it("sets up every agent found, is idempotent, and leaves the others alone", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "Dracula" }));
    const env = { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, TOKMIZER_HOME: join(home, ".tokmizer"), TOKMIZER_TELEMETRY: "0", TOKMIZER_AUTO_UPDATE: "0" };
    const run = (...args: string[]) => spawnSync(process.execPath, [tkrJs, ...args], { env, cwd: home, encoding: "utf8", timeout: 120000 });
    expect(run("network", "off").status).toBe(0);
    const first = run("setup", "--all");
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/Cursor:\s+done/);
    expect(first.stdout).toMatch(/Gemini CLI:\s+done/);
    expect(first.stdout).toContain("Not found, skipped:");
    expect(readFileSync(join(home, ".cursor", "hooks.json"), "utf8")).toContain("tkr-cursor-hook");
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).theme).toBe("Dracula");
    expect(existsSync(join(home, ".codex"))).toBe(false);
    const before = readFileSync(join(home, ".cursor", "hooks.json"), "utf8");
    expect(run("setup", "--all").status).toBe(0);
    expect(readFileSync(join(home, ".cursor", "hooks.json"), "utf8")).toBe(before);
    const listed = run("setup");
    expect(listed.stdout).toContain("Run tkr setup --all");
    expect(run("setup", "--bogus").status).toBe(1);
  }, 180000);
});

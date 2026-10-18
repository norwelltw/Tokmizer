import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENT_SETUPS } from "../agent-plugins";
import { JSON_HOOK_AGENTS } from "../agent-hooks";

const TKR = resolve("packages/plugin/dist/bin/tkr.js");
const SETUPS = ["setup-codex", "setup-cursor", "setup-gemini", ...AGENT_SETUPS.map((a) => a.command), ...JSON_HOOK_AGENTS.map((a) => a.setup.slice(4))];

let dir: string;
let tk: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-bonuses-cli-"));
  tk = join(dir, ".tokmizer");
  mkdirSync(join(tk, "skills"), { recursive: true });
  writeFileSync(join(tk, "settings-cache.json"), JSON.stringify({ enabled: true, reducer: "balanced", telemetryOptIn: false, outputVerbosity: "compact", filters: { enableAll: true, disabled: [] } }));
  writeFileSync(join(tk, "state.json"), JSON.stringify({ token: "t", jwt: "j", signingSecret: "s", plan: "pro", status: "active", trialEndsAt: null, subEndsAt: null, jwtVersion: 1, installId: "i", lastHeartbeatOkAt: Date.now() }));
  writeFileSync(join(tk, "skills", "reducer-balanced.md"), "RULESET BALANCED");
  writeFileSync(join(tk, "skills", "power.md"), "POWER BODY");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tkr(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, TOKMIZER_HOME: tk, TOKMIZER_NETWORK: "0", TOKMIZER_AUTO_UPDATE: "0", TOKMIZER_DAEMON_BIN: join(dir, "disabled-daemon.js") };
  const r = spawnSync(process.execPath, [TKR, ...args], { env, encoding: "utf8", timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function userFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (p === tk) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

describe.skipIf(!existsSync(TKR))("tkr setup-<agent> installs /power and the reducer, uninstall removes them", () => {
  it("leaves no Tokmizer trace in agent files after tkr uninstall, and keeps user content", () => {
    const userRules = join(dir, ".vibe", "AGENTS.md");
    mkdirSync(dirname(userRules), { recursive: true });
    writeFileSync(userRules, "# mine\n");
    const codexHooks = join(dir, ".codex", "hooks.json");
    mkdirSync(dirname(codexHooks), { recursive: true });
    writeFileSync(codexHooks, "{}\n");
    writeFileSync(`${codexHooks}.tkr-bak`, "{}\n");
    writeFileSync(join(dir, ".codex", "notes.md.tkr-bak"), "mine\n");
    writeFileSync(join(dir, ".grok-AGENTS.md.tkr-bak"), "mine\n");
    for (const setup of SETUPS) {
      const r = tkr(setup);
      expect(r.status, `${setup}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    const all = userFiles(dir).filter((f) => !f.endsWith(".tkr-bak"));
    const text = all.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(text).toContain("tkr-context-hook");
    expect(text).toContain("managed-by: tokmizer");
    expect(readFileSync(userRules, "utf8")).toContain("RULESET BALANCED");
    expect(existsSync(join(dir, ".agents", "skills", "power", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".gemini", "commands", "power.toml"))).toBe(true);
    expect(existsSync(join(dir, ".config", "opencode", "commands", "power.md"))).toBe(true);
    const doctor = tkr("doctor");
    expect(doctor.stdout).toMatch(/\/power: .*Codex/);
    expect(doctor.stdout).toMatch(/Reducer: .*Mistral Vibe/);

    const again = SETUPS.map((s) => tkr(s));
    for (const r of again) expect(r.status).toBe(0);
    expect(userFiles(dir).filter((f) => !f.endsWith(".tkr-bak")).map((f) => readFileSync(f, "utf8")).join("\n")).toBe(text);

    expect(tkr("uninstall").status).toBe(0);
    for (const file of userFiles(dir)) {
      if (file.endsWith(".tkr-bak")) continue;
      const body = readFileSync(file, "utf8");
      expect(body, file).not.toContain("tkr-context-hook");
      expect(body, file).not.toContain("managed-by: tokmizer");
      expect(body, file).not.toContain("tokmizer:begin");
    }
    expect(readFileSync(userRules, "utf8")).toBe("# mine\n");
    expect(existsSync(join(dir, ".agents", "skills", "power"))).toBe(false);
    expect(userFiles(dir).filter((f) => f.endsWith(".tkr-bak")).sort()).toEqual([join(dir, ".codex", "notes.md.tkr-bak"), join(dir, ".grok-AGENTS.md.tkr-bak")].sort());
    expect(existsSync(join(tk, "backup", "config"))).toBe(false);
    expect(existsSync(join(tk, "reducer-rules.json"))).toBe(false);
    expect(existsSync(join(tk, "reducer-context.txt"))).toBe(false);
  }, 120000);

  it("tkr reducer <level> rewrites rules-file agents with the same ruleset", () => {
    expect(tkr("setup-junie").status).toBe(0);
    const rules = join(dir, ".junie", "AGENTS.md");
    expect(readFileSync(rules, "utf8")).toContain("RULESET BALANCED");
    writeFileSync(join(tk, "skills", "reducer-max.md"), "RULESET MAX");
    const r = tkr("reducer", "max");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(rules, "utf8")).toContain("RULESET MAX");
    expect(readFileSync(rules, "utf8")).not.toContain("RULESET BALANCED");
    expect(readFileSync(join(tk, "reducer-context.txt"), "utf8")).toBe("RULESET MAX");
    expect(tkr("reducer", "off").status).toBe(0);
    expect(existsSync(rules)).toBe(false);
    expect(existsSync(join(tk, "reducer-context.txt"))).toBe(false);
    expect(tkr("reducer", "max").status).toBe(0);
    expect(readFileSync(rules, "utf8")).toContain("RULESET MAX");
    expect(tkr("setup-junie", "--remove").status).toBe(0);
    expect(existsSync(join(dir, ".junie", "commands", "power.md"))).toBe(false);
    expect(existsSync(rules)).toBe(false);
  }, 60000);
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENT_BONUSES,
  agentBonus,
  installAgentBonuses,
  powerInstalled,
  reducerInstalled,
  removeAgentBonuses,
  renderPower,
  syncReducerRules,
  type AgentBonus
} from "../agent-bonuses";
import { codexHooksFile, ensureCodexHook, removeCodexHook } from "../codex-hooks";
import { geminiSettingsFile } from "../gemini-hooks";
import { cursorHooksFile, ensureCursorHook, removeCursorHook } from "../cursor-hooks";
import { copilotHooksFile, qwenSettingsFile, zcodeConfigFile } from "../agent-hooks";
import { antigravityHooksFile } from "../agent-command-hooks";
import { contextHookOutput, parseContextHookArgs } from "../context-hooks";
import { MANAGED_MARK } from "../managed-files";
import { configBackupFile } from "../config-backup";

const ENV = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "TOKMIZER_HOME", "CODEX_HOME", "GEMINI_CLI_HOME", "COPILOT_HOME", "QWEN_HOME", "VIBE_HOME"];
const saved: Record<string, string | undefined> = {};
let dir: string;
let tk: string;

const CONTEXT_JS = "/opt/tokmizer/dist/bin/tkr-context-hook.js";

function seedReducer(level: string, body: string): void {
  writeFileSync(join(tk, "settings-cache.json"), JSON.stringify({ enabled: true, reducer: level, telemetryOptIn: false, outputVerbosity: "compact", filters: { enableAll: true, disabled: [] } }));
  writeFileSync(join(tk, "state.json"), JSON.stringify({ token: "t", jwt: "j", signingSecret: "s", plan: "pro", status: "active", trialEndsAt: null, subEndsAt: null, jwtVersion: 1, installId: "i", lastHeartbeatOkAt: Date.now() }));
  mkdirSync(join(tk, "skills"), { recursive: true });
  writeFileSync(join(tk, "skills", `reducer-${level}.md`), body);
}

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "tok-bonuses-"));
  tk = join(dir, ".tokmizer");
  mkdirSync(tk, { recursive: true });
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.TOKMIZER_HOME = tk;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const seed = (file: string, data: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
};

const read = (file: string): string => readFileSync(file, "utf8");

function filesOf(bonus: AgentBonus): string[] {
  const out: string[] = [];
  if (!("none" in bonus.power)) out.push(bonus.power.file());
  const r = bonus.reducer;
  if (r.kind === "rules") out.push(r.file());
  if (r.kind === "hooks") out.push(...r.targets().map((t) => t.file));
  if (r.kind === "antigravity") out.push(antigravityHooksFile());
  return out;
}

function snapshot(files: string[]): Record<string, string | null> {
  return Object.fromEntries(files.map((f) => [f, existsSync(f) ? read(f) : null]));
}

describe("every agent: install, reinstall, remove", () => {
  for (const bonus of AGENT_BONUSES) {
    it(`${bonus.label} is idempotent and removes everything it added`, async () => {
      seedReducer("balanced", "RULES-BALANCED");
      const first = await installAgentBonuses(bonus.id, "", CONTEXT_JS);
      expect(first.error).toBe(false);
      const files = filesOf(bonus);
      const after = snapshot(files);
      if (!("none" in bonus.power)) expect(existsSync(bonus.power.file())).toBe(true);
      expect(powerInstalled(bonus)).toBe(!("none" in bonus.power) && !bonus.power.shared);
      expect(reducerInstalled(bonus)).toBe(bonus.reducer.kind !== "none" && bonus.reducer.kind !== "plugin");
      const second = await installAgentBonuses(bonus.id, "", CONTEXT_JS);
      expect(second.error).toBe(false);
      expect(snapshot(files)).toEqual(after);
      expect(await removeAgentBonuses(bonus.id)).toBe("removed");
      expect(powerInstalled(bonus)).toBe(false);
      expect(reducerInstalled(bonus)).toBe(false);
      expect(await removeAgentBonuses(bonus.id)).toBe("absent");
      if (!("none" in bonus.power)) expect(existsSync(bonus.power.file())).toBe(false);
    });
  }
});

describe("user content is never clobbered", () => {
  it("keeps user hooks and settings in a shared JSON config, then restores it on removal", async () => {
    const userGroup = { matcher: "startup", hooks: [{ type: "command", command: "./my-session.sh", timeout: 5 }] };
    const original = { model: "x", hooks: { SessionStart: [userGroup], PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "./guard.sh" }] }] } };
    seed(codexHooksFile(), original);
    await installAgentBonuses("codex", "", CONTEXT_JS);
    const installed = JSON.parse(read(codexHooksFile()));
    expect(installed.model).toBe("x");
    expect(installed.hooks.SessionStart[0]).toEqual(userGroup);
    expect(installed.hooks.SessionStart).toHaveLength(2);
    expect(installed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(JSON.parse(read(configBackupFile(codexHooksFile())))).toEqual(original);
    await removeAgentBonuses("codex");
    expect(JSON.parse(read(codexHooksFile()))).toEqual(original);
  });

  it("leaves a user's own power command alone and does not delete it", async () => {
    const file = join(dir, ".qwen", "commands", "power.md");
    seed(file, "my own power\n");
    const out = await installAgentBonuses("qwen-code", "", CONTEXT_JS);
    expect(out.lines.join("\n")).toContain("not Tokmizer's");
    expect(read(file)).toBe("my own power\n");
    await removeAgentBonuses("qwen-code");
    expect(read(file)).toBe("my own power\n");
  });

  it("refuses to touch an invalid JSON config", async () => {
    seed(qwenSettingsFile(), "{ not json");
    const out = await installAgentBonuses("qwen-code", "", CONTEXT_JS);
    expect(out.error).toBe(true);
    expect(read(qwenSettingsFile())).toBe("{ not json");
  });

  it("adds a removable managed block to a rules file without changing the user's text", async () => {
    seedReducer("max", "RULES-MAX line one\nline two");
    const file = join(dir, ".junie", "AGENTS.md");
    const user = "# My rules\n\nUse tabs.\n";
    seed(file, user);
    await installAgentBonuses("junie", "", CONTEXT_JS);
    const text = read(file);
    expect(text.startsWith(user.trimEnd())).toBe(true);
    expect(text).toContain("RULES-MAX line one\nline two");
    expect(read(configBackupFile(file))).toBe(user);
    await removeAgentBonuses("junie");
    expect(read(file)).toBe(user);
  });
});

describe("hardening", () => {
  it("ignores a quoted begin marker in the user's text", async () => {
    seedReducer("max", "RULES-MAX");
    const file = join(dir, ".vibe", "AGENTS.md");
    const user = "Notes: the marker <!-- tokmizer:begin managed-by: tokmizer --> is Tokmizer's.\n\nKeep this line.\n";
    seed(file, user);
    await installAgentBonuses("vibe", "", CONTEXT_JS);
    await syncReducerRules();
    expect(read(file)).toContain("Keep this line.");
    await removeAgentBonuses("vibe");
    expect(read(file)).toBe(user);
  });

  it("keeps an empty rules file the user already had", async () => {
    const file = join(dir, ".grok", "AGENTS.md");
    seed(file, "");
    await installAgentBonuses("grok", "", CONTEXT_JS);
    await removeAgentBonuses("grok");
    expect(existsSync(file)).toBe(true);
    expect(read(file)).toBe("");
  });

  it("does not delete a commands folder the user owns", async () => {
    const commands = join(dir, ".qwen", "commands");
    mkdirSync(commands, { recursive: true });
    await installAgentBonuses("qwen-code", "", CONTEXT_JS);
    await removeAgentBonuses("qwen-code");
    expect(existsSync(commands)).toBe(true);
  });

  it("skips /power when the Tokmizer folder path would be interpreted by the agent", async () => {
    process.env.TOKMIZER_HOME = join(dir, "odd!{x}");
    const out = await installAgentBonuses("gemini", "", CONTEXT_JS);
    expect(out.lines.join("\n")).toContain("/power: skipped");
    expect(existsSync(join(dir, ".gemini", "commands", "power.toml"))).toBe(false);
  });
});

describe("reducer follows tkr reducer", () => {
  it("rewrites rules blocks when the level changes, removes them when off and restores them when on", async () => {
    seedReducer("light", "RULES-LIGHT");
    await installAgentBonuses("vibe", "", CONTEXT_JS);
    await installAgentBonuses("grok", "", CONTEXT_JS);
    const vibe = join(dir, ".vibe", "AGENTS.md");
    const grok = join(dir, ".grok", "AGENTS.md");
    expect(read(vibe)).toContain("RULES-LIGHT");
    seedReducer("max", "RULES-MAX");
    expect((await syncReducerRules()).sort()).toEqual([grok, vibe].sort());
    expect(read(vibe)).toContain("RULES-MAX");
    expect(read(vibe)).not.toContain("RULES-LIGHT");
    expect(read(grok)).toContain("RULES-MAX");
    const user = "# Grok notes\n";
    writeFileSync(grok, `${user}\n${read(grok)}`);
    writeFileSync(join(tk, "settings-cache.json"), JSON.stringify({ enabled: true, reducer: "off" }));
    expect((await syncReducerRules()).sort()).toEqual([grok, vibe].sort());
    expect(existsSync(vibe)).toBe(false);
    expect(read(grok)).toBe(user);
    expect(existsSync(join(tk, "reducer-context.txt"))).toBe(false);
    expect(reducerInstalled(agentBonus("vibe")!)).toBe(true);
    expect(await syncReducerRules()).toEqual([]);
    seedReducer("light", "RULES-LIGHT");
    expect((await syncReducerRules()).sort()).toEqual([grok, vibe].sort());
    expect(read(vibe)).toContain("RULES-LIGHT");
    expect(read(grok).startsWith(user)).toBe(true);
    expect(read(join(tk, "reducer-context.txt"))).toBe("RULES-LIGHT");
    await removeAgentBonuses("vibe");
    await removeAgentBonuses("grok");
    expect(existsSync(vibe)).toBe(false);
    expect(read(grok)).toBe(user);
    expect(existsSync(join(tk, "reducer-rules.json"))).toBe(false);
  });

  it("keeps rules blocks and the context file when the ruleset is only temporarily unavailable", async () => {
    seedReducer("max", "RULES-MAX");
    await installAgentBonuses("grok", "", CONTEXT_JS);
    await syncReducerRules();
    const grok = join(dir, ".grok", "AGENTS.md");
    rmSync(join(tk, "skills", "reducer-max.md"));
    expect(await syncReducerRules()).toEqual([]);
    expect(read(grok)).toContain("RULES-MAX");
    expect(read(join(tk, "reducer-context.txt"))).toBe("RULES-MAX");
  });

  it("removes an untagged block only for the agent being removed and never adopts it for others", async () => {
    seedReducer("max", "RULES-MAX");
    const real = join(dir, "shared", "AGENTS.md");
    seed(real, "keep\n\n<!-- tokmizer:begin managed-by: tokmizer -->\nOLD\n<!-- tokmizer:end -->\n");
    mkdirSync(join(dir, ".grok"), { recursive: true });
    mkdirSync(join(dir, ".junie"), { recursive: true });
    symlinkSync(real, join(dir, ".grok", "AGENTS.md"));
    symlinkSync(real, join(dir, ".junie", "AGENTS.md"));
    expect(await syncReducerRules()).toEqual([]);
    expect(await removeAgentBonuses("junie")).toBe("removed");
    expect(read(real)).toBe("keep\n");
  });

  it("does not write a rules block while the reducer is off, then adds it when turned on", async () => {
    writeFileSync(join(tk, "settings-cache.json"), JSON.stringify({ enabled: true, reducer: "off" }));
    const out = await installAgentBonuses("amp", "", CONTEXT_JS);
    expect(out.error).toBe(false);
    const amp = join(dir, ".config", "amp", "AGENTS.md");
    expect(existsSync(amp)).toBe(false);
    seedReducer("max", "RULES-MAX");
    expect(await syncReducerRules()).toEqual([amp]);
    expect(read(amp)).toContain("RULES-MAX");
  });

  it("does not create rules files for agents that were never set up", async () => {
    seedReducer("max", "RULES-MAX");
    await syncReducerRules();
    expect(existsSync(join(dir, ".vibe", "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, ".config", "crush", "CRUSH.md"))).toBe(false);
  });

  it("registers hook commands that run the context hook with the agent's output format", async () => {
    await installAgentBonuses("gemini", "", CONTEXT_JS);
    const gemini = JSON.parse(read(geminiSettingsFile()));
    expect(gemini.hooks.SessionStart[0].hooks[0].command).toMatch(/tkr-context-hook gemini session$/);
    expect(gemini.hooks.BeforeAgent[0].hooks[0].command).toMatch(/tkr-context-hook gemini prompt$/);
    await installAgentBonuses("cursor", "", CONTEXT_JS);
    const cursor = JSON.parse(read(cursorHooksFile()));
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.sessionStart[0].command).toMatch(/tkr-context-hook cursor session$/);
    await installAgentBonuses("copilot", "", CONTEXT_JS);
    expect(JSON.parse(read(copilotHooksFile())).hooks.sessionStart[0].bash).toMatch(/tkr-context-hook copilot session$/);
    await installAgentBonuses("zcode", "", CONTEXT_JS);
    expect(JSON.parse(read(zcodeConfigFile())).hooks.events.UserPromptSubmit[0].hooks[0].command).toMatch(/tkr-context-hook hso prompt$/);
    await installAgentBonuses("antigravity", "", CONTEXT_JS);
    expect(JSON.parse(read(antigravityHooksFile()))["tokmizer-reducer"].SessionStart[0].command).toMatch(/tkr-context-hook antigravity session$/);
  });

  it("formats context for each agent", () => {
    expect(parseContextHookArgs(["hso", "session"])).toEqual({ format: "hso", kind: "session" });
    expect(parseContextHookArgs(["nope", "session"])).toBeNull();
    expect(parseContextHookArgs(["hso", "later"])).toBeNull();
    expect(JSON.parse(contextHookOutput("hso", "prompt", "X"))).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "X" } });
    expect(JSON.parse(contextHookOutput("gemini", "prompt", "X")).hookSpecificOutput.hookEventName).toBe("BeforeAgent");
    expect(JSON.parse(contextHookOutput("top", "session", "X"))).toEqual({ additionalContext: "X" });
    expect(JSON.parse(contextHookOutput("cursor", "session", "X"))).toEqual({ additional_context: "X" });
    expect(JSON.parse(contextHookOutput("antigravity", "session", "X"))).toEqual({ injectSteps: [{ systemMessage: { systemMessage: "X" } }] });
    expect(JSON.parse(contextHookOutput("copilot", "session", "X"))).toEqual({ additionalContext: "X", hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "X" } });
    expect(JSON.parse(contextHookOutput("copilot", "prompt", "X")).hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(contextHookOutput("plain", "session", "X")).toBe("X");
  });
});

describe("/power files", () => {
  it("points every agent at the same synced instructions and passes the request", () => {
    for (const bonus of AGENT_BONUSES) {
      if ("none" in bonus.power) continue;
      const text = renderPower(bonus.power);
      expect(text).toContain(MANAGED_MARK);
      expect(text).toContain(join(tk, "skills", "power.md"));
      expect(text).toContain("tkr heartbeat");
      expect(text).not.toMatch(/\.claude\/plugins\/cache|Cellar|_npx/);
      if (bonus.power.placeholder) expect(text).toContain(`Request: ${bonus.power.placeholder}`);
    }
  });

  it("writes Gemini commands as TOML with a literal prompt string", () => {
    const bonus = agentBonus("gemini")!;
    if ("none" in bonus.power) throw new Error("gemini has power");
    const text = renderPower(bonus.power);
    expect(text).toMatch(/^# managed-by: tokmizer\ndescription = ".+"\nprompt = ".+"\n$/);
    expect(JSON.parse(text.split("\n")[2]!.slice("prompt = ".length))).toContain("Request: {{args}}");
    expect(text).toContain("{{args}}");
  });

  it("writes skills with the name and description frontmatter", () => {
    const bonus = agentBonus("grok")!;
    if ("none" in bonus.power) throw new Error("grok has power");
    expect(renderPower(bonus.power)).toMatch(/^---\nname: power\ndescription: ".+"\nuser-invocable: true\n---\n/);
  });

  it("keeps the shared ~/.agents skill while another agent still uses it", async () => {
    await ensureCodexHook("/x/tkr-codex-hook");
    await ensureCursorHook("/x/tkr-cursor-hook");
    await installAgentBonuses("codex", "", CONTEXT_JS);
    await installAgentBonuses("cursor", "", CONTEXT_JS);
    expect(powerInstalled(agentBonus("codex")!)).toBe(true);
    expect(powerInstalled(agentBonus("copilot")!)).toBe(false);
    await removeCodexHook();
    const shared = join(dir, ".agents", "skills", "power", "SKILL.md");
    expect(existsSync(shared)).toBe(true);
    await removeAgentBonuses("codex");
    expect(existsSync(shared)).toBe(true);
    await removeCursorHook();
    await removeAgentBonuses("cursor");
    expect(existsSync(shared)).toBe(false);
    expect(existsSync(dirname(shared))).toBe(false);
  });

  it("uninstall removes the shared skill even with several agents registered", async () => {
    await installAgentBonuses("codex", "", CONTEXT_JS);
    await installAgentBonuses("droid", "", CONTEXT_JS);
    for (const b of AGENT_BONUSES) await removeAgentBonuses(b.id, true);
    expect(existsSync(join(dir, ".agents", "skills", "power", "SKILL.md"))).toBe(false);
  });
});

describe("rules files shared through symlinks", () => {
  const link = (target: string, path: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
  };

  it("keeps the block while another installed agent reads the same file, and tags it with every agent", async () => {
    seedReducer("max", "RULES-MAX");
    const real = join(dir, "shared", "AGENTS.md");
    const user = "# Shared rules\n";
    seed(real, user);
    link(real, join(dir, ".grok", "AGENTS.md"));
    link(real, join(dir, ".config", "amp", "AGENTS.md"));
    await installAgentBonuses("grok", "", CONTEXT_JS);
    await installAgentBonuses("amp", "", CONTEXT_JS);
    expect(read(real)).toContain("<!-- tokmizer:begin managed-by: tokmizer agents: amp,grok -->");
    expect(read(real).match(/RULES-MAX/g)).toHaveLength(1);
    expect(await removeAgentBonuses("grok")).toBe("removed");
    expect(read(real)).toContain("<!-- tokmizer:begin managed-by: tokmizer agents: amp -->");
    expect(read(real)).toContain("RULES-MAX");
    expect(reducerInstalled(agentBonus("amp")!)).toBe(true);
    seedReducer("light", "RULES-LIGHT");
    await syncReducerRules();
    expect(read(real)).toContain("RULES-LIGHT");
    expect(await removeAgentBonuses("amp")).toBe("removed");
    expect(read(real)).toBe(user);
    expect(lstatSync(join(dir, ".grok", "AGENTS.md")).isSymbolicLink()).toBe(true);
  });

  it("deletes a shared file Tokmizer created only when its last agent goes", async () => {
    seedReducer("max", "RULES-MAX");
    const real = join(dir, "shared", "AGENTS.md");
    mkdirSync(dirname(real), { recursive: true });
    link(real, join(dir, ".grok", "AGENTS.md"));
    link(real, join(dir, ".vibe", "AGENTS.md"));
    await installAgentBonuses("grok", "", CONTEXT_JS);
    await installAgentBonuses("vibe", "", CONTEXT_JS);
    await removeAgentBonuses("vibe");
    expect(read(real)).toContain("RULES-MAX");
    await removeAgentBonuses("grok");
    expect(existsSync(real)).toBe(false);
  });

  it("still removes the block when the other agent's file no longer points at it", async () => {
    seedReducer("max", "RULES-MAX");
    const real = join(dir, "shared", "AGENTS.md");
    seed(real, "keep\n");
    link(real, join(dir, ".grok", "AGENTS.md"));
    link(real, join(dir, ".vibe", "AGENTS.md"));
    await installAgentBonuses("grok", "", CONTEXT_JS);
    await installAgentBonuses("vibe", "", CONTEXT_JS);
    rmSync(join(dir, ".vibe", "AGENTS.md"));
    await removeAgentBonuses("grok");
    expect(read(real)).toBe("keep\n");
  });
});

describe("reducer context file for plugin agents", () => {
  it("is written atomically under TOKMIZER_HOME when the reducer is on and removed when off", async () => {
    seedReducer("balanced", "RULES-BALANCED");
    await installAgentBonuses("opencode", "", CONTEXT_JS);
    const file = join(tk, "reducer-context.txt");
    expect(read(file)).toBe("RULES-BALANCED");
    seedReducer("max", "RULES-MAX");
    await syncReducerRules();
    expect(read(file)).toBe("RULES-MAX");
    expect(readdirSync(tk).filter((f) => f.includes(".tmp-"))).toEqual([]);
    writeFileSync(join(tk, "settings-cache.json"), JSON.stringify({ enabled: true, reducer: "off" }));
    await syncReducerRules();
    expect(existsSync(file)).toBe(false);
  });
});

describe("config backups", () => {
  it("moves Tokmizer's old .tkr-bak, which holds the pre-Tokmizer original, into the backup folder", async () => {
    const original = { model: "x" };
    seed(codexHooksFile(), { model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/old/tkr-codex-hook" }] }] } });
    writeFileSync(`${codexHooksFile()}.tkr-bak`, JSON.stringify(original));
    await installAgentBonuses("codex", "", CONTEXT_JS);
    expect(JSON.parse(read(configBackupFile(codexHooksFile())))).toEqual(original);
    expect(existsSync(`${codexHooksFile()}.tkr-bak`)).toBe(false);
  });

  it("never replaces the user's copy with Tokmizer's own output across runs", async () => {
    seedReducer("light", "RULES-LIGHT");
    const file = join(dir, ".vibe", "AGENTS.md");
    seed(file, "# mine\n");
    await installAgentBonuses("vibe", "", CONTEXT_JS);
    for (const [level, body] of [["max", "RULES-MAX"], ["balanced", "RULES-BALANCED"]]) {
      seedReducer(level!, body!);
      await syncReducerRules();
    }
    expect(read(file)).toContain("RULES-BALANCED");
    expect(read(configBackupFile(file))).toBe("# mine\n");
  });

  it("keeps only the latest copy per file under the Tokmizer home with owner-only access", async () => {
    const original = { model: "x" };
    seed(codexHooksFile(), original);
    await installAgentBonuses("codex", "", CONTEXT_JS);
    const backup = configBackupFile(codexHooksFile());
    expect(backup.startsWith(join(tk, "backup", "config"))).toBe(true);
    expect(JSON.parse(read(backup))).toEqual(original);
    if (process.platform !== "win32") expect(statSync(backup).mode & 0o777).toBe(0o600);
    await removeAgentBonuses("codex");
    expect(JSON.parse(read(backup))).toEqual(original);
    await installAgentBonuses("codex", "", CONTEXT_JS);
    const edited = { ...JSON.parse(read(codexHooksFile())), theme: "dark" };
    seed(codexHooksFile(), edited);
    await removeAgentBonuses("codex");
    expect(JSON.parse(read(backup))).toEqual(edited);
    expect(readdirSync(join(tk, "backup", "config")).filter((f) => f.endsWith("hooks.json"))).toHaveLength(1);
  });

  it("leaves a .tkr-bak next to a file Tokmizer does not manage", async () => {
    const other = join(dir, ".codex", "other.json.tkr-bak");
    seed(other, "mine");
    seed(codexHooksFile(), {});
    await installAgentBonuses("codex", "", CONTEXT_JS);
    expect(read(other)).toBe("mine");
  });
});

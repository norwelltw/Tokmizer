import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configBackupFile } from "../config-backup";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { grokHooksFile, jsonHookAgent, jsonHookAgentForSetup, zcodeConfigFile } from "../agent-hooks";
import { buildAgentHookOutput } from "../adapters/json-agents";
import { parseRewriteArgs, rewriteForAgent } from "../agent-rewrite";
import { selectEntry } from "../single-entries";
import { KNOWN_HOSTS } from "../host-detect";

const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"];
let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-zcode-grok-"));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const seed = (file: string, data: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const noUsage = () => {};

describe("ZCode hook config", () => {
  const agent = jsonHookAgent("zcode");

  it("installs under hooks.events.PreToolUse with a Bash matcher, idempotently, and removes cleanly", async () => {
    expect(zcodeConfigFile()).toBe(join(dir, ".zcode", "cli", "config.json"));
    expect(agent.installed()).toBe(false);
    expect(await agent.ensure("/bin/tkr-zcode-hook")).toBe("added");
    expect(read(zcodeConfigFile())).toEqual({
      hooks: { enabled: true, events: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/bin/tkr-zcode-hook", timeoutMs: 10000 }] }] } }
    });
    expect(agent.installed()).toBe(true);
    expect(await agent.ensure("/bin/tkr-zcode-hook")).toBe("present");
    expect(await agent.ensure("/new/tkr-zcode-hook")).toBe("updated");
    expect(read(zcodeConfigFile()).hooks.events.PreToolUse).toHaveLength(1);
    expect(await agent.remove()).toBe("removed");
    expect(agent.installed()).toBe(false);
    expect(await agent.remove()).toBe("absent");
  });

  it("keeps user settings, user hooks and an explicit enabled flag", async () => {
    const userGroup = { matcher: "Edit", hooks: [{ type: "command", command: "./guard.sh", timeoutMs: 5000 }] };
    const original = { model: "glm-5", hooks: { enabled: false, events: { PreToolUse: [userGroup], Stop: [{ hooks: [{ type: "command", command: "./done.sh" }] }] } } };
    seed(zcodeConfigFile(), original);
    expect(await agent.ensure("/bin/tkr-zcode-hook")).toBe("added");
    const installed = read(zcodeConfigFile());
    expect(installed.model).toBe("glm-5");
    expect(installed.hooks.enabled).toBe(false);
    expect(installed.hooks.events.PreToolUse[0]).toEqual(userGroup);
    expect(installed.hooks.events.Stop).toEqual(original.hooks.events.Stop);
    expect(read(configBackupFile(zcodeConfigFile()))).toEqual(original);
    expect(await agent.remove()).toBe("removed");
    expect(read(zcodeConfigFile())).toEqual(original);
  });

  it("refuses files it cannot parse or whose hooks are not objects", async () => {
    seed(zcodeConfigFile(), "{ nope");
    expect(await agent.ensure("/bin/tkr-zcode-hook")).toBe("error");
    expect(readFileSync(zcodeConfigFile(), "utf8")).toBe("{ nope");
    seed(zcodeConfigFile(), { hooks: [] });
    expect(await agent.ensure("/bin/tkr-zcode-hook")).toBe("error");
    seed(zcodeConfigFile(), { hooks: { events: "x" } });
    expect(await agent.ensure("/bin/tkr-zcode-hook")).toBe("error");
  });

  it("answers ZCode's Claude-compatible payload with a full updatedInput", () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "git status", timeout: 30, description: "status" } };
    const out = JSON.parse(buildAgentHookOutput("zcode", payload, "tkr-exec", noUsage));
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "tkr-exec git status", timeout: 30, description: "status" } } });
    expect(buildAgentHookOutput("zcode", { ...payload, tool_name: "Read" }, "tkr-exec", noUsage)).toBe("{}");
    expect(buildAgentHookOutput("zcode", { ...payload, tool_input: { command: "sleep 9", run_in_background: true } }, "tkr-exec", noUsage)).toBe("{}");
    expect(buildAgentHookOutput("zcode", { ...payload, tool_input: { command: "cd /tmp" } }, "tkr-exec", noUsage)).toBe("{}");
  });
});

describe("Grok Build hook config", () => {
  const agent = jsonHookAgent("grok");

  it("writes its own hooks file in Claude format and removes it cleanly", async () => {
    expect(grokHooksFile()).toBe(join(dir, ".grok", "hooks", "tokmizer.json"));
    expect(await agent.ensure("/bin/tkr-grok-hook")).toBe("added");
    expect(read(grokHooksFile())).toEqual({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/bin/tkr-grok-hook", timeout: 10 }] }] } });
    expect(agent.installed()).toBe(true);
    expect(await agent.ensure("/bin/tkr-grok-hook")).toBe("present");
    expect(await agent.remove()).toBe("removed");
    expect(read(grokHooksFile())).toEqual({ hooks: {} });
    expect(agent.installed()).toBe(false);
  });

  it("keeps other hooks already in the file", async () => {
    const userGroup = { matcher: "Edit", hooks: [{ type: "command", command: "./fmt.sh" }] };
    seed(grokHooksFile(), { hooks: { PreToolUse: [userGroup] } });
    expect(await agent.ensure("/bin/tkr-grok-hook")).toBe("added");
    expect(read(grokHooksFile()).hooks.PreToolUse[0]).toEqual(userGroup);
    expect(await agent.remove()).toBe("removed");
    expect(read(grokHooksFile())).toEqual({ hooks: { PreToolUse: [userGroup] } });
  });

  it("rewrites the camelCase run_terminal_command payload and keeps other input fields", () => {
    const payload = { hook_event_name: "PreToolUse", sessionId: "g1", toolName: "run_terminal_command", toolInput: { command: "cargo test", cwd: "/w" } };
    const out = JSON.parse(buildAgentHookOutput("grok", payload, "tkr-exec", noUsage));
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "tkr-exec cargo test", cwd: "/w" } } });
    const snake = JSON.parse(buildAgentHookOutput("grok", { tool_name: "Bash", tool_input: { command: "git log" } }, "tkr-exec", noUsage));
    expect(snake.hookSpecificOutput.updatedInput.command).toBe("tkr-exec git log");
    expect(buildAgentHookOutput("grok", { toolName: "read_file", toolInput: { command: "git log" } }, "tkr-exec", noUsage)).toBe("{}");
    expect(buildAgentHookOutput("grok", { toolName: "run_terminal_command", toolInput: { command: "tkr-exec git log" } }, "tkr-exec", noUsage)).toBe("{}");
    expect(buildAgentHookOutput("grok", "garbage", "tkr-exec", noUsage)).toBe("{}");
  });
});

describe("new hosts are wired end to end", () => {
  it("resolves setup commands, single-binary entries and host names", () => {
    expect(jsonHookAgentForSetup("setup-zcode")?.id).toBe("zcode");
    expect(jsonHookAgentForSetup("setup-grok")?.id).toBe("grok");
    expect(selectEntry(["hook", "zcode"]).entry).toBe("tkr-zcode-hook");
    expect(selectEntry(["hook", "grok"]).entry).toBe("tkr-grok-hook");
    for (const host of ["zcode", "grok", "kilo"]) expect(KNOWN_HOSTS).toContain(host);
  });

  it("lets the Kilo Code plugin ask for a rewrite", () => {
    expect(parseRewriteArgs(["--host", "kilo", "--session", "k"])).toEqual({ host: "kilo", session: "k" });
    expect(rewriteForAgent("git status", "kilo", "k", "tkr-exec", noUsage)).toBe("tkr-exec git status");
  });
});

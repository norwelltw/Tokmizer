import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configBackupFile } from "../config-backup";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  JSON_HOOK_AGENTS,
  copilotHooksFile,
  crushConfigFile,
  droidHookTarget,
  jsonHookAgent,
  jsonHookAgentForSetup,
  junieConfigFile,
  qwenSettingsFile,
  traeHooksFiles,
  type JsonHookAgentId
} from "../agent-hooks";

const ENV_KEYS = ["HOME", "USERPROFILE", "COPILOT_HOME", "QWEN_HOME", "XDG_CONFIG_HOME"];
let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-json-agents-"));
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

const cases: { id: JsonHookAgentId; file: () => string; bin: string; hooks: (data: any) => unknown[]; ours: (data: any) => any }[] = [
  { id: "copilot", file: () => join(dir, ".copilot", "hooks", "tokmizer.json"), bin: "tkr-copilot-hook", hooks: (d) => d.hooks.PreToolUse, ours: (d) => d.hooks.PreToolUse.at(-1) },
  { id: "droid", file: () => join(dir, ".factory", "hooks.json"), bin: "tkr-droid-hook", hooks: (d) => d.PreToolUse, ours: (d) => d.PreToolUse.at(-1).hooks[0] },
  { id: "trae", file: () => join(dir, ".trae", "hooks.json"), bin: "tkr-trae-hook", hooks: (d) => d.hooks.PreToolUse, ours: (d) => d.hooks.PreToolUse.at(-1).hooks[0] },
  { id: "qwen-code", file: () => join(dir, ".qwen", "settings.json"), bin: "tkr-qwen-hook", hooks: (d) => d.hooks.PreToolUse, ours: (d) => d.hooks.PreToolUse.at(-1).hooks[0] },
  { id: "crush", file: () => join(dir, ".config", "crush", "crush.json"), bin: "tkr-crush-hook", hooks: (d) => d.hooks.PreToolUse, ours: (d) => d.hooks.PreToolUse.at(-1) },
  { id: "junie", file: () => join(dir, ".junie", "config.json"), bin: "tkr-junie-hook", hooks: (d) => d.hooks.PreToolUse, ours: (d) => d.hooks.PreToolUse.at(-1).hooks[0] }
];

describe.each(cases)("$id hook config", ({ id, file, bin, hooks, ours }) => {
  const agent = jsonHookAgent(id);

  it("installs idempotently, updates a moved entrypoint and removes cleanly", async () => {
    expect(agent.files()).toEqual([file()]);
    expect(agent.installed()).toBe(false);
    expect(await agent.ensure(`/bin/${bin}`)).toBe("added");
    expect(agent.installed()).toBe(true);
    expect(ours(read(file())).command).toBe(`/bin/${bin}`);
    expect(await agent.ensure(`/bin/${bin}`)).toBe("present");
    expect(await agent.ensure(`/new/${bin}`)).toBe("updated");
    expect(hooks(read(file()))).toHaveLength(1);
    expect(ours(read(file())).command).toBe(`/new/${bin}`);
    expect(await agent.remove()).toBe("removed");
    expect(agent.installed()).toBe(false);
    expect(await agent.remove()).toBe("absent");
  });

  it("keeps user hooks and settings and backs the file up once", async () => {
    const userHook = { type: "command", command: "./hooks/audit.sh" };
    const original = id === "droid"
      ? { PostToolUse: [{ matcher: "Edit", hooks: [userHook] }], SessionStart: [{ hooks: [userHook] }] }
      : { version: 1, theme: "dark", hooks: { PostToolUse: [{ matcher: "Edit", hooks: [userHook] }] } };
    seed(file(), original);
    expect(await agent.ensure(`/bin/${bin}`)).toBe("added");
    expect(read(configBackupFile(file()))).toEqual(original);
    const installed = read(file());
    if (id === "droid") expect(installed.SessionStart).toEqual(original.SessionStart);
    else expect(installed.theme).toBe("dark");
    expect(await agent.remove()).toBe("removed");
    expect(read(file())).toEqual(id === "droid" ? original : { ...original, hooks: { PostToolUse: (original as any).hooks.PostToolUse } });
    expect(read(configBackupFile(file()))).toEqual(original);
  });

  it("keeps a user's own PreToolUse hooks next to ours", async () => {
    const userGroup = id === "copilot" || id === "crush" ? { command: "./guard.sh" } : { matcher: "Edit", hooks: [{ type: "command", command: "./guard.sh" }] };
    seed(file(), id === "droid" ? { PreToolUse: [userGroup] } : { version: 1, hooks: { PreToolUse: [userGroup] } });
    expect(await agent.ensure(`/bin/${bin}`)).toBe("added");
    expect(hooks(read(file()))[0]).toEqual(userGroup);
    expect(await agent.remove()).toBe("removed");
    expect(hooks(read(file()))).toEqual([userGroup]);
  });

  it("refuses to overwrite a file it cannot parse", async () => {
    seed(file(), "{ not json");
    expect(await agent.ensure(`/bin/${bin}`)).toBe("error");
    expect(await agent.remove()).toBe("error");
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
    expect(agent.installed()).toBe(false);
  });

  it("resolves its setup command", () => {
    expect(jsonHookAgentForSetup(agent.setup.slice(4))).toBe(agent);
  });
});

describe("agent-specific entries", () => {
  it("writes one Copilot entry both VS Code and Copilot CLI accept", async () => {
    await jsonHookAgent("copilot").ensure("/bin/tkr-copilot-hook");
    expect(read(copilotHooksFile())).toEqual({
      version: 1,
      hooks: {
        PreToolUse: [
          { type: "command", command: "/bin/tkr-copilot-hook", bash: "/bin/tkr-copilot-hook", powershell: "/bin/tkr-copilot-hook", timeout: 10, timeoutSec: 10 }
        ]
      }
    });
  });

  it("follows COPILOT_HOME, QWEN_HOME and XDG_CONFIG_HOME", () => {
    process.env.COPILOT_HOME = join(dir, "cp");
    process.env.QWEN_HOME = join(dir, "qw");
    process.env.XDG_CONFIG_HOME = join(dir, "xdg");
    expect(copilotHooksFile()).toBe(join(dir, "cp", "hooks", "tokmizer.json"));
    expect(qwenSettingsFile()).toBe(join(dir, "qw", "settings.json"));
    expect(crushConfigFile()).toBe(join(dir, "xdg", "crush", "crush.json"));
    expect(junieConfigFile()).toBe(join(dir, ".junie", "config.json"));
  });

  it("matches each agent's shell tool", async () => {
    for (const agent of JSON_HOOK_AGENTS) await agent.ensure(`/bin/${agent.bin}`);
    expect(read(join(dir, ".factory", "hooks.json")).PreToolUse[0].matcher).toBe("Execute");
    expect(read(traeHooksFiles()[0]!).hooks.PreToolUse[0]).toEqual({ matcher: "RunCommand", hooks: [{ type: "command", command: "/bin/tkr-trae-hook", timeout: 30 }] });
    expect(read(qwenSettingsFile()).hooks.PreToolUse[0]).toEqual({
      matcher: "run_shell_command",
      hooks: [{ name: "tokmizer", type: "command", command: "/bin/tkr-qwen-hook", timeout: 10 }]
    });
    expect(read(crushConfigFile()).hooks.PreToolUse[0]).toEqual({ name: "tokmizer", matcher: "^bash$", command: "/bin/tkr-crush-hook", timeout: 10 });
    expect(read(junieConfigFile()).hooks.PreToolUse[0].matcher).toBe("^Bash$");
  });

  it("also manages Trae CN when its directory exists", async () => {
    mkdirSync(join(dir, ".trae-cn"));
    const trae = jsonHookAgent("trae");
    expect(trae.files()).toEqual([join(dir, ".trae", "hooks.json"), join(dir, ".trae-cn", "hooks.json")]);
    expect(await trae.ensure("/bin/tkr-trae-hook")).toBe("added");
    expect(read(join(dir, ".trae-cn", "hooks.json")).hooks.PreToolUse).toHaveLength(1);
    expect(await trae.remove()).toBe("removed");
    expect(read(join(dir, ".trae-cn", "hooks.json")).hooks).toEqual({});
  });

  it("refuses a Trae hooks.json with an unknown version", async () => {
    seed(join(dir, ".trae", "hooks.json"), { version: 2, hooks: {} });
    expect(await jsonHookAgent("trae").ensure("/bin/tkr-trae-hook")).toBe("error");
    expect(read(join(dir, ".trae", "hooks.json"))).toEqual({ version: 2, hooks: {} });
  });
});

describe("Factory Droid target file", () => {
  const droid = () => jsonHookAgent("droid");
  const root = () => join(dir, ".factory", "hooks.json");
  const legacy = () => join(dir, ".factory", "hooks", "hooks.json");
  const settings = () => join(dir, ".factory", "settings.json");
  const userGroup = { matcher: "Execute", hooks: [{ type: "command", command: "./guard.sh" }] };

  it("creates the root hooks.json when nothing exists", () => {
    expect(droidHookTarget().file).toBe(root());
  });

  it("uses settings.json when its PreToolUse hooks are live, so hooks.json never shadows them", async () => {
    seed(root(), { SessionStart: [] });
    seed(settings(), { model: "custom", hooks: { PreToolUse: [userGroup] } });
    expect(droidHookTarget().file).toBe(settings());
    expect(await droid().ensure("/bin/tkr-droid-hook")).toBe("added");
    const data = read(settings());
    expect(data.model).toBe("custom");
    expect(data.hooks.PreToolUse).toHaveLength(2);
    expect(read(root())).toEqual({ SessionStart: [] });
    expect(droid().installed()).toBe(true);
    expect(await droid().remove()).toBe("removed");
    expect(read(settings())).toEqual({ model: "custom", hooks: { PreToolUse: [userGroup] } });
  });

  it("prefers a hooks.json that already defines PreToolUse", () => {
    seed(root(), { PreToolUse: [userGroup] });
    seed(settings(), { hooks: { PreToolUse: [userGroup] } });
    expect(droidHookTarget().file).toBe(root());
  });

  it("patches the legacy hooks/hooks.json when the root file is absent", async () => {
    seed(legacy(), { PreToolUse: [userGroup] });
    expect(droidHookTarget().file).toBe(legacy());
    expect(await droid().ensure("/bin/tkr-droid-hook")).toBe("added");
    expect(existsSync(root())).toBe(false);
    expect(read(legacy()).PreToolUse).toHaveLength(2);
  });

  it("moves a stale copy out of a shadowed file", async () => {
    seed(settings(), { hooks: { PreToolUse: [{ matcher: "Execute", hooks: [{ type: "command", command: "/old/tkr-droid-hook" }] }] } });
    seed(root(), { PreToolUse: [userGroup] });
    expect(await droid().ensure("/bin/tkr-droid-hook")).toBe("added");
    expect(read(root()).PreToolUse).toHaveLength(2);
    expect(read(settings())).toEqual({ hooks: {} });
  });
});

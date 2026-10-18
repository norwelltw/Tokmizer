import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { hookCommandFor, isJsonObject, type HookInstall, type HookRemoval, type JsonObject } from "./hook-config";
import { ensureJsonHookIn, jsonHookInstalledIn, removeJsonHookFrom, type JsonHookSpec } from "./json-hooks";

export type JsonHookAgentId = "copilot" | "droid" | "trae" | "qwen-code" | "crush" | "junie" | "zcode" | "grok";

export type JsonHookAgent = {
  id: JsonHookAgentId;
  label: string;
  setup: string;
  bin: string;
  restart: string;
  files: () => string[];
  installed: () => boolean;
  ensure: (command: string) => Promise<HookInstall>;
  remove: () => Promise<HookRemoval>;
};

function home(): string {
  return os.homedir();
}

export function withVersion(parsed: JsonObject): boolean {
  if (parsed.version === undefined) parsed.version = 1;
  return parsed.version === 1;
}

function ensureAll(files: string[], spec: JsonHookSpec, command: string): Promise<HookInstall> {
  return Promise.all(files.map((f) => ensureJsonHookIn(f, spec, command))).then((all) =>
    all.includes("error") ? "error" : all.includes("updated") ? "updated" : all.includes("added") ? "added" : "present"
  );
}

function removeAll(files: string[], spec: JsonHookSpec): Promise<HookRemoval> {
  return Promise.all(files.map((f) => removeJsonHookFrom(f, spec))).then((all) =>
    all.includes("error") ? "error" : all.includes("removed") ? "removed" : "absent"
  );
}

function simpleAgent(base: Omit<JsonHookAgent, "installed" | "ensure" | "remove">, spec: JsonHookSpec): JsonHookAgent {
  return {
    ...base,
    installed: () => base.files().some((f) => jsonHookInstalledIn(f, spec)),
    ensure: (command) => ensureAll(base.files(), spec, command),
    remove: () => removeAll(base.files(), spec)
  };
}

const COPILOT_SPEC: JsonHookSpec = {
  mark: "tkr-copilot-hook",
  event: "PreToolUse",
  nested: true,
  entry: (command) => ({ type: "command", command, bash: command, powershell: command, timeout: 10, timeoutSec: 10 }),
  prepare: withVersion
};

export function copilotHooksFile(): string {
  return join(process.env.COPILOT_HOME || join(home(), ".copilot"), "hooks", "tokmizer.json");
}

const TRAE_SPEC: JsonHookSpec = {
  mark: "tkr-trae-hook",
  event: "PreToolUse",
  nested: true,
  matcher: "RunCommand",
  entry: (command) => ({ type: "command", command, timeout: 30 }),
  prepare: withVersion
};

export function traeHooksFiles(): string[] {
  const files = [join(home(), ".trae", "hooks.json")];
  if (existsSync(join(home(), ".trae-cn"))) files.push(join(home(), ".trae-cn", "hooks.json"));
  return files;
}

const QWEN_SPEC: JsonHookSpec = {
  mark: "tkr-qwen-hook",
  event: "PreToolUse",
  nested: true,
  matcher: "run_shell_command",
  entry: (command) => ({ name: "tokmizer", type: "command", command, timeout: 10 })
};

export function qwenSettingsFile(): string {
  return join(process.env.QWEN_HOME || join(home(), ".qwen"), "settings.json");
}

const CRUSH_SPEC: JsonHookSpec = {
  mark: "tkr-crush-hook",
  event: "PreToolUse",
  nested: true,
  entry: (command) => ({ name: "tokmizer", matcher: "^bash$", command, timeout: 10 })
};

export function crushConfigFile(): string {
  return join(process.env.XDG_CONFIG_HOME || join(home(), ".config"), "crush", "crush.json");
}

const JUNIE_SPEC: JsonHookSpec = {
  mark: "tkr-junie-hook",
  event: "PreToolUse",
  nested: true,
  matcher: "^Bash$",
  entry: (command) => ({ type: "command", command, timeout: 10 })
};

export function junieConfigFile(): string {
  return join(home(), ".junie", "config.json");
}

export function prepareZcode(parsed: JsonObject): boolean {
  if (parsed.hooks === undefined) parsed.hooks = {};
  if (!isJsonObject(parsed.hooks)) return false;
  if (parsed.hooks.enabled === undefined) parsed.hooks.enabled = true;
  return parsed.hooks.events === undefined || isJsonObject(parsed.hooks.events);
}

const ZCODE_SPEC: JsonHookSpec = {
  mark: "tkr-zcode-hook",
  event: "PreToolUse",
  nested: true,
  path: ["hooks", "events"],
  matcher: "Bash",
  entry: (command) => ({ type: "command", command, timeoutMs: 10000 }),
  prepare: prepareZcode
};

export function zcodeConfigFile(): string {
  return join(home(), ".zcode", "cli", "config.json");
}

const GROK_SPEC: JsonHookSpec = {
  mark: "tkr-grok-hook",
  event: "PreToolUse",
  nested: true,
  matcher: "Bash",
  entry: (command) => ({ type: "command", command, timeout: 10 })
};

export function grokHooksFile(): string {
  return join(home(), ".grok", "hooks", "tokmizer.json");
}

const DROID_MARK = "tkr-droid-hook";
const DROID_ROOT_SPEC: JsonHookSpec = {
  mark: DROID_MARK,
  event: "PreToolUse",
  nested: false,
  matcher: "Execute",
  entry: (command) => ({ type: "command", command, timeout: 10 })
};
const DROID_NESTED_SPEC: JsonHookSpec = { ...DROID_ROOT_SPEC, nested: true };

export type DroidFile = { file: string; spec: JsonHookSpec };

function droidDir(): string {
  return join(home(), ".factory");
}

export function droidFiles(): DroidFile[] {
  return [
    { file: join(droidDir(), "hooks.json"), spec: DROID_ROOT_SPEC },
    { file: join(droidDir(), "hooks", "hooks.json"), spec: DROID_ROOT_SPEC },
    { file: join(droidDir(), "settings.json"), spec: DROID_NESTED_SPEC }
  ];
}

function readObject(file: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function definesPreToolUse(parsed: JsonObject | null, nested: boolean): boolean {
  const box = nested ? parsed?.hooks : parsed;
  return isJsonObject(box) && Array.isArray(box.PreToolUse) && box.PreToolUse.length > 0;
}

export function droidHookTarget(): DroidFile {
  const [root, legacy, settings] = droidFiles() as [DroidFile, DroidFile, DroidFile];
  const live = existsSync(root.file) ? root : existsSync(legacy.file) ? legacy : null;
  if (live && definesPreToolUse(readObject(live.file), false)) return live;
  if (definesPreToolUse(readObject(settings.file), true)) return settings;
  return live ?? root;
}

const droid: JsonHookAgent = {
  id: "droid",
  label: "Factory Droid",
  setup: "tkr setup-droid",
  bin: "tkr-droid-hook",
  restart: "Restart Droid, then check it with /hooks.",
  files: () => [droidHookTarget().file],
  installed: () => droidFiles().some((d) => jsonHookInstalledIn(d.file, d.spec)),
  ensure: async (command) => {
    const target = droidHookTarget();
    const status = await ensureJsonHookIn(target.file, target.spec, command);
    if (status === "error") return status;
    await Promise.all(droidFiles().filter((d) => d.file !== target.file).map((d) => removeJsonHookFrom(d.file, d.spec)));
    return status;
  },
  remove: async () => {
    const all = await Promise.all(droidFiles().map((d) => removeJsonHookFrom(d.file, d.spec)));
    return all.includes("error") ? "error" : all.includes("removed") ? "removed" : "absent";
  }
};

export const JSON_HOOK_AGENTS: readonly JsonHookAgent[] = [
  simpleAgent(
    {
      id: "copilot",
      label: "GitHub Copilot",
      setup: "tkr setup-copilot",
      bin: "tkr-copilot-hook",
      restart: "Restart VS Code or Copilot CLI so they load the new hook.",
      files: () => [copilotHooksFile()]
    },
    COPILOT_SPEC
  ),
  droid,
  simpleAgent(
    {
      id: "trae",
      label: "Trae",
      setup: "tkr setup-trae",
      bin: "tkr-trae-hook",
      restart: "Restart Trae so it loads the new hook.",
      files: traeHooksFiles
    },
    TRAE_SPEC
  ),
  simpleAgent(
    {
      id: "qwen-code",
      label: "Qwen Code",
      setup: "tkr setup-qwen",
      bin: "tkr-qwen-hook",
      restart: "Restart Qwen Code, then check it with /hooks.",
      files: () => [qwenSettingsFile()]
    },
    QWEN_SPEC
  ),
  simpleAgent(
    {
      id: "crush",
      label: "Crush",
      setup: "tkr setup-crush",
      bin: "tkr-crush-hook",
      restart: "Restart Crush so it loads the new hook.",
      files: () => [crushConfigFile()]
    },
    CRUSH_SPEC
  ),
  simpleAgent(
    {
      id: "junie",
      label: "Junie CLI",
      setup: "tkr setup-junie",
      bin: "tkr-junie-hook",
      restart: "Restart Junie CLI so it loads the new hook.",
      files: () => [junieConfigFile()]
    },
    JUNIE_SPEC
  ),
  simpleAgent(
    {
      id: "zcode",
      label: "ZCode",
      setup: "tkr setup-zcode",
      bin: "tkr-zcode-hook",
      restart: "Restart ZCode so it loads the new hook.",
      files: () => [zcodeConfigFile()]
    },
    ZCODE_SPEC
  ),
  simpleAgent(
    {
      id: "grok",
      label: "Grok Build",
      setup: "tkr setup-grok",
      bin: "tkr-grok-hook",
      restart: "Restart Grok Build (1.0.4 or newer) so it loads the new hook.",
      files: () => [grokHooksFile()]
    },
    GROK_SPEC
  )
];

export function jsonHookAgent(id: JsonHookAgentId): JsonHookAgent {
  return JSON_HOOK_AGENTS.find((a) => a.id === id)!;
}

export function jsonHookAgentForSetup(cmd: string): JsonHookAgent | undefined {
  return JSON_HOOK_AGENTS.find((a) => a.setup === `tkr ${cmd}`);
}

export function agentHookCommand(agent: JsonHookAgent, pathEnv: string, installedJs: string): string {
  return hookCommandFor(agent.bin, pathEnv, installedJs);
}

import { existsSync, readFileSync } from "node:fs";
import { parseJsonText } from "./json-text";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { hookCommandFor, isJsonObject, resolveConfigPath, readJsonConfig, writeJsonConfig, writeTextPreserving, type HookInstall, type HookRemoval, type JsonObject } from "./hook-config";
import { ensureJsonHookIn, jsonHookInstalledIn, removeJsonHookFrom, type JsonHookSpec } from "./json-hooks";
import { codexHookInstalled, codexHooksFile } from "./codex-hooks";
import { geminiSettingsFile } from "./gemini-hooks";
import { cursorHookInstalled, cursorHooksFile } from "./cursor-hooks";
import { JSON_HOOK_AGENTS, copilotHooksFile, droidFiles, droidHookTarget, prepareZcode, qwenSettingsFile, traeHooksFiles, withVersion, zcodeConfigFile } from "./agent-hooks";
import { antigravityHooksFile } from "./agent-command-hooks";
import { CONTEXT_MARK, type ContextFormat } from "./context-hooks";
import { powerCommandBody, reducerContext, type ReducerContextKind } from "./bonuses";
import { reducerConfigured } from "./hooks-host/quick-settings";
import { MANAGED_MARK, blockAgents, blockBody, hasBlock, removeManagedFile, stripBlock, upsertBlock, writeManagedFile, type ManagedWrite } from "./managed-files";
import { reducerContextFile, reducerRulesStateFile, skillFile } from "./paths";
import { writeConfigText } from "./config-backup";
import { agentIntegrationInstalled, agentSetupForHost } from "./agent-plugins";

const home = (): string => os.homedir();
const piDir = (): string => process.env.PI_CODING_AGENT_DIR || join(home(), ".pi", "agent");
const xdgConfig = (): string => process.env.XDG_CONFIG_HOME || join(home(), ".config");

type PowerFormat = "skill" | "markdown" | "gemini-toml";
type PowerSpec = { file: () => string; format: PowerFormat; placeholder: string | null; front?: string[]; shared?: boolean; invoke: string };

type HookEvent = { event: string; kind: ReducerContextKind };
type HookTarget = { file: string; spec: (event: string) => JsonHookSpec };
type ReducerSpec =
  | { kind: "hooks"; format: ContextFormat; events: HookEvent[]; targets: () => HookTarget[]; cleanup?: () => HookTarget[]; note: string }
  | { kind: "antigravity"; note: string }
  | { kind: "rules"; file: () => string; note: string }
  | { kind: "plugin"; note: string }
  | { kind: "none"; note: string };

export type AgentBonus = { id: string; label: string; power: PowerSpec | { none: string }; reducer: ReducerSpec };


function sharedSkillFile(): string {
  return join(home(), ".agents", "skills", "power", "SKILL.md");
}

function skill(dir: () => string, invoke: string, extra: string[] = []): PowerSpec {
  return { file: () => join(dir(), "power", "SKILL.md"), format: "skill", placeholder: null, front: ["user-invocable: true", ...extra], invoke };
}

function sharedSkill(invoke: string): PowerSpec {
  return { ...skill(() => join(home(), ".agents", "skills"), invoke), shared: true };
}

function claudeShape(file: string, extra: Partial<JsonHookSpec> & { entry: JsonHookSpec["entry"] }, matcher: string | null = ""): HookTarget {
  return { file, spec: (event) => ({ mark: CONTEXT_MARK, event, nested: true, ...(matcher === null ? {} : { matcher }), ...extra }) };
}

const SESSION_AND_PROMPT: HookEvent[] = [
  { event: "SessionStart", kind: "session" },
  { event: "UserPromptSubmit", kind: "prompt" }
];

const DESCRIPTION = "Tokmizer power workflow: plan, execute, review, verify and wrap up a coding request with few tokens. Use only when the user explicitly asks for power.";

export const AGENT_BONUSES: readonly AgentBonus[] = [
  {
    id: "codex",
    label: "Codex",
    power: sharedSkill("$power <request> (or pick it in /skills)"),
    reducer: {
      kind: "hooks",
      format: "hso",
      events: SESSION_AND_PROMPT,
      targets: () => [claudeShape(codexHooksFile(), { entry: (command) => ({ type: "command", command, timeout: 10 }) })],
      note: "injected by a SessionStart and a UserPromptSubmit hook in hooks.json; approve them once in /hooks"
    }
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    power: { file: () => join(process.env.GEMINI_CLI_HOME || home(), ".gemini", "commands", "power.toml"), format: "gemini-toml", placeholder: "{{args}}", invoke: "/power <request>" },
    reducer: {
      kind: "hooks",
      format: "gemini",
      events: [{ event: "SessionStart", kind: "session" }, { event: "BeforeAgent", kind: "prompt" }],
      targets: () => [claudeShape(geminiSettingsFile(), { entry: (command) => ({ name: "tokmizer-reducer", type: "command", command, timeout: 10000 }) }, "*")],
      note: "injected by a SessionStart and a BeforeAgent hook in settings.json"
    }
  },
  {
    id: "cursor",
    label: "Cursor",
    power: sharedSkill("/power <request>"),
    reducer: {
      kind: "hooks",
      format: "cursor",
      events: [{ event: "sessionStart", kind: "session" }],
      targets: () => [claudeShape(cursorHooksFile(), { entry: (command) => ({ command, timeout: 10 }), prepare: withVersion }, null)],
      note: "injected by a sessionStart hook in hooks.json (Cursor has no per-prompt context hook)"
    }
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    power: sharedSkill("/power <request>"),
    reducer: {
      kind: "hooks",
      format: "copilot",
      events: [{ event: "sessionStart", kind: "session" }],
      targets: () => [claudeShape(copilotHooksFile(), { entry: (command) => ({ type: "command", command, bash: command, powershell: command, timeout: 10, timeoutSec: 10 }), prepare: withVersion }, null)],
      note: "injected by a sessionStart hook (Copilot drops per-prompt hook output)"
    }
  },
  {
    id: "droid",
    label: "Factory Droid",
    power: sharedSkill("/power <request>"),
    reducer: {
      kind: "hooks",
      format: "hso",
      events: SESSION_AND_PROMPT,
      targets: () => {
        const target = droidHookTarget();
        return [claudeShape(target.file, { nested: target.spec.nested, entry: (command) => ({ type: "command", command, timeout: 10 }) })];
      },
      cleanup: () => droidFiles().map((d) => claudeShape(d.file, { nested: d.spec.nested, entry: (command) => ({ type: "command", command, timeout: 10 }) })),
      note: "injected by a SessionStart and a UserPromptSubmit hook"
    }
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    power: { file: () => join(process.env.QWEN_HOME || join(home(), ".qwen"), "commands", "power.md"), format: "markdown", placeholder: "{{args}}", invoke: "/power <request>" },
    reducer: {
      kind: "hooks",
      format: "hso",
      events: SESSION_AND_PROMPT,
      targets: () => [claudeShape(qwenSettingsFile(), { entry: (command) => ({ name: "tokmizer-reducer", type: "command", command, timeout: 10 }) })],
      note: "injected by a SessionStart and a UserPromptSubmit hook in settings.json"
    }
  },
  {
    id: "crush",
    label: "Crush",
    power: sharedSkill("user:power from the command palette (ctrl+p)"),
    reducer: { kind: "rules", file: () => join(xdgConfig(), "crush", "CRUSH.md"), note: "written into a managed block of CRUSH.md (Crush has no session or prompt hook)" }
  },
  {
    id: "junie",
    label: "Junie CLI",
    power: { file: () => join(home(), ".junie", "commands", "power.md"), format: "markdown", placeholder: "$prompt", front: ["allowPromptArgument: true"], invoke: "/power <request>" },
    reducer: { kind: "rules", file: () => join(home(), ".junie", "AGENTS.md"), note: "written into a managed block of ~/.junie/AGENTS.md (Junie ignores session-start context)" }
  },
  {
    id: "zcode",
    label: "ZCode",
    power: skill(() => join(home(), ".zcode", "skills"), "/power <request>"),
    reducer: {
      kind: "hooks",
      format: "hso",
      events: SESSION_AND_PROMPT,
      targets: () => [{ file: zcodeConfigFile(), spec: (event) => ({ mark: CONTEXT_MARK, event, nested: true, path: ["hooks", "events"], matcher: "", entry: (command) => ({ type: "command", command, timeoutMs: 10000 }), prepare: prepareZcode }) }],
      note: "injected by a SessionStart and a UserPromptSubmit hook in config.json"
    }
  },
  {
    id: "trae",
    label: "Trae",
    power: { none: "Trae documents no file location for custom commands or skills" },
    reducer: {
      kind: "hooks",
      format: "plain",
      events: SESSION_AND_PROMPT,
      targets: () => traeHooksFiles().map((file) => claudeShape(file, { entry: (command) => ({ type: "command", command, timeout: 30 }), prepare: withVersion })),
      note: "injected by a SessionStart and a UserPromptSubmit hook in hooks.json"
    }
  },
  {
    id: "grok",
    label: "Grok Build",
    power: skill(() => join(home(), ".grok", "skills"), "/power <request>"),
    reducer: { kind: "rules", file: () => join(home(), ".grok", "AGENTS.md"), note: "written into a managed block of ~/.grok/AGENTS.md (Grok ignores the output of session and prompt hooks)" }
  },
  {
    id: "vibe",
    label: "Mistral Vibe",
    power: skill(() => join(process.env.VIBE_HOME || join(home(), ".vibe"), "skills"), "/power <request>"),
    reducer: { kind: "rules", file: () => join(process.env.VIBE_HOME || join(home(), ".vibe"), "AGENTS.md"), note: "written into a managed block of AGENTS.md (Vibe has no session or prompt hook)" }
  },
  {
    id: "opencode",
    label: "OpenCode",
    power: { file: () => join(xdgConfig(), "opencode", "commands", "power.md"), format: "markdown", placeholder: "$ARGUMENTS", invoke: "/power <request>" },
    reducer: { kind: "plugin", note: "added to the system prompt by the Tokmizer plugin (OpenCode's experimental.chat.system.transform plugin hook)" }
  },
  {
    id: "kilo",
    label: "Kilo Code",
    power: { file: () => join(xdgConfig(), "kilo", "commands", "power.md"), format: "markdown", placeholder: "$ARGUMENTS", invoke: "/power <request>" },
    reducer: { kind: "plugin", note: "added to the system prompt by the Tokmizer plugin (Kilo's experimental.chat.system.transform plugin hook)" }
  },
  {
    id: "amp",
    label: "Amp",
    power: sharedSkill("ask Amp to use the power skill (Amp has no custom slash commands)"),
    reducer: { kind: "rules", file: () => join(xdgConfig(), "amp", "AGENTS.md"), note: "written into a managed block of ~/.config/amp/AGENTS.md (Amp plugins can only append to each user message)" }
  },
  {
    id: "pi",
    label: "Pi",
    power: { file: () => join(piDir(), "prompts", "power.md"), format: "markdown", placeholder: "$ARGUMENTS", invoke: "/power <request> (run /reload first)" },
    reducer: { kind: "rules", file: () => join(piDir(), "APPEND_SYSTEM.md"), note: "written into a managed block of APPEND_SYSTEM.md, which Pi appends to its system prompt" }
  },
  {
    id: "omp",
    label: "Oh My Pi",
    power: { file: () => join(home(), ".omp", "agent", "commands", "power.md"), format: "markdown", placeholder: "$ARGUMENTS", invoke: "/power <request>" },
    reducer: { kind: "rules", file: () => join(home(), ".omp", "agent", "APPEND_SYSTEM.md"), note: "written into a managed block of APPEND_SYSTEM.md, which omp appends to its system prompt" }
  },
  {
    id: "hermes",
    label: "Hermes",
    power: skill(() => join(process.env.HERMES_HOME || join(home(), ".hermes"), "skills"), "/power <request>"),
    reducer: { kind: "plugin", note: "added as a system prompt section by the Tokmizer plugin (register_system_prompt_section)" }
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    power: skill(() => join(home(), ".openclaw", "skills"), "/power <request>"),
    reducer: { kind: "plugin", note: "added to the system prompt by the Tokmizer plugin's before_prompt_build hook, which OpenClaw only runs once you set plugins.entries.tokmizer.hooks.allowConversationAccess to true" }
  },
  {
    id: "antigravity",
    label: "Antigravity",
    power: skill(() => join(home(), ".gemini", "config", "skills"), "/power <request>"),
    reducer: { kind: "antigravity", note: "injected as a system message by a SessionStart hook in hooks.json" }
  }
];

export function agentBonus(id: string): AgentBonus | undefined {
  return AGENT_BONUSES.find((b) => b.id === id);
}

function frontmatter(lines: string[]): string {
  return ["---", ...lines, "---"].join("\n");
}

export function renderPower(spec: PowerSpec): string {
  const body = powerCommandBody(spec.placeholder);
  const marker = `<!-- ${MANAGED_MARK} -->`;
  if (spec.format === "gemini-toml") {
    return [`# ${MANAGED_MARK}`, `description = ${JSON.stringify(DESCRIPTION)}`, `prompt = ${JSON.stringify(body)}`, ""].join("\n");
  }
  const front = spec.format === "skill"
    ? frontmatter(["name: power", `description: ${JSON.stringify(DESCRIPTION)}`, ...(spec.front ?? [])])
    : frontmatter([`description: ${JSON.stringify(DESCRIPTION)}`, ...(spec.front ?? [])]);
  return `${front}\n\n${marker}\n\n${body}\n`;
}

function integrationActive(id: string): boolean {
  if (id === "codex") return codexHookInstalled();
  if (id === "cursor") return cursorHookInstalled();
  const json = JSON_HOOK_AGENTS.find((a) => a.id === id);
  if (json) return json.installed();
  const setup = agentSetupForHost(id);
  return setup ? agentIntegrationInstalled(setup) : false;
}

function otherSharedUsers(id: string): string[] {
  return AGENT_BONUSES.filter((b) => b.id !== id && !("none" in b.power) && b.power.shared && integrationActive(b.id)).map((b) => b.id);
}

const UNSAFE_PATH = /[\r\n]|!\{|@\{|\$\{|\{\{/;

async function installPower(bonus: AgentBonus): Promise<ManagedWrite | "none" | "unsafe"> {
  if ("none" in bonus.power) return "none";
  if (UNSAFE_PATH.test(skillFile("power"))) return "unsafe";
  return writeManagedFile(bonus.power.file(), renderPower(bonus.power));
}

async function removePower(bonus: AgentBonus, everything: boolean): Promise<HookRemoval> {
  if ("none" in bonus.power) return "absent";
  const spec = bonus.power;
  if (spec.shared && !everything && otherSharedUsers(bonus.id).length) return "absent";
  return removeManagedFile(spec.file(), spec.format === "skill");
}

function hookCommand(format: ContextFormat, kind: ReducerContextKind, pathEnv: string, contextJs: string): string {
  const base = `${hookCommandFor(CONTEXT_MARK, pathEnv, contextJs)} ${format} ${kind}`;
  return base.includes(CONTEXT_MARK) ? base : `${base} ${CONTEXT_MARK}`;
}

const ANTIGRAVITY_KEY = "tokmizer-reducer";

async function ensureAntigravityReducer(command: string): Promise<HookInstall> {
  const file = antigravityHooksFile();
  const parsed = await readJsonConfig(file);
  if (!parsed) return "error";
  const entry = { enabled: true, SessionStart: [{ type: "command", command, timeout: 10 }] };
  const existing = parsed[ANTIGRAVITY_KEY];
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(entry)) return "present";
  parsed[ANTIGRAVITY_KEY] = entry;
  return (await writeJsonConfig(file, parsed)) ? (existing === undefined ? "added" : "updated") : "error";
}

async function removeAntigravityReducer(): Promise<HookRemoval> {
  const file = antigravityHooksFile();
  if (!existsSync(file)) return "absent";
  const parsed = await readJsonConfig(file);
  if (!parsed) return "error";
  if (!(ANTIGRAVITY_KEY in parsed)) return "absent";
  delete parsed[ANTIGRAVITY_KEY];
  return (await writeJsonConfig(file, parsed)) ? "removed" : "error";
}

async function rulesBody(): Promise<string | null> {
  if (!reducerConfigured()) return "";
  try {
    const ctx = await reducerContext("session");
    return ctx ? ctx.text : null;
  } catch {
    return null;
  }
}

type RulesState = { agents: Record<string, string>; created: string[] };

function realPath(file: string): string {
  return resolveConfigPath(file);
}

function readRulesState(): RulesState {
  try {
    const parsed: unknown = parseJsonText(readFileSync(reducerRulesStateFile(), "utf8"));
    if (!isJsonObject(parsed)) return { agents: {}, created: [] };
    const agents = isJsonObject(parsed.agents) ? Object.fromEntries(Object.entries(parsed.agents).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
    const created = Array.isArray(parsed.created) ? parsed.created.filter((c): c is string => typeof c === "string") : [];
    return { agents, created };
  } catch {
    return { agents: {}, created: [] };
  }
}

async function saveRulesState(state: RulesState): Promise<boolean> {
  if (!Object.keys(state.agents).length && !state.created.length) {
    try {
      await unlink(reducerRulesStateFile());
    } catch {}
    return true;
  }
  return writeTextPreserving(reducerRulesStateFile(), `${JSON.stringify(state, null, 2)}\n`);
}

function rulesBonuses(): (AgentBonus & { reducer: { kind: "rules"; file: () => string } })[] {
  return AGENT_BONUSES.filter((b): b is AgentBonus & { reducer: { kind: "rules"; file: () => string } } => b.reducer.kind === "rules");
}

function agentsAt(real: string, state: RulesState, text: string | null): string[] {
  const named = new Set([...Object.keys(state.agents), ...(text === null ? [] : blockAgents(text))]);
  return rulesBonuses().filter((b) => named.has(b.id) && realPath(b.reducer.file()) === real).map((b) => b.id).sort();
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function replaceText(file: string, text: string | null, next: string): Promise<boolean> {
  return writeConfigText(file, next, text ?? undefined);
}

async function applyRules(file: string, body: string | null, state: RulesState): Promise<HookInstall | "removed"> {
  if (body === null) return "present";
  let text: string | null;
  try {
    text = await readText(file);
  } catch {
    return "error";
  }
  const real = realPath(file);
  if (!body) {
    const next = text === null ? null : stripBlock(text);
    if (next === null) return "present";
    if (!next.trim() && state.created.includes(real)) {
      try {
        await unlink(real);
        return "removed";
      } catch {
        return "error";
      }
    }
    return (await replaceText(file, text, next)) ? "removed" : "error";
  }
  const next = upsertBlock(text ?? "", body, agentsAt(real, state, text));
  if (next === text) return "present";
  return (await replaceText(file, text, next)) ? (text !== null && hasBlock(text) ? "updated" : "added") : "error";
}

async function installRules(bonus: AgentBonus, file: string): Promise<HookInstall> {
  const state = readRulesState();
  const real = realPath(file);
  if (!existsSync(file) && !state.created.includes(real)) state.created.push(real);
  state.agents[bonus.id] = file;
  const status = await applyRules(file, await rulesBody(), state);
  if (status === "error" || !(await saveRulesState(state))) return "error";
  return status === "removed" ? "updated" : status;
}

async function removeRules(bonus: AgentBonus, file: string): Promise<HookRemoval> {
  const state = readRulesState();
  const real = realPath(file);
  const tracked = bonus.id in state.agents;
  const created = state.created.includes(real);
  delete state.agents[bonus.id];
  let text: string | null;
  try {
    text = await readText(file);
  } catch {
    return "error";
  }
  const body = text === null ? null : blockBody(text);
  const tag = text === null ? [] : blockAgents(text);
  if (!tracked && (body === null || (tag.length && !tag.includes(bonus.id)))) return "absent";
  const remaining = agentsAt(real, state, text).filter((id) => id !== bonus.id);
  if (!remaining.length) state.created = state.created.filter((c) => c !== real);
  if (!(await saveRulesState(state))) return "error";
  if (text === null || body === null) return "removed";
  if (remaining.length) {
    const next = upsertBlock(text, body, remaining);
    if (next === text) return "removed";
    return (await replaceText(file, text, next)) ? "removed" : "error";
  }
  const next = stripBlock(text) ?? text;
  if (!next.trim() && created) {
    try {
      await unlink(real);
      return "removed";
    } catch {
      return "error";
    }
  }
  return (await replaceText(file, text, next)) ? "removed" : "error";
}

async function writeReducerContextFile(body: string | null): Promise<void> {
  if (body === null) return;
  const file = reducerContextFile();
  if (!body) {
    try {
      await unlink(file);
    } catch {}
    return;
  }
  try {
    if ((await readFile(file, "utf8")) === body) return;
  } catch {}
  await writeTextPreserving(file, body);
}

function combine(all: (HookInstall | HookRemoval)[]): string {
  if (all.includes("error")) return "error";
  for (const s of ["added", "updated", "removed"]) if (all.includes(s as HookInstall)) return s;
  return all.includes("present") ? "present" : "absent";
}

async function installReducer(bonus: AgentBonus, pathEnv: string, contextJs: string): Promise<HookInstall | "none" | "plugin"> {
  const r = bonus.reducer;
  if (r.kind === "none") return "none";
  if (r.kind === "plugin") {
    await writeReducerContextFile(await rulesBody());
    return "plugin";
  }
  if (r.kind === "rules") return installRules(bonus, r.file());
  if (r.kind === "antigravity") return ensureAntigravityReducer(hookCommand("antigravity", "session", pathEnv, contextJs));
  const results: HookInstall[] = [];
  const targets = r.targets();
  for (const target of targets) {
    for (const ev of r.events) results.push(await ensureJsonHookIn(target.file, target.spec(ev.event), hookCommand(r.format, ev.kind, pathEnv, contextJs)));
  }
  if (r.cleanup) {
    const keep = new Set(targets.map((t) => t.file));
    for (const other of r.cleanup().filter((t) => !keep.has(t.file))) {
      for (const ev of r.events) await removeJsonHookFrom(other.file, other.spec(ev.event));
    }
  }
  return combine(results) as HookInstall;
}

async function removeReducer(bonus: AgentBonus): Promise<HookRemoval> {
  const r = bonus.reducer;
  if (r.kind === "none" || r.kind === "plugin") return "absent";
  if (r.kind === "rules") return removeRules(bonus, r.file());
  if (r.kind === "antigravity") return removeAntigravityReducer();
  const results: HookRemoval[] = [];
  for (const target of r.cleanup ? r.cleanup() : r.targets()) {
    for (const ev of r.events) results.push(await removeJsonHookFrom(target.file, target.spec(ev.event)));
  }
  return combine(results) as HookRemoval;
}

export function reducerInstalled(bonus: AgentBonus): boolean {
  const r = bonus.reducer;
  if (r.kind === "rules") {
    if (bonus.id in readRulesState().agents) return true;
    try {
      return hasBlock(readFileSync(r.file(), "utf8"));
    } catch {
      return false;
    }
  }
  if (r.kind === "antigravity") {
    try {
      const parsed: unknown = parseJsonText(readFileSync(antigravityHooksFile(), "utf8"));
      return isJsonObject(parsed) && isJsonObject((parsed as JsonObject)[ANTIGRAVITY_KEY]);
    } catch {
      return false;
    }
  }
  if (r.kind === "plugin") {
    const setup = agentSetupForHost(bonus.id);
    return setup ? agentIntegrationInstalled(setup) : false;
  }
  if (r.kind !== "hooks") return false;
  return (r.cleanup ? r.cleanup() : r.targets()).some((t) => r.events.some((ev) => jsonHookInstalledIn(t.file, t.spec(ev.event))));
}

export function powerInstalled(bonus: AgentBonus): boolean {
  if ("none" in bonus.power) return false;
  if (bonus.power.shared && !integrationActive(bonus.id)) return false;
  try {
    return readFileSync(bonus.power.file(), "utf8").includes(MANAGED_MARK);
  } catch {
    return false;
  }
}

export async function installAgentBonuses(id: string, pathEnv: string, contextJs: string): Promise<{ lines: string[]; error: boolean }> {
  const bonus = agentBonus(id);
  if (!bonus) return { lines: [], error: false };
  const lines: string[] = [];
  let error = false;
  const power = await installPower(bonus).catch(() => "error" as const);
  if ("none" in bonus.power) lines.push(`/power: not available in ${bonus.label} (${bonus.power.none}).`);
  else if (power === "unsafe") lines.push(`/power: skipped, the Tokmizer folder path ${skillFile("power")} contains characters the agent would interpret.`);
  else if (power === "skipped") lines.push(`/power: ${bonus.power.file()} already exists and is not Tokmizer's; left it untouched.`);
  else if (power === "error") {
    error = true;
    lines.push(`/power: could not write ${bonus.power.file()}.`);
  } else lines.push(`/power: ${power === "present" ? "already set" : "added"} in ${bonus.power.file()}. Use it with: ${bonus.power.invoke}`);
  const reducer = await installReducer(bonus, pathEnv, contextJs).catch(() => "error" as const);
  if (reducer === "error") {
    error = true;
    lines.push(`Reducer: could not update the ${bonus.label} configuration.`);
  } else if (reducer === "none") lines.push(`Reducer: not available in ${bonus.label} (${bonus.reducer.note}).`);
  else lines.push(`Reducer: follows tkr reducer <off|light|balanced|max>; ${bonus.reducer.note}.`);
  return { lines, error };
}

export async function repairReducerHooks(id: string, pathEnv: string, contextJs: string): Promise<void> {
  const bonus = agentBonus(id);
  if (!bonus || bonus.reducer.kind === "rules" || !reducerInstalled(bonus)) return;
  await installReducer(bonus, pathEnv, contextJs).catch(() => null);
}

export async function removeAgentBonuses(id: string, everything = false): Promise<HookRemoval> {
  const bonus = agentBonus(id);
  if (!bonus) return "absent";
  const results = [await removePower(bonus, everything).catch(() => "error" as const), await removeReducer(bonus).catch(() => "error" as const)];
  return combine(results) as HookRemoval;
}

export async function syncReducerRules(): Promise<string[]> {
  const body = await rulesBody();
  await writeReducerContextFile(body);
  const state = readRulesState();
  let adopted = false;
  for (const bonus of rulesBonuses()) {
    if (bonus.id in state.agents) continue;
    try {
      const text = readFileSync(bonus.reducer.file(), "utf8");
      const tag = blockAgents(text);
      if (tag.includes(bonus.id)) {
        state.agents[bonus.id] = bonus.reducer.file();
        adopted = true;
      }
    } catch {}
  }
  if (adopted) await saveRulesState(state);
  const updated: string[] = [];
  const done = new Set<string>();
  for (const bonus of rulesBonuses()) {
    if (!(bonus.id in state.agents)) continue;
    const file = bonus.reducer.file();
    const real = realPath(file);
    if (done.has(real)) continue;
    done.add(real);
    const status = await applyRules(file, body, state).catch(() => "error" as const);
    if (status === "updated" || status === "added" || status === "removed") updated.push(file);
  }
  return updated;
}

export async function forgetReducerFiles(): Promise<void> {
  for (const file of [reducerContextFile(), reducerRulesStateFile()]) {
    try {
      await unlink(file);
    } catch {}
  }
}

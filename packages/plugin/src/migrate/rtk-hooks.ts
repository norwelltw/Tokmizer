import { claudeConfigDir } from "../claude-config-dir";
import { existsSync, readFileSync } from "node:fs";
import { parseJsonText } from "../json-text";
import { basename, join } from "node:path";
import { codexHookInstalled } from "../codex-hooks";
import { cursorHookInstalled } from "../cursor-hooks";
import { geminiHookInstalled, geminiSettingsFile } from "../gemini-hooks";
import { agentIntegrationInstalled, agentSetupForHost, type AgentSetupHost } from "../agent-plugins";
import { jsonHookAgent, type JsonHookAgentId } from "../agent-hooks";
import type { RtkEnv } from "./rtk-paths";

export type HookEdit = { file: string; action: "write" | "delete"; content?: string; what: string };

export type AgentFinding = {
  agent: string;
  tkrInstalled: boolean;
  tkrSetup: string;
  edits: HookEdit[];
  notes: string[];
};

type Json = Record<string, unknown>;

const RTK_INSTRUCTIONS = /<!-- rtk-instructions v2 -->[\s\S]*?<!-- \/rtk-instructions -->\n?/;
const PREFIX_RTK = /prefix (?:every|all|each)? ?(?:shell )?commands? with `?rtk`?/i;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shellWords(cmd: string): string[] {
  const words: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (const m of cmd.trim().matchAll(re)) words.push(m[1] ?? m[2] ?? m[3] ?? "");
  return words;
}

export function isRtkHookCommand(cmd: unknown, agent: string): boolean {
  if (typeof cmd !== "string") return false;
  if (/rtk-rewrite\.sh|rtk-hook-gemini\.sh/.test(cmd)) return true;
  const words = shellWords(cmd);
  if (words.length !== 3) return false;
  const program = basename(words[0]!.replace(/\\/g, "/")).toLowerCase();
  return (program === "rtk" || program === "rtk.exe") && words[1] === "hook" && words[2] === agent;
}

function readJson(file: string): Json | null {
  try {
    const parsed: unknown = parseJsonText(readFileSync(file, "utf8"));
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function stripList(list: unknown[], agent: string): { kept: unknown[]; removed: number } {
  let removed = 0;
  const kept: unknown[] = [];
  for (const item of list) {
    if (isObj(item) && Array.isArray(item.hooks)) {
      const hooks = item.hooks.filter((h) => !(isObj(h) && (h.type === undefined || h.type === "command") && isRtkHookCommand(h.command, agent)));
      const dropped = item.hooks.length - hooks.length;
      removed += dropped;
      if (dropped > 0 && hooks.length === 0) continue;
      kept.push(dropped > 0 ? { ...item, hooks } : item);
    } else if (isObj(item) && (item.type === undefined || item.type === "command") && isRtkHookCommand(item.command, agent)) {
      removed += 1;
    } else kept.push(item);
  }
  return { kept, removed };
}

function stripEvents(doc: Json, events: string[], agent: string): number {
  let removed = 0;
  for (const box of [doc, isObj(doc.hooks) ? doc.hooks : null]) {
    if (!box) continue;
    for (const event of events) {
      const list = box[event];
      if (!Array.isArray(list)) continue;
      const r = stripList(list, agent);
      if (r.removed === 0) continue;
      removed += r.removed;
      if (r.kept.length > 0) box[event] = r.kept;
      else delete box[event];
    }
  }
  if (removed > 0 && isObj(doc.hooks) && Object.keys(doc.hooks).length === 0) delete doc.hooks;
  return removed;
}

function jsonEdit(file: string, events: string[], agent: string, what: string): HookEdit | null {
  const doc = readJson(file);
  if (!doc) return null;
  const removed = stripEvents(doc, events, agent);
  return removed > 0 ? { file, action: "write", content: `${JSON.stringify(doc, null, 2)}\n`, what: `${what} (${removed} entr${removed === 1 ? "y" : "ies"})` } : null;
}

function markdownEdit(file: string, isImport: (line: string) => boolean, what: string): HookEdit | null {
  const text = readText(file);
  if (text === null) return null;
  const next = text.replace(RTK_INSTRUCTIONS, "").split("\n").filter((line) => !isImport(line.trim())).join("\n");
  return next !== text ? { file, action: "write", content: next, what } : null;
}

function deleteIf(file: string, test: (text: string) => boolean, what: string): HookEdit | null {
  const text = readText(file);
  return text !== null && test(text) ? { file, action: "delete", what } : null;
}

function vibeEdit(file: string): HookEdit | null {
  const text = readText(file);
  if (text === null) return null;
  const lines = text.split("\n");
  const sections: { start: number; end: number }[] = [];
  let start = -1;
  lines.forEach((line, i) => {
    if (/^\s*\[/.test(line)) {
      if (start >= 0) sections.push({ start, end: i });
      start = i;
    }
  });
  if (start >= 0) sections.push({ start, end: lines.length });
  const target = sections.find((s) => /^\s*\[\[hooks\]\]/.test(lines[s.start]!) && lines.slice(s.start, s.end).some((l) => /^\s*name\s*=\s*"rtk-rewrite"/.test(l)));
  if (!target) return null;
  const next = [...lines.slice(0, target.start), ...lines.slice(target.end)].join("\n");
  return { file, action: "write", content: next, what: "rtk [[hooks]] block" };
}

function antigravityEdit(file: string): HookEdit | null {
  const doc = readJson(file);
  if (!doc || !isObj(doc["rtk-rewrite"]) || doc["rtk-rewrite"].enabled === false) return null;
  doc["rtk-rewrite"] = { ...doc["rtk-rewrite"], enabled: false };
  return { file, action: "write", content: `${JSON.stringify(doc, null, 2)}\n`, what: "rtk-rewrite hook (set enabled = false)" };
}

const isRtkExtension = (text: string) => /["']rtk["']\s*,\s*\[\s*["']rewrite["']|rtk hook opencode|rtk rewrite/.test(text);

function setupInstalled(host: AgentSetupHost): boolean {
  const setup = agentSetupForHost(host);
  return setup ? agentIntegrationInstalled(setup) : false;
}

function jsonAgentInstalled(id: JsonHookAgentId): boolean {
  try {
    return jsonHookAgent(id).installed();
  } catch {
    return false;
  }
}

export function claudeDir(e: RtkEnv): string {
  return claudeConfigDir(e.env, e.home);
}

export function tokmizerInClaude(e: RtkEnv): boolean {
  const settings = readJson(join(claudeDir(e), "settings.json"));
  const enabled = settings && isObj(settings.enabledPlugins) ? settings.enabledPlugins : {};
  if (Object.entries(enabled).some(([k, v]) => k.startsWith("tokmizer@") && v !== false)) return true;
  const installed = readText(join(claudeDir(e), "plugins", "installed_plugins.json"));
  return installed !== null && installed.includes('"tokmizer@');
}

function claudeFinding(e: RtkEnv): AgentFinding {
  const dir = claudeDir(e);
  const settingsFile = join(dir, "settings.json");
  const edits = [
    jsonEdit(settingsFile, ["PreToolUse", "PostToolUse"], "claude", "rtk PreToolUse/PostToolUse hook"),
    jsonEdit(join(dir, "settings.local.json"), ["PreToolUse", "PostToolUse"], "claude", "rtk PreToolUse/PostToolUse hook"),
    markdownEdit(join(dir, "CLAUDE.md"), (l) => l.startsWith("@RTK.md"), "@RTK.md import and rtk instructions")
  ].filter((x): x is HookEdit => x !== null);
  const notes: string[] = [];
  const settings = readJson(settingsFile);
  const env = settings && isObj(settings.env) ? settings.env : {};
  if (typeof env.ANTHROPIC_BASE_URL === "string" && /127\.0\.0\.1|localhost/.test(env.ANTHROPIC_BASE_URL)) {
    notes.push(`rtk proxy is set in ${settingsFile} (env.ANTHROPIC_BASE_URL); left as is, with its SessionStart hook. It does not wrap commands. Remove both by hand if you stop using it.`);
  }
  return { agent: "Claude Code", tkrInstalled: tokmizerInClaude(e), tkrSetup: "install the tokmizer plugin in Claude Code", edits, notes };
}

function codexFinding(e: RtkEnv): AgentFinding {
  const dir = e.env.CODEX_HOME || join(e.home, ".codex");
  const edits = [
    jsonEdit(join(dir, "hooks.json"), ["PreToolUse"], "codex", "rtk PreToolUse hook"),
    markdownEdit(join(dir, "AGENTS.md"), (l) => l === "@RTK.md" || (l.startsWith("@") && l.endsWith("RTK.md")), "@RTK.md import and rtk instructions")
  ].filter((x): x is HookEdit => x !== null);
  return { agent: "Codex", tkrInstalled: codexHookInstalled(), tkrSetup: "tkr setup-codex", edits, notes: [] };
}

function geminiFinding(e: RtkEnv): AgentFinding {
  const edits = [jsonEdit(geminiSettingsFile(), ["BeforeTool"], "gemini", "rtk BeforeTool hook")].filter((x): x is HookEdit => x !== null);
  const notes: string[] = [];
  const md = join(e.home, ".gemini", "GEMINI.md");
  const text = readText(md);
  if (text && PREFIX_RTK.test(text)) notes.push(`${md} was written by rtk and tells Gemini to prefix commands with rtk. Edit or delete it.`);
  return { agent: "Gemini CLI", tkrInstalled: geminiHookInstalled(), tkrSetup: "tkr setup-gemini", edits, notes };
}

function droidFinding(e: RtkEnv): AgentFinding {
  const dir = e.env.FACTORY_HOME_OVERRIDE ? join(e.env.FACTORY_HOME_OVERRIDE, ".factory") : join(e.home, ".factory");
  const edits = [join(dir, "hooks.json"), join(dir, "hooks", "hooks.json"), join(dir, "settings.json")]
    .map((f) => jsonEdit(f, ["PreToolUse"], "droid", "rtk PreToolUse hook"))
    .filter((x): x is HookEdit => x !== null);
  return { agent: "Factory Droid", tkrInstalled: jsonAgentInstalled("droid"), tkrSetup: "tkr setup-droid", edits, notes: [] };
}

function traeFinding(e: RtkEnv): AgentFinding {
  const edits = [join(e.home, ".trae", "hooks.json"), join(e.home, ".trae-cn", "hooks.json")]
    .map((f) => jsonEdit(f, ["PreToolUse"], "trae", "rtk PreToolUse hook"))
    .filter((x): x is HookEdit => x !== null);
  return { agent: "Trae", tkrInstalled: jsonAgentInstalled("trae"), tkrSetup: "tkr setup-trae", edits, notes: [] };
}

function copilotFinding(e: RtkEnv): AgentFinding {
  const dir = e.env.COPILOT_HOME || join(e.home, ".copilot");
  const edits = [deleteIf(join(dir, "hooks", "rtk-rewrite.json"), (t) => t.includes("rtk hook copilot"), "rtk hook file")].filter((x): x is HookEdit => x !== null);
  const notes: string[] = [];
  const instructions = readText(join(dir, "copilot-instructions.md"));
  if (instructions && /rtk/i.test(instructions) && PREFIX_RTK.test(instructions)) {
    notes.push(`${join(dir, "copilot-instructions.md")} tells Copilot to prefix commands with rtk. Remove the rtk block.`);
  }
  return { agent: "GitHub Copilot", tkrInstalled: jsonAgentInstalled("copilot"), tkrSetup: "tkr setup-copilot", edits, notes };
}

function fileAgent(agent: string, host: AgentSetupHost, setup: string, edit: HookEdit | null): AgentFinding {
  return { agent, tkrInstalled: setupInstalled(host), tkrSetup: setup, edits: edit ? [edit] : [], notes: [] };
}

export function scanRtkHooks(e: RtkEnv): AgentFinding[] {
  const piDir = e.env.PI_CODING_AGENT_DIR || join(e.home, ".pi", "agent");
  const findings: AgentFinding[] = [
    claudeFinding(e),
    codexFinding(e),
    { agent: "Cursor", tkrInstalled: cursorHookInstalled(), tkrSetup: "tkr setup-cursor", edits: [jsonEdit(join(e.home, ".cursor", "hooks.json"), ["preToolUse"], "cursor", "rtk preToolUse hook")].filter((x): x is HookEdit => x !== null), notes: [] },
    geminiFinding(e),
    copilotFinding(e),
    droidFinding(e),
    traeFinding(e),
    fileAgent("Mistral Vibe", "vibe", "tkr setup-vibe", vibeEdit(join(e.home, ".vibe", "hooks.toml"))),
    fileAgent("Antigravity", "antigravity", "tkr setup-antigravity", antigravityEdit(join(e.home, ".gemini", "config", "plugins", "rtk", "hooks.json"))),
    fileAgent("OpenCode", "opencode", "tkr setup-opencode", deleteIf(join(e.home, ".config", "opencode", "plugins", "rtk.ts"), isRtkExtension, "rtk plugin")),
    fileAgent("Pi", "pi", "tkr setup-pi", deleteIf(join(piDir, "extensions", "rtk.ts"), isRtkExtension, "rtk extension")),
    fileAgent("Oh My Pi", "omp", "tkr setup-omp", deleteIf(join(e.home, ".omp", "agent", "extensions", "rtk.ts"), isRtkExtension, "rtk extension"))
  ];
  const hermes = join(e.env.HERMES_HOME || join(e.home, ".hermes"), "plugins", "rtk-rewrite");
  if (existsSync(hermes)) {
    findings.push({ agent: "Hermes", tkrInstalled: setupInstalled("hermes"), tkrSetup: "tkr setup-hermes", edits: [], notes: [`rtk plugin in ${hermes} is not changed automatically. Remove it with: rtk init --agent hermes --uninstall`] });
  }
  for (const rules of [".windsurfrules", ".clinerules", join(".kilocode", "rules", "rtk-rules.md")]) {
    const file = join(e.cwd, rules);
    const text = readText(file);
    if (text && PREFIX_RTK.test(text)) {
      findings.push({ agent: "Project rules", tkrInstalled: true, tkrSetup: "", edits: [], notes: [`${file} tells the agent to prefix commands with rtk. Remove that part.`] });
    }
  }
  return findings.filter((f) => f.edits.length > 0 || f.notes.length > 0);
}

export function doubleHooked(e: RtkEnv): string[] {
  return scanRtkHooks(e).filter((f) => f.tkrInstalled && f.edits.length > 0).map((f) => f.agent);
}

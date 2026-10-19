import { claudeConfigDir } from "./claude-config-dir";
import { accessSync, constants, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import os from "node:os";

export type AgentProbe = { id: string; label: string; command: string; dirs: () => string[]; bins: string[] };

const home = (): string => os.homedir();
const xdg = (): string => process.env.XDG_CONFIG_HOME || join(home(), ".config");

export const AGENT_PROBES: readonly AgentProbe[] = [
  { id: "claude", label: "Claude Code", command: "setup-claude", dirs: () => [claudeConfigDir(process.env, home())], bins: ["claude"] },
  { id: "codex", label: "Codex", command: "setup-codex", dirs: () => [process.env.CODEX_HOME || join(home(), ".codex")], bins: ["codex"] },
  { id: "cursor", label: "Cursor", command: "setup-cursor", dirs: () => [join(home(), ".cursor")], bins: ["cursor-agent", "cursor"] },
  { id: "gemini", label: "Gemini CLI", command: "setup-gemini", dirs: () => [join(process.env.GEMINI_CLI_HOME || home(), ".gemini", "settings.json")], bins: ["gemini"] },
  { id: "copilot", label: "GitHub Copilot", command: "setup-copilot", dirs: () => [process.env.COPILOT_HOME || join(home(), ".copilot")], bins: ["copilot"] },
  { id: "droid", label: "Factory Droid", command: "setup-droid", dirs: () => [join(home(), ".factory")], bins: ["droid"] },
  { id: "trae", label: "Trae", command: "setup-trae", dirs: () => [join(home(), ".trae"), join(home(), ".trae-cn")], bins: ["trae"] },
  { id: "qwen-code", label: "Qwen Code", command: "setup-qwen", dirs: () => [process.env.QWEN_HOME || join(home(), ".qwen")], bins: ["qwen"] },
  { id: "crush", label: "Crush", command: "setup-crush", dirs: () => [join(xdg(), "crush")], bins: ["crush"] },
  { id: "junie", label: "Junie CLI", command: "setup-junie", dirs: () => [join(home(), ".junie")], bins: ["junie"] },
  { id: "zcode", label: "ZCode", command: "setup-zcode", dirs: () => [join(home(), ".zcode")], bins: ["zcode"] },
  { id: "grok", label: "Grok Build", command: "setup-grok", dirs: () => [join(home(), ".grok")], bins: ["grok"] },
  { id: "opencode", label: "OpenCode", command: "setup-opencode", dirs: () => [join(xdg(), "opencode")], bins: ["opencode"] },
  { id: "kilo", label: "Kilo Code", command: "setup-kilo", dirs: () => [join(xdg(), "kilo")], bins: ["kilo"] },
  { id: "amp", label: "Amp", command: "setup-amp", dirs: () => [join(xdg(), "amp")], bins: ["amp"] },
  { id: "vibe", label: "Mistral Vibe", command: "setup-vibe", dirs: () => [process.env.VIBE_HOME || join(home(), ".vibe")], bins: ["vibe"] },
  { id: "antigravity", label: "Antigravity", command: "setup-antigravity", dirs: () => [join(home(), ".gemini", "antigravity"), join(home(), ".gemini", "config")], bins: ["antigravity", "agy"] },
  { id: "openclaw", label: "OpenClaw", command: "setup-openclaw", dirs: () => [join(home(), ".openclaw")], bins: ["openclaw"] },
  { id: "pi", label: "Pi", command: "setup-pi", dirs: () => [process.env.PI_CODING_AGENT_DIR || join(home(), ".pi")], bins: ["pi"] },
  { id: "omp", label: "Oh My Pi", command: "setup-omp", dirs: () => [join(home(), ".omp")], bins: ["omp"] },
  { id: "hermes", label: "Hermes", command: "setup-hermes", dirs: () => [process.env.HERMES_HOME || join(home(), ".hermes")], bins: ["hermes"] }
];

function onPath(bin: string, pathEnv: string): boolean {
  const names = process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        accessSync(join(dir, name), process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

export function detectedAgents(pathEnv: string = process.env.PATH ?? "", probes: readonly AgentProbe[] = AGENT_PROBES): AgentProbe[] {
  return probes.filter((p) => p.dirs().some((d) => existsSync(d)) || p.bins.some((b) => onPath(b, pathEnv)));
}

export type SetupResult = { agent: AgentProbe; ok: boolean; output: string };

export function runSetups(agents: readonly AgentProbe[], self: readonly string[]): SetupResult[] {
  return agents.map((agent) => {
    const r = spawnSync(self[0]!, [...self.slice(1), agent.command], { encoding: "utf8", env: process.env, timeout: 120000, windowsHide: true });
    return { agent, ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
  });
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

export function setupSummary(results: readonly SetupResult[], skipped: readonly AgentProbe[]): string[] {
  const width = Math.max(10, ...results.map((r) => r.agent.label.length + 2));
  return [
    "",
    "Summary:",
    ...results.map((r) => `  ${`${r.agent.label}:`.padEnd(width)}${r.ok ? "done" : "FAILED"}${firstLine(r.output) ? ` — ${firstLine(r.output)}` : ""}`),
    ...(skipped.length ? [`  Not found, skipped: ${skipped.map((a) => a.label).join(", ")}`] : []),
    "",
    "Restart each agent so it loads Tokmizer. In Codex, approve the Tokmizer hook once in /hooks.",
    ""
  ];
}

export function parseSelection(answer: string, count: number): number[] | null {
  const text = answer.trim().toLowerCase();
  if (!text || text === "all" || text === "a") return [...Array(count).keys()];
  if (text === "none" || text === "n" || text === "q") return [];
  const picked = new Set<number>();
  for (const word of text.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(word);
    if (!Number.isInteger(n) || n < 1 || n > count) return null;
    picked.add(n - 1);
  }
  return [...picked].sort((a, b) => a - b);
}

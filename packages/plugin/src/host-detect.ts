import { cursorHookInstalled } from "./cursor-hooks";
import { geminiHookInstalled } from "./gemini-hooks";
import { AGENT_SETUPS, agentIntegrationInstalled } from "./agent-plugins";
import { JSON_HOOK_AGENTS } from "./agent-hooks";

export type Host =
  | "claude-code"
  | "codex"
  | "cursor"
  | "cline"
  | "aider"
  | "gemini-cli"
  | "windsurf"
  | "copilot"
  | "opencode"
  | "amp"
  | "vibe"
  | "antigravity"
  | "openclaw"
  | "pi"
  | "omp"
  | "hermes"
  | "droid"
  | "trae"
  | "qwen-code"
  | "crush"
  | "junie"
  | "zcode"
  | "grok"
  | "kilo"
  | "shell";

export type HostInfo = {
  host: Host;
  source: "env" | "argv" | "fallback";
  os: "darwin" | "linux" | "win32" | "other";
  arch: string;
  shimRecommended: boolean;
};

const ENV_PROBES: { host: Host; vars: string[] }[] = [
  { host: "claude-code", vars: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE", "CLAUDE_CODE_VERSION", "ANTHROPIC_CLAUDE_CODE"] },
  { host: "codex", vars: ["CODEX_VERSION", "CODEX_CLI", "OPENAI_CODEX", "CODEX_THREAD_ID", "CODEX_SESSION_ID"] },
  { host: "cursor", vars: ["CURSOR_AGENT", "CURSOR_VERSION", "CURSOR_TRACE_ID"] },
  { host: "cline", vars: ["CLINE_VERSION", "CLINE_API_KEY"] },
  { host: "aider", vars: ["AIDER_VERSION", "AIDER_MODEL"] },
  { host: "qwen-code", vars: ["QWEN_CODE"] },
  { host: "gemini-cli", vars: ["GEMINI_CLI", "GEMINI_CLI_VERSION", "GEMINI_API_KEY"] },
  { host: "windsurf", vars: ["WINDSURF_VERSION", "WINDSURF_USER"] },
  { host: "copilot", vars: ["GITHUB_COPILOT_VERSION", "COPILOT_INTEGRATION_ID"] },
  { host: "opencode", vars: [] },
  { host: "amp", vars: [] },
  { host: "vibe", vars: [] },
  { host: "antigravity", vars: [] },
  { host: "openclaw", vars: [] },
  { host: "pi", vars: [] },
  { host: "omp", vars: [] },
  { host: "hermes", vars: [] },
  { host: "crush", vars: ["CRUSH"] },
  { host: "droid", vars: [] },
  { host: "trae", vars: [] },
  { host: "junie", vars: [] },
  { host: "zcode", vars: [] },
  { host: "grok", vars: [] },
  { host: "kilo", vars: [] }
];

export const KNOWN_HOSTS: readonly Host[] = [...ENV_PROBES.map((p) => p.host), "shell"];

const HOSTS_WITH_NATIVE_HOOKS = new Set<Host>(["claude-code", "codex"]);

const OPTIONAL_NATIVE_HOOKS: Partial<Record<Host, { installed: () => boolean; setup: string }>> = {
  cursor: { installed: cursorHookInstalled, setup: "tkr setup-cursor" },
  "gemini-cli": { installed: geminiHookInstalled, setup: "tkr setup-gemini" },
  ...Object.fromEntries(AGENT_SETUPS.map((a) => [a.host, { installed: () => agentIntegrationInstalled(a), setup: `tkr ${a.command}` }])),
  ...Object.fromEntries(JSON_HOOK_AGENTS.map((a) => [a.id, { installed: a.installed, setup: a.setup }]))
};

export function hostEnvVars(nativeHook: boolean): string[] {
  return ENV_PROBES.filter((p) => HOSTS_WITH_NATIVE_HOOKS.has(p.host) === nativeHook).flatMap((p) => p.vars);
}

export function hasNativeHook(host: Host): boolean {
  return HOSTS_WITH_NATIVE_HOOKS.has(host) || (OPTIONAL_NATIVE_HOOKS[host]?.installed() ?? false);
}

export function nativeHookSetupCommand(host: Host): string | null {
  const optional = OPTIONAL_NATIVE_HOOKS[host];
  return optional && !optional.installed() ? optional.setup : null;
}

export function hostOutputCapBytes(_host: Host): number | null {
  return null;
}

export function detectHost(env: NodeJS.ProcessEnv = process.env): HostInfo {
  const platform = process.platform;
  const os: HostInfo["os"] =
    platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other";
  const arch = process.arch;

  const explicit = env.TOKMIZER_HOST;
  if (explicit && KNOWN_HOSTS.includes(explicit as Host)) {
    const host = explicit as Host;
    return { host, source: "env", os, arch, shimRecommended: !hasNativeHook(host) };
  }

  for (const probe of ENV_PROBES) {
    if (probe.vars.some((v) => env[v])) {
      return {
        host: probe.host,
        source: "env",
        os,
        arch,
        shimRecommended: !hasNativeHook(probe.host)
      };
    }
  }

  return { host: "shell", source: "fallback", os, arch, shimRecommended: true };
}

export function detectHostFromArgv(argv: string[]): Host | null {
  const idx = argv.findIndex((a) => a === "--host");
  if (idx >= 0 && argv[idx + 1]) {
    const v = argv[idx + 1];
    if (KNOWN_HOSTS.includes(v as Host)) return v as Host;
  }
  return null;
}

export function adapterFor(host: Host): "native-hooks" | "shell-shim" {
  return hasNativeHook(host) ? "native-hooks" : "shell-shim";
}

import { readFile, rmdir, unlink } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { writeTextPreserving, type HookInstall, type HookRemoval } from "./hook-config";
import { removeShimFile, renderShim, shimInstalled, writeShimFile } from "./agent-shim-files";
import {
  antigravityHookInstalled,
  antigravityHooksFile,
  ensureAntigravityHook,
  ensureVibeHook,
  removeAntigravityHook,
  removeVibeHook,
  vibeHookInstalled,
  vibeHooksFile
} from "./agent-command-hooks";

export type AgentSetupHost = "opencode" | "kilo" | "amp" | "vibe" | "antigravity" | "openclaw" | "pi" | "omp" | "hermes";

type ShimFile = { template: string; target: string };
type ShimPlugin = { kind: "shim"; files: () => ShimFile[] };
type CommandHook = { kind: "hook"; file: () => string; installed: () => boolean; ensure: (command: string) => Promise<HookInstall>; remove: () => Promise<HookRemoval> };

export type AgentSetup = { host: AgentSetupHost; label: string; command: string; next: string } & (ShimPlugin | CommandHook);

const home = () => os.homedir();
const xdgConfig = () => process.env.XDG_CONFIG_HOME || join(home(), ".config");

export const AGENT_SETUPS: readonly AgentSetup[] = [
  {
    host: "opencode",
    label: "OpenCode",
    command: "setup-opencode",
    kind: "shim",
    files: () => [{ template: "opencode.js", target: join(xdgConfig(), "opencode", "plugins", "tokmizer.js") }],
    next: "Restart OpenCode so it loads the plugin."
  },
  {
    host: "kilo",
    label: "Kilo Code",
    command: "setup-kilo",
    kind: "shim",
    files: () => [{ template: "kilo.js", target: join(xdgConfig(), "kilo", "plugin", "tokmizer.js") }],
    next: "Restart Kilo Code (CLI or VS Code extension) so it loads the plugin."
  },
  {
    host: "amp",
    label: "Amp",
    command: "setup-amp",
    kind: "shim",
    files: () => [{ template: "amp.js", target: join(xdgConfig(), "amp", "plugins", "tokmizer.js") }],
    next: "Reload plugins in Amp (or restart it), then check it with: amp plugins list"
  },
  {
    host: "vibe",
    label: "Mistral Vibe",
    command: "setup-vibe",
    kind: "hook",
    file: vibeHooksFile,
    installed: vibeHookInstalled,
    ensure: ensureVibeHook,
    remove: removeVibeHook,
    next: "Restart Vibe so it reads hooks.toml."
  },
  {
    host: "antigravity",
    label: "Antigravity",
    command: "setup-antigravity",
    kind: "hook",
    file: antigravityHooksFile,
    installed: antigravityHookInstalled,
    ensure: ensureAntigravityHook,
    remove: removeAntigravityHook,
    next: "Restart Antigravity, then check it with /hooks."
  },
  {
    host: "openclaw",
    label: "OpenClaw",
    command: "setup-openclaw",
    kind: "shim",
    files: () => {
      const dir = join(home(), ".openclaw", "extensions", "tokmizer");
      return ["index.js", "openclaw.plugin.json", "package.json"].map((f) => ({ template: `openclaw/${f}`, target: join(dir, f) }));
    },
    next: "Run: openclaw plugins enable tokmizer && openclaw gateway restart"
  },
  {
    host: "pi",
    label: "Pi",
    command: "setup-pi",
    kind: "shim",
    files: () => [{ template: "pi.js", target: join(process.env.PI_CODING_AGENT_DIR || join(home(), ".pi", "agent"), "extensions", "tokmizer.js") }],
    next: "Restart Pi (or run /reload) so it loads the extension."
  },
  {
    host: "omp",
    label: "Oh My Pi",
    command: "setup-omp",
    kind: "shim",
    files: () => [{ template: "omp.js", target: join(home(), ".omp", "agent", "extensions", "tokmizer.js") }],
    next: "Restart omp so it loads the extension."
  },
  {
    host: "hermes",
    label: "Hermes",
    command: "setup-hermes",
    kind: "shim",
    files: () => {
      const dir = join(process.env.HERMES_HOME || join(home(), ".hermes"), "plugins", "tokmizer");
      return ["__init__.py", "plugin.yaml"].map((f) => ({ template: `hermes/${f}`, target: join(dir, f) }));
    },
    next: "Run: hermes plugins enable tokmizer, then restart Hermes (needs Hermes v2026.8.16 or newer)."
  }
];

export function agentSetupFor(command: string): AgentSetup | undefined {
  return AGENT_SETUPS.find((s) => s.command === command);
}

export function agentSetupForHost(host: string): AgentSetup | undefined {
  return AGENT_SETUPS.find((s) => s.host === host);
}

export function agentSetupTarget(setup: AgentSetup): string {
  return setup.kind === "hook" ? setup.file() : dirname(setup.files()[0]!.target);
}

export function agentIntegrationInstalled(setup: AgentSetup): boolean {
  return setup.kind === "hook" ? setup.installed() : shimInstalled(setup.files()[0]!.target);
}

async function writeCompanion(file: string, content: string): Promise<HookInstall> {
  try {
    if (existsSync(file) && (await readFile(file, "utf8")) === content) return "present";
    return (await writeTextPreserving(file, content)) ? "updated" : "error";
  } catch {
    return "error";
  }
}

export async function installAgentShim(setup: AgentSetup & ShimPlugin, templatesDir: string, argv: string[]): Promise<HookInstall> {
  const [main, ...companions] = setup.files();
  let status: HookInstall;
  try {
    status = await writeShimFile(main!.target, renderShim(await readFile(join(templatesDir, main!.template), "utf8"), argv));
  } catch {
    return "error";
  }
  if (status === "error") return status;
  for (const file of companions) {
    let companion: HookInstall;
    try {
      companion = await writeCompanion(file.target, await readFile(join(templatesDir, file.template), "utf8"));
    } catch {
      return "error";
    }
    if (companion === "error") return "error";
    if (companion === "updated" && status === "present") status = "updated";
  }
  return status;
}

export async function removeAgentShim(setup: AgentSetup & ShimPlugin): Promise<HookRemoval> {
  const [main, ...companions] = setup.files();
  const removed = await removeShimFile(main!.target);
  if (removed !== "removed") return removed;
  try {
    for (const file of companions) if (existsSync(file.target)) await unlink(file.target);
    if (companions.length) {
      const dir = dirname(main!.target);
      if (existsSync(dir) && readdirSync(dir).length === 0) await rmdir(dir);
    }
    return "removed";
  } catch {
    return "error";
  }
}

import { chmod, mkdir, readFile, writeFile, stat, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  skillsDir,
  skillFile,
  claudeCommandsDir,
  claudeCommandFile,
  bundleRefreshFile,
  managedCommandsFile,
  tokmizerHome
} from "./paths";

const MANAGED_MARKER = "managed-by: tokmizer";

export const STATIC_COMMAND_NAMES: readonly string[] = [
  "tkr", "tkr-gain", "tkr-status", "tkr-link", "tkr-unlink",
  "tkr-compression", "tkr-telemetry", "tkr-update", "tkr-yolo"
];

const LEGACY_SERVER_COMMAND_NAMES: readonly string[] = ["power", "tkr-reducer"];

async function readCommandRegistry(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(managedCommandsFile(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

async function writeCommandRegistry(names: string[]): Promise<void> {
  try {
    await mkdir(tokmizerHome(), { recursive: true, mode: 0o700 });
    await writeFile(managedCommandsFile(), JSON.stringify(names), { mode: 0o600 });
  } catch {}
}

const TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function maxAgeMs(): number {
  const raw = Number(process.env.TOKMIZER_MAX_BUNDLE_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, DEFAULT_MAX_AGE_MS) : DEFAULT_MAX_AGE_MS;
}

export async function isFresh(slug: string): Promise<boolean> {
  try {
    const s = await stat(skillFile(slug));
    const age = Date.now() - s.mtimeMs;
    return age < TTL_MS && age <= maxAgeMs();
  } catch {
    return false;
  }
}

export async function writeSkill(slug: string, body: string): Promise<void> {
  await mkdir(skillsDir(), { recursive: true, mode: 0o700 });
  await writeFile(skillFile(slug), body, { mode: 0o600 });
  await chmod(skillFile(slug), 0o600);
}

export async function pruneSkills(keep: string[]): Promise<void> {
  const keepSet = new Set(keep);
  let entries: string[];
  try {
    entries = await readdir(skillsDir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const slug = entry.slice(0, -3);
    if (keepSet.has(slug)) continue;
    try {
      await rm(skillFile(slug));
    } catch {}
  }
}

export async function installCommand(name: string, body: string): Promise<void> {
  if (!process.env.TOKMIZER_CLAUDE_COMMANDS_DIR && !existsSync(dirname(claudeCommandsDir()))) return;
  await mkdir(claudeCommandsDir(), { recursive: true });
  try {
    const current = await readFile(claudeCommandFile(name), "utf8");
    if (!current.includes(MANAGED_MARKER)) return;
  } catch {}
  await writeFile(claudeCommandFile(name), body, { mode: 0o600 });
  await chmod(claudeCommandFile(name), 0o600);
  const registry = await readCommandRegistry();
  if (!registry.includes(name)) await writeCommandRegistry([...registry, name]);
}

export async function pruneCommands(keep: string[]): Promise<void> {
  const keepSet = new Set([...keep, ...STATIC_COMMAND_NAMES]);
  const registry = await readCommandRegistry();
  const candidates = new Set([...registry, ...LEGACY_SERVER_COMMAND_NAMES]);
  for (const name of candidates) {
    if (keepSet.has(name)) continue;
    try {
      const body = await readFile(claudeCommandFile(name), "utf8");
      if (!body.includes(MANAGED_MARKER)) continue;
      await rm(claudeCommandFile(name));
    } catch {}
  }
  await writeCommandRegistry(registry.filter((n) => keepSet.has(n)));
}

export async function commandsInstallStatus(): Promise<{ installed: number; total: number }> {
  let installed = 0;
  for (const name of STATIC_COMMAND_NAMES) {
    if (await commandInstalled(name)) installed++;
  }
  return { installed, total: STATIC_COMMAND_NAMES.length };
}

export async function commandInstalled(name: string): Promise<boolean> {
  try {
    await stat(claudeCommandFile(name));
    return true;
  } catch {
    return false;
  }
}

export async function recordBundleRefresh(error: string | null): Promise<void> {
  try {
    await mkdir(tokmizerHome(), { recursive: true, mode: 0o700 });
    await writeFile(bundleRefreshFile(), JSON.stringify({ at: Date.now(), error }), {
      mode: 0o600
    });
    await chmod(bundleRefreshFile(), 0o600);
  } catch {}
}

export async function readBundleRefresh(): Promise<{ at: number; error: string | null } | null> {
  try {
    return JSON.parse(await readFile(bundleRefreshFile(), "utf8"));
  } catch {
    return null;
  }
}

export async function readSkill(slug: string): Promise<string | null> {
  try {
    const s = await stat(skillFile(slug));
    if (Date.now() - s.mtimeMs > maxAgeMs()) return null;
    return await readFile(skillFile(slug), "utf8");
  } catch {
    return null;
  }
}

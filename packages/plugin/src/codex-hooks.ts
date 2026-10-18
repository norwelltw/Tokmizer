import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { hookCommandFor, isTokmizerHookCommand, keepFirstHook, readJsonConfig, writeJsonConfig, type HookInstall, type HookRemoval } from "./hook-config";
import { codexFindingLines, codexFindings, codexPluginProvidesHook, projectCodexDirs, repairCodexConfig, type CodexRepair } from "./codex-repair";

const MARK = "tkr-codex-hook";

type HookCommand = { type?: string; command?: string; timeout?: number };
type HookGroup = { matcher?: string; hooks?: HookCommand[] };
type HooksFile = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

export function codexHooksFile(): string {
  return join(process.env.CODEX_HOME || join(os.homedir(), ".codex"), "hooks.json");
}

function isOurs(hook: unknown): boolean {
  return hook != null && typeof hook === "object" && isTokmizerHookCommand((hook as HookCommand).command, MARK);
}

function ours(group: HookGroup): HookCommand | undefined {
  return (Array.isArray(group.hooks) ? group.hooks : []).find(isOurs);
}

function hooksJsonHasOurs(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(codexHooksFile(), "utf8")) as HooksFile;
    return (parsed.hooks?.PreToolUse ?? []).some((g) => ours(g) != null);
  } catch {
    return false;
  }
}

export function codexHookInstalled(): boolean {
  return hooksJsonHasOurs() || codexPluginProvidesHook();
}

export async function ensureCodexHook(command: string): Promise<"added" | "updated" | "present" | "error"> {
  const file = codexHooksFile();
  const parsed = (await readJsonConfig(file)) as HooksFile | null;
  if (!parsed) return "error";
  const hooks = parsed.hooks && typeof parsed.hooks === "object" ? parsed.hooks : {};
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  let status: "added" | "updated" | "present" = "added";
  const existing = pre.map(ours).find((h) => h != null);
  if (existing) {
    const collapsed = keepFirstHook(pre, isOurs, existing, true);
    if (existing.command === command && existing.timeout === 10 && !collapsed) return "present";
    existing.command = command;
    existing.timeout = 10;
    status = "updated";
  } else {
    pre.push({ matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] });
  }
  hooks.PreToolUse = pre;
  parsed.hooks = hooks;
  return (await writeJsonConfig(file, parsed)) ? status : "error";
}

export function codexHookCommand(pathEnv: string, installedJs: string): string {
  return hookCommandFor(MARK, pathEnv, installedJs);
}

export async function removeCodexHook(): Promise<HookRemoval> {
  const file = codexHooksFile();
  if (!existsSync(file)) return "absent";
  const parsed = (await readJsonConfig(file)) as HooksFile | null;
  if (!parsed) return "error";
  const pre = Array.isArray(parsed.hooks?.PreToolUse) ? parsed.hooks!.PreToolUse : [];
  if (!pre.some((g) => ours(g) != null)) return "absent";
  const kept = pre
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
  parsed.hooks!.PreToolUse = kept;
  if (!kept.length) delete parsed.hooks!.PreToolUse;
  return (await writeJsonConfig(file, parsed)) ? "removed" : "error";
}

export type CodexSetup = HookInstall | "plugin";

export async function setupCodexHook(command: string): Promise<{ hook: CodexSetup; repair: CodexRepair }> {
  const repair = await repairCodexConfig();
  if (!codexPluginProvidesHook()) return { hook: await ensureCodexHook(command), repair };
  return { hook: (await removeCodexHook()) === "error" ? "error" : "plugin", repair };
}

export function codexDoctorLines(): string[] {
  const lines = codexFindingLines(codexFindings(process.cwd(), true));
  if (codexPluginProvidesHook() && hooksJsonHasOurs()) lines.push(`Codex:    the Tokmizer plugin and ${codexHooksFile()} both run the Tokmizer hook — run: tkr doctor --fix`);
  return lines;
}

export async function codexDoctorFix(command: string): Promise<string[]> {
  const findings = codexFindings(process.cwd(), true);
  const duplicate = codexPluginProvidesHook() && hooksJsonHasOurs();
  if (!findings.length && !duplicate) return [];
  const projectFiles = new Set(projectCodexDirs().flatMap((d) => [join(d, "hooks.json"), join(d, "config.toml")]));
  const project = await repairCodexConfig(findings.filter((f) => projectFiles.has(f.file)));
  const { hook, repair } = await setupCodexHook(command);
  const lines = [...project.lines, ...repair.lines];
  if (hook === "error") lines.push(`Could not update ${codexHooksFile()}; run tkr setup-codex again.`);
  else if (hook === "plugin") lines.push(duplicate ? `Removed the extra Tokmizer hook from ${codexHooksFile()}: the Tokmizer Codex plugin already runs it.` : "The Tokmizer Codex plugin runs the Codex hook.");
  else lines.push(`${hook === "present" ? "The Codex hook is set" : "Added the Codex hook"} in ${codexHooksFile()}.`);
  if (repair.changed || project.changed || hook === "added" || hook === "updated") lines.push("In Codex, run /hooks once, approve the Tokmizer hook, then restart Codex.");
  return lines;
}

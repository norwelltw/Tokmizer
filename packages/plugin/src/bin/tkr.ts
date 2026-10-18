#!/usr/bin/env node
import { runWizard } from "../wizard";
import { heartbeat, activate, maybeAutoEnroll } from "../license";
import { baseUrlFromEnv } from "../base-url";
import { M, engineNotice } from "../ui";
import { loadState, clearState } from "../state";
import { PLUGIN_VERSION, isOlderVersion } from "../version";
import { buildFingerprint } from "../fingerprint";
import { fetchSigned } from "../transport";
import { getSettings, patchSettings, buildPatchFromArg } from "../settings-client";
import { runConfigureFromCli } from "../configure";
import { detectHost, adapterFor, nativeHookSetupCommand } from "../host-detect";
import { powerAvailable } from "../engine/plans";
import { commandInstalled, commandsInstallStatus, readSkill, readBundleRefresh, pruneSkills, pruneCommands } from "../cache";
import { gatingPlan, gatingBonus, graceExceeded } from "../entitlement";
import { readGain, renderGain, readDaily, renderDaily, clearStats, coverageSummary, recordStat, normalizeProject, projectLabel, readAgentDaily, renderCsv, renderGraph, readHistory, renderHistory, renderByRule, renderFallbacks, quotaEstimate, renderQuota, QUOTA_TIERS, type QuotaTier } from "../stats";
import { effectivePricePerMtok } from "../pricing";
import { readSession, renderSession, clearUsage } from "../usage";
import { clearSpool } from "../learn/spool";
import { recordTelemetry } from "../learn/telemetry";
import { loadSettingsCache, clearSettingsCache, updateSettingsCache } from "../settings-cache";
import { telemetryHintLine, telemetryNoticeLine, markTelemetryNoticeShown, TELEMETRY_NOTICE } from "../telemetry-hint";
import { networkEnabled, networkNoticeLine, networkStatusLabel, networkOffByEnv, setNetwork, NETWORK_OFF_MESSAGE } from "../network";
import { yoloEnabled, setYoloMode } from "../yolo-mode";
import { restoreCommand, contentCacheStats, retentionLabel, readRestoreConfig } from "../content-cache";
import { restoreConfigFile } from "../paths";
import {
  installShims,
  uninstallShims,
  shimsDir,
  shimsInstalled,
  resolveShimJsPath,
  setGlobalPath,
  globalPathOptedIn,
  agentPathEnv,
  globalPathRemovals
} from "../shim/install";
import { healInstall, failOpenActive, shimFallbackCount } from "../shim/heal";
import { fileURLToPath } from "node:url";
import { codexHookCommand, codexHooksFile, codexHookInstalled } from "../codex-hooks";
import { ensureCursorHook, removeCursorHook, cursorHookCommand, cursorHooksFile, cursorHookInstalled } from "../cursor-hooks";
import { ensureGeminiHook, removeGeminiHook, geminiHookCommand, geminiSettingsFile, geminiHookInstalled } from "../gemini-hooks";
import { AGENT_HOSTS, parseRewriteArgs, rewriteForAgent } from "../agent-rewrite";
import { AGENT_SETUPS, agentIntegrationInstalled, agentSetupFor, agentSetupTarget, installAgentShim, removeAgentShim } from "../agent-plugins";
import { agentHookCommand } from "../agent-command-hooks";
import { tkrArgv } from "../agent-shim-files";
import { readStdin } from "../stdin";
import { selfInvocation, singleBinary } from "../self-command";
import { JSON_HOOK_AGENTS, jsonHookAgentForSetup, agentHookCommand as jsonAgentHookCommand } from "../agent-hooks";
import { currentRtkEnv } from "../migrate/rtk-paths";
import { rtkMigrationHint } from "../migrate/migrate-rtk";
import { loadRtkImport, renderRtkImportLine } from "../migrate/rtk-history";

const BASE_URL = baseUrlFromEnv();

async function bonusDoctorLines(): Promise<string[]> {
  const { AGENT_BONUSES, powerInstalled, reducerInstalled } = await import("../agent-bonuses");
  const power = AGENT_BONUSES.filter(powerInstalled).map((b) => b.label);
  const reducer = AGENT_BONUSES.filter(reducerInstalled).map((b) => b.label);
  return [
    `/power:   ${power.length ? power.join(", ") : "no other agent set up"} (Claude Code gets it from its plugin; others from tkr setup-<agent>)`,
    `Reducer:  ${reducer.length ? reducer.join(", ") : "no other agent set up"} (Claude Code gets it from its plugin; others from tkr setup-<agent>)`
  ];
}

function contextHookJs(): string {
  return fileURLToPath(new URL("./tkr-context-hook.js", import.meta.url));
}

async function bonusLines(id: string): Promise<{ lines: string[]; error: boolean }> {
  const { installAgentBonuses } = await import("../agent-bonuses");
  return installAgentBonuses(id, process.env.PATH ?? "", contextHookJs()).catch(() => ({ lines: ["Could not add /power and the reducer for this agent."], error: true }));
}

async function removeBonuses(id: string): Promise<string> {
  const { removeAgentBonuses } = await import("../agent-bonuses");
  return removeAgentBonuses(id).catch(() => "error");
}

function bonusRemovalLine(status: string): string[] {
  return status === "removed" ? ["Removed the tokmizer /power command and reducer instructions for this agent."] : status === "error" ? ["Could not remove the tokmizer /power command or reducer instructions; remove them by hand."] : [];
}

async function syncRulesQuietly(): Promise<void> {
  try {
    const { syncReducerRules } = await import("../agent-bonuses");
    await syncReducerRules();
  } catch {}
}

async function noticeLines(): Promise<string[]> {
  const notices = [networkNoticeLine(), await telemetryNoticeLine(), rtkMigrationHint(currentRtkEnv())].filter((n): n is string => n !== null);
  return notices.length ? ["", ...notices] : [];
}

async function migrateCommand(argv: string[]): Promise<void> {
  const usage = "Usage: tkr migrate rtk [--dry-run] [--yes] [--shim] | tkr migrate rtk --undo\n";
  const flags = argv.slice(1);
  if (argv[0] !== "rtk" || flags.some((f) => !["--dry-run", "--yes", "-y", "--shim", "--undo"].includes(f)) || (flags.includes("--undo") && flags.length > 1)) {
    process.stderr.write(usage);
    process.exitCode = 1;
    return;
  }
  const { buildPlan, renderPlan, planHasWork, applyPlan, undoMigration, migrationApplied } = await import("../migrate/migrate-rtk");
  if (flags.includes("--undo")) {
    const r = await undoMigration();
    process.stdout.write(`${r.lines.join("\n")}\n`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  const e = currentRtkEnv();
  const shim = flags.includes("--shim") ? { tkr: tkrArgv(process.env.PATH ?? "", fileURLToPath(import.meta.url)) } : undefined;
  const plan = await buildPlan(e, shim ? { shim } : {});
  const anything = plan.binary || plan.dirs.length > 0 || plan.filters.length > 0 || plan.config.file || plan.history || plan.hooks.length > 0;
  if (!anything && !plan.shim) {
    process.stdout.write("rtk was not found on this machine: no rtk command, settings, history or agent hook. Nothing to migrate.\n");
    return;
  }
  process.stdout.write(renderPlan(plan));
  if (!planHasWork(plan)) {
    process.stdout.write(migrationApplied() ? "Already migrated: nothing to change. Undo with: tkr migrate rtk --undo\n" : "Nothing to change.\n");
    return;
  }
  let apply = flags.includes("--yes") || flags.includes("-y");
  if (flags.includes("--dry-run")) {
    process.stdout.write("Dry run: nothing changed. Apply with: tkr migrate rtk --yes\n");
    return;
  }
  if (!apply && process.stdin.isTTY && process.stdout.isTTY) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      apply = ["y", "yes"].includes((await rl.question("Apply these changes? [y/N] ")).trim().toLowerCase());
    } finally {
      rl.close();
    }
  }
  if (!apply) {
    process.stdout.write("Nothing changed. Apply with: tkr migrate rtk --yes\n");
    return;
  }
  const done = await applyPlan(plan);
  process.stdout.write(`\n${done.join("\n")}\n`);
  if (plan.shim && plan.binary) {
    process.stdout.write(`The real rtk is still at ${plan.binary.path}. Uninstall it so the rtk command forwards to Tokmizer.\n`);
  }
  if (plan.hooks.some((h) => h.tkrInstalled && h.edits.length > 0)) process.stdout.write("Restart your agents so they reload their hooks.\n");
  process.stdout.write("Undo anytime with: tkr migrate rtk --undo\n");
}

function help(): void {
  process.stdout.write(
    [
      "Usage: tkr <command>",
      "",
      "  link                              link your account (optional; paste your key)",
      "  link <key>                        link without prompts",
      "  link --shim [--shim-runner P]     install shell-shims (universal compat)",
      "  unlink                            unlink this machine from your account",
      "  status                            show account and engine status",
      "  gain [--day|--week|--month]       estimated tool-output savings (today / 7 days / 30 days / all time)",
      "       [--project [path]]           only commands run inside a project directory (default: current)",
      "       [--json|--csv|--graph|--history]  JSON, one CSV row per day, per-day bar chart, last 20 commands",
      "       [--by-rule|--failures]       savings per rule, commands left unchanged",
      "       [--quota [pro|5x|20x]]       estimated share of a Claude plan budget (default pro, last 30 days)",
      "  session                           this session's tkr coverage",
      "  restore <hash>                    re-fetch the full output behind a [tkr restore …] hint",
      "          [--lines a:b] [--grep re] only some lines of it",
      "  restore --list | --grep <re>      list cached outputs, or search all of them",
      "  filters trust [file…]             allow your ~/.tokmizer/filters/*.toml files (records SHA-256)",
      "  filters untrust [file…]           stop using them",
      "  filters test [rule]               run the inline tests of your filters",
      "  discover                          what's covered (agent + terminal)",
      "  setup-claude [--remove]           add or remove Claude Code hooks for the standalone tkr",
      "  setup [--all]                     set up every agent found on this machine (asks which; --all sets up all)",
      "  setup-codex [--remove]            one-command setup for OpenAI Codex",
      "  uninstall                         remove every hook, shim and PATH line Tokmizer added",
      "  setup-cursor [--remove]           install or remove the Cursor agent hook",
      "  setup-gemini [--remove]           install or remove the Gemini CLI hook",
      ...AGENT_SETUPS.map((a) => `  ${`${a.command} [--remove]`.padEnd(34)}install or remove the ${a.label} integration`),
      "  rewrite --host <agent>            print the tokmizer form of a command read on stdin (used by agent plugins)",
      ...JSON_HOOK_AGENTS.map((a) => `  ${`${a.setup.slice(4)} [--remove]`.padEnd(34)}install or remove the ${a.label} hook`),
      "  auto-update [on|off|status]       keep the tkr CLI up to date on its own (on by default)",
      "  network [on|off|status]           allow or block every connection to tokmizer.com (on by default)",
      "  doctor [--fix]                    print detected host, OS, adapter; --fix repairs outdated shims and hooks",
      "  migrate rtk [--dry-run] [--yes]   move from rtk: filters, settings, history; turn off its agent hooks",
      "          [--shim] | --undo         also forward the rtk command to tkr; undo the last migration",
      "  shim install [--runner P]         install command shims for agents without hooks (Aider, Cline, Windsurf)",
      "          [--global-path]           also route every terminal through them (changes your shell profile)",
      "  shim global-path [on|off|status]  turn that terminal-wide PATH line on or off",
      "  shim uninstall                    remove the shims and any PATH line Tokmizer added",
      "  wrap [--host H] <agent> [args]    start an agent with the shims active only for it",
      "  heartbeat                         refresh JWT + bundle",
      "  settings show                     print current settings",
      "  settings set <key> <value>        update one setting (key uses dot path, e.g. filters.enableAll true)",
      "  settings configure                interactive wizard (recommended or custom)",
      "  settings reset                    reset all settings to defaults",
      "  compression [level]               show or set compression level (light, balanced, max)",
      "  yolo [on|off|status]              local aggressive output reduction; content can be lost",
      "  reducer [level]                   show or set response reducer (off, light, balanced, max)",
      "  telemetry status                  show telemetry on/off + local record count",
      "  telemetry on | off                turn usage stats (command names, token counts; on by default) on or off",
      "  telemetry forget                  erase telemetry data stored on this machine",
      ""
    ].join("\n")
  );
}

async function settingsCommand(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "show";
  if (sub === "show") {
    try {
      const r = await getSettings();
      process.stdout.write(`Plan: ${r.plan}\n`);
      process.stdout.write(`${JSON.stringify(r.settings, null, 2)}\n`);
    } catch (e) {
      process.stdout.write(`Settings unavailable; showing local cached settings: ${e instanceof Error ? e.message : String(e)}\n`);
      process.stdout.write(`${JSON.stringify(await loadSettingsCache(), null, 2)}\n`);
    }
    return;
  }
  if (sub === "set") {
    const key = argv[1];
    const value = argv[2];
    if (!key || value === undefined) {
      process.stderr.write("Usage: tkr settings set <key> <value>\n");
      process.exitCode = 1;
      return;
    }
    const patch = buildPatchFromArg(key, value);
    const r = await patchSettings(patch);
    await syncRulesQuietly();
    process.stdout.write(`Updated. ${key} = ${JSON.stringify(value)}\n`);
    process.stdout.write(`Current: ${JSON.stringify(r.settings, null, 2)}\n`);
    return;
  }
  if (sub === "configure") {
    await runConfigureFromCli();
    return;
  }
  if (sub === "reset") {
    const r = await patchSettings({
      enabled: true,
      outputVerbosity: "compact",
      reducer: "off",
      filters: { enableAll: true, disabled: [] }
    });
    await setYoloMode(false);
    await syncRulesQuietly();
    process.stdout.write(`Settings reset to defaults.\n`);
    process.stdout.write("YOLO: off (this machine only)\n");
    process.stdout.write(`${JSON.stringify(r.settings, null, 2)}\n`);
    return;
  }
  process.stderr.write(`Unknown settings subcommand: ${sub}\n`);
  process.exitCode = 1;
}

async function telemetryCommand(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "status";
  if (sub === "on" || sub === "off") {
    const on = sub === "on";
    try {
      const r = await patchSettings({ telemetryOptIn: on });
      process.stdout.write(`Telemetry ${r.settings.telemetryOptIn ? "on" : "off"}.\n`);
      if (r.settings.telemetryOptIn && !networkEnabled()) {
        process.stdout.write("Network is off, so nothing is sent. Turn it back on with: tkr network on\n");
      } else if (r.settings.telemetryOptIn) {
        if (!(await loadState())) {
          process.stdout.write("Could not reach tokmizer.com right now. Usage stats stay on this machine and are sent once Tokmizer is online.\n");
        }
        process.stdout.write(`${TELEMETRY_NOTICE}\n`);
        markTelemetryNoticeShown();
      } else {
        process.stdout.write("Your choice is saved on this machine and survives updates. Turn them back on with: tkr telemetry on\n");
      }
    } catch (e) {
      process.stdout.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (sub === "forget") {
    clearSpool("telemetry");
    clearSpool("learn");
    const removed = (await clearStats()) + clearUsage();
    process.stdout.write(
      `Cleared ${removed} local telemetry record${removed === 1 ? "" : "s"} from this machine.\n`
    );
    return;
  }
  if (sub === "status") {
    let onOff: string;
    try {
      const r = await getSettings();
      onOff = r.settings.telemetryOptIn ? "on" : "off";
    } catch {
      const cached = await loadSettingsCache();
      onOff = `${cached.telemetryOptIn ? "on" : "off"} (offline; last known)`;
    }
    const [agg, state] = await Promise.all([readGain(), loadState()]);
    const on = onOff.startsWith("on");
    const sending = on && networkEnabled();
    process.stdout.write(
      `Telemetry: ${onOff}\n` +
        `Network: ${networkStatusLabel()}\n` +
        `Account: ${state?.linked === true || state?.email ? "linked" : "none (stats are tied to this install's random key)"}\n` +
        (sending
          ? "Sent: command names, token counts, session ID, agent name and install health counts. Never arguments, output, file contents or paths.\n"
          : on
            ? "Sent: nothing while network is off.\n"
            : "Sent: nothing.\n") +
        `${agg.count} commands recorded locally.\n` +
        (on
          ? "Default: on. Turn off in one command: tkr telemetry off (your choice survives updates)\n"
          : "Default: on; you turned them off. Turn on: tkr telemetry on\n") +
        `Manage: tkr telemetry on | off | forget. Stop every connection: tkr network off\n`
    );
    if (sending) markTelemetryNoticeShown();
    return;
  }
  process.stderr.write(`Unknown telemetry subcommand: ${sub}\n`);
  process.exitCode = 1;
}

const SHIM_ONLY_HOSTS = ["aider", "cline", "windsurf"] as const;

function shimPathNote(): string {
  return [
    "Shims only run inside agents you start with: tkr wrap <agent> [args]",
    "Your own terminals are not changed. To route every terminal through Tokmizer anyway: tkr shim global-path on",
    ""
  ].join("\n");
}

async function wrapCommand(argv: string[]): Promise<void> {
  const hostIdx = argv.indexOf("--host");
  const host = hostIdx >= 0 ? argv[hostIdx + 1] : undefined;
  const command = hostIdx >= 0 ? [...argv.slice(0, hostIdx), ...argv.slice(hostIdx + 2)] : argv;
  if (command[0] === "--") command.shift();
  const program = command[0];
  const guessed = program ? program.split(/[\\/]/).pop()!.replace(/\.(?:exe|cmd)$/, "") : "";
  const agent = host ?? ((SHIM_ONLY_HOSTS as readonly string[]).includes(guessed) ? guessed : undefined);
  if (!program || !agent) {
    process.stderr.write(`Usage: tkr wrap [--host <${SHIM_ONLY_HOSTS.join("|")}>] <agent command> [args]\n`);
    process.exitCode = 2;
    return;
  }
  if (!shimsInstalled()) await installShims(resolveShimJsPath());
  const { spawn } = await import("node:child_process");
  const child = spawn(program, command.slice(1), { stdio: "inherit", env: { ...agentPathEnv(), TOKMIZER_HOST: agent } });
  const forward = (sig: NodeJS.Signals): void => {
    try {
      child.kill(sig);
    } catch {}
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.exitCode = await new Promise<number>((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`tkr wrap: ${err.message}\n`);
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
  });
}

function removedPathNotice(files: string[]): string {
  return `Tokmizer no longer changes your terminals: it removed its PATH line from ${files.join(", ")} (backups in ~/.tokmizer/backup/rc). Agents keep their savings through their hooks. To put the line back: tkr shim global-path on`;
}

function healLines(report: Awaited<ReturnType<typeof healInstall>>): string[] {
  return [
    ...(report.rewrittenShims ? [`Rewrote ${report.rewrittenShims} outdated command shim${report.rewrittenShims === 1 ? "" : "s"}.`] : []),
    ...(report.launcher === "written" ? ["Pointed the shims at the current Tokmizer install."] : []),
    ...(report.hookLauncher === "written" ? ["Pointed the agent hooks at the current Tokmizer install."] : []),
    ...report.globalPathRemoved.map((f) => `Removed the Tokmizer PATH line from ${f} (backup in ~/.tokmizer/backup/rc; undo: tkr shim global-path on).`)
  ];
}

async function managedConfigFiles(): Promise<string[]> {
  const { droidFiles } = await import("../agent-hooks");
  const { claudeSettingsFile } = await import("../claude-hooks");
  const { AGENT_BONUSES } = await import("../agent-bonuses");
  const files = [claudeSettingsFile(), codexHooksFile(), cursorHooksFile(), geminiSettingsFile(), ...droidFiles().map((d) => d.file), ...JSON_HOOK_AGENTS.flatMap((a) => a.files())];
  for (const setup of AGENT_SETUPS) files.push(...(setup.kind === "hook" ? [setup.file()] : setup.files().map((f) => f.target)));
  for (const bonus of AGENT_BONUSES) if (bonus.reducer.kind === "rules") files.push(bonus.reducer.file());
  return files;
}

async function uninstallEverything(): Promise<void> {
  const { removeCodexHook } = await import("../codex-hooks");
  const { removeClaudeHooks } = await import("../claude-hooks");
  const { removeVibeHook, removeAntigravityHook } = await import("../agent-command-hooks");
  const { rm } = await import("node:fs/promises");
  const { hookLauncherFile } = await import("../shim/launcher");
  const lines: string[] = [];
  const removals: [string, () => Promise<string>][] = [
    ["Claude Code", removeClaudeHooks],
    ["Codex", removeCodexHook],
    ["Cursor", removeCursorHook],
    ["Gemini CLI", removeGeminiHook],
    ["Vibe", removeVibeHook],
    ["Antigravity", removeAntigravityHook],
    ...JSON_HOOK_AGENTS.map((a): [string, () => Promise<string>] => [a.label, a.remove]),
    ...AGENT_SETUPS.filter((a) => a.kind !== "hook").map((a): [string, () => Promise<string>] => [a.label, () => removeAgentShim(a as never)])
  ];
  for (const [label, remove] of removals) {
    const r = await remove().catch(() => "error");
    if (r === "removed") lines.push(`Removed the ${label} integration.`);
    else if (r === "error") lines.push(`Could not update the ${label} configuration; remove the tokmizer entry by hand.`);
  }
  const { AGENT_BONUSES, removeAgentBonuses } = await import("../agent-bonuses");
  for (const bonus of AGENT_BONUSES) {
    const r = await removeAgentBonuses(bonus.id, true).catch(() => "error");
    if (r === "removed") lines.push(`Removed the ${bonus.label} /power command and reducer instructions.`);
    else if (r === "error") lines.push(`Could not remove the ${bonus.label} /power command or reducer instructions; remove them by hand.`);
  }
  const { forgetReducerFiles } = await import("../agent-bonuses");
  await forgetReducerFiles();
  const { cleanLegacyBackups, removeConfigBackups } = await import("../config-backup");
  await cleanLegacyBackups(await managedConfigFiles());
  await removeConfigBackups();
  const shims = await uninstallShims();
  if (shims) lines.push(`Removed ${shims} command shims.`);
  for (const f of (await setGlobalPath(false)).files) lines.push(`Removed the Tokmizer PATH line from ${f} (backup in ~/.tokmizer/backup/rc).`);
  await rm(hookLauncherFile(), { force: true }).catch(() => {});
  lines.push(
    "Your shell and agents now run without Tokmizer. Your savings history stays in ~/.tokmizer (delete that folder to erase it).",
    "To remove the program itself: npm uninstall -g @tokmizer/plugin, brew uninstall tokmizer, or /plugin uninstall tokmizer@tokmizer in Claude Code."
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function ensureIntegration(id: string, pathEnv: string): Promise<{ status: string; notes: string[] }> {
  if (id === "claude") {
    const { claudeExecutables, claudePluginEnabled, claudeSettingsFile, ensureClaudeHooks } = await import("../claude-hooks");
    if (singleBinary()) return { status: await ensureClaudeHooks(claudeExecutables()), notes: [] };
    const { readJsonConfig } = await import("../hook-config");
    const settings = await readJsonConfig(claudeSettingsFile());
    return { status: settings && claudePluginEnabled(settings) ? "plugin" : "error", notes: [] };
  }
  if (id === "codex") {
    const { setupCodexHook } = await import("../codex-hooks");
    const codex = await setupCodexHook(codexHookCommand(pathEnv, fileURLToPath(new URL("./tkr-codex-hook.js", import.meta.url))));
    return { status: codex.hook, notes: codex.repair.lines };
  }
  if (id === "cursor") return { status: await ensureCursorHook(cursorHookCommand(pathEnv, fileURLToPath(new URL("./tkr-cursor-hook.js", import.meta.url)))), notes: [] };
  if (id === "gemini") return { status: await ensureGeminiHook(geminiHookCommand(pathEnv, fileURLToPath(new URL("./tkr-gemini-hook.js", import.meta.url)))), notes: [] };
  const json = JSON_HOOK_AGENTS.find((a) => a.id === id);
  if (json) return { status: await json.ensure(jsonAgentHookCommand(json, pathEnv, fileURLToPath(new URL(`./${json.bin}.js`, import.meta.url)))), notes: [] };
  const agent = AGENT_SETUPS.find((a) => a.host === id);
  if (!agent) return { status: "error", notes: [] };
  const status = agent.kind === "hook"
    ? await agent.ensure(agentHookCommand(agent.host as "vibe" | "antigravity", pathEnv, fileURLToPath(new URL("./tkr-agent-hook.js", import.meta.url))))
    : await installAgentShim(agent, fileURLToPath(new URL("../../agent-plugins/", import.meta.url)), tkrArgv(pathEnv, fileURLToPath(import.meta.url)));
  return { status, notes: [] };
}

async function repairIntegrations(explicit = false): Promise<string[]> {
  const lines: string[] = [];
  const { brokenIntegrations } = await import("../hook-health");
  const pathEnv = process.env.PATH ?? "";
  for (const { check } of brokenIntegrations()) {
    if (check.id === "claude" && !singleBinary()) continue;
    const { status, notes } = await ensureIntegration(check.id, pathEnv);
    if (status !== "error") {
      const { repairReducerHooks } = await import("../agent-bonuses");
      await repairReducerHooks(check.id, pathEnv, contextHookJs());
    }
    lines.push(...notes);
    lines.push(status === "error" ? `Could not repair the ${check.label} hook. Run its setup command again.` : `Repaired the ${check.label} hook, which pointed at a removed install.${check.id === "codex" ? " In Codex, run /hooks once and approve it." : ""}`);
  }
  const { codexFindings } = await import("../codex-repair");
  if (codexFindings().some((f) => f.kind !== "config-toml" || f.commands.length > 0)) {
    const { status, notes } = await ensureIntegration("codex", pathEnv);
    lines.push(...notes, ...(status === "added" || status === "updated" ? ["In Codex, run /hooks once, approve the Tokmizer hook, then restart Codex."] : []));
  }
  const { healForeignHooks } = await import("../foreign-hooks");
  lines.push(...(await healForeignHooks(async (id) => (await ensureIntegration(id, pathEnv)).status, explicit)));
  return lines;
}

async function doctorFix(): Promise<void> {
  const report = await healInstall({ shimJs: resolveShimJsPath(), explicit: true, rc: true });
  const { codexDoctorFix } = await import("../codex-hooks");
  const codex = await codexDoctorFix(codexHookCommand(process.env.PATH ?? "", fileURLToPath(new URL("./tkr-codex-hook.js", import.meta.url))));
  const lines = [...healLines(report), ...codex, ...(await repairIntegrations(true))];
  if (!lines.length) lines.push("Nothing left to repair.");
  for (const r of await globalPathRemovals()) lines.push(`Removed earlier: the Tokmizer PATH line in ${r.file} (backup: ${r.backup}; undo: tkr shim global-path on).`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  let cmd = process.argv[2] ?? "help";
  let rest = process.argv.slice(3);
  if (cmd === "reducer" && rest[0] === "--context") {
    const kind = rest[1] === "prompt" ? "prompt" : "session";
    const { reducerContext } = await import("../bonuses");
    const ctx = await reducerContext(kind).catch(() => null);
    if (ctx) process.stdout.write(ctx.text);
    return;
  }
  if (!["rtk-compat", "shims-heal", "rewrite", "help", "--help", "-h"].includes(cmd) && !(cmd === "doctor" && rest[0] !== "--fix")) {
    const healed = await healInstall({ shimJs: resolveShimJsPath(), rc: true }).catch(() => null);
    if (healed?.globalPathRemoved.length) process.stderr.write(`${removedPathNotice(healed.globalPathRemoved)}\n`);
    if (cmd !== "doctor") for (const line of await repairIntegrations().catch(() => [])) process.stderr.write(`${line}\n`);
  }

  if (cmd === "rtk-compat") {
    const { rtkCompatAction, runRaw } = await import("../migrate/rtk-compat");
    const action = rtkCompatAction(rest);
    if (action.kind === "message") {
      if (action.stdout) process.stdout.write(action.stdout);
      if (action.stderr) process.stderr.write(action.stderr);
      process.exitCode = action.code;
      return;
    }
    if (action.kind === "raw") {
      process.exitCode = runRaw(action.argv);
      return;
    }
    cmd = action.argv[0]!;
    rest = action.argv.slice(1);
  }

  if (cmd === "migrate") {
    await migrateCommand(rest);
    return;
  }

  if (cmd === "rewrite") {
    const parsed = parseRewriteArgs(rest);
    if (!parsed) {
      process.stderr.write(`Usage: tkr rewrite --host <${AGENT_HOSTS.join("|")}> [--session <id>] < command\n`);
      process.exitCode = 2;
      return;
    }
    const rewritten = rewriteForAgent(await readStdin(), parsed.host, parsed.session);
    if (rewritten) process.stdout.write(rewritten);
    return;
  }

  if (cmd === "yolo") {
    const action = rest[0] ?? "status";
    if (rest.length > 1 || !["on", "off", "status"].includes(action)) {
      process.stderr.write("Usage: tkr yolo [on|off|status]\n");
      process.exitCode = 1;
      return;
    }
    if (action === "on") {
      process.stderr.write("Warning: YOLO can discard content and diagnostics. Lost output cannot be restored; command exit codes are preserved.\n");
      await setYoloMode(true);
    } else if (action === "off") {
      await setYoloMode(false);
    }
    process.stdout.write(`YOLO: ${yoloEnabled() ? "on" : "off"} (this machine only)\n`);
    return;
  }

  if (cmd === "init" || cmd === "link") {
    if (cmd === "init") {
      process.stdout.write("`tkr init` is now `tkr link`. Running link...\n");
    }
    if (rest.includes("--shim")) {
      const idx = rest.indexOf("--shim-runner");
      const runner = idx >= 0 ? rest[idx + 1] : resolveShimJsPath();
      const created = await installShims(runner ?? resolveShimJsPath());
      process.stdout.write(`Installed ${created.length} shims into ${shimsDir()}\n${shimPathNote()}`);
      return;
    }
    if (!networkEnabled()) {
      process.stdout.write(
        "Linking needs to reach tokmizer.com, and network access is off for Tokmizer.\n" +
          (networkOffByEnv()
            ? "Unset TOKMIZER_NETWORK (or set it to 1), then run tkr link again.\n"
            : "Turn it back on with: tkr network on, then run tkr link again.\n")
      );
      process.exitCode = 1;
      return;
    }
    const emailIdx = rest.indexOf("--email");
    const tokenIdx = rest.indexOf("--token");
    const positional = rest.find((a) => a.startsWith("tokmizer_"));
    const tokenArg = tokenIdx >= 0 ? (rest[tokenIdx + 1] ?? "") : (positional ?? "");
    if (rest.length > 0) {
      if (!tokenArg) {
        process.stdout.write("Usage: tkr link <key>   (the key from tokmizer.com/dashboard/token, starts with tokmizer_)\n");
        process.exitCode = 1;
        return;
      }
      const email = emailIdx >= 0 ? rest[emailIdx + 1] : "";
      try {
        const state = await activate({ token: tokenArg, baseUrl: BASE_URL, ...(email ? { email } : {}) });
        process.stdout.write(M.activated(state.plan) + "\n");
        process.stdout.write("Review this account's settings: tkr settings show. Adjust them with: tkr settings configure\n");
        const linkRefresh = await readBundleRefresh();
        if (linkRefresh?.error) {
          process.stdout.write(
            `Note: feature sync failed (${linkRefresh.error}). Run "tkr heartbeat" to retry.\n`
          );
        }
      } catch (err) {
        process.stdout.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
      return;
    }
    await runWizard(BASE_URL);
    return;
  }
  if (cmd === "unlink") {
    const s = await loadState();
    const telemetryRefused = !(await loadSettingsCache()).telemetryOptIn;
    const online = networkEnabled();
    if (online && s?.jwt && s.signingSecret) {
      try {
        const fp = await buildFingerprint();
        await fetchSigned("POST", "/api/v1/license/unlink", { ts: Date.now() }, {
          baseUrl: BASE_URL,
          bearer: s.jwt,
          signingSecret: s.signingSecret,
          fingerprint: fp.fingerprint,
          installId: fp.installId,
          timeoutMs: 4000
        });
      } catch {}
    }
    await clearState();
    try {
      await pruneSkills([]);
      await pruneCommands([]);
    } catch {}
    await clearSettingsCache();
    if (telemetryRefused) await updateSettingsCache({ telemetryOptIn: false });
    try {
      const { shutdownDaemon } = await import("../daemon/client");
      await shutdownDaemon();
    } catch {}
    const who = s?.email ? ` from ${s.email}` : "";
    process.stdout.write(
      `Unlinked this machine${who}. The plugin keeps working without an account; ` +
        `a new install token is created on the next online run. Link another account with: tkr link\n`
    );
    if (!online && s) {
      process.stdout.write("Network is off: the local link was removed, but tokmizer.com was not told. Run tkr unlink again after tkr network on to remove this device from your dashboard.\n");
    }
    return;
  }
  if (cmd === "doctor") {
    if (rest[0] === "--fix") {
      await doctorFix();
      return;
    }
    const health = await healInstall({ shimJs: resolveShimJsPath(), rc: true, dryRun: true });
    const { brokenIntegrations } = await import("../hook-health");
    const broken = brokenIntegrations();
    const fallbacks = shimFallbackCount();
    const info = detectHost();
    const cmds = await commandsInstallStatus();
    const { brewTapStatus } = await import("../brew");
    const tap = brewTapStatus();
    const tapDir = tap?.wedged ? tap.path.replace(/\/Formula\/tokmizer\.rb$/, "") : null;
    const hookSetup = nativeHookSetupCommand(info.host);
    const restoreInfo = await contentCacheStats().catch(() => null);
    const lines = [
      `Host:     ${info.host} (source: ${info.source})`,
      `OS:       ${info.os}`,
      `Arch:     ${info.arch}`,
      `Network:  ${networkStatusLabel()}${networkEnabled() ? " — turn off with: tkr network off" : " — no request leaves this machine; re-enable with: tkr network on"}`,
      `Adapter:  ${adapterFor(info.host)}${hookSetup ? ` — native hook available, run: ${hookSetup}` : ""}`,
      `Shim dir: ${shimsDir()}`,
      `Shim:     ${shimsInstalled() ? `installed — ${health.staleShims || health.launcher === "stale" ? "outdated, run: tkr doctor --fix" : "up to date"}` : "not installed (only needed for Aider, Cline, Windsurf: tkr wrap <agent>)"}`,
      `PATH:     ${health.globalPathLines ? `${globalPathOptedIn() ? "terminal-wide PATH line on (tkr shim global-path off to remove)" : "old terminal-wide PATH line found — run: tkr doctor --fix"}` : "your shell profile is not changed by Tokmizer"}`,
      ...(health.hookLauncher === "stale" ? ["Hooks:    the agent hooks point at a removed install — run: tkr doctor --fix"] : []),
      ...(fallbacks ? [`Fallback: ${fallbacks} command${fallbacks === 1 ? "" : "s"} ran without Tokmizer because its files were missing — run: tkr doctor --fix`] : []),
      ...(failOpenActive() ? ["Safe mode: on — tokmizer.com paused command rewriting for this version; commands run unchanged"] : []),
      ...broken.map((b) => `Broken:   ${b.check.label} points at a missing file (${b.missing[0]}) — run: tkr doctor --fix`),
      ...(await import("../codex-hooks")).codexDoctorLines(),
      ...(await import("../foreign-hooks")).foreignFindingLines((await import("../foreign-hooks")).foreignFindings()),
      `Codex:    ${codexHookInstalled() ? "hook installed — if Codex shows it as new or changed, approve it once with /hooks" : "hook not installed — run: tkr setup-codex"}`,
      `Cursor:   ${cursorHookInstalled() ? "hook installed" : "hook not installed — run: tkr setup-cursor"}`,
      `Gemini:   ${geminiHookInstalled() ? "hook installed" : "hook not installed — run: tkr setup-gemini"}`,
      ...AGENT_SETUPS.map((a) => `${`${a.label}:`.padEnd(Math.max(10, a.label.length + 2))}${agentIntegrationInstalled(a) ? "integration installed" : `integration not installed — run: tkr ${a.command}`}`),
      ...JSON_HOOK_AGENTS.map((a) => `${`${a.label}:`.padEnd(9)} ${a.installed() ? "hook installed" : `hook not installed — run: ${a.setup}`}`),
      ...(await bonusDoctorLines()),
      `Commands: ${cmds.installed}/${cmds.total} unprefixed slash commands${cmds.installed < cmds.total ? " — restart Claude Code to reinstall" : ""}`,
      `Restore:  ${process.env.TOKMIZER_CCR_DISABLED === "1" || process.env.TOKMIZER_CCR_DISABLED === "true" ? "disabled (TOKMIZER_CCR_DISABLED)" : readRestoreConfig().disabled ? `disabled (${restoreConfigFile()})` : `active${restoreInfo ? ` · ${restoreInfo.entries} cached output${restoreInfo.entries === 1 ? "" : "s"} · kept ${retentionLabel()} (tkr restore --list)` : ""}`}`,
      ...(tapDir
        ? [`Homebrew: tap clone conflicted — updates are stuck. Fix: git -C ${tapDir} fetch origin && git -C ${tapDir} reset --hard origin/main && brew upgrade tokmizer`]
        : []),
      ""
    ];
    try {
      const { connectDaemon } = await import("../daemon/client");
      const { socketPath } = await import("../daemon/lifecycle");
      const { path } = socketPath();
      const client = await connectDaemon();
      const info2 = await client.ping();
      client.close();
      lines.push(
        `Daemon:   running (pid ${info2.pid})`,
        `  socket:        ${path}`,
        `  uptime:        ${Math.floor(info2.uptimeMs / 1000)}s`,
        `  ruleCount:     ${info2.ruleCount}`,
        `  bundleVersion: ${info2.bundleVersion}`,
        ""
      );
    } catch (err) {
      lines.push(`Daemon:   not running (${(err as Error).message})`, "");
    }
    try {
      const { readFileSync: rf, existsSync: ex, statSync: st } = await import("node:fs");
      const { join: j } = await import("node:path");
      const { tokmizerHome } = await import("../paths");
      const home = tokmizerHome();
      const failFile = j(home, "daemon.spawn.fail");
      if (ex(failFile)) {
        const at = Number(rf(failFile, "utf8"));
        lines.push(
          `  last spawn failure: ${Number.isFinite(at) ? new Date(at).toISOString() : "unknown"} (details: ${j(home, "daemon.log")})`
        );
      }
      const driftFile = j(home, "drift.jsonl");
      if (ex(driftFile) && st(driftFile).size > 0) {
        const rows = rf(driftFile, "utf8").trim().split("\n");
        const last = JSON.parse(rows[rows.length - 1]!) as { tool?: string };
        lines.push(
          `Drift:    ${rows.length} unrecognized hook payload shape(s), last on ${last.tool ?? "?"} (${driftFile})`,
          ""
        );
      }
    } catch {}
    try {
      const cov = coverageSummary(await readGain());
      if (cov) lines.push(`Coverage: ${cov}`, "");
    } catch {}
    try {
      const { loadUserFilters } = await import("../engine/user-filters");
      const user = await loadUserFilters();
      const count = user.filters.size;
      lines.push(
        count === 0 && user.issues.length === 0
          ? `Filters:  no user filters (optional: *.toml files in ${user.dir})`
          : `Filters:  ${count} user filter${count === 1 ? "" : "s"} loaded from ${user.dir}`
      );
      for (const issue of user.issues) lines.push(`  skipped ${issue.file}: ${issue.message}`);
      lines.push("");
    } catch (err) {
      lines.push(`Filters:  unavailable (${(err as Error).message})`, "");
    }
    try {
      const { doubleHooked } = await import("../migrate/rtk-hooks");
      const both = doubleHooked(currentRtkEnv());
      if (both.length > 0) {
        lines.push(`rtk:      double hook — rtk and Tokmizer both wrap commands in ${both.join(", ")}. Fix: tkr migrate rtk`, "");
      } else {
        const hint = rtkMigrationHint(currentRtkEnv());
        if (hint) lines.push(`rtk:      ${hint}`, "");
      }
    } catch {}
    process.stdout.write(lines.join("\n"));
    return;
  }
  if (cmd === "auto-update") {
    const { autoUpdateEnabled, setAutoUpdate } = await import("../self-update");
    const sub = rest[0] ?? "status";
    if (sub === "on" || sub === "off") setAutoUpdate(sub === "on");
    else if (sub !== "status") {
      process.stderr.write("Usage: tkr auto-update [on|off|status]\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`auto-update: ${autoUpdateEnabled() ? "on" : "off"}\n`);
    return;
  }

  if (cmd === "network") {
    const sub = rest[0] ?? "status";
    if (rest.length > 1 || !["on", "off", "status"].includes(sub)) {
      process.stderr.write("Usage: tkr network [on|off|status]\n");
      process.exitCode = 1;
      return;
    }
    if (sub === "on" || sub === "off") setNetwork(sub === "on");
    process.stdout.write(`Network: ${networkStatusLabel()}\n`);
    if (networkEnabled()) {
      process.stdout.write(
        "Tokmizer may contact tokmizer.com to keep its rules up to date, check for updates and, if you turned them on, send usage stats.\n" +
          "Turn it off with: tkr network off\n"
      );
    } else {
      process.stdout.write(
        "Tokmizer sends nothing: no sign-up, no rule download, no update check, no usage stats.\n" +
          "It keeps compressing locally: with the last downloaded rules for up to 7 days, then with its core built-in rules.\n" +
          (networkOffByEnv() && sub === "on"
            ? "TOKMIZER_NETWORK still blocks it for this shell. Unset it (or set it to 1) to turn the network back on.\n"
            : "Turn it back on with: tkr network on\n")
      );
    }
    return;
  }

  if (cmd === "self-update") {
    const { selfUpdate, defaultDeps } = await import("../self-update");
    const state = await loadState();
    const actions = await selfUpdate(defaultDeps(state?.latestPluginVersion));
    process.stdout.write(`${actions.length ? actions.join("\n") : "up to date"}\n`);
    return;
  }

  if (cmd === "shims-refresh") {
    const report = await healInstall({ shimJs: resolveShimJsPath(), explicit: true, rc: true });
    process.stdout.write(`shims refreshed: ${report.rewrittenShims}\n`);
    return;
  }
  if (cmd === "shims-heal") {
    const healed = await healInstall({ shimJs: resolveShimJsPath(), rc: true }).catch(() => null);
    if (healed?.globalPathRemoved.length) process.stdout.write(`${removedPathNotice(healed.globalPathRemoved)}\n`);
    for (const line of await repairIntegrations().catch(() => [])) process.stdout.write(`${line}\n`);
    return;
  }
  if (cmd === "wrap") {
    await wrapCommand(rest);
    return;
  }

  if (cmd === "setup") {
    const { AGENT_PROBES, detectedAgents, parseSelection, runSetups, setupSummary } = await import("../setup-all");
    if (rest.length && !(rest.length === 1 && rest[0] === "--all")) {
      process.stderr.write("Usage: tkr setup [--all]\n");
      process.exitCode = 1;
      return;
    }
    const found = detectedAgents();
    const skipped = AGENT_PROBES.filter((a) => !found.includes(a));
    if (!found.length) {
      process.stdout.write("No supported agent found on this machine. See tkr discover for the list.\n");
      return;
    }
    let chosen = found;
    if (rest[0] !== "--all") {
      const list = found.map((a, i) => `  ${String(i + 1).padStart(2)}. ${a.label}`).join("\n");
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stdout.write(`Agents found:\n${list}\nRun tkr setup --all to set them all up, or tkr <setup command> for one.\n`);
        return;
      }
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let picked: number[] | null = null;
      try {
        while (picked === null) {
          picked = parseSelection(await rl.question(`Agents found:\n${list}\nSet up which? Enter = all, numbers like 1 3, or none: `), found.length);
          if (picked === null) process.stdout.write("Type all, none, or numbers from the list.\n");
        }
      } finally {
        rl.close();
      }
      chosen = picked.map((i) => found[i]!);
      if (!chosen.length) return;
    }
    const results = runSetups(chosen, selfInvocation(fileURLToPath(import.meta.url)));
    for (const r of results) process.stdout.write(`== ${r.agent.label} (tkr ${r.agent.command})\n${r.output ? `${r.output}\n` : ""}`);
    process.stdout.write(setupSummary(results, skipped).join("\n"));
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  if (cmd === "setup-claude") {
    const { claudeExecutables, claudeSettingsFile, ensureClaudeHooks, removeClaudeHooks } = await import("../claude-hooks");
    const file = claudeSettingsFile();
    const invalid = `Could not update ${file}: it is not valid JSON. Fix it, then run tkr setup-claude again.`;
    if (rest[0] === "--remove") {
      const removed = await removeClaudeHooks();
      process.stdout.write(`${removed === "error" ? invalid : removed === "removed" ? `Removed the tokmizer hooks from ${file}.` : `No tokmizer hooks found in ${file}.`}\n`);
      if (removed === "error") process.exitCode = 1;
      return;
    }
    if (rest.length) {
      process.stderr.write("Usage: tkr setup-claude [--remove]\n");
      process.exitCode = 1;
      return;
    }
    if (!singleBinary()) {
      process.stdout.write("Claude Code loads Tokmizer from its plugin: /plugin marketplace add norwelltw/Tokmizer, then /plugin install tokmizer@tokmizer\n");
      return;
    }
    const status = await ensureClaudeHooks(claudeExecutables());
    process.stdout.write(`${
      status === "error"
        ? invalid
        : status === "plugin"
          ? "Claude Code already runs Tokmizer through its plugin; no hooks added."
          : status === "present"
            ? `Claude Code hooks already set in ${file}.`
            : `Added the tokmizer hooks to ${file}. Restart Claude Code to load them.`
    }\n`);
    for (const line of (await noticeLines()).slice(1)) process.stdout.write(`${line}\n`);
    if (status === "error") process.exitCode = 1;
    return;
  }
  if (cmd === "setup-codex" && rest[0] === "--remove") {
    const { removeCodexHook } = await import("../codex-hooks");
    const removed = await removeCodexHook();
    const bonus = await removeBonuses("codex");
    process.stdout.write(`${removed === "error" ? `Could not update ${codexHooksFile()}: it is not valid JSON.` : removed === "removed" ? `Removed the tokmizer hook from ${codexHooksFile()}.` : `No tokmizer hook found in ${codexHooksFile()}.`}\n`);
    for (const line of bonusRemovalLine(bonus)) process.stdout.write(`${line}\n`);
    if (removed === "error" || bonus === "error") process.exitCode = 1;
    return;
  }
  if (cmd === "uninstall") {
    await uninstallEverything();
    return;
  }
  if (cmd === "setup-codex") {
    await maybeAutoEnroll(BASE_URL);
    const hookJs = fileURLToPath(new URL("./tkr-codex-hook.js", import.meta.url));
    const { setupCodexHook } = await import("../codex-hooks");
    const { hook, repair } = await setupCodexHook(codexHookCommand(process.env.PATH ?? "", hookJs));
    const hookLine =
      hook === "error"
        ? `Could not update ${codexHooksFile()}: it is not valid JSON. Fix it, then run tkr setup-codex again.`
        : hook === "plugin"
          ? "The Tokmizer Codex plugin already runs the Codex hook. In Codex, run /hooks once and approve it."
          : `${hook === "present" ? "Codex hook already set" : "Added the tokmizer hook"} in ${codexHooksFile()}. In Codex, run /hooks once and approve it.`;
    const codexBonus = await bonusLines("codex");
    process.stdout.write(
      [
        ...repair.lines,
        hookLine,
        ...codexBonus.lines,
        "",
        "Last step: restart Codex so it picks up the change.",
        "Check coverage anytime with: tkr discover",
        "Tokmizer is free. No account is required.",
        ...(await noticeLines()),
        ""
      ].join("\n")
    );
    if (hook === "error" || repair.error || codexBonus.error) process.exitCode = 1;
    return;
  }
  if (cmd === "setup-cursor" || cmd === "setup-gemini") {
    const cursor = cmd === "setup-cursor";
    const label = cursor ? "Cursor" : "Gemini CLI";
    const file = cursor ? cursorHooksFile() : geminiSettingsFile();
    const invalid = `Could not update ${file}: it is not valid JSON. Fix it, then run tkr ${cmd} again.`;
    if (rest[0] === "--remove") {
      const removed = cursor ? await removeCursorHook() : await removeGeminiHook();
      const bonus = await removeBonuses(cursor ? "cursor" : "gemini");
      process.stdout.write(
        `${removed === "error" ? invalid : removed === "removed" ? `Removed the tokmizer hook from ${file}.` : `No tokmizer hook found in ${file}.`}\n`
      );
      for (const line of bonusRemovalLine(bonus)) process.stdout.write(`${line}\n`);
      if (removed === "error" || bonus === "error") process.exitCode = 1;
      return;
    }
    if (rest.length) {
      process.stderr.write(`Usage: tkr ${cmd} [--remove]\n`);
      process.exitCode = 1;
      return;
    }
    await maybeAutoEnroll(BASE_URL);
    const hookJs = fileURLToPath(new URL(cursor ? "./tkr-cursor-hook.js" : "./tkr-gemini-hook.js", import.meta.url));
    const command = (cursor ? cursorHookCommand : geminiHookCommand)(process.env.PATH ?? "", hookJs);
    const hook = cursor ? await ensureCursorHook(command) : await ensureGeminiHook(command);
    const extra = await bonusLines(cursor ? "cursor" : "gemini");
    process.stdout.write(
      [
        hook === "error"
          ? invalid
          : `${hook === "present" ? `${label} hook already set` : "Added the tokmizer hook"} in ${file}.`,
        ...extra.lines,
        cursor
          ? "Cursor reloads hooks on its own; restart Cursor if the Hooks tab does not list it."
          : "Restart Gemini CLI, then check it with /hooks panel.",
        "Shell commands run by the agent now go through tokmizer. Check savings anytime with: tkr gain",
        "Tokmizer is free. No account is required.",
        ...(await noticeLines()),
        ""
      ].join("\n")
    );
    if (hook === "error" || extra.error) process.exitCode = 1;
    return;
  }
  const agentSetup = agentSetupFor(cmd);
  if (agentSetup) {
    const target = agentSetupTarget(agentSetup);
    const invalid = `Could not update ${target}. Check that it is valid and writable, then run tkr ${cmd} again.`;
    if (rest[0] === "--remove" && rest.length === 1) {
      const removed = agentSetup.kind === "hook" ? await agentSetup.remove() : await removeAgentShim(agentSetup);
      const bonus = await removeBonuses(agentSetup.host);
      process.stdout.write(
        `${removed === "error" ? invalid : removed === "removed" ? `Removed the tokmizer ${agentSetup.label} integration from ${target}.` : `No tokmizer integration found in ${target}.`}\n`
      );
      for (const line of bonusRemovalLine(bonus)) process.stdout.write(`${line}\n`);
      if (removed === "error" || bonus === "error") process.exitCode = 1;
      return;
    }
    if (rest.length) {
      process.stderr.write(`Usage: tkr ${cmd} [--remove]\n`);
      process.exitCode = 1;
      return;
    }
    await maybeAutoEnroll(BASE_URL);
    const pathEnv = process.env.PATH ?? "";
    const status =
      agentSetup.kind === "hook"
        ? await agentSetup.ensure(agentHookCommand(agentSetup.host as "vibe" | "antigravity", pathEnv, fileURLToPath(new URL("./tkr-agent-hook.js", import.meta.url))))
        : await installAgentShim(agentSetup, fileURLToPath(new URL("../../agent-plugins/", import.meta.url)), tkrArgv(pathEnv, fileURLToPath(import.meta.url)));
    const agentExtra = await bonusLines(agentSetup.host);
    process.stdout.write(
      [
        status === "error"
          ? invalid
          : `${status === "present" ? `${agentSetup.label} integration already set` : `Added the tokmizer ${agentSetup.label} integration`} in ${target}.`,
        ...agentExtra.lines,
        agentSetup.next,
        "Shell commands run by the agent now go through tokmizer. Check savings anytime with: tkr gain",
        "Tokmizer is free. No account is required.",
        ...(await noticeLines()),
        ""
      ].join("\n")
    );
    if (status === "error" || agentExtra.error) process.exitCode = 1;
    return;
  }
  const jsonAgent = jsonHookAgentForSetup(cmd);
  if (jsonAgent) {
    const files = jsonAgent.files().join(", ");
    const invalid = `Could not update ${files}: it is not valid JSON or has an unsupported format. Fix it, then run tkr ${cmd} again.`;
    if (rest[0] === "--remove") {
      const removed = await jsonAgent.remove();
      const bonus = await removeBonuses(jsonAgent.id);
      process.stdout.write(
        `${removed === "error" ? invalid : removed === "removed" ? `Removed the tokmizer hook for ${jsonAgent.label}.` : `No tokmizer hook found for ${jsonAgent.label}.`}\n`
      );
      for (const line of bonusRemovalLine(bonus)) process.stdout.write(`${line}\n`);
      if (removed === "error" || bonus === "error") process.exitCode = 1;
      return;
    }
    if (rest.length) {
      process.stderr.write(`Usage: tkr ${cmd} [--remove]\n`);
      process.exitCode = 1;
      return;
    }
    await maybeAutoEnroll(BASE_URL);
    const hookJs = fileURLToPath(new URL(`./${jsonAgent.bin}.js`, import.meta.url));
    const hook = await jsonAgent.ensure(jsonAgentHookCommand(jsonAgent, process.env.PATH ?? "", hookJs));
    const jsonExtra = await bonusLines(jsonAgent.id);
    process.stdout.write(
      [
        hook === "error"
          ? invalid
          : `${hook === "present" ? `${jsonAgent.label} hook already set` : "Added the tokmizer hook"} in ${files}.`,
        ...jsonExtra.lines,
        jsonAgent.restart,
        "Shell commands run by the agent now go through tokmizer. Check savings anytime with: tkr gain",
        "Tokmizer is free. No account is required.",
        ...(await noticeLines()),
        ""
      ].join("\n")
    );
    if (hook === "error" || jsonExtra.error) process.exitCode = 1;
    return;
  }
  if (cmd === "shim") {
    const sub = rest[0] ?? "install";
    if (sub === "install") {
      const idx = rest.indexOf("--runner");
      const runner = idx >= 0 ? rest[idx + 1] : resolveShimJsPath();
      const created = await installShims(runner ?? resolveShimJsPath());
      process.stdout.write(`Installed ${created.length} shims into ${shimsDir()}\n`);
      if (rest.includes("--global-path")) {
        const r = await setGlobalPath(true);
        if (r.files.length) process.stdout.write(`Added PATH to ${r.files.join(", ")}. Open a new terminal to activate.\n`);
        else if (r.manual) {
          process.stdout.write(`Add this to your shell profile, then open a new terminal:\n${r.manual}`);
          process.exitCode = 1;
          return;
        } else process.stdout.write("PATH already set. Open a new terminal if not active.\n");
      } else process.stdout.write(shimPathNote());
      const state = (await loadState()) ?? (await maybeAutoEnroll(BASE_URL));
      process.stdout.write(
        state
          ? "Free access is ready. No account is required.\n"
          : networkEnabled()
            ? "Free activation is pending. When online, run: tkr status\n"
            : "Network is off: Tokmizer runs with its built-in rules. Turn it back on with: tkr network on\n"
      );
      for (const line of (await noticeLines()).slice(1)) process.stdout.write(`${line}\n`);
      return;
    }
    if (sub === "uninstall") {
      const n = await uninstallShims();
      const { files } = await setGlobalPath(false);
      process.stdout.write(`Removed ${n} shims from ${shimsDir()}\n`);
      for (const f of files) process.stdout.write(`Removed the Tokmizer PATH line from ${f} (backup in ~/.tokmizer/backup/rc).\n`);
      return;
    }
    if (sub === "global-path") {
      const mode = rest[1] ?? "status";
      if (mode === "status") {
        process.stdout.write(`Global PATH: ${globalPathOptedIn() ? "on — every terminal goes through Tokmizer (turn off: tkr shim global-path off)" : "off — shims only run inside agents started with tkr wrap"}\n`);
        return;
      }
      if (mode !== "on" && mode !== "off") {
        process.stderr.write("Usage: tkr shim global-path [on|off|status]\n");
        process.exitCode = 1;
        return;
      }
      if (mode === "on" && !shimsInstalled()) await installShims(resolveShimJsPath());
      const r = await setGlobalPath(mode === "on");
      if (mode === "on") {
        if (r.files.length) process.stdout.write(`Added PATH to ${r.files.join(", ")}. Open a new terminal to activate.\n`);
        else if (r.manual) {
          process.stdout.write(`Add this to your shell profile, then open a new terminal:\n${r.manual}`);
          process.exitCode = 1;
        } else process.stdout.write("PATH already set. Open a new terminal if not active.\n");
      } else {
        for (const f of r.files) process.stdout.write(`Removed the Tokmizer PATH line from ${f} (backup in ~/.tokmizer/backup/rc).\n`);
        process.stdout.write("Global PATH off. Open a new terminal for it to take effect.\n");
      }
      return;
    }
    process.stderr.write(`Unknown shim subcommand: ${sub}\n`);
    process.exitCode = 1;
    return;
  }
  if (cmd === "status") {
    process.stdout.write(`YOLO: ${yoloEnabled() ? "on" : "off"} (this machine only)\n`);
    process.stdout.write(`Network: ${networkStatusLabel()}${networkEnabled() ? "" : " (built-in and cached rules only; re-enable: tkr network on)"}\n`);
    const s = (await loadState()) ?? (await maybeAutoEnroll(BASE_URL));
    if (!s) {
      process.stdout.write(
        networkEnabled()
          ? "Tokmizer starts automatically on the first online run. Could not reach tokmizer.com right now. Retry later, or run: tkr link\n"
          : "Tokmizer compresses with its built-in rules. Nothing is sent while network is off.\n"
      );
      for (const line of (await noticeLines()).slice(1)) process.stdout.write(`${line}\n`);
      return;
    }
    const power = powerAvailable(gatingPlan(s), gatingBonus(s));
    process.stdout.write(
      `Status ${s.status} | ${s.email ? `Account ${s.email}` : "Not linked (run tkr link to see your savings on the dashboard)"}\n`
    );
    process.stdout.write(`power: ${power ? "available" : "locked"}\n`);
    if (power) {
      const cmdOk = await commandInstalled("power");
      const skillOk = (await readSkill("power")) !== null;
      if (!cmdOk || !skillOk) {
        const refresh = await readBundleRefresh();
        const failed = refresh?.error ? ` (last sync failed: ${refresh.error})` : "";
        process.stdout.write(`/power not synced yet${failed} — run: tkr heartbeat\n`);
      }
    }
    if (graceExceeded(s)) {
      process.stdout.write(
        networkEnabled()
          ? "Offline too long — reconnect (tkr heartbeat) to refresh your local state.\n"
          : "Network is off — compression uses the built-in and last downloaded rules.\n"
      );
    }
    const hint = await telemetryHintLine();
    if (hint) process.stdout.write(`${hint}\n`);
    for (const line of (await noticeLines()).slice(1)) process.stdout.write(`${line}\n`);
    return;
  }
  if (cmd === "gain") {
    const usage = "Usage: tkr gain [--day|--week|--month] [--project [path]] [--json] [--csv|--graph|--history|--by-rule|--failures|--quota [pro|5x|20x]]\n";
    const n = new Date();
    const dayStart = (daysAgo: number): number =>
      Math.floor(new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo).getTime() / 1000);
    const periodFlags: Record<string, { since: number; subtitle: string; daily: boolean }> = {
      "--day": { since: dayStart(0), subtitle: "today", daily: false },
      "--jour": { since: dayStart(0), subtitle: "today", daily: false },
      "--week": { since: dayStart(6), subtitle: "last 7 days", daily: true },
      "--semaine": { since: dayStart(6), subtitle: "last 7 days", daily: true },
      "--month": { since: dayStart(29), subtitle: "last 30 days", daily: true },
      "--mois": { since: dayStart(29), subtitle: "last 30 days", daily: true }
    };
    const modeFlags = new Set(["--csv", "--graph", "--history", "--by-rule", "--failures", "--quota"]);
    let period: { since: number; subtitle: string; daily: boolean } | undefined;
    let mode: string | undefined;
    let json = false;
    let tier: QuotaTier = "pro";
    let project: string | undefined;
    let bad = false;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (periodFlags[arg] && !period) period = periodFlags[arg];
      else if (arg === "--json" && !json) json = true;
      else if (modeFlags.has(arg) && !mode) {
        mode = arg;
        const next = rest[i + 1];
        if (arg === "--quota" && next != null && !next.startsWith("--")) {
          if (Object.hasOwn(QUOTA_TIERS, next)) tier = next as QuotaTier;
          else bad = true;
          i += 1;
        }
      } else if (arg === "--project" && project == null) {
        const next = rest[i + 1];
        const explicit = next != null && !next.startsWith("--");
        if (explicit) i += 1;
        project = normalizeProject(explicit ? next : process.cwd());
      } else bad = true;
    }
    if (bad || (json && mode != null && !["--by-rule", "--failures", "--quota"].includes(mode))) {
      process.stderr.write(usage);
      process.exitCode = 1;
      return;
    }
    const quotaDefault = mode === "--quota" && !period ? { since: dayStart(29), subtitle: "last 30 days" } : undefined;
    const sinceTs = period?.since ?? quotaDefault?.since ?? 0;
    const subtitle = period?.subtitle ?? quotaDefault?.subtitle;
    const showDaily = period?.daily ?? false;
    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    const scopeLabel = `${subtitle ?? "all time"}${project ? ` · ${projectLabel(project)}` : ""}`;
    const projectNote = project ? `  Project ${project}: live journal only, rotated history not included.\n` : "";
    if (json) {
      const [agg, jsonState, restoreCache, rtkImport] = await Promise.all([readGain(undefined, sinceTs, project), loadState(), contentCacheStats(), !sinceTs && !project ? loadRtkImport() : null]);
      const price = effectivePricePerMtok(agg.savedByProvider);
      process.stdout.write(JSON.stringify({
        ...agg,
        restoreCache,
        ...(mode === "--quota" ? { quota: quotaEstimate(agg, tier) } : {}),
        savedUsd: Number(((agg.savedTokens / 1e6) * price).toFixed(2)),
        savedUsdBasis: "reference-input-price",
        savedUsdScope: "reduced-outputs",
        netSavedUsd: Number((((agg.observed?.savedTokens ?? agg.savedTokens) / 1e6) * price).toFixed(2)),
        netSavedUsdScope: "all-observed-outputs",
        referencePricePerMtok: price,
        plan: jsonState?.plan ?? "free",
        ...(rtkImport ? { importedFromRtk: { commands: rtkImport.commands, savedTokens: rtkImport.savedTokens, inputTokens: rtkImport.inputTokens, outputTokens: rtkImport.outputTokens, firstAt: rtkImport.firstAt, lastAt: rtkImport.lastAt, scope: "rtk-estimate-not-in-totals" } } : {}),
        ...(sinceTs ? { since: sinceTs } : {}),
        ...(project ? { project, projectScope: "live-journal" } : {})
      }) + "\n");
      return;
    }
    if (mode === "--by-rule" || mode === "--failures" || mode === "--quota") {
      const agg = await readGain(undefined, sinceTs, project);
      const view = mode === "--by-rule"
        ? renderByRule(agg, { color, subtitle: scopeLabel })
        : mode === "--failures"
          ? renderFallbacks(agg, { subtitle: scopeLabel })
          : renderQuota(quotaEstimate(agg, tier), { color, subtitle: scopeLabel });
      process.stdout.write(view + projectNote);
      return;
    }
    if (mode === "--csv") {
      process.stdout.write(renderCsv(await readAgentDaily(undefined, sinceTs, project)));
      return;
    }
    if (mode === "--graph") {
      const graphSince = period ? sinceTs : dayStart(29);
      const rows = await readAgentDaily(undefined, graphSince, project);
      const graphScope = `${subtitle ?? "last 30 days"}${project ? ` · ${projectLabel(project)}` : ""}`;
      process.stdout.write(renderGraph(rows, { color, sinceTs: graphSince, nowTs: Math.floor(n.getTime() / 1000), subtitle: graphScope }) + projectNote);
      return;
    }
    if (mode === "--history") {
      process.stdout.write(renderHistory(await readHistory(undefined, sinceTs, project), { color, subtitle: scopeLabel }) + projectNote);
      return;
    }
    const [agg, gainState, today, week] = await Promise.all([
      readGain(undefined, sinceTs, project),
      loadState(),
      period ? undefined : readGain(undefined, dayStart(0), project),
      period ? undefined : readGain(undefined, dayStart(6), project)
    ]);
    const agentPeriod = (g: Awaited<ReturnType<typeof readGain>>) => ({
      savedTokens: g.agent ? g.agent.rawTokens - g.agent.filteredTokens : g.observed?.savedTokens ?? g.savedTokens,
      count: g.agent?.count ?? g.count
    });
    const periods = today && week ? [
      { label: "Today", ...agentPeriod(today) },
      { label: "Last 7 days", ...agentPeriod(week) }
    ] : undefined;
    const price = effectivePricePerMtok(agg.savedByProvider);
    const linked = gainState?.linked ?? (Boolean(gainState?.jwt) && gainState?.plan !== "free");
    const cacheStats = await contentCacheStats().catch(() => null);
    const restoreCache = cacheStats ? { entries: cacheStats.entries, bytes: cacheStats.bytes, kept: retentionLabel() } : undefined;
    let out = renderGain(agg, { color, pricePerMtok: price, subtitle: scopeLabel, periods, restoreCache });
    const rtkImport = !period && !project ? await loadRtkImport() : null;
    if (rtkImport) out += renderRtkImportLine(rtkImport);
    if (project) out += (agg.count === 0 ? "\n" : "") + projectNote;
    if (!linked) out += "  Not linked: run tkr link to see these on your dashboard.\n";
    if (showDaily) {
      const table = renderDaily(await readDaily(undefined, sinceTs, project), { color });
      if (table) out += "\n" + table;
    }
    if (gainState?.relinkRequired) {
      out += "  ⚠ dashboard link lost — run: tkr link <your-token> (from tokmizer.com/dashboard)\n";
    }
    if (gainState?.updateRequired) {
      out += "  ⚠ plugin update required — run: /tkr-update\n";
    } else if (isOlderVersion(PLUGIN_VERSION, gainState?.latestPluginVersion)) {
      out += `  ⚠ you run v${PLUGIN_VERSION}, v${gainState?.latestPluginVersion} is out — older versions undercount savings. Run /tkr-update, then RESTART Claude Code.\n`;
    }
    if (gainState?.clockSkewDetected) {
      out += "  ⚠ system clock looks off — sync it, then run: tkr heartbeat\n";
    }
    const builtinRules = async (): Promise<number | null> => {
      const { defaultRulesRuntime } = await import("../default-rules");
      return defaultRulesRuntime()?.ruleCount ?? null;
    };
    try {
      const { connectDaemon } = await import("../daemon/client");
      const client = await connectDaemon();
      const info = await client.ping();
      client.close();
      let cachedRules: number | null = null;
      if (info.ruleCount === 0) {
        const { runtimeFromCache } = await import("../daemon/runtime");
        cachedRules = (await runtimeFromCache())?.ruleCount ?? null;
      }
      out += engineNotice(info.ruleCount, cachedRules, info.ruleCount === 0 ? await builtinRules() : null);
    } catch {
      const { runtimeFromCache } = await import("../daemon/runtime");
      const cached = await runtimeFromCache();
      out += engineNotice(null, cached ? cached.ruleCount : null, await builtinRules());
    }
    const hint = await telemetryHintLine();
    if (hint) out += `  ${hint}\n`;
    for (const notice of (await noticeLines()).slice(1)) out += `${notice.split("\n").map((l) => `  ${l}`).join("\n")}\n`;
    process.stdout.write(out + "\n");
    return;
  }
  if (cmd === "session") {
    process.stdout.write(renderSession(readSession()) + "\n");
    return;
  }
  if (cmd === "discover") {
    const terminal = shimsInstalled() && globalPathOptedIn();
    const agentLine = (name: string, hook: boolean, setup: string): string =>
      `  ${name.padEnd(23)}${hook ? "✅ optimized automatically" : `⚠️  not covered — run: ${setup}`}`;
    const lines = [
      "  tokmizer coverage",
      "  " + "─".repeat(40),
      "  Claude Code / Codex    ✅ optimized automatically",
      agentLine("Cursor", cursorHookInstalled(), "tkr setup-cursor"),
      agentLine("Gemini CLI", geminiHookInstalled(), "tkr setup-gemini"),
      ...AGENT_SETUPS.map((a) => agentLine(a.label, agentIntegrationInstalled(a), `tkr ${a.command}`)),
      ...JSON_HOOK_AGENTS.map((a) => agentLine(a.label, a.installed(), a.setup)),
      terminal
        ? "  Your terminal          ✅ routed through Tokmizer (tkr shim global-path on)"
        : "  Your terminal          unchanged (optional: tkr shim global-path on)",
      `  ${"Aider, Cline, Windsurf".padEnd(23)}start with: tkr wrap <agent>`
    ];
    lines.push("");
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  if (cmd === "restore") {
    const r = await restoreCommand(rest);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.code === 0 && r.stdout && r.restoredTokens) {
      recordStat(0, Buffer.byteLength(r.stdout, "utf8"), undefined, false, detectHost().host, "restore", "tkr restore", process.cwd());
    }
    if (r.code === 0 && r.restoredTokens) {
      const settings = await loadSettingsCache();
      await recordTelemetry({
        cmd: "restore",
        tokensSaved: 0,
        tokensRestored: r.restoredTokens,
        optimized: false,
        telemetryOptIn: settings.telemetryOptIn,
        host: detectHost().host
      });
    }
    process.exitCode = r.code;
    return;
  }
  if (cmd === "filters") {
    const { trustUserFilters, untrustUserFilters, runUserFilterTests, userFiltersDir } = await import("../engine/user-filters");
    const sub = rest[0];
    const names = rest.slice(1);
    const dir = userFiltersDir();
    if (sub === "trust") {
      const { trusted, missing } = await trustUserFilters(names);
      if (trusted.length > 0) process.stdout.write(`Trusted ${trusted.length} filter file${trusted.length === 1 ? "" : "s"} in ${dir}: ${trusted.join(", ")}\nEditing a file revokes its trust until you run this again.\n`);
      else if (missing.length === 0) process.stdout.write(`No *.toml file in ${dir}.\n`);
      if (missing.length > 0) {
        process.stderr.write(`tkr filters: not found in ${dir}: ${missing.join(", ")}\n`);
        process.exitCode = 1;
      }
      return;
    }
    if (sub === "untrust") {
      const removed = await untrustUserFilters(names);
      process.stdout.write(removed.length > 0 ? `No longer used: ${removed.join(", ")}\n` : "Nothing to untrust.\n");
      return;
    }
    if (sub === "test" && names.length <= 1) {
      const { results, issues, untested } = await runUserFilterTests(names[0]);
      const lines: string[] = [];
      const indent = (text: string): string => text.trimEnd().split("\n").map((l) => `      ${l}`).join("\n");
      for (const issue of issues) lines.push(`  skipped ${issue.file}: ${issue.message}`);
      for (const r of results) {
        const label = `${r.rule} #${r.index}${r.name ? ` (${r.name})` : ""}`;
        lines.push(`  ${r.pass ? "PASS" : "FAIL"} ${label}`);
        if (!r.pass) lines.push("    expected:", indent(r.expected), "    got:", indent(r.actual));
      }
      const failed = results.filter((r) => !r.pass).length;
      if (names[0] && results.length === 0 && !untested.includes(names[0])) {
        lines.push(`  No rule named ${names[0]} in ${dir}.`);
        process.exitCode = 1;
      } else if (results.length === 0) {
        lines.push(`  No inline test found. Add [[filters.<name>.tests]] with input and expected to a file in ${dir}.`);
      } else {
        lines.push(`  ${results.length} test${results.length === 1 ? "" : "s"}: ${results.length - failed} passed, ${failed} failed`);
      }
      if (untested.length > 0) lines.push(`  Without tests: ${untested.join(", ")}`);
      process.stdout.write(lines.join("\n") + "\n");
      if (failed > 0 || issues.length > 0) process.exitCode = 1;
      return;
    }
    process.stderr.write("Usage: tkr filters trust [file…] | untrust [file…] | test [rule]\n");
    process.exitCode = 1;
    return;
  }
  if (cmd === "heartbeat") {
    if (!networkEnabled()) {
      process.stderr.write(`${NETWORK_OFF_MESSAGE}\n`);
      process.exitCode = 1;
      return;
    }
    await maybeAutoEnroll(BASE_URL);
    const startedAt = Date.now();
    const s = await heartbeat(BASE_URL);
    if (!s || (s.lastHeartbeatOkAt ?? 0) < startedAt) {
      process.stderr.write("Heartbeat failed\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`OK status=${s.status}\n`);
    await syncRulesQuietly();
    const hbRefresh = await readBundleRefresh();
    if (hbRefresh?.error) {
      process.stdout.write(`Note: feature sync failed: ${hbRefresh.error}\n`);
    }
    return;
  }
  if (cmd === "settings") {
    if ((rest[0] ?? "show") === "show") {
      process.stdout.write(`YOLO: ${yoloEnabled() ? "on" : "off"} (this machine only)\n`);
    }
    await maybeAutoEnroll(BASE_URL);
    await settingsCommand(rest);
    return;
  }
  if (cmd === "telemetry") {
    if (!["off", "status", "forget"].includes(rest[0] ?? "status")) await maybeAutoEnroll(BASE_URL);
    await telemetryCommand(rest);
    return;
  }
  if (cmd === "reducer") {
    const LEVELS = ["off", "light", "balanced", "max"] as const;
    type Level = (typeof LEVELS)[number];
    const DESC: Record<Level, string> = {
      off: "default: responses untouched",
      light: "trims padding, keeps natural prose",
      balanced: "dense and direct, answer first",
      max: "telegraphic, every token earns its place"
    };
    const level = rest[0]?.toLowerCase() as Level | undefined;
    if (!level) {
      const cached = await loadSettingsCache();
      const readiness = cached.reducer === "off" ? ""
        : !cached.enabled ? "Tokmizer is disabled; the reducer is inactive.\n"
          : await readSkill(`reducer-${cached.reducer}`) ? "Ready for the next agent session.\n"
            : "Reducer ruleset unavailable; reconnect and run: tkr heartbeat\n";
      process.stdout.write(
        `Reducer: ${cached.reducer}\n` +
          LEVELS.map((l) => `  ${l.padEnd(10)}  ${DESC[l]}`).join("\n") +
          "\nReducer guides the response style of every agent set up with Tokmizer (see tkr doctor); command output compression is separate.\n" +
          readiness +
          "Change it: tkr reducer <off|light|balanced|max>\n"
      );
      return;
    }
    if (!LEVELS.includes(level)) {
      process.stderr.write(`Unknown level: ${rest[0]}. Use off, light, balanced or max.\n`);
      process.exitCode = 1;
      return;
    }
    await maybeAutoEnroll(BASE_URL);
    try {
      const r = await patchSettings({ reducer: level });
      if (r.settings.reducer === "off") {
        await syncRulesQuietly();
        process.stdout.write("Reducer off. Agent responses back to normal next session.\n");
      } else if (!r.settings.enabled) {
        await syncRulesQuietly();
        process.stdout.write(`Reducer saved as ${r.settings.reducer}. Tokmizer is disabled; enable it with: tkr settings set enabled true\n`);
      } else {
        await heartbeat(BASE_URL);
        if (!(await readSkill(`reducer-${r.settings.reducer}`))) {
          process.stderr.write(
            networkEnabled()
              ? `Reducer saved as ${r.settings.reducer}, but its ruleset is unavailable. Reconnect and run: tkr heartbeat before starting a new agent session.\n`
              : `Reducer saved as ${r.settings.reducer}, but its ruleset was never downloaded and network is off. Run tkr network on, then tkr heartbeat.\n`
          );
          process.exitCode = 1;
          return;
        }
        await syncRulesQuietly();
        process.stdout.write(
          `Reducer set to ${r.settings.reducer}. Its response-style instructions load in the next session of each agent set up with Tokmizer.\n`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("plan_required") || msg.toLowerCase().includes("smart and pro")) {
        process.stdout.write(
          "Reducer is not available on this token right now.\n"
        );
      } else {
        process.stdout.write(`${msg}\n`);
      }
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "compression") {
    if (rest.length > 1) {
      process.stderr.write("Usage: tkr compression [light|balanced|max]\n");
      process.exitCode = 1;
      return;
    }
    const LEVEL_ALIASES: Record<string, "normal" | "compact" | "minimal"> = {
      light: "normal",
      balanced: "compact",
      max: "minimal",
      normal: "normal",
      compact: "compact",
      minimal: "minimal"
    };
    const DISPLAY: Record<"normal" | "compact" | "minimal", string> = {
      normal: "light",
      compact: "balanced",
      minimal: "max"
    };
    const level = rest[0];
    if (!level) {
      const cached = await loadSettingsCache();
      const yolo = yoloEnabled();
      process.stdout.write(
        (yolo
          ? `Compression: YOLO (this machine only)\nStandard level: ${DISPLAY[cached.outputVerbosity]}\nContent and diagnostics can be lost; discarded output cannot be restored.\n`
          : `Compression: ${DISPLAY[cached.outputVerbosity]}\n`) +
          `YOLO: ${yolo ? "on" : "off"} (this machine only)\n` +
          `  light       gentle: standard cleanup only\n` +
          `  balanced    default: also collapses repeated output and blank runs\n` +
          `  max         strongest standard level: also drops verbose log noise\n` +
          `Change standard level and leave YOLO: tkr compression <light|balanced|max>\n` +
          `Local mode: tkr yolo <on|off|status>\n`
      );
      return;
    }
    const wire = Object.hasOwn(LEVEL_ALIASES, level.toLowerCase()) ? LEVEL_ALIASES[level.toLowerCase()] : undefined;
    if (!wire) {
      process.stderr.write(`Unknown level: ${level}. Use light, balanced or max.\n`);
      process.exitCode = 1;
      return;
    }
    await setYoloMode(false);
    process.stdout.write("YOLO: off (this machine only)\n");
    try {
      await maybeAutoEnroll(BASE_URL);
      const r = await patchSettings({ outputVerbosity: wire });
      process.stdout.write(`Compression set to ${DISPLAY[r.settings.outputVerbosity]}. Applies to your next commands.\n`);
    } catch (e) {
      process.stderr.write(`Could not update standard compression: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  help();
  process.exitCode = ["help", "--help", "-h"].includes(cmd) ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message ?? e}\n`);
  process.exitCode = 1;
});

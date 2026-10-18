import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Plan, Settings } from "./contracts";
import { patchSettings, getSettings } from "./settings-client";
import { powerAvailable } from "./engine/plans";
import { loadState } from "./state";
import { gatingPlan, gatingBonus } from "./entitlement";
import { setYoloMode } from "./yolo-mode";

const RECOMMENDED: Partial<Settings> = {
  enabled: true,
  outputVerbosity: "compact",
  filters: { enableAll: true, disabled: [] }
};

const TELEMETRY_WHY =
  "\nHelp improve Tokmizer\n" +
  "By default Tokmizer collects the NAME of the commands you run, like \"git\" or \"docker\",\n" +
  "and whether we managed to compress them. Never their arguments, your output,\n" +
  "your file paths, or anything inside them. It just shows us which commands to\n" +
  "optimize next, so you save even more over time. Turn it off anytime with\n" +
  "tkr telemetry off; your choice survives updates.\n\n";

async function askTelemetry(rl: RL): Promise<boolean> {
  stdout.write(TELEMETRY_WHY);
  return askYesNo(rl, "Share command names and token counts to help improve filters?", true);
}

type RL = readline.Interface;

async function ask(rl: RL, q: string, def: string): Promise<string> {
  const a = (await rl.question(`${q} [${def}]: `)).trim();
  return a.length === 0 ? def : a;
}

async function askYesNo(rl: RL, q: string, defYes: boolean): Promise<boolean> {
  const def = defYes ? "Y/n" : "y/N";
  const a = (await rl.question(`${q} [${def}]: `)).trim().toLowerCase();
  if (a === "") return defYes;
  return a === "y" || a === "yes";
}

async function askEnum<T extends string>(
  rl: RL,
  q: string,
  options: readonly T[],
  def: T
): Promise<T> {
  const a = (await rl.question(`${q} (${options.join(" / ")}) [${def}]: `)).trim().toLowerCase();
  if (a.length === 0) return def;
  const found = options.find((o) => o === a);
  return found ?? def;
}

async function runCustom(rl: RL, plan: Plan, bonusActive: boolean): Promise<Partial<Settings>> {
  stdout.write("\nLet us walk through each setting. Press Enter to keep the default.\n\n");

  const enabled = await askYesNo(rl, "Enable Tokmizer optimizations?", true);
  const outputVerbosity = await askEnum(
    rl,
    "Output verbosity",
    ["normal", "compact", "minimal"] as const,
    "normal"
  );
  const enableAll = await askYesNo(rl, "Enable all built-in filters?", true);
  let disabled: string[] = [];
  if (!enableAll) {
    const raw = await ask(rl, "Comma-separated slugs to DISABLE (e.g. git,grep)", "");
    disabled = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const patch: Partial<Settings> = {
    enabled,
    outputVerbosity,
    filters: { enableAll, disabled }
  };

  if (powerAvailable(plan, bonusActive)) {
    stdout.write("\n/power is available right now on this token.\n");
  } else if (plan === "smart") {
    stdout.write(
      "\n/power is included with Pro.\nIt is NOT available on this token today.\n"
    );
  }

  return patch;
}

export async function runConfigure(plan: Plan, bonusActive = false): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const bonusLabel = bonusActive ? " (bonus window active)" : "";
    stdout.write(`\nConfigure Tokmizer (current plan: ${plan}${bonusLabel})\n\n`);
    stdout.write("  1) Recommended  - sane defaults, ready to go\n");
    stdout.write("  2) Custom       - walk through each option\n\n");
    const choice = await ask(rl, "Choose 1 or 2", "1");
    const base =
      choice === "2" ? await runCustom(rl, plan, bonusActive) : { ...RECOMMENDED };
    const telemetryOptIn = await askTelemetry(rl);
    const patch: Partial<Settings> = { ...base, telemetryOptIn };
    stdout.write("\nSaving...\n");
    const r = await patchSettings(patch);
    await setYoloMode(false);
    stdout.write("Done.\n");
    stdout.write("YOLO: off (this machine only)\n");
    stdout.write(`${JSON.stringify(r.settings, null, 2)}\n`);
    stdout.write("\nYou can re-run this any time with: tkr settings configure\n");
    stdout.write((await loadState())?.linked === false
      ? "These settings are saved only on this machine.\n"
      : "Or edit at: https://tokmizer.com/dashboard/settings\n");
  } finally {
    rl.close();
  }
}

export async function runConfigureFromCli(): Promise<void> {
  const cur = await getSettings();
  const st = await loadState();
  const plan = st ? gatingPlan({ ...st, plan: cur.plan }) : cur.plan;
  const bonus = st ? gatingBonus(st) : false;
  await runConfigure(plan, bonus);
}

import { existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { tokmizerHome } from "../paths";
import { failOpenFile, shimFallbackFile, shimsDir } from "./sh";

export { failOpenActive } from "./sh";
import { hookLauncherFile, launchTargetFor, launcherHealthy, readLauncher, writeHookLauncher, writeLauncher } from "./launcher";
import { countGlobalPathLines, refreshStaleShims, removeGlobalPathLines, shimsInstalled, currentShim } from "./install";

export type HealReport = {
  staleShims: number;
  rewrittenShims: number;
  launcher: "ok" | "stale" | "written" | "failed" | "absent";
  hookLauncher: "ok" | "stale" | "written" | "failed" | "absent";
  globalPathRemoved: string[];
  globalPathLines: number;
};

function healedFile(): string {
  return join(tokmizerHome(), "healed");
}

function bumpHealed(n: number): void {
  if (n <= 0) return;
  try {
    const prev = Number(readFileSync(healedFile(), "utf8")) || 0;
    mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
    writeFileSync(healedFile(), String(prev + n), { mode: 0o600 });
  } catch {}
}

export async function healInstall(opts: { shimJs: string; explicit?: boolean; rc?: boolean; dryRun?: boolean }): Promise<HealReport> {
  const report: HealReport = { staleShims: 0, rewrittenShims: 0, launcher: "absent", hookLauncher: "absent", globalPathRemoved: [], globalPathLines: 0 };
  if (os.platform() !== "win32" && existsSync(hookLauncherFile())) {
    const healthy = launcherHealthy(readLauncher(hookLauncherFile()));
    const target = launchTargetFor(opts.shimJs);
    const rewrite = !healthy || (opts.explicit === true && (target.single !== "" || target.js !== ""));
    if (!rewrite || (opts.dryRun && healthy)) report.hookLauncher = "ok";
    else if (opts.dryRun) report.hookLauncher = "stale";
    else report.hookLauncher = (await writeHookLauncher(target)) ? "written" : "failed";
  }
  const hasShims = existsSync(shimsDir()) && shimsInstalled();
  if (hasShims && os.platform() !== "win32") {
    const healthy = launcherHealthy(readLauncher());
    const target = launchTargetFor(opts.shimJs);
    const rewrite = !healthy || (opts.explicit === true && (target.single !== "" || target.js !== ""));
    if (!rewrite || (opts.dryRun && healthy)) report.launcher = "ok";
    else if (opts.dryRun) report.launcher = "stale";
    else report.launcher = (await writeLauncher(target)) ? "written" : "failed";
  }
  if (hasShims) {
    const shims = await refreshStaleShims(opts.shimJs, { dryRun: opts.dryRun === true });
    report.staleShims = shims.stale;
    report.rewrittenShims = shims.rewritten;
  }
  if (opts.rc) {
    if (!opts.dryRun) report.globalPathRemoved = await removeGlobalPathLines();
    report.globalPathLines = await countGlobalPathLines();
  }
  bumpHealed(report.rewrittenShims + (report.launcher === "written" ? 1 : 0) + (report.hookLauncher === "written" ? 1 : 0) + report.globalPathRemoved.length);
  return report;
}

export function setFailOpen(on: boolean): void {
  try {
    if (on) {
      mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
      writeFileSync(failOpenFile(), String(Date.now()), { mode: 0o600 });
    } else rmSync(failOpenFile(), { force: true });
  } catch {}
}

export function shimFallbackCount(): number {
  try {
    return Math.min(1_000_000, Math.floor(statSync(shimFallbackFile()).size / 2));
  } catch {
    return 0;
  }
}

export function clearShimFallbacks(): void {
  try {
    rmSync(shimFallbackFile(), { force: true });
  } catch {}
}

export function healedCount(): number {
  try {
    return Math.min(1_000_000, Number(readFileSync(healedFile(), "utf8")) || 0);
  } catch {
    return 0;
  }
}

export async function healIfStale(shimJs: string, cmd: string): Promise<void> {
  if (os.platform() === "win32") return;
  try {
    if (currentShim(readFileSync(join(shimsDir(), cmd), "utf8")) && launcherHealthy(readLauncher())) return;
  } catch {
    return;
  }
  await healInstall({ shimJs });
}

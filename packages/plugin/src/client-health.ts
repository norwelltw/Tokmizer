import type { ClientHealth } from "./contracts";
import { loadSettingsCache } from "./settings-cache";
import { brokenIntegrations } from "./hook-health";
import { failOpenActive, healedCount, healInstall, shimFallbackCount } from "./shim/heal";
import { resolveShimJsPath } from "./shim/install";

export async function collectHealth(): Promise<ClientHealth | undefined> {
  try {
    if (!(await loadSettingsCache()).telemetryOptIn) return undefined;
    const dry = await healInstall({ shimJs: resolveShimJsPath(), rc: true, dryRun: true });
    return {
      shimFallbacks: shimFallbackCount(),
      staleShims: Math.min(1000, dry.staleShims + (dry.launcher === "stale" ? 1 : 0) + (dry.hookLauncher === "stale" ? 1 : 0)),
      brokenHooks: Math.min(1000, brokenIntegrations().length),
      globalPathLines: Math.min(100, dry.globalPathLines),
      healed: healedCount(),
      failOpen: failOpenActive()
    };
  } catch {
    return undefined;
  }
}

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokmizerHome } from "./paths";
import { loadSettingsCache } from "./settings-cache";
import { networkEnabled } from "./network";
import { PLUGIN_VERSION } from "./version";

const MARKER = "telemetry-hint-shown";
const NOTICE_MARKER = "telemetry-notice-shown";

export const TELEMETRY_HINT =
  "Usage stats are off on this machine. If you turn them on, they share command names and token counts, never arguments or output. Turn them on with: tkr telemetry on";

export const TELEMETRY_NOTICE =
  "Tokmizer sends usage stats (command names and tokens saved, never content, files or arguments) to improve the product. No account or email needed. To turn off: tkr telemetry off (or tkr network off to cut all network access).";

export function telemetryHintMarker(): string {
  return join(tokmizerHome(), MARKER);
}

export function telemetryNoticeMarker(): string {
  return join(tokmizerHome(), NOTICE_MARKER);
}

function claimOnce(marker: string, value: string): boolean {
  if (existsSync(marker)) return false;
  try {
    mkdirSync(tokmizerHome(), { recursive: true });
    writeFileSync(marker, value, { mode: 0o600 });
  } catch {
    return false;
  }
  return true;
}

export async function telemetryHintLine(): Promise<string | null> {
  if ((await loadSettingsCache()).telemetryOptIn) return null;
  return claimOnce(telemetryHintMarker(), String(Date.now())) ? TELEMETRY_HINT : null;
}

export function telemetryNoticeShown(): boolean {
  return existsSync(telemetryNoticeMarker());
}

export function markTelemetryNoticeShown(): void {
  claimOnce(telemetryNoticeMarker(), `${PLUGIN_VERSION} ${Date.now()}`);
}

export async function telemetryNoticeLine(): Promise<string | null> {
  if (!networkEnabled() || existsSync(telemetryNoticeMarker())) return null;
  if (!(await loadSettingsCache()).telemetryOptIn) return null;
  return claimOnce(telemetryNoticeMarker(), `${PLUGIN_VERSION} ${Date.now()}`) ? TELEMETRY_NOTICE : null;
}

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokmizerHome } from "./paths";

const ENV_OFF = new Set(["0", "off", "false", "no"]);
const NOTICE_MARKER = "network-notice-shown";

export const NETWORK_OFF_MESSAGE = "Network is off for Tokmizer. Turn it back on with: tkr network on";

export const NETWORK_NOTICE = [
  "Tokmizer contacts tokmizer.com to keep its rules up to date and to improve the product. No account or email is needed.",
  "It sends a random install ID, the plugin version and how it was installed (npm, Homebrew, Claude Code...), nothing that describes your machine: no computer name, OS, hardware or user name. Command contents and output are never sent.",
  "Usage stats (command names, token counts and install health counts) are sent only while they are on, to spot when compression gets worse and fix it before it reaches everyone. Check with: tkr telemetry status.",
  "Turn all network access off: tkr network off. Usage stats only: tkr telemetry off."
].join("\n");

export class NetworkDisabledError extends Error {
  constructor() {
    super(NETWORK_OFF_MESSAGE);
    this.name = "NetworkDisabledError";
  }
}

export function networkOffFile(): string {
  return join(tokmizerHome(), "network-off");
}

export function networkOffByEnv(): boolean {
  const raw = process.env.TOKMIZER_NETWORK;
  return raw !== undefined && ENV_OFF.has(raw.trim().toLowerCase());
}

export function networkEnabled(): boolean {
  if (networkOffByEnv()) return false;
  return !existsSync(networkOffFile());
}

export function assertNetworkEnabled(): void {
  if (!networkEnabled()) throw new NetworkDisabledError();
}

export function setNetwork(on: boolean): void {
  if (on) {
    rmSync(networkOffFile(), { force: true });
    return;
  }
  mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
  writeFileSync(networkOffFile(), String(Date.now()), { mode: 0o600 });
}

export function networkStatusLabel(): string {
  if (networkOffByEnv()) return "off (TOKMIZER_NETWORK)";
  return networkEnabled() ? "on" : "off";
}

export function networkNoticeMarker(): string {
  return join(tokmizerHome(), NOTICE_MARKER);
}

export function networkNoticeLine(): string | null {
  if (!networkEnabled()) return null;
  const marker = networkNoticeMarker();
  if (existsSync(marker)) return null;
  try {
    mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
    writeFileSync(marker, String(Date.now()), { mode: 0o600 });
  } catch {
    return null;
  }
  return NETWORK_NOTICE;
}

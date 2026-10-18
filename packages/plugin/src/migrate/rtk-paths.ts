import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import os from "node:os";

export type RtkEnv = { home: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; cwd: string };

export type RtkConfigDir = { dir: string; readByRtk: boolean };

export type RtkBinary = { path: string; version: string | null; compatShim: boolean };

export const RTK_SHIM_MARK = "tokmizer-rtk-compat";

export function currentRtkEnv(): RtkEnv {
  return { home: os.homedir(), env: process.env, platform: process.platform, cwd: process.cwd() };
}

function absEnv(e: RtkEnv, name: string): string | null {
  const value = e.env[name];
  return value && isAbsolute(value) ? value : null;
}

export function rtkConfigDirs(e: RtkEnv): RtkConfigDir[] {
  if (e.platform === "darwin") {
    return [
      { dir: join(e.home, "Library", "Application Support", "rtk"), readByRtk: true },
      { dir: join(e.home, ".config", "rtk"), readByRtk: false }
    ];
  }
  if (e.platform === "win32") {
    return [{ dir: join(absEnv(e, "APPDATA") ?? join(e.home, "AppData", "Roaming"), "rtk"), readByRtk: true }];
  }
  return [{ dir: join(absEnv(e, "XDG_CONFIG_HOME") ?? join(e.home, ".config"), "rtk"), readByRtk: true }];
}

export function rtkDataDir(e: RtkEnv): string {
  if (e.platform === "darwin") return join(e.home, "Library", "Application Support", "rtk");
  if (e.platform === "win32") return join(absEnv(e, "LOCALAPPDATA") ?? join(e.home, "AppData", "Local"), "rtk");
  return join(absEnv(e, "XDG_DATA_HOME") ?? join(e.home, ".local", "share"), "rtk");
}

export function rtkTrustStore(e: RtkEnv): string {
  return join(rtkDataDir(e), "trusted_filters.json");
}

export function rtkConfigFile(e: RtkEnv): string | null {
  for (const { dir, readByRtk } of rtkConfigDirs(e)) {
    const file = join(dir, "config.toml");
    if (readByRtk && existsSync(file)) return file;
  }
  return null;
}

export function rtkHistoryDb(e: RtkEnv, configured?: string | null): string {
  const fromEnv = e.env.RTK_DB_PATH;
  if (fromEnv) return fromEnv;
  if (configured) return configured;
  return join(rtkDataDir(e), "history.db");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findRtkBinary(e: RtkEnv, skipDirs: string[] = [], withVersion = true): RtkBinary | null {
  const pathValue = e.env.PATH ?? e.env.Path ?? "";
  const names = e.platform === "win32" ? ["rtk.exe", "rtk.cmd"] : ["rtk"];
  for (const dir of pathValue.split(e.platform === "win32" ? ";" : delimiter)) {
    if (!dir || skipDirs.includes(dir)) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (!isFile(candidate)) continue;
      let compatShim = false;
      try {
        compatShim = statSync(candidate).size < 4096 && readFileSync(candidate, "utf8").includes(RTK_SHIM_MARK);
      } catch {}
      return { path: candidate, version: compatShim || !withVersion ? null : rtkVersion(candidate, e), compatShim };
    }
  }
  return null;
}

function rtkVersion(bin: string, e: RtkEnv): string | null {
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000, env: { ...e.env, RTK_TELEMETRY_DISABLED: "1" } });
    const line = `${r.stdout ?? ""}`.split("\n")[0]?.trim() ?? "";
    return line || null;
  } catch {
    return null;
  }
}

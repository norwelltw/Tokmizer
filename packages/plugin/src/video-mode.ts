import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tokmizerHome } from "./paths";

export type VideoMode = { global: boolean; projects: string[] };

function videoModeFile(): string {
  return join(tokmizerHome(), "video-mode.json");
}

export function videoProjectRoot(cwd: string = process.cwd()): string {
  let dir: string;
  try {
    dir = realpathSync(resolve(cwd));
  } catch {
    dir = resolve(cwd);
  }
  for (let cur = dir; ; cur = dirname(cur)) {
    if (existsSync(join(cur, ".git"))) return cur;
    if (dirname(cur) === cur) return dir;
  }
}

export function readVideoMode(): VideoMode {
  try {
    const parsed = JSON.parse(readFileSync(videoModeFile(), "utf8")) as Partial<VideoMode>;
    return {
      global: parsed.global === true,
      projects: Array.isArray(parsed.projects) ? parsed.projects.filter((p): p is string => typeof p === "string" && p.length > 0) : []
    };
  } catch {
    return { global: false, projects: [] };
  }
}

export function videoModeEnabled(cwd: string = process.cwd(), mode: VideoMode = readVideoMode()): boolean {
  if (mode.global) return true;
  if (mode.projects.length === 0) return false;
  let dir: string;
  try {
    dir = realpathSync(resolve(cwd));
  } catch {
    dir = resolve(cwd);
  }
  return mode.projects.some((root) => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep));
}

export async function setVideoMode(enabled: boolean, scope: { global: boolean; cwd?: string }): Promise<VideoMode> {
  const current = readVideoMode();
  const root = videoProjectRoot(scope.cwd);
  const next: VideoMode = scope.global
    ? { global: enabled, projects: enabled ? current.projects : [] }
    : { global: current.global, projects: enabled ? [...new Set([...current.projects, root])] : current.projects.filter((p) => p !== root) };
  const path = videoModeFile();
  if (!next.global && next.projects.length === 0) {
    await rm(path, { force: true });
    return next;
  }
  await mkdir(tokmizerHome(), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return next;
}

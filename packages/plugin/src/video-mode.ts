import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tokmizerHome } from "./paths";

// On unless turned off. `projects` turns it on for one project while it is off
// everywhere, `off` turns it off for one project while it is on everywhere.
export type VideoMode = { global: boolean; projects: string[]; off: string[] };

const DEFAULT_MODE: VideoMode = { global: true, projects: [], off: [] };

function pathList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
}

function inside(dir: string, roots: string[]): boolean {
  return roots.some((root) => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep));
}

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
    return { global: parsed.global !== false, projects: pathList(parsed.projects), off: pathList(parsed.off) };
  } catch {
    return { ...DEFAULT_MODE };
  }
}

export function videoModeEnabled(cwd: string = process.cwd(), mode: VideoMode = readVideoMode()): boolean {
  let dir: string;
  try {
    dir = realpathSync(resolve(cwd));
  } catch {
    dir = resolve(cwd);
  }
  if (inside(dir, mode.off)) return false;
  return mode.global || inside(dir, mode.projects);
}

export async function setVideoMode(enabled: boolean, scope: { global: boolean; cwd?: string }): Promise<VideoMode> {
  const current = readVideoMode();
  const root = videoProjectRoot(scope.cwd);
  const next: VideoMode = scope.global
    ? { global: enabled, projects: [], off: [] }
    : enabled
      ? { global: current.global, projects: current.global ? current.projects : [...new Set([...current.projects, root])], off: current.off.filter((p) => p !== root) }
      : { global: current.global, projects: current.projects.filter((p) => p !== root), off: current.global ? [...new Set([...current.off, root])] : current.off };
  const path = videoModeFile();
  if (next.global && next.projects.length === 0 && next.off.length === 0) {
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

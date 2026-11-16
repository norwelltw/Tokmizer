import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { arch, homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { tokmizerHome } from "./paths";
import { videoModeEnabled } from "./video-mode";
import { autoVideoArgs, autoVideoNotice } from "./video-tips";

/** How video mode launches a command: the same for the JS wrapper and the native launcher. */
export type VideoLaunch = { argv: string[]; notice: string; appendPathEnv: Record<string, string> };

// Blender (4.2 and later) adds every BLENDER_SYSTEM_SCRIPTS directory to its own and runs its
// startup modules, also in background renders started by a script (`python3 render.py`).
// This one puts Cycles scenes left on the default CPU device on the Apple GPU, only when the
// Cycles preferences point at Metal. A script that sets the device itself, a `--cycles-device`
// argument, a non-Metal preference and a scene custom property tkr_keep_device = 1 win. Saved
// .blend files keep their device (scenes are tracked by pointer, renames included).
export const BLENDER_GPU_STARTUP = `# Written by Tokmizer video mode (tkr video off removes it from your commands).
import bpy
from bpy.app.handlers import persistent

_flipped = set()


def _metal_ready():
    try:
        addon = bpy.context.preferences.addons.get("cycles")
        if addon is None:
            return False
        prefs = addon.preferences
        if prefs.compute_device_type != "METAL":
            return False
        if not any(d.type == "METAL" for d in prefs.devices):
            prefs.get_devices_for_type("METAL")
        return any(d.type == "METAL" and d.use for d in prefs.devices)
    except Exception:
        return False


@persistent
def _tkr_load_post(*_args):
    _flipped.clear()
    if not _metal_ready():
        return
    for scene in bpy.data.scenes:
        # A scene can opt out: custom property tkr_keep_device = 1.
        if scene.cycles.device == "CPU" and not scene.get("tkr_keep_device"):
            scene.cycles.device = "GPU"
            _flipped.add(scene.as_pointer())


@persistent
def _tkr_save_pre(*_args):
    for scene in bpy.data.scenes:
        if scene.as_pointer() in _flipped and scene.cycles.device == "GPU":
            scene.cycles.device = "CPU"


@persistent
def _tkr_save_post(*_args):
    for scene in bpy.data.scenes:
        if scene.as_pointer() in _flipped and scene.cycles.device == "CPU":
            scene.cycles.device = "GPU"


_HANDLERS = (
    (bpy.app.handlers.load_post, _tkr_load_post),
    (bpy.app.handlers.save_pre, _tkr_save_pre),
    (bpy.app.handlers.save_post, _tkr_save_post),
)


def register():
    if not bpy.app.background:
        return
    for handlers, fn in _HANDLERS:
        if fn not in handlers:
            handlers.append(fn)


def unregister():
    for handlers, fn in _HANDLERS:
        if fn in handlers:
            handlers.remove(fn)
`;

const MIN_BLENDER: [number, number] = [4, 2];
const APP_BINARY_RE = /\.app\/Contents\/MacOS\/Blender$/;
const WRAPPER_EXEC_RE = /exec\s+"([^"]+\.app\/Contents\/MacOS\/Blender)"/;
const PLIST_VERSION_RE = /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\.(\d+)/;

/** The Blender.app behind a `blender` file: the binary itself or a Homebrew wrapper script. */
function blenderApp(file: string): string | null {
  try {
    const real = realpathSync(file);
    if (APP_BINARY_RE.test(real)) return dirname(dirname(dirname(real)));
    if (statSync(real).size > 4096) return null;
    const wrapped = WRAPPER_EXEC_RE.exec(readFileSync(real, "utf8"));
    return wrapped ? dirname(dirname(dirname(wrapped[1]!))) : null;
  } catch {
    return null;
  }
}

function appVersion(app: string): [number, number] | null {
  try {
    const m = PLIST_VERSION_RE.exec(readFileSync(join(app, "Contents", "Info.plist"), "utf8"));
    return m ? [Number(m[1]), Number(m[2])] : null;
  } catch {
    return null;
  }
}

/** Every Blender a command could start (on PATH, Blender*.app in /Applications and ~/Applications) is 4.2 or later, and there is one. */
function installedApps(): string[] {
  const out: string[] = [];
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    try {
      for (const name of readdirSync(dir)) if (/^Blender.*\.app$/i.test(name)) out.push(join(dir, name));
    } catch {}
  }
  return out;
}

export function blenderAddsSystemScripts(pathEnv: string | undefined, apps: string[] = installedApps()): boolean {
  const found = new Set<string>();
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    const app = blenderApp(join(dir, "blender"));
    if (app) found.add(app);
  }
  for (const app of apps) {
    if (appVersion(app)) found.add(app);
  }
  if (found.size === 0) return false;
  for (const app of found) {
    const v = appVersion(app);
    if (!v || v[0] < MIN_BLENDER[0] || (v[0] === MIN_BLENDER[0] && v[1] < MIN_BLENDER[1])) return false;
  }
  return true;
}

/** Directory holding startup/tkr_cycles_gpu.py, rewritten only when its content changed. */
export function blenderGpuScriptsDir(home: string = tokmizerHome()): string | null {
  const dir = join(home, "video", "blender-scripts");
  const file = join(dir, "startup", "tkr_cycles_gpu.py");
  try {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {}
    if (current !== BLENDER_GPU_STARTUP) {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // Atomic: a Blender starting meanwhile never reads half a module.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, BLENDER_GPU_STARTUP, { mode: 0o644 });
      renameSync(tmp, file);
    }
    return dir;
  } catch {
    return null;
  }
}

export type LaunchContext = { platform: NodeJS.Platform; arch: string; pathEnv: string | undefined; enabled: boolean };

export function videoLaunch(argv: string[], cwd: string, ctx?: Partial<LaunchContext>): VideoLaunch {
  const same: VideoLaunch = { argv, notice: "", appendPathEnv: {} };
  try {
    const platform = ctx?.platform ?? process.platform;
    const cpu = ctx?.arch ?? arch();
    if (platform !== "darwin" || cpu !== "arm64") return same;
    if (!(ctx?.enabled ?? videoModeEnabled(cwd))) return same;
    const out: VideoLaunch = { ...same, appendPathEnv: {} };
    const auto = autoVideoArgs(argv, { platform, arch: cpu, totalMemBytes: 0, cpus: 0 });
    if (auto.added) {
      out.argv = auto.argv;
      out.notice = autoVideoNotice(auto.added);
    }
    if (blenderAddsSystemScripts(ctx?.pathEnv ?? process.env.PATH)) {
      const dir = blenderGpuScriptsDir();
      if (dir) out.appendPathEnv.BLENDER_SYSTEM_SCRIPTS = dir;
    }
    return out;
  } catch {
    return same;
  }
}

/** `existing` path list plus `dir`, without duplicating it. */
export function appendPathList(existing: string | undefined, dir: string): string {
  const parts = (existing ?? "").split(delimiter).filter((p) => p.length > 0);
  if (!parts.includes(dir)) parts.push(dir);
  return parts.join(delimiter);
}

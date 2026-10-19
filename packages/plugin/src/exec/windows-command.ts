import { statSync } from "node:fs";
import { extname, join, resolve, win32 } from "node:path";

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function windowsCommand(cmd: string, env: NodeJS.ProcessEnv, cwd: string = process.cwd(), platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || /[\\/:]/.test(cmd)) return cmd;
  const here = resolve(cwd).toLowerCase();
  const pathExts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const exts = extname(cmd) ? ["", ...pathExts] : pathExts;
  for (const dir of (env.Path ?? env.PATH ?? "").split(";")) {
    const entry = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !win32.isAbsolute(entry) || resolve(entry).toLowerCase() === here) continue;
    for (const ext of exts) {
      const candidate = join(entry, `${cmd}${ext.toLowerCase()}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return win32.join(env.SystemRoot || "C:\\Windows", "tkr-not-on-path", cmd);
}

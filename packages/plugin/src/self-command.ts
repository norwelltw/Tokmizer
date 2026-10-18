import { realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import os from "node:os";
import { entryWords } from "./single-entries";

export function singleBinary(): boolean {
  return process.env.TOKMIZER_SINGLE_BINARY === "1";
}

export function selfInvocation(script: string, node: string = process.execPath): string[] {
  const words = singleBinary() ? entryWords(script) : null;
  return words ? [process.execPath, ...words] : [node, script];
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export function stableSelfPath(pathEnv: string = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform, self: string = process.execPath): string {
  const name = platform === "win32" ? "tkr.exe" : "tkr";
  for (const dir of pathEnv.split(platform === "win32" ? ";" : delimiter)) {
    if (!dir || dir.includes("node_modules")) continue;
    const candidate = join(dir, name);
    if (sameFile(candidate, self)) return candidate;
  }
  if (platform !== "win32") {
    const home = os.homedir();
    for (const candidate of [
      join(home, ".local", "bin", name),
      join(home, ".local", "share", "tokmizer", "current", "dist", "bin", name),
      join("/opt/homebrew/bin", name),
      join("/usr/local/bin", name),
      join("/home/linuxbrew/.linuxbrew/bin", name)
    ]) {
      if (sameFile(candidate, self)) return candidate;
    }
  }
  return self;
}

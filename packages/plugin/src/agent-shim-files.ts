import { readFile, unlink } from "node:fs/promises";
import { existsSync, accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeTextPreserving, type HookInstall, type HookRemoval } from "./hook-config";
import { selfInvocation } from "./self-command";
import { backupConfig } from "./config-backup";
import { reducerContextFile } from "./paths";

export const SHIM_ARGV_PLACEHOLDER = "__TKR_ARGV__";
export const SHIM_CONTEXT_PLACEHOLDER = "__TKR_CONTEXT_FILE__";
const SHIM_MARK = '"rewrite", "--host"';

export function tkrArgv(pathEnv: string, installedJs: string, platform: NodeJS.Platform = process.platform, node: string = process.execPath): string[] {
  if (platform !== "win32") {
    for (const dir of pathEnv.split(":")) {
      if (!dir || dir.includes("node_modules")) continue;
      const candidate = join(dir, "tkr");
      try {
        accessSync(candidate, constants.X_OK);
        return [candidate];
      } catch {}
    }
  }
  return selfInvocation(installedJs, node);
}

export function renderShim(template: string, argv: string[], contextFile: string = reducerContextFile()): string {
  return template.split(SHIM_ARGV_PLACEHOLDER).join(JSON.stringify(argv)).split(SHIM_CONTEXT_PLACEHOLDER).join(JSON.stringify(contextFile));
}

export function isOurShim(content: string): boolean {
  return content.includes(SHIM_MARK);
}

export function shimInstalled(file: string): boolean {
  try {
    return isOurShim(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

export async function writeShimFile(file: string, content: string): Promise<HookInstall> {
  try {
    let status: HookInstall = "added";
    if (existsSync(file)) {
      const current = await readFile(file, "utf8");
      if (current === content) return "present";
      if (isOurShim(current)) status = "updated";
      else if (!(await backupConfig(file, current))) return "error";
    }
    return (await writeTextPreserving(file, content)) ? status : "error";
  } catch {
    return "error";
  }
}

export async function removeShimFile(file: string): Promise<HookRemoval> {
  try {
    if (!existsSync(file)) return "absent";
    if (!isOurShim(await readFile(file, "utf8"))) return "absent";
    await unlink(file);
    return "removed";
  } catch {
    return "error";
  }
}

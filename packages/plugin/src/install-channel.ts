import { realpathSync } from "node:fs";
import type { InstallChannel } from "./contracts";
import { singleBinary } from "./self-command";

export function installChannelOf(path: string, single: boolean): InstallChannel | null {
  const p = path.replace(/\\/g, "/");
  if (p.includes("/.claude/plugins/")) return "claude-code";
  if (p.includes("/.codex/plugins/")) return "codex";
  if (p.includes("/_npx/")) return "npx";
  if (/\/(Cellar|homebrew|linuxbrew)\//.test(p)) return "homebrew";
  if (p.includes("/node_modules/@tokmizer/")) return "npm";
  return single ? "script" : null;
}

export function installChannel(): InstallChannel | null {
  const single = singleBinary();
  const entry = single ? process.execPath : process.argv[1] ?? "";
  let path = entry;
  try {
    path = realpathSync(entry);
  } catch {}
  return installChannelOf(path, single);
}

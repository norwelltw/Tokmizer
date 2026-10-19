import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokmizerHome } from "./paths";

export const CODEX_HOOK_NOTICE =
  "An automatic Tokmizer update added its hook to Codex (hooks.json) so Codex commands are optimized too. To remove it: tkr setup-codex --remove";

function noticeFile(): string {
  return join(tokmizerHome(), "codex-hook-notice");
}

export function queueCodexHookNotice(): void {
  try {
    mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
    writeFileSync(noticeFile(), String(Date.now()), { mode: 0o600 });
  } catch {}
}

export function codexHookNoticeLine(): string | null {
  if (!existsSync(noticeFile())) return null;
  try {
    rmSync(noticeFile());
  } catch {
    return null;
  }
  return CODEX_HOOK_NOTICE;
}

import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Resolve the Claude config dir from CLAUDE_CONFIG_DIR: expands a leading `~`
 * (a launcher may set it literally, unexpanded) and makes the path absolute.
 * Falls back to <home>/.claude when unset or empty.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  if (!raw) return join(home, ".claude");
  let p = raw;
  if (p === "~") p = home;
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(home, p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(p);
}

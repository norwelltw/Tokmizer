import os from "node:os";
import { join } from "node:path";

export function tokmizerHome(): string {
  return process.env.TOKMIZER_HOME || join(os.homedir(), ".tokmizer");
}

export function stateFile(): string {
  return join(tokmizerHome(), "state.json");
}

export function installIdFile(): string {
  return join(tokmizerHome(), "install-id");
}

export function enrollCooldownFile(): string {
  return join(tokmizerHome(), "enroll-cooldown");
}

export function bundleRefreshFile(): string {
  return join(tokmizerHome(), "bundle-refresh.json");
}

export function bundleVersionsFile(): string {
  return join(tokmizerHome(), "bundle-versions.json");
}

export function skillsDir(): string {
  return join(tokmizerHome(), "skills");
}

export function skillFile(slug: string): string {
  return join(skillsDir(), `${slug}.md`);
}

export function contentCacheDir(): string {
  return join(tokmizerHome(), "content-cache");
}

export function restoreConfigFile(): string {
  return join(tokmizerHome(), "restore.json");
}

export function contentCacheFile(hash: string): string {
  return join(contentCacheDir(), hash);
}

export function reducerContextFile(): string {
  return join(tokmizerHome(), "reducer-context.txt");
}

export function reducerRulesStateFile(): string {
  return join(tokmizerHome(), "reducer-rules.json");
}

export function managedCommandsFile(): string {
  return join(tokmizerHome(), "managed-commands.json");
}

export function claudeCommandsDir(): string {
  return process.env.TOKMIZER_CLAUDE_COMMANDS_DIR || join(os.homedir(), ".claude", "commands");
}

export function claudeCommandFile(name: string): string {
  return join(claudeCommandsDir(), `${name}.md`);
}

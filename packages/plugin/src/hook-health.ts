import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { claudeSettingsFile } from "./claude-hooks";
import { codexHooksFile } from "./codex-hooks";
import { cursorHooksFile } from "./cursor-hooks";
import { geminiSettingsFile } from "./gemini-hooks";
import { JSON_HOOK_AGENTS } from "./agent-hooks";
import { AGENT_SETUPS, agentSetupTarget } from "./agent-plugins";

export type IntegrationCheck = { id: string; label: string; files: string[] };

const OUR_FILE = /^(?:tkr|tkr-exec(?:\.exe)?|tkr-[a-z-]+\.js|tkr-[a-z]+-hook|tkr-hook|tkr-shim-launch)$/;

export function integrationChecks(): IntegrationCheck[] {
  return [
    { id: "claude", label: "Claude Code", files: [claudeSettingsFile()] },
    { id: "codex", label: "Codex", files: [codexHooksFile()] },
    { id: "cursor", label: "Cursor", files: [cursorHooksFile()] },
    { id: "gemini", label: "Gemini CLI", files: [geminiSettingsFile()] },
    ...JSON_HOOK_AGENTS.map((a) => ({ id: a.id, label: a.label, files: a.files() })),
    ...AGENT_SETUPS.map((a) => ({ id: a.host, label: a.label, files: [agentSetupTarget(a)] }))
  ];
}

export function missingTargets(text: string): string[] {
  const missing = new Set<string>();
  for (const m of text.matchAll(/(['"])((?:\/|[A-Za-z]:(?:\\\\|\\|\/))[^'"\n]+)\1/g)) {
    const path = m[2]!.replace(/\\\\/g, "\\");
    if (OUR_FILE.test(basename(path.replace(/\\/g, "/"))) && !existsSync(path)) missing.add(path);
  }
  return [...missing];
}

export function brokenIntegrations(checks: IntegrationCheck[] = integrationChecks()): { check: IntegrationCheck; missing: string[] }[] {
  const out: { check: IntegrationCheck; missing: string[] }[] = [];
  for (const check of checks) {
    const missing: string[] = [];
    for (const file of check.files) {
      try {
        missing.push(...missingTargets(readFileSync(file, "utf8")));
      } catch {}
    }
    if (missing.length) out.push({ check, missing: [...new Set(missing)] });
  }
  return out;
}

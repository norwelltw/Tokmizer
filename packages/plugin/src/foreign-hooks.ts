import { readFileSync } from "node:fs";
import { isJsonObject, readJsonConfig, writeJsonConfig } from "./hook-config";
import { foreignTo } from "./hook-forms";
import { claudeSettingsFile } from "./claude-hooks";
import { cursorHooksFile } from "./cursor-hooks";
import { geminiSettingsFile } from "./gemini-hooks";
import { JSON_HOOK_AGENTS, droidFiles } from "./agent-hooks";
import { antigravityHooksFile } from "./agent-command-hooks";
import type { RouteHost } from "./hooks-host/payload-host";

export type HealTarget = { id: string; label: string; setup: string; host: RouteHost; files: () => string[] };

export function healTargets(): HealTarget[] {
  return [
    { id: "claude", label: "Claude Code", setup: "tkr setup-claude", host: "claude-code", files: () => [claudeSettingsFile()] },
    { id: "cursor", label: "Cursor", setup: "tkr setup-cursor", host: "cursor", files: () => [cursorHooksFile()] },
    { id: "gemini", label: "Gemini CLI", setup: "tkr setup-gemini", host: "gemini-cli", files: () => [geminiSettingsFile()] },
    { id: "antigravity", label: "Antigravity", setup: "tkr setup-antigravity", host: "antigravity", files: () => [antigravityHooksFile()] },
    ...JSON_HOOK_AGENTS.map((a) => ({ id: a.id, label: a.label, setup: a.setup, host: a.id, files: () => (a.id === "droid" ? droidFiles().map((d) => d.file) : a.files()) }))
  ];
}

export function stripForeign(root: unknown, foreign: (command: unknown) => boolean): string[] {
  const removed: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; ) {
        const item: unknown = value[i];
        if (isJsonObject(item) && foreign(item.command)) {
          removed.push(String(item.command));
          value.splice(i, 1);
          continue;
        }
        const before = removed.length;
        const grouped = isJsonObject(item) && Array.isArray(item.hooks) && item.hooks.length > 0;
        visit(item);
        if (grouped && removed.length > before && !(item as { hooks?: unknown[] }).hooks?.length) value.splice(i, 1);
        else i++;
      }
      return;
    }
    if (!isJsonObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const before = removed.length;
      visit(child);
      if (removed.length > before && Array.isArray(child) && child.length === 0) delete value[key];
    }
  };
  visit(root);
  return removed;
}

export type ForeignFinding = { target: HealTarget; file: string; commands: string[] };

export function foreignFindings(targets: readonly HealTarget[] = healTargets()): ForeignFinding[] {
  const findings: ForeignFinding[] = [];
  for (const target of targets) {
    for (const file of new Set(target.files())) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if (!isJsonObject(parsed)) continue;
      const commands = stripForeign(parsed, foreignTo(target.host));
      if (commands.length) findings.push({ target, file, commands });
    }
  }
  return findings;
}

export function foreignFindingLines(findings: readonly ForeignFinding[]): string[] {
  return findings.map((f) => `${`${f.target.label}:`.padEnd(Math.max(10, f.target.label.length + 2))}${f.file} has ${f.commands.length} Tokmizer hook${f.commands.length === 1 ? "" : "s"} made for another agent (copied or imported) — run: tkr doctor --fix`);
}

export async function healForeignHooks(ensure: (id: string) => Promise<string>, explicit: boolean, findings: readonly ForeignFinding[] = foreignFindings()): Promise<string[]> {
  const lines: string[] = [];
  const byTarget = new Map<HealTarget, ForeignFinding[]>();
  for (const f of findings) byTarget.set(f.target, [...(byTarget.get(f.target) ?? []), f]);
  for (const [target, own] of byTarget) {
    const status = await ensure(target.id).catch(() => "error");
    if (status === "error") {
      if (explicit) lines.push(`Left the Tokmizer hooks copied into ${own.map((f) => f.file).join(", ")}: they still work, but the ${target.label} hook could not be set up (run: ${target.setup}).`);
      continue;
    }
    for (const f of own) {
      const parsed = await readJsonConfig(f.file);
      const removed = parsed ? stripForeign(parsed, foreignTo(target.host)) : [];
      if (!parsed || (removed.length && !(await writeJsonConfig(f.file, parsed)))) {
        if (explicit) lines.push(`Could not update ${f.file}; remove the Tokmizer hooks made for another agent from it by hand.`);
        continue;
      }
      if (removed.length) lines.push(`Replaced ${removed.length} Tokmizer hook${removed.length === 1 ? "" : "s"} copied from another agent in ${f.file} with the ${target.label} hook (backup in ~/.tokmizer/backup/config).`);
    }
  }
  return lines;
}

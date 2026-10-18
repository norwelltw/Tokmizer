#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryModule } from "../entry";
import { selfInvocation } from "../self-command";
import { readStdin } from "../stdin";

const SAFE_ARG = /^[A-Za-z0-9._~/:-]{1,64}$/;

const COMMANDS: Record<string, { base: string[]; args: (given: string[]) => string[] | null }> = {
  "tkr-gain": { base: ["gain"], args: (given) => given },
  "tkr-status": { base: ["status"], args: (given) => (given.length ? null : []) },
  "tkr-telemetry": { base: ["telemetry"], args: (given) => (given.length === 0 ? ["status"] : given.length === 1 && given[0] === "status" ? given : null) },
  "tkr-compression": { base: ["compression"], args: (given) => (given.length ? null : []) },
  "tkr-yolo": { base: ["yolo"], args: (given) => (given.length === 0 ? ["status"] : given.length === 1 && given[0] === "status" ? given : null) }
};

export function commandFor(name: unknown, rawArgs: unknown): string[] | null {
  if (typeof name !== "string") return null;
  const spec = COMMANDS[name.replace(/^[^:]+:/, "")];
  if (!spec) return null;
  const given = typeof rawArgs === "string" && rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
  if (!given.every((arg) => SAFE_ARG.test(arg))) return null;
  const args = spec.args(given);
  return args ? [...spec.base, ...args] : null;
}

export function blockWithOutput(text: string): string {
  return JSON.stringify({ decision: "block", reason: text.replace(/\s+$/, ""), hookSpecificOutput: { hookEventName: "UserPromptExpansion", suppressOriginalPrompt: true } });
}

async function main(): Promise<void> {
  let payload: { hook_event_name?: unknown; command_name?: unknown; command_args?: unknown };
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (payload.hook_event_name !== "UserPromptExpansion") return;
  const args = commandFor(payload.command_name, payload.command_args);
  if (!args) return;
  const [bin, ...prefix] = selfInvocation(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "tkr.js"));
  const run = spawnSync(bin!, [...prefix, ...args], {
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (run.error || run.status !== 0 || !run.stdout.trim()) return;
  process.stdout.write(blockWithOutput(run.stdout));
}

const entry = process.argv[1] ?? "";
if (isEntryModule(entry, import.meta.url, "command-expansion")) {
  main().catch(() => {
    process.exit(0);
  });
}

#!/usr/bin/env node
import { readStdin } from "../stdin";
import { reducerConfigured } from "../hooks-host/quick-settings";
import { contextFormatFor, contextHookOutput, parseContextHookArgs } from "../context-hooks";

async function main(): Promise<void> {
  const raw = process.stdin.isTTY ? "" : await readStdin(2000);
  const parsed = parseContextHookArgs(process.argv.slice(2));
  if (!parsed || !reducerConfigured()) return;
  const format = contextFormatFor(raw, parsed.format);
  if (!format) return;
  const { reducerContext } = await import("../bonuses");
  const ctx = await reducerContext(parsed.kind);
  if (!ctx) return;
  process.stdout.write(contextHookOutput(format, parsed.kind, ctx.text));
}

main().catch(() => {});

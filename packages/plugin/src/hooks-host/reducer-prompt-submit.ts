#!/usr/bin/env node
import { reducerConfigured } from "./quick-settings";
import { drainStdin } from "../stdin";

async function main(): Promise<void> {
  await drainStdin();
  if (!reducerConfigured()) return;
  const { reducerContext } = await import("../bonuses");
  const ctx = await reducerContext("prompt");
  if (!ctx) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: ctx.text
      }
    })
  );
}

main().catch(() => {});

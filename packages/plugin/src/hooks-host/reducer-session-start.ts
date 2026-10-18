#!/usr/bin/env node
import { reducerConfigured } from "./quick-settings";
import { drainStdin } from "../stdin";

async function main(): Promise<void> {
  await drainStdin();
  if (!reducerConfigured()) return;
  const { reducerContext } = await import("../bonuses");
  const ctx = await reducerContext("session");
  if (ctx) process.stdout.write(ctx.text);
}

main().catch(() => {});

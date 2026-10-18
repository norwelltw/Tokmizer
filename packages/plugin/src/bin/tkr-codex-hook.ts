#!/usr/bin/env node
import { runCodexHookFromStdin } from "../adapters/codex";

runCodexHookFromStdin().catch((err) => {
  process.stderr.write(`tkr-codex-hook: ${(err as Error).message}\n`);
  process.stdout.write(JSON.stringify({ action: "continue" }));
  process.exit(0);
});

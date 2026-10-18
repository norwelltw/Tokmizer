#!/usr/bin/env node
import { runCursorHookFromStdin } from "../adapters/cursor";

runCursorHookFromStdin().catch((err) => {
  process.stderr.write(`tkr-cursor-hook: ${(err as Error).message}\n`);
  process.stdout.write(JSON.stringify({ permission: "allow" }));
  process.exit(0);
});

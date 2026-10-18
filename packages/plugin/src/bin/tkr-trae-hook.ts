#!/usr/bin/env node
import { PASS, runAgentHookFromStdin } from "../adapters/json-agents";

runAgentHookFromStdin("trae").catch((err) => {
  process.stderr.write(`tkr-trae-hook: ${(err as Error).message}\n`);
  process.stdout.write(PASS);
  process.exit(0);
});

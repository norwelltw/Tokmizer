#!/usr/bin/env node
import { PASS, runAgentHookFromStdin } from "../adapters/json-agents";

runAgentHookFromStdin("grok").catch((err) => {
  process.stderr.write(`tkr-grok-hook: ${(err as Error).message}\n`);
  process.stdout.write(PASS);
  process.exit(0);
});

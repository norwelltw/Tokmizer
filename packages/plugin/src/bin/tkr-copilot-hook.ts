#!/usr/bin/env node
import { PASS, runAgentHookFromStdin } from "../adapters/json-agents";

runAgentHookFromStdin("copilot").catch((err) => {
  process.stderr.write(`tkr-copilot-hook: ${(err as Error).message}\n`);
  process.stdout.write(PASS);
  process.exit(0);
});

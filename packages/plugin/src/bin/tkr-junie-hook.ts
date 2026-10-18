#!/usr/bin/env node
import { PASS, runAgentHookFromStdin } from "../adapters/json-agents";

runAgentHookFromStdin("junie").catch((err) => {
  process.stderr.write(`tkr-junie-hook: ${(err as Error).message}\n`);
  process.stdout.write(PASS);
  process.exit(0);
});

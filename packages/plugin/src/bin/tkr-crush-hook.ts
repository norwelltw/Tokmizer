#!/usr/bin/env node
import { PASS, runAgentHookFromStdin } from "../adapters/json-agents";

runAgentHookFromStdin("crush").catch((err) => {
  process.stderr.write(`tkr-crush-hook: ${(err as Error).message}\n`);
  process.stdout.write(PASS);
  process.exit(0);
});

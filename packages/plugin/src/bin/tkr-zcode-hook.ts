#!/usr/bin/env node
import { PASS, runAgentHookFromStdin } from "../adapters/json-agents";

runAgentHookFromStdin("zcode").catch((err) => {
  process.stderr.write(`tkr-zcode-hook: ${(err as Error).message}\n`);
  process.stdout.write(PASS);
  process.exit(0);
});

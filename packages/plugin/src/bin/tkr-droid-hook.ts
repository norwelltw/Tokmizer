#!/usr/bin/env node
import { PASS, runAgentHookFromStdin } from "../adapters/json-agents";

runAgentHookFromStdin("droid").catch((err) => {
  process.stderr.write(`tkr-droid-hook: ${(err as Error).message}\n`);
  process.stdout.write(PASS);
  process.exit(0);
});

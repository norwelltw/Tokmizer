#!/usr/bin/env node
import { PASS, runAgentHookFromStdin } from "../adapters/json-agents";

runAgentHookFromStdin("qwen-code").catch((err) => {
  process.stderr.write(`tkr-qwen-hook: ${(err as Error).message}\n`);
  process.stdout.write(PASS);
  process.exit(0);
});

#!/usr/bin/env node
import { agentHookFallback, runAgentHookFromStdin } from "../adapters/agent-hooks";

runAgentHookFromStdin(process.argv[2]).catch((err) => {
  process.stderr.write(`tkr-agent-hook: ${(err as Error).message}\n`);
  process.stdout.write(agentHookFallback(process.argv[2]));
  process.exit(0);
});

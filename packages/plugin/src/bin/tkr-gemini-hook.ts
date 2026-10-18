#!/usr/bin/env node
import { runGeminiHookFromStdin } from "../adapters/gemini";

runGeminiHookFromStdin().catch((err) => {
  process.stderr.write(`tkr-gemini-hook: ${(err as Error).message}\n`);
  process.stdout.write("{}");
  process.exit(0);
});

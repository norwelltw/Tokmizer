import { readStdin } from "../stdin";
import { isEntryModule } from "../entry";
import { routePreToolUse } from "./hook-router";

export { buildPreToolUseOutput, execInvocation, rewrite, splitTopLevel } from "./pre-tool-rewrite";

export function preToolUseResponse(raw: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return "";
  }
  return routePreToolUse(payload, "claude-code");
}

async function main() {
  const raw = await readStdin();
  const out = raw ? preToolUseResponse(raw) : "";
  if (out) process.stdout.write(out);
}

const entry = process.argv[1] ?? "";
if (isEntryModule(entry, import.meta.url, "pre-tool-use")) {
  main().catch((err) => {
    process.stderr.write(`tkr pre-tool-use: ${(err as Error).message}\n`);
    process.exit(0);
  });
}

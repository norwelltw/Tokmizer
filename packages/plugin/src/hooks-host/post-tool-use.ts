import { readStdin } from "../stdin";
import { isEntryModule } from "../entry";
import { postToolUseResponse, type PostToolUsePayload } from "./post-tool-process";

export { buildHookEnvelope, postToolUseResponse, processToolOutput, takeFirstSaveNotice } from "./post-tool-process";
export type { PostToolUseOptions, PostToolUsePayload } from "./post-tool-process";

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw) process.exit(0);
  let payload: PostToolUsePayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const response = await postToolUseResponse(payload);
  if (!response) process.exit(0);
  process.stdout.write(response);
}

const entry = process.argv[1] ?? "";
if (isEntryModule(entry, import.meta.url, "post-tool-use")) {
  main().catch((err) => {
    process.stderr.write(`tkr post-tool-use: ${(err as Error).message}\n`);
    process.exit(0);
  });
}

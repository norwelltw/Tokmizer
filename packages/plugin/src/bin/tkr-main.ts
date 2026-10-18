import { selectSingleEntry } from "../entry";
import { SINGLE_CHECK_FLAG, selectEntry, type SingleEntry } from "../single-entries";
import { PLUGIN_VERSION } from "../version";

const loaders: Record<SingleEntry, () => Promise<unknown>> = {
  tkr: () => import("./tkr"),
  "tkr-exec": () => import("./tkr-exec"),
  "tkr-processor": () => import("./tkr-processor"),
  "tkr-daemon": () => import("./tkr-daemon"),
  "tkr-shim": () => import("./tkr-shim"),
  "tkr-codex-hook": () => import("./tkr-codex-hook"),
  "tkr-cursor-hook": () => import("./tkr-cursor-hook"),
  "tkr-gemini-hook": () => import("./tkr-gemini-hook"),
  "tkr-agent-hook": () => import("./tkr-agent-hook"),
  "tkr-copilot-hook": () => import("./tkr-copilot-hook"),
  "tkr-droid-hook": () => import("./tkr-droid-hook"),
  "tkr-trae-hook": () => import("./tkr-trae-hook"),
  "tkr-qwen-hook": () => import("./tkr-qwen-hook"),
  "tkr-crush-hook": () => import("./tkr-crush-hook"),
  "tkr-junie-hook": () => import("./tkr-junie-hook"),
  "tkr-zcode-hook": () => import("./tkr-zcode-hook"),
  "tkr-grok-hook": () => import("./tkr-grok-hook"),
  "tkr-context-hook": () => import("./tkr-context-hook"),
  "pre-tool-use": () => import("../hooks-host/pre-tool-use"),
  "post-tool-use": () => import("../hooks-host/post-tool-use"),
  "session-recap": () => import("../hooks-host/session-recap"),
  "on-session-start": () => import("../../hooks/on-session-start.mjs"),
  "reducer-session-start": () => import("../hooks-host/reducer-session-start"),
  "reducer-prompt-submit": () => import("../hooks-host/reducer-prompt-submit"),
  "reducer-stop": () => import("../hooks-host/reducer-stop"),
  "command-expansion": () => import("../hooks-host/command-expansion")
};

const given = process.argv.slice(2);
if (given.length === 1 && given[0] === SINGLE_CHECK_FLAG) {
  process.stdout.write(`tokmizer-single ${PLUGIN_VERSION}\n`);
} else {
  const { entry, args } = selectEntry(given);
  process.argv.splice(1, process.argv.length - 1, entry, ...args);
  selectSingleEntry(entry);
  loaders[entry]().catch((error: unknown) => {
    process.stderr.write(`tkr: ${(error as Error).message ?? error}\n`);
    process.exitCode = 1;
  });
}

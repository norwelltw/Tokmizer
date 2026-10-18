import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const TKR = __TKR_ARGV__;
const CONTEXT_FILE = __TKR_CONTEXT_FILE__;
const ARGS = ["rewrite", "--host", "kilo"];

function rewrite(command, session) {
  return new Promise((resolve) => {
    if (typeof command !== "string" || !command.trim()) return resolve(null);
    try {
      const args = [...TKR.slice(1), ...ARGS, ...(typeof session === "string" && session ? ["--session", session] : [])];
      const child = execFile(TKR[0], args, { timeout: 3000, windowsHide: true, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout) => {
        resolve(!error && typeof stdout === "string" && stdout.trim() ? stdout : null);
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(command);
    } catch {
      resolve(null);
    }
  });
}

const contexts = new Map();

function readContext() {
  try {
    const text = readFileSync(CONTEXT_FILE, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function reducerContext(session) {
  const key = typeof session === "string" && session ? session : "";
  if (contexts.has(key)) return contexts.get(key);
  const text = readContext();
  if (text === null) return null;
  if (contexts.size >= 64) contexts.delete(contexts.keys().next().value);
  contexts.set(key, text);
  return text;
}

function addReducer(session, output) {
  try {
    if (!output || !Array.isArray(output.system)) return;
    const text = reducerContext(session);
    if (text) output.system.push(text);
  } catch {}
}

async function apply(tool, container, session) {
  try {
    if ((tool !== "bash" && tool !== "shell") || !container || typeof container !== "object") return;
    const rewritten = await rewrite(container.command, session);
    if (rewritten) container.command = rewritten;
  } catch {}
}

export default {
  id: "tokmizer",
  async setup(ctx) {
    await ctx?.tool?.hook?.("execute.before", (event) => apply(event?.tool, event?.input, event?.sessionID));
  },
  async server() {
    return {
      "tool.execute.before": (input, output) => apply(input?.tool, output?.args, input?.sessionID),
      "experimental.chat.system.transform": (input, output) => addReducer(input?.sessionID, output)
    };
  }
};

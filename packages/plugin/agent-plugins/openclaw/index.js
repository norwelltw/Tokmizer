import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const TKR = __TKR_ARGV__;
const CONTEXT_FILE = __TKR_CONTEXT_FILE__;
const ARGS = ["rewrite", "--host", "openclaw"];

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

function reducerContext() {
  try {
    const text = readFileSync(CONTEXT_FILE, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

export default {
  id: "tokmizer",
  name: "Tokmizer",
  description: "Routes exec commands through tokmizer to cut tool-output tokens.",
  register(api) {
    api.on("before_tool_call", async (event) => {
      try {
        if (event?.toolName !== "exec" || event.toolKind === "code_mode_exec") return undefined;
        const params = event.params;
        if (!params || typeof params !== "object") return undefined;
        const rewritten = await rewrite(params.command);
        return rewritten ? { params: { ...params, command: rewritten } } : undefined;
      } catch {
        return undefined;
      }
    });
    api.on("before_prompt_build", async () => {
      try {
        const text = reducerContext();
        return text ? { appendSystemContext: text } : undefined;
      } catch {
        return undefined;
      }
    });
  }
};

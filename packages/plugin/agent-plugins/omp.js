import { execFile } from "node:child_process";

const TKR = __TKR_ARGV__;
const ARGS = ["rewrite", "--host", "omp"];

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

export default function (pi) {
  pi.on("tool_call", async (event) => {
    try {
      if (event?.toolName !== "bash" || !event.input || typeof event.input !== "object") return;
      const rewritten = await rewrite(event.input.command);
      return rewritten ? { input: { ...event.input, command: rewritten } } : undefined;
    } catch {
      return undefined;
    }
  });
}

import { execFile } from "node:child_process";

const TKR = __TKR_ARGV__;
const ARGS = ["rewrite", "--host", "amp"];

export const description = "Routes shell commands through tokmizer to cut tool-output tokens.";

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

export default function (amp) {
  amp.on("tool.call", async (event) => {
    try {
      const shell = amp.helpers?.shellCommandFromToolCall?.(event);
      const input = event?.input;
      if (!shell || !input || typeof input !== "object") return { action: "allow" };
      const key = input.command === shell.command ? "command" : input.cmd === shell.command ? "cmd" : null;
      if (!key) return { action: "allow" };
      const rewritten = await rewrite(shell.command, event?.thread?.id);
      return rewritten ? { action: "modify", input: { ...input, [key]: rewritten } } : { action: "allow" };
    } catch {
      return { action: "allow" };
    }
  });
}

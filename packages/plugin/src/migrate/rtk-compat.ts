import spawn from "cross-spawn";
import { join } from "node:path";
import { constants } from "node:os";
import { RTK_SHIM_MARK } from "./rtk-paths";

export type RtkCompatAction =
  | { kind: "tkr"; argv: string[] }
  | { kind: "raw"; argv: string[] }
  | { kind: "message"; stdout?: string; stderr?: string; code: number };

const USAGE = [
  "rtk was replaced by Tokmizer. This rtk command forwards to it:",
  "  rtk gain [...]             -> tkr gain [...]",
  "  rtk recall|restore <hash>  -> tkr restore <hash>",
  "  rtk bypass|proxy <cmd>     -> runs <cmd> unchanged",
  "Run your other commands directly: Tokmizer compresses them on its own.",
  ""
].join("\n");

export function rtkCompatAction(args: string[]): RtkCompatAction {
  const [sub, ...rest] = args;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") return { kind: "message", stdout: USAGE, code: 0 };
  if (sub === "--version" || sub === "-V" || sub === "version") return { kind: "message", stdout: "rtk compatibility command for Tokmizer\n", code: 0 };
  if (sub === "gain") return { kind: "tkr", argv: ["gain", ...rest] };
  if (sub === "recall" || sub === "restore") return { kind: "tkr", argv: ["restore", ...rest.filter((a) => a !== "--full")] };
  if (sub === "bypass" || sub === "proxy") {
    if (rest.length === 0) return { kind: "message", stderr: `Usage: rtk ${sub} <command> [args...]\n`, code: 2 };
    return { kind: "raw", argv: rest };
  }
  const direct = [sub, ...rest].join(" ");
  return {
    kind: "message",
    stderr: `rtk ${sub}: rtk was replaced by Tokmizer, which has no "${sub}" subcommand.\nRun the command directly, Tokmizer compresses its output on its own: ${direct}\nSee: rtk help\n`,
    code: 1
  };
}

export function runRaw(argv: string[]): number {
  const r = spawn.sync(argv[0]!, argv.slice(1), { stdio: "inherit" });
  if (r.error) {
    process.stderr.write(`rtk: ${argv[0]}: ${(r.error as NodeJS.ErrnoException).code === "ENOENT" ? "command not found" : r.error.message}\n`);
    return 127;
  }
  if (r.signal) return 128 + (constants.signals[r.signal] ?? 1);
  return r.status ?? 1;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function rtkShimFile(dir: string, platform: NodeJS.Platform = process.platform): string {
  return join(dir, platform === "win32" ? "rtk.cmd" : "rtk");
}

export function rtkShimContent(tkr: string[], platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return `@echo off\r\nset TOKMIZER_SHIM=${RTK_SHIM_MARK}\r\n${tkr.map((a) => `"${a}"`).join(" ")} rtk-compat %*\r\n`;
  }
  return `#!/bin/sh\nTOKMIZER_SHIM=${RTK_SHIM_MARK} exec ${tkr.map(shQuote).join(" ")} rtk-compat "$@"\n`;
}

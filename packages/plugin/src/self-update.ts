import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import os from "node:os";
import { tokmizerHome } from "./paths";
import { isOlderVersion } from "./version";
import { capJsonl } from "./jsonl-cap";
import { selfInvocation } from "./self-command";
import { networkEnabled } from "./network";

const SEMVER = /^\d+\.\d+\.\d+$/;
const COOLDOWN_MS = 6 * 3600_000;
const MIN_CODEX_HOOK_VERSION = "0.9.34";
const LOG_BYTES = 64 * 1024;

export type RunResult = { code: number; stdout: string; stderr?: string };
export type SelfUpdateDeps = {
  latest: string | undefined;
  run: (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<RunResult>;
  npmVersion: (root: string) => string | undefined;
  writable: (dir: string) => boolean;
  codexInstalled: () => boolean;
  ensureCodexHook: (npmRoot: string) => Promise<string>;
};

const offFile = (): string => join(tokmizerHome(), "auto-update-off");
const slotFile = (): string => join(tokmizerHome(), "self-update-last");
const offeredFile = (): string => join(tokmizerHome(), "codex-hook-offered");

export function autoUpdateEnabled(): boolean {
  if (process.env.TOKMIZER_AUTO_UPDATE === "0") return false;
  return !existsSync(offFile());
}

export function setAutoUpdate(on: boolean): void {
  if (on) {
    rmSync(offFile(), { force: true });
    return;
  }
  mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
  writeFileSync(offFile(), String(Date.now()));
}

export function claimSelfUpdateSlot(now = Date.now()): boolean {
  try {
    const last = Number(readFileSync(slotFile(), "utf8"));
    if (Number.isFinite(last) && now - last < COOLDOWN_MS) return false;
  } catch {}
  try {
    mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
    writeFileSync(slotFile(), String(now));
  } catch {
    return false;
  }
  return true;
}

function log(line: string): void {
  try {
    const file = join(tokmizerHome(), "self-update.log");
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    capJsonl(file, LOG_BYTES, LOG_BYTES / 2);
  } catch {}
}

export async function selfUpdate(d: SelfUpdateDeps): Promise<string[]> {
  if (!autoUpdateEnabled()) return ["disabled"];
  if (!networkEnabled()) return ["network off"];
  const latest = d.latest;
  if (!latest || !SEMVER.test(latest)) return ["no-version"];
  const actions: string[] = [];
  const current: string[] = [];

  const root = (await d.run("npm", ["root", "-g"]).catch((): RunResult => ({ code: 1, stdout: "" }))).stdout.trim();
  const npmV = root ? d.npmVersion(root) : undefined;
  if (npmV) {
    if (!isOlderVersion(npmV, latest)) current.push(npmV);
    else if (!d.writable(root)) actions.push("npm needs permission");
    else {
      const r = await d.run("npm", ["i", "-g", `@tokmizer/plugin@${latest}`, "--no-audit", "--no-fund"]).catch((): RunResult => ({ code: 1, stdout: "" }));
      const after = d.npmVersion(root);
      if (r.code === 0 && after === latest) {
        actions.push(`npm ${npmV} -> ${latest}`);
        current.push(latest);
      } else actions.push(`npm failed (${npmV})`);
    }
  }

  if (process.platform !== "win32") {
    const listed = await d.run("brew", ["list", "--versions", "tokmizer"]).catch((): RunResult => ({ code: 1, stdout: "" }));
    const brewV = listed.code === 0 ? listed.stdout.trim().split(/\s+/)[1] : undefined;
    if (brewV && SEMVER.test(brewV)) {
      if (!isOlderVersion(brewV, latest)) current.push(brewV);
      else {
        const r = await d.run("brew", ["upgrade", "tokmizer"], { ...process.env, HOMEBREW_NO_INSTALL_CLEANUP: "1" }).catch((): RunResult => ({ code: 1, stdout: "" }));
        if (r.code === 0) {
          actions.push(`brew ${brewV} -> ${latest}`);
          current.push(latest);
        } else if (/untrusted tap/i.test(r.stderr ?? "")) actions.push("brew tap not trusted: run brew trust norwelltw/tokmizer");
        else actions.push(`brew failed (${brewV})`);
      }
    }
  }

  if (actions.some((a) => a.includes("->"))) {
    await d.run("tkr", ["shims-refresh"]).catch((): RunResult => ({ code: 1, stdout: "" }));
  }

  const hookReady = current.some((v) => !isOlderVersion(v, MIN_CODEX_HOOK_VERSION));
  if (hookReady && d.codexInstalled() && !existsSync(offeredFile())) {
    const r = await d.ensureCodexHook(root).catch(() => "error");
    if (r !== "error") {
      try {
        writeFileSync(offeredFile(), String(Date.now()));
      } catch {}
      actions.push(`codex hook ${r}`);
    }
  }

  for (const a of actions) log(a);
  return actions;
}

function runCommand(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: env ?? process.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (err.length < 8192) err += c.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out, stderr: err });
    });
  });
}

export function defaultDeps(latest: string | undefined): SelfUpdateDeps {
  return {
    latest,
    run: runCommand,
    npmVersion: (root) => {
      try {
        const v = JSON.parse(readFileSync(join(root, "@tokmizer", "plugin", "package.json"), "utf8")).version;
        return typeof v === "string" ? v : undefined;
      } catch {
        return undefined;
      }
    },
    writable: (dir) => {
      try {
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    codexInstalled: () => existsSync(process.env.CODEX_HOME || join(os.homedir(), ".codex")),
    ensureCodexHook: async (npmRoot) => {
      const { ensureCodexHook, codexHookCommand } = await import("./codex-hooks");
      const { codexPluginProvidesHook } = await import("./codex-repair");
      if (codexPluginProvidesHook()) return "present";
      const hookJs = join(npmRoot, "@tokmizer", "plugin", "dist", "bin", "tkr-codex-hook.js");
      const command = codexHookCommand(process.env.PATH ?? "", hookJs);
      if (command.startsWith("node ") && !existsSync(hookJs)) return "error";
      return ensureCodexHook(command);
    }
  };
}

function tkrDistRoot(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const candidate of [join(here), join(here, "..")]) {
    if (existsSync(join(candidate, "bin", "tkr.js"))) return candidate;
  }
  return null;
}

export function maybeSpawnSelfUpdate(): void {
  try {
    if (!autoUpdateEnabled() || !networkEnabled()) return;
    const root = tkrDistRoot();
    if (!root) return;
    if (!claimSelfUpdateSlot()) return;
    const [command, ...args] = selfInvocation(join(root, "bin", "tkr.js"));
    const child = spawn(command!, [...args, "self-update"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, TOKMIZER_SELF_UPDATE_CHILD: "1" }
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

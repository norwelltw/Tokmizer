import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import os from "node:os";
import { tokmizerHome } from "./paths";
import { isOlderVersion } from "./version";
import { capJsonl } from "./jsonl-cap";
import { selfInvocation, singleBinary } from "./self-command";
import { networkEnabled } from "./network";
import { queueCodexHookNotice } from "./codex-hook-notice";

const SEMVER = /^\d+\.\d+\.\d+$/;
const COOLDOWN_MS = 6 * 3600_000;
const RELEASE_AGE_MS = 24 * 3600_000;
const MIN_CODEX_HOOK_VERSION = "0.9.34";
const LOG_BYTES = 64 * 1024;

export type RunResult = { code: number; stdout: string; stderr?: string };
export type StandaloneDeps = {
  root: string;
  key: string;
  base: (version: string) => string;
  fetch: (url: string) => Promise<Response>;
};
export type SelfUpdateDeps = {
  latest: string | undefined;
  run: (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<RunResult>;
  npmVersion: (root: string) => string | undefined;
  writable: (dir: string) => boolean;
  codexInstalled: () => boolean;
  ensureCodexHook: (npmRoot: string) => Promise<string>;
  standalone?: StandaloneDeps | undefined;
  now?: () => number;
};

const offFile = (): string => join(tokmizerHome(), "auto-update-off");
const slotFile = (): string => join(tokmizerHome(), "self-update-last");
const offeredFile = (): string => join(tokmizerHome(), "codex-hook-offered");
const seenFile = (): string => join(tokmizerHome(), "self-update-seen");

function announcedLongEnough(version: string, now: number): boolean {
  try {
    const seen = JSON.parse(readFileSync(seenFile(), "utf8")) as { version?: unknown; at?: unknown };
    if (seen.version === version && typeof seen.at === "number") return now - seen.at >= RELEASE_AGE_MS;
  } catch {}
  try {
    mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
    writeFileSync(seenFile(), JSON.stringify({ version, at: now }), { mode: 0o600 });
  } catch {}
  return false;
}

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
  const ripe = announcedLongEnough(latest, (d.now ?? Date.now)());
  const actions: string[] = [];
  const current: string[] = [];
  const waits = (v: string): void => {
    current.push(v);
    if (!actions.includes(`waiting: ${latest} is less than 24h old`)) actions.push(`waiting: ${latest} is less than 24h old`);
  };

  const root = (await d.run("npm", ["root", "-g"]).catch((): RunResult => ({ code: 1, stdout: "" }))).stdout.trim();
  const npmV = root ? d.npmVersion(root) : undefined;
  if (npmV) {
    if (!isOlderVersion(npmV, latest)) current.push(npmV);
    else if (!ripe) waits(npmV);
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

  const standaloneV = d.standalone ? standaloneVersion(d.standalone.root) : undefined;
  if (d.standalone && standaloneV) {
    if (!isOlderVersion(standaloneV, latest)) current.push(standaloneV);
    else if (!ripe) waits(standaloneV);
    else {
      const result = await installStandalone(d.standalone, standaloneV, latest, d.run).catch(() => `standalone failed (${standaloneV})`);
      actions.push(result);
      if (result.includes("->")) current.push(latest);
    }
  }

  if (process.platform !== "win32") {
    const listed = await d.run("brew", ["list", "--versions", "tokmizer"]).catch((): RunResult => ({ code: 1, stdout: "" }));
    const brewV = listed.code === 0 ? listed.stdout.trim().split(/\s+/)[1] : undefined;
    if (brewV && SEMVER.test(brewV)) {
      if (!isOlderVersion(brewV, latest)) current.push(brewV);
      else if (!ripe) waits(brewV);
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
      if (r === "added" || r === "updated") queueCodexHookNotice();
      actions.push(`codex hook ${r}`);
    }
  }

  for (const a of actions) log(a);
  return actions;
}

function standaloneVersion(root: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(join(root, "current", "package.json"), "utf8")).version;
    return typeof v === "string" && SEMVER.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

async function download(s: StandaloneDeps, url: string): Promise<Buffer> {
  const res = await s.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function pruneStandalone(root: string, key: string, keep: string[]): void {
  const pattern = new RegExp(`^tokmizer-\\d+\\.\\d+\\.\\d+-${key}$`);
  for (const entry of readdirSync(root)) {
    if (pattern.test(entry) && !keep.includes(entry)) rmSync(join(root, entry), { recursive: true, force: true });
  }
}

async function installStandalone(s: StandaloneDeps, from: string, latest: string, run: SelfUpdateDeps["run"]): Promise<string> {
  const name = `tokmizer-${latest}-${s.key}`;
  const failed = (why: string): string => `standalone failed (${from}): ${why}`;
  const sums = (await download(s, `${s.base(latest)}/SHA256SUMS`)).toString("utf8");
  const expected = sums
    .split("\n")
    .map((line) => /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim()))
    .find((m) => m?.[2] === `${name}.tar.gz`)?.[1];
  if (!expected) return failed(`no build for ${s.key}`);
  const archive = await download(s, `${s.base(latest)}/${name}.tar.gz`);
  if (createHash("sha256").update(archive).digest("hex") !== expected) return failed("checksum mismatch");
  const stage = mkdtempSync(join(s.root, ".update-"));
  try {
    writeFileSync(join(stage, "release.tar.gz"), archive);
    const extracted = await run("tar", ["-xzf", join(stage, "release.tar.gz"), "-C", stage]);
    const binary = join(stage, name, "dist", "bin", "tkr");
    if (extracted.code !== 0 || !existsSync(binary)) return failed("archive");
    const probe = await run(binary, ["--single-check"]);
    if (probe.code !== 0 || probe.stdout.trim() !== `tokmizer-single ${latest}`) return failed("probe");
    const previous = basename(realpathSync(join(s.root, "current")));
    const target = join(s.root, name);
    rmSync(target, { recursive: true, force: true });
    renameSync(join(stage, name), target);
    const link = join(s.root, `.current-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(name, link);
    renameSync(link, join(s.root, "current"));
    pruneStandalone(s.root, s.key, [name, previous]);
    return `standalone ${from} -> ${latest}`;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function standaloneRoot(): string | undefined {
  if (!singleBinary() || process.platform === "win32") return undefined;
  try {
    const versionDir = dirname(dirname(dirname(realpathSync(process.execPath))));
    const root = dirname(versionDir);
    return realpathSync(join(root, "current")) === versionDir ? root : undefined;
  } catch {
    return undefined;
  }
}

function defaultStandalone(): StandaloneDeps | undefined {
  const root = standaloneRoot();
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "";
  if (!root || !arch || (process.platform !== "darwin" && process.platform !== "linux")) return undefined;
  return {
    root,
    key: `${process.platform}-${arch}`,
    base: (version) => `https://github.com/norwelltw/Tokmizer/releases/download/v${version}`,
    fetch: (url) => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) })
  };
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
    standalone: defaultStandalone(),
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
    const root = singleBinary() ? "" : tkrDistRoot();
    if (root === null) return;
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

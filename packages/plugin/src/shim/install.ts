import { mkdir, writeFile, readFile, unlink, chmod, rename, copyFile, stat, readdir, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { entryWords } from "../single-entries";
import { singleBinary, stableSelfPath } from "../self-command";
import { tokmizerHome } from "../paths";
import { hostEnvVars } from "../host-detect";
import { FALLBACK_HINT, failOpenFile, failOpenShellTest, passthroughLines, shimsDir, shQuote } from "./sh";
import { launcherFile, launchTargetFor, removeLauncher, writeLauncher } from "./launcher";

export { shimsDir } from "./sh";

const COMMANDS_TO_SHIM = [
  "git",
  "npm",
  "yarn",
  "pnpm",
  "docker",
  "kubectl",
  "terraform",
  "tofu",
  "cargo",
  "go",
  "mvn",
  "gradle",
  "rg",
  "grep",
  "find",
  "ls",
  "cat",
  "tail",
  "head",
  "ps",
  "lsof",
  "ssh",
  "scp",
  "rsync",
  "curl",
  "wget",
  "jq",
  "yq",
  "make"
];

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function envWithoutShimDir(): NodeJS.ProcessEnv {
  const dir = shimsDir();
  const env = { ...process.env };
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const raw = env[pathKey] ?? env.PATH ?? "";
  const real = realOrSelf(dir);
  const parts = raw.split(delimiter).filter((p) => p && p !== dir && realOrSelf(p) !== real);
  env[pathKey] = parts.join(delimiter);
  if (pathKey === "Path") env.PATH = env[pathKey];
  return env;
}

export function shimsInstalled(): boolean {
  try {
    const isWin = os.platform() === "win32";
    return existsSync(join(shimsDir(), isWin ? "git.cmd" : "git"));
  } catch {
    return false;
  }
}

export function listShimmableCommands(): string[] {
  return [...COMMANDS_TO_SHIM];
}

function envConcat(vars: string[]): string {
  return `"${vars.map((v) => `\${${v}:-}`).join("")}"`;
}

const SHIM_FORMAT = 1;

export function currentShim(content: string): boolean {
  const m = content.match(/^#!\/bin\/sh\n_tk_f=(\d+)\n/);
  return m !== null && Number(m[1]) >= SHIM_FORMAT && content.includes(`exec /bin/sh ${shQuote(launcherFile())} "$_tk_c" "$@"`);
}

export function unixWrapperScript(cmd: string): string {
  return [
    "#!/bin/sh",
    `_tk_f=${SHIM_FORMAT}`,
    `_tk_c=${shQuote(cmd)}`,
    `if [ -z ${envConcat(hostEnvVars(true))} ] && { [ -n ${envConcat(["TOKMIZER_HOST", ...hostEnvVars(false)])} ] || [ -t 1 ]; } && [ -f ${shQuote(launcherFile())} ] && ! ${failOpenShellTest()}; then`,
    `  exec /bin/sh ${shQuote(launcherFile())} "$_tk_c" "$@"`,
    "fi",
    ...passthroughLines(""),
    ""
  ].join("\n");
}

function windowsLauncher(shimJs: string): { check: string; run: string } {
  const words = singleBinary() ? entryWords(shimJs) : null;
  const target = words ? stableSelfPath() : shimJs;
  return { check: target, run: words ? [`"${target}"`, ...words].join(" ") : `node "${target}"` };
}

export function windowsWrapperScript(shimJs: string, cmd: string): string {
  const launch = windowsLauncher(shimJs);
  const dir = shimsDir();
  return [
    "@echo off",
    `if exist "${failOpenFile()}" goto tkpass`,
    `if not exist "${launch.check}" goto tkmissing`,
    `${launch.run} --as "${cmd}" %*`,
    "exit /b %errorlevel%",
    ":tkmissing",
    `echo ${FALLBACK_HINT.replace(/`/g, "")} 1>&2`,
    ":tkpass",
    `set "PATH=%PATH:${dir}\\;=%"`,
    `set "PATH=%PATH:${dir};=%"`,
    `set "PATH=%PATH:;${dir}=%"`,
    "for %%E in (.exe .cmd .bat .com) do for %%I in (" + cmd + "%%E) do if not \"%%~$PATH:I\"==\"\" if /i not \"%%~dp$PATH:I\"==\"%~dp0\" (",
    "  \"%%~$PATH:I\" %*",
    "  exit /b",
    ")",
    `echo ${cmd}: command not found 1>&2`,
    "exit /b 9009",
    ""
  ].join("\r\n");
}

function shimFile(cmd: string): string {
  return join(shimsDir(), os.platform() === "win32" ? `${cmd}.cmd` : cmd);
}

function expectedShim(shimJs: string, cmd: string): string {
  return os.platform() === "win32" ? windowsWrapperScript(shimJs, cmd) : unixWrapperScript(cmd);
}

async function writeAtomic(target: string, content: string, mode: number): Promise<boolean> {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, content, { mode });
    await chmod(tmp, mode);
    await rename(tmp, target);
    return true;
  } catch {
    try {
      await unlink(tmp);
    } catch {}
    return false;
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

async function pruneBackups(dir: string, prefix: string, keep: number): Promise<void> {
  try {
    const old = (await readdir(dir)).filter((n) => n.startsWith(prefix)).sort().slice(0, -keep);
    for (const name of old) await rm(join(dir, name), { recursive: true, force: true });
  } catch {}
}

export async function refreshStaleShims(shimJs: string, opts: { dryRun?: boolean } = {}): Promise<{ stale: number; rewritten: number }> {
  const dir = shimsDir();
  if (!existsSync(dir)) return { stale: 0, rewritten: 0 };
  let stale = 0;
  let rewritten = 0;
  let backup: string | null = null;
  for (const cmd of COMMANDS_TO_SHIM) {
    const target = shimFile(cmd);
    const expected = expectedShim(shimJs, cmd);
    let current: string;
    try {
      current = await readFile(target, "utf8");
    } catch {
      continue;
    }
    if (current === expected || (os.platform() !== "win32" && currentShim(current))) continue;
    stale += 1;
    if (opts.dryRun) continue;
    try {
      if (!backup) {
        backup = join(tokmizerHome(), "backup", `shims-${stamp()}`);
        await mkdir(backup, { recursive: true, mode: 0o700 });
      }
      await copyFile(target, join(backup, cmd));
    } catch {}
    if (await writeAtomic(target, expected, 0o755)) rewritten += 1;
  }
  if (backup) await pruneBackups(dirname(backup), "shims-", 3);
  return { stale, rewritten };
}

export async function installShims(shimJs: string): Promise<string[]> {
  const dir = shimsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (os.platform() !== "win32") await writeLauncher(launchTargetFor(shimJs));
  const created: string[] = [];
  for (const cmd of COMMANDS_TO_SHIM) {
    if (await writeAtomic(shimFile(cmd), expectedShim(shimJs, cmd), 0o755)) created.push(cmd);
  }
  return created;
}

export async function uninstallShims(): Promise<number> {
  const dir = shimsDir();
  await removeLauncher();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const cmd of COMMANDS_TO_SHIM) {
    try {
      await unlink(shimFile(cmd));
      removed += 1;
    } catch {}
  }
  return removed;
}

const RC_MARKER = "# tokmizer-shim PATH (managed by tokmizer)";

function fishQuote(path: string): string {
  return `'${path.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function shellRcLine(fish = false): string {
  return `${RC_MARKER}\n${fish ? `set -gx PATH ${fishQuote(shimsDir())} $PATH` : `export PATH=${shQuote(shimsDir())}:"$PATH"`}\n`;
}

export function powershellProfileSnippet(): string {
  return `${RC_MARKER}\n$env:Path = '${shimsDir().replace(/'/g, "''")};' + $env:Path\n`;
}

function globalPathVariants(): string[] {
  const dir = shimsDir();
  return [
    `export PATH=${shQuote(dir)}:"$PATH"`,
    `export PATH="${dir}:$PATH"`,
    `set -gx PATH ${fishQuote(dir)} $PATH`,
    `$env:Path = '${dir.replace(/'/g, "''")};' + $env:Path`,
    `$env:Path = "${dir};" + $env:Path`
  ];
}

export function globalPathOptInFile(): string {
  return join(tokmizerHome(), "global-path");
}

export function globalPathOptedIn(): boolean {
  return existsSync(globalPathOptInFile());
}

function globalPathJournal(): string {
  return join(tokmizerHome(), "backup", "global-path.json");
}

export function stripGlobalPathBlock(content: string): { content: string; removed: number } {
  const variants = globalPathVariants();
  const lines = content.split("\n");
  const out: string[] = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.replace(/\r$/, "");
    const next = lines[i + 1]?.replace(/\r$/, "");
    if (line === RC_MARKER && next !== undefined && variants.includes(next)) {
      if (out.length && out[out.length - 1]!.replace(/\r$/, "") === "") out.pop();
      removed += 1;
      i += 1;
      continue;
    }
    out.push(lines[i]!);
  }
  return { content: removed ? out.join("\n") : content, removed };
}

export function globalPathFiles(): string[] {
  const home = os.homedir();
  const unix = [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".bash_login", ".profile", join(".config", "fish", "config.fish")].map((f) => join(home, f));
  if (os.platform() !== "win32") return unix;
  return [
    ...unix,
    join(home, "Documents", "PowerShell", "profile.ps1"),
    join(home, "Documents", "WindowsPowerShell", "profile.ps1"),
    join(home, "OneDrive", "Documents", "PowerShell", "profile.ps1"),
    join(home, "OneDrive", "Documents", "WindowsPowerShell", "profile.ps1")
  ];
}

export async function countGlobalPathLines(): Promise<number> {
  let n = 0;
  for (const file of globalPathFiles()) {
    try {
      n += stripGlobalPathBlock(await readFile(file, "utf8")).removed;
    } catch {}
  }
  return n;
}

type JournalEntry = { file: string; backup: string; fish: boolean; at: string };

async function readJournal(): Promise<JournalEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(globalPathJournal(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((e): e is JournalEntry => e != null && typeof e === "object" && typeof (e as JournalEntry).file === "string") : [];
  } catch {
    return [];
  }
}

export async function globalPathRemovals(): Promise<{ file: string; backup: string; at: string }[]> {
  return (await readJournal()).map(({ file, backup, at }) => ({ file, backup, at }));
}

export async function removeGlobalPathLines(opts: { force?: boolean } = {}): Promise<string[]> {
  if (!opts.force && globalPathOptedIn()) return [];
  const changed: string[] = [];
  const journal = await readJournal();
  for (const file of globalPathFiles()) {
    let real: string;
    let content: string;
    try {
      real = realpathSync(file);
      content = await readFile(real, "utf8");
    } catch {
      continue;
    }
    const result = stripGlobalPathBlock(content);
    if (!result.removed) continue;
    const backupDir = join(tokmizerHome(), "backup", "rc");
    const backup = join(backupDir, `${basename(file)}-${stamp()}`);
    try {
      const info = await stat(real);
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      await copyFile(real, backup);
      await chmod(backup, 0o600);
      if (!(await writeAtomic(real, result.content, info.mode & 0o777))) {
        await unlink(backup).catch(() => {});
        continue;
      }
    } catch {
      continue;
    }
    changed.push(file);
    journal.push({ file, backup, fish: file.endsWith("config.fish"), at: new Date().toISOString() });
  }
  if (changed.length) {
    try {
      await mkdir(dirname(globalPathJournal()), { recursive: true, mode: 0o700 });
      await writeFile(globalPathJournal(), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    } catch {}
  }
  return changed;
}

export async function ensurePathInRc(rcFile: string, fish = false): Promise<"added" | "present" | "missing"> {
  try {
    await mkdir(dirname(rcFile), { recursive: true });
    const content = existsSync(rcFile) ? await readFile(rcFile, "utf8") : "";
    if (content.includes(RC_MARKER)) return "present";
    await writeFile(rcFile, `${content.replace(/\n*$/, "\n")}\n${shellRcLine(fish)}`, { mode: 0o600 });
    return "added";
  } catch {
    return "missing";
  }
}

export async function setGlobalPath(on: boolean): Promise<{ files: string[]; manual: string | null }> {
  if (!on) {
    try {
      await unlink(globalPathOptInFile());
    } catch {}
    return { files: await removeGlobalPathLines({ force: true }), manual: null };
  }
  await mkdir(tokmizerHome(), { recursive: true, mode: 0o700 });
  await writeFile(globalPathOptInFile(), String(Date.now()), { mode: 0o600 });
  const restored: string[] = [];
  for (const entry of await readJournal()) {
    if (restored.includes(entry.file) || os.platform() === "win32") continue;
    if ((await ensurePathInRc(entry.file, entry.fish)) === "added") restored.push(entry.file);
  }
  if (restored.length) return { files: restored, manual: null };
  const rc = await ensureShimPath();
  return { files: rc.status === "added" ? [rc.target] : [], manual: rc.status === "missing" ? rc.manual : null };
}

export function powershellProfilePath(): string {
  const documents = os.platform() === "win32"
    ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('MyDocuments')"], { encoding: "utf8", windowsHide: true }).trim()
    : join(os.homedir(), "Documents");
  return join(documents || join(os.homedir(), "Documents"), "PowerShell", "profile.ps1");
}

export async function ensureShimPath(): Promise<{
  status: "added" | "present" | "missing";
  target: string;
  manual: string;
}> {
  if (os.platform() === "win32") {
    let target = join(os.homedir(), "Documents", "PowerShell", "profile.ps1");
    const snippet = powershellProfileSnippet();
    try {
      target = powershellProfilePath();
      let added = false;
      for (const profile of [target, join(dirname(dirname(target)), "WindowsPowerShell", "profile.ps1")]) {
        await mkdir(dirname(profile), { recursive: true });
        const content = existsSync(profile) ? await readFile(profile, "utf8") : "";
        if (content.includes(RC_MARKER)) continue;
        await writeFile(profile, `${content.replace(/\n*$/, "\n")}\n${snippet}`);
        added = true;
      }
      return { status: added ? "added" : "present", target, manual: snippet };
    } catch {
      return { status: "missing", target, manual: snippet };
    }
  }
  const shell = process.env.SHELL ?? "";
  const fish = shell.endsWith("/fish");
  const rcName = fish ? ".config/fish/config.fish" : shell.endsWith("/zsh") ? ".zshrc" : shell.endsWith("/bash") ? ".bashrc" : ".profile";
  const rcFile = join(os.homedir(), rcName);
  const status = await ensurePathInRc(rcFile, fish);
  if (shell.endsWith("/bash") && status !== "missing") {
    const loginFile = [".bash_profile", ".bash_login", ".profile"].map(name => join(os.homedir(), name)).find(existsSync) ?? join(os.homedir(), ".bash_profile");
    const loginStatus = await ensurePathInRc(loginFile);
    if (loginStatus === "missing") return { status: "missing", target: loginFile, manual: shellRcLine() };
    if (loginStatus === "added") return { status: "added", target: loginFile, manual: shellRcLine() };
  }
  return { status, target: rcFile, manual: shellRcLine(fish) };
}

export function agentPathEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pathKey = os.platform() === "win32" && env.Path !== undefined ? "Path" : "PATH";
  const dir = shimsDir();
  const rest = (env[pathKey] ?? "").split(delimiter).filter((p) => p && p !== dir);
  return { ...env, [pathKey]: [dir, ...rest].join(delimiter), TOKMIZER_HOST: env.TOKMIZER_HOST || "shell" };
}

export function resolveShimJsPath(): string {
  if (process.env.TOKMIZER_SHIM_JS) return process.env.TOKMIZER_SHIM_JS;
  return fileURLToPath(new URL("../bin/tkr-shim.js", import.meta.url));
}

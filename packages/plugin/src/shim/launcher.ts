import { claudeConfigDir } from "../claude-config-dir";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import os from "node:os";
import { tokmizerHome } from "../paths";
import { singleBinary, stableSelfPath } from "../self-command";
import { entryWords } from "../single-entries";
import { FALLBACK_HINT, failOpenShellTest, passthroughLines, shimFallbackFile, shimsDir, shQuote, shUnquote } from "./sh";

export const LAUNCHER_FORMAT = 1;
export const STABLE_MARK = "tkr-shim.stable";

const SEMVER_DIR = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;

export type LaunchTarget = { single: string; js: string; cache: string; node: string };

export function launcherFile(): string {
  return join(tokmizerHome(), "bin", "tkr-shim-launch");
}

export function hookLauncherFile(): string {
  return join(tokmizerHome(), "bin", "tkr-hook");
}

export function runLauncherFile(): string {
  return join(tokmizerHome(), "bin", "tkr-run");
}

export function claudePluginCacheDir(): string {
  return join(claudeConfigDir(), "plugins", "cache", "tokmizer", "tokmizer");
}

function pluginCacheParent(shimJs: string): string | null {
  const root = dirname(dirname(dirname(shimJs)));
  return SEMVER_DIR.test(basename(root)) && basename(dirname(root)) === "tokmizer" ? dirname(root) : null;
}

export function ephemeralPath(path: string): boolean {
  return /[\n\r]/.test(path) || path.includes(`${sep}_npx${sep}`) || path.includes(`${sep}.bun${sep}install${sep}cache${sep}`);
}

export function brewStablePath(path: string): string {
  const m = path.match(/^(.*)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/](.*)$/);
  if (!m) return path;
  const stable = join(m[1]!, "opt", m[2]!, m[3]!);
  try {
    return realpathSync(stable) === realpathSync(path) ? stable : path;
  } catch {
    return path;
  }
}

export function stableNodePath(node: string = process.execPath): string {
  return ephemeralPath(node) ? "" : brewStablePath(node);
}

export function launchTargetFor(shimJs: string, single: boolean = singleBinary()): LaunchTarget {
  if (single && entryWords(shimJs)) {
    const self = stableSelfPath();
    return { single: ephemeralPath(self) ? "" : brewStablePath(self), js: "", cache: claudePluginCacheDir(), node: "" };
  }
  const node = stableNodePath();
  const cache = pluginCacheParent(shimJs);
  if (cache) return { single: "", js: "", cache, node };
  return { single: "", js: ephemeralPath(shimJs) ? "" : brewStablePath(shimJs), cache: claudePluginCacheDir(), node };
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function newestStablePluginRoot(cache: string): string | null {
  let best: string | null = null;
  let bestKey = -1;
  let names: string[];
  try {
    names = readdirSync(cache);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!SEMVER_DIR.test(name)) continue;
    const root = join(cache, name);
    if (!existsSync(join(root, "dist", "bin", "tkr-shim.js")) || !existsSync(join(root, "dist", "bin", STABLE_MARK))) continue;
    const [a, b, c] = name.split(".").map(Number);
    const key = a! * 1_000_000 + b! * 1000 + c!;
    if (key > bestKey) {
      bestKey = key;
      best = root;
    }
  }
  return best;
}

export function targetUsable(target: LaunchTarget): boolean {
  if (target.single && executable(target.single)) return true;
  if (target.js && existsSync(target.js) && (basename(target.js) !== "tkr-shim.js" || existsSync(join(dirname(target.js), STABLE_MARK)))) return true;
  return target.cache !== "" && newestStablePluginRoot(target.cache) !== null;
}

function headerLines(target: LaunchTarget, first: string): string[] {
  return [
    "#!/bin/sh",
    `_tk_f=${LAUNCHER_FORMAT}`,
    `${first}=$1`,
    "shift",
    `_tk_s=${shQuote(target.single)}`,
    `_tk_j=${shQuote(target.js)}`,
    `_tk_k=${shQuote(target.cache)}`,
    `_tk_n=${shQuote(target.node)}`
  ];
}

function findLines(file: string, recorded: string): string[] {
  return [
    "_tk_t=",
    `if [ -n "$_tk_j" ] && [ -f "${recorded}" ] && { [ "\${_tk_j##*/}" != tkr-shim.js ] || [ -f "\${_tk_j%/*}/${STABLE_MARK}" ]; }; then _tk_t=${recorded}; fi`,
    'if [ -z "$_tk_t" ] && [ -n "$_tk_k" ] && [ -d "$_tk_k" ]; then',
    "  _tk_b=-1",
    '  for _tk_r in "$_tk_k"/*/; do',
    "    _tk_v=${_tk_r%/}; _tk_v=${_tk_v##*/}",
    "    case $_tk_v in *[!0-9.]*|.*|*.|*..*|0[0-9]*|*.0[0-9]*|*[0-9][0-9][0-9][0-9][0-9][0-9][0-9]*) continue ;; [0-9]*.[0-9]*.[0-9]*) ;; *) continue ;; esac",
    "    case ${_tk_v#*.*.} in *.*) continue ;; esac",
    `    [ -f "\${_tk_r}dist/bin/${file}" ] && [ -f "\${_tk_r}dist/bin/${STABLE_MARK}" ] || continue`,
    "    _tk_1=${_tk_v%%.*}; _tk_2=${_tk_v#*.}; _tk_3=${_tk_2#*.}; _tk_2=${_tk_2%%.*}",
    "    _tk_v=$((_tk_1 * 1000000 + _tk_2 * 1000 + _tk_3))",
    `    if [ "$_tk_v" -gt "$_tk_b" ]; then _tk_b=$_tk_v; _tk_t=\${_tk_r}dist/bin/${file}; fi`,
    "  done",
    "fi",
    'if [ -z "$_tk_t" ]; then',
    `  _tk_d=${shQuote(shimsDir())}`,
    "  set -f; _tk_o=$IFS; IFS=:",
    "  for _tk_e in $PATH; do",
    "    case $_tk_e in /*/node_modules/*|*/node_modules) continue ;; /*) ;; *) continue ;; esac",
    '    [ ! "$_tk_e" -ef "$_tk_d" ] || continue',
    "    for _tk_g in \"$_tk_e/../lib/node_modules/@tokmizer/plugin/dist/bin\" \"$_tk_e/../opt/tokmizer/libexec/lib/node_modules/@tokmizer/plugin/dist/bin\"; do",
    `      if [ -f "$_tk_g/${STABLE_MARK}" ] && [ -f "$_tk_g/${file}" ]; then _tk_t=$_tk_g/${file}; break 2; fi`,
    "    done",
    "  done",
    "  IFS=$_tk_o; set +f",
    "fi",
    "_tk_x=",
    'if [ -n "$_tk_t" ]; then',
    '  for _tk_x in "$_tk_n" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node ""; do',
    '    [ -n "$_tk_x" ] && [ -x "$_tk_x" ] && break',
    "  done",
    "fi"
  ];
}

export function launcherScript(target: LaunchTarget): string {
  return [
    ...headerLines(target, "_tk_c"),
    `if ! ${failOpenShellTest()}; then`,
    `  if [ -n "$_tk_s" ] && [ -x "$_tk_s" ]; then exec "$_tk_s" shim-run --as "$_tk_c" "$@"; fi`,
    ...findLines("tkr-shim.js", "$_tk_j").map((l) => `  ${l}`),
    '  if [ -n "$_tk_x" ]; then exec "$_tk_x" "$_tk_t" --as "$_tk_c" "$@"; fi',
    `  echo ${shQuote(FALLBACK_HINT)} >&2`,
    `  { echo x >> ${shQuote(shimFallbackFile())}; } 2>/dev/null`,
    "fi",
    ...passthroughLines(""),
    ""
  ].join("\n");
}

export function hookLauncherScript(target: LaunchTarget): string {
  return [
    ...headerLines(target, "_tk_m"),
    'case $_tk_m in tkr-*-hook) ;; *) { /bin/cat || /usr/bin/cat; } >/dev/null 2>&1; exit 0 ;; esac',
    'if [ -n "$_tk_s" ] && [ -x "$_tk_s" ]; then _tk_w=${_tk_m#tkr-}; exec "$_tk_s" hook "${_tk_w%-hook}" "$@"; fi',
    ...findLines("$_tk_m.js", "${_tk_j%/*}/$_tk_m.js"),
    'if [ -n "$_tk_x" ]; then exec "$_tk_x" "$_tk_t" "$@"; fi',
    "{ /bin/cat || /usr/bin/cat; } >/dev/null 2>&1",
    "exit 0",
    ""
  ].join("\n");
}

export function runLauncherScript(target: LaunchTarget): string {
  return [
    "#!/bin/sh",
    `_tk_f=${LAUNCHER_FORMAT}`,
    `_tk_s=${shQuote(target.single)}`,
    `_tk_j=${shQuote(target.js)}`,
    `_tk_k=${shQuote(target.cache)}`,
    `_tk_n=${shQuote(target.node)}`,
    '[ "$#" -gt 0 ] || exit 0',
    `if ! ${failOpenShellTest()}; then`,
    '  if [ -n "$_tk_s" ] && [ -x "$_tk_s" ]; then exec "$_tk_s" exec "$@"; fi',
    ...findLines("tkr-exec.js", "${_tk_j%/*}/tkr-exec.js").map((l) => `  ${l}`),
    '  if [ -n "$_tk_t" ]; then',
    '    _tk_r=${_tk_t%/*}',
    '    if [ -f "$_tk_r/tkr-exec" ] && [ -s "$_tk_r/tkr-exec" ] && [ -x "$_tk_r/tkr-exec" ]; then exec "$_tk_r/tkr-exec" "$@"; fi',
    '    if [ -n "$_tk_x" ] && [ -s "$_tk_t" ]; then exec "$_tk_x" "$_tk_t" "$@"; fi',
    "  fi",
    "fi",
    'exec "$@"',
    ""
  ].join("\n");
}

export function ensureRunLauncherSync(execJs: string): string | null {
  const file = runLauncherFile();
  const target = launchTargetFor(join(dirname(execJs), "tkr-shim.js"));
  const current = readLauncher(file);
  if (current && current.format === LAUNCHER_FORMAT && targetUsable(current.target) && JSON.stringify(current.target) === JSON.stringify(target)) return file;
  if (!targetUsable(target)) return current && targetUsable(current.target) ? file : null;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, runLauncherScript(target), { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, file);
    return file;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
    return null;
  }
}

export type LauncherInfo = { format: number; target: LaunchTarget } | null;

export function parseLauncher(content: string): LauncherInfo {
  const value = (name: string): string | null => {
    const m = content.match(new RegExp(`^${name}=(.*)$`, "m"));
    return m ? (name === "_tk_f" ? m[1]! : shUnquote(m[1]!)) : null;
  };
  const format = Number(value("_tk_f"));
  const single = value("_tk_s");
  const js = value("_tk_j");
  const cache = value("_tk_k");
  const node = value("_tk_n") ?? "";
  if (!Number.isInteger(format) || single === null || js === null || cache === null) return null;
  return { format, target: { single, js, cache, node } };
}

export function readLauncher(file: string = launcherFile()): LauncherInfo {
  try {
    return parseLauncher(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function launcherHealthy(info: LauncherInfo = readLauncher()): boolean {
  return info !== null && info.format === LAUNCHER_FORMAT && targetUsable(info.target);
}

async function writeExecutable(file: string, content: string): Promise<boolean> {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(tmp, content, { mode: 0o755 });
    await chmod(tmp, 0o755);
    await rename(tmp, file);
    return true;
  } catch {
    try {
      await unlink(tmp);
    } catch {}
    return false;
  }
}

export function writeLauncher(target: LaunchTarget): Promise<boolean> {
  return writeExecutable(launcherFile(), launcherScript(target));
}

export function writeHookLauncher(target: LaunchTarget): Promise<boolean> {
  return writeExecutable(hookLauncherFile(), hookLauncherScript(target));
}

export function ensureHookLauncherSync(hookJs: string): void {
  const target = launchTargetFor(join(dirname(hookJs), "tkr-shim.js"));
  const current = readLauncher(hookLauncherFile());
  if (current && current.format === LAUNCHER_FORMAT && targetUsable(current.target) && target.single === "" && target.js === "") return;
  const file = hookLauncherFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, hookLauncherScript(target), { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

export async function removeLauncher(): Promise<void> {
  try {
    await unlink(launcherFile());
  } catch {}
}

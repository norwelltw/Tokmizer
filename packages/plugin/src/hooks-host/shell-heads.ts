import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const SAFE_HEAD = /^[A-Za-z0-9._+@%:,/-]+$/;
const BINARY_MAGIC = new Set(["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"]);
const MAX_SNAPSHOTS = 32;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export type ShellNames = { functions: Set<string>; aliases: Map<string, string>; paths: string[]; uncertain: boolean };

export function fileMagic(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(4);
    const n = readSync(fd, bytes, 0, 4, 0);
    if (n >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return "#!";
    return n === 4 ? bytes.toString("hex") : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function directlyExecutable(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    if (platform === "win32") return true;
    if ((st.mode & 0o111) === 0) return false;
    const kind = fileMagic(path);
    return kind === "#!" || (kind !== null && BINARY_MAGIC.has(kind));
  } catch {
    return false;
  }
}

function windowsCandidates(name: string): string[] {
  if (/\.[A-Za-z0-9]+$/.test(name)) return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [name, ...exts.map((ext) => name + ext.toLowerCase())];
}

export function resolvableHead(
  head: string,
  cwd: string | undefined,
  pathEnv: string | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!SAFE_HEAD.test(head)) return false;
  const windows = platform === "win32";
  if (head.includes("/")) return directlyExecutable(resolve(cwd ?? process.cwd(), head), platform);
  if (!pathEnv) return false;
  const names = windows ? windowsCandidates(head) : [head];
  for (const dir of pathEnv.split(windows ? ";" : ":")) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      if (directlyExecutable(join(dir, name), platform)) return true;
    }
  }
  return false;
}

const BASH_FUNCTION = /^eval \$'([^\s'()=]+) \(\) /;
const ZSH_FUNCTION = /^([^\s'"()=]+) \(\) \{$/;
const ALIAS = /^alias -- ([^\s=]+)=(.*)$/;
const FUNCTIONS_END = /^# (?:Shell Options|Aliases|Shopt|Check for |Shadow )/;
const EXPORT_PATH = /^export PATH=(.*)$/;
const COSMETIC_FLAG = /^(?:--colou?r(?:=\S+)?|-G)$/;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/'\\''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

export function parseShellSnapshot(text: string, names: ShellNames): void {
  let section = "";
  for (const line of text.split("\n")) {
    const path = EXPORT_PATH.exec(line);
    if (path && section !== "# Functions") {
      const value = unquote(path[1]!.trim());
      if (!/[$`\\]/.test(value)) names.paths.push(value);
      continue;
    }
    if (line.startsWith("# ") && (section !== "# Functions" || FUNCTIONS_END.test(line))) {
      section = line;
      continue;
    }
    if (section === "# Functions") {
      const m = BASH_FUNCTION.exec(line) ?? ZSH_FUNCTION.exec(line);
      if (m) names.functions.add(m[1]!);
    } else if (section === "# Aliases") {
      const m = ALIAS.exec(line);
      if (m) names.aliases.set(m[1]!, unquote(m[2]!.trim()));
    }
  }
}

function missing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function claudeShellNames(configDir: string | undefined): ShellNames {
  const names: ShellNames = { functions: new Set(), aliases: new Map(), paths: [], uncertain: false };
  const dir = join(configDir || join(homedir(), ".claude"), "shell-snapshots");
  let files: { path: string; mtime: number; size: number }[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("snapshot-") || !name.endsWith(".sh")) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isFile()) files.push({ path, mtime: st.mtimeMs, size: st.size });
      } catch (err) {
        if (!missing(err)) names.uncertain = true;
      }
    }
  } catch (err) {
    if (!missing(err)) names.uncertain = true;
    return names;
  }
  files = files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SNAPSHOTS);
  for (const file of files) {
    try {
      if (file.size > MAX_SNAPSHOT_BYTES) throw new Error("snapshot too large");
      parseShellSnapshot(readFileSync(file.path, "utf8"), names);
    } catch (err) {
      if (!missing(err)) names.uncertain = true;
    }
  }
  return names;
}

export function shadowedByShell(head: string, names: ShellNames): boolean {
  if (names.uncertain || names.functions.has(head)) return true;
  const value = names.aliases.get(head);
  if (value === undefined) return false;
  const words = value.trim().split(/\s+/);
  return words[0] !== head || !words.slice(1).every((word) => COSMETIC_FLAG.test(word));
}
